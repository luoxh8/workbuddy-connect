/**
 * 大请求体整形。
 *
 * 为什么需要：客户端（Codex、ZCode 里的视觉会话等）每一轮都会把整段对话连同其中所有
 * base64 图片重新发一遍。图片按 token 计很小，永远不会触发上下文压缩，但字节数只涨不跌，
 * 迟早撞上上游网关的请求体上限（`413`），会话就每轮必失败。
 *
 * 这里只动一件事——请求里的图片：先按内容去重（历史上重复出现的同一张图只留最新一份），
 * 再用 ffmpeg 把偏大的图缩成 JPEG，最后按字节预算从最旧的开始换成文字占位。
 * 其余字段（messages 文本、tools、参数……）一律原样转发；没有图片的请求连解析都省掉。
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ShapeOptions {
  /** 整形后的请求体预算；超过就继续丢最旧的图片。 */
  maxBytes: number
  /** 图片长边上限（等比缩小）。 */
  imageMaxDim: number
  /** ffmpeg `-q:v`，越小越清晰也越大。 */
  imageQuality: number
  /** 保留最新的 N 张图，更旧的直接换成占位。 */
  maxImages: number
  /** 单张图超过这个字节数才值得重编码。 */
  imageMaxBytes: number
  /** ffmpeg 可执行文件；undefined 表示没找到，只做去重与丢弃。 */
  ffmpeg: string | undefined
}

export interface ShapeInfo {
  images: number
  duplicated: number
  shaped: number
  dropped: number
  bytesIn: number
  bytesOut: number
  overBudget: boolean
  shrinker: 'ffmpeg' | 'none'
}

const DEFAULTS = {
  maxBytes: 24 * 1024 * 1024,
  imageMaxDim: 1536,
  imageQuality: 3,
  maxImages: 64,
  imageMaxBytes: 256 * 1024,
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/** 从环境变量读整形参数。名字统一 `WORKBUDDY_SHAPE_` 前缀。 */
export function shapeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ShapeOptions {
  const ffmpeg = env['WORKBUDDY_SHAPE_FFMPEG']?.trim()
  return {
    maxBytes: positive(env['WORKBUDDY_SHAPE_MAX_BYTES'], DEFAULTS.maxBytes),
    imageMaxDim: positive(env['WORKBUDDY_SHAPE_IMAGE_DIM'], DEFAULTS.imageMaxDim),
    imageQuality: positive(env['WORKBUDDY_SHAPE_IMAGE_QUALITY'], DEFAULTS.imageQuality),
    maxImages: positive(env['WORKBUDDY_SHAPE_MAX_IMAGES'], DEFAULTS.maxImages),
    imageMaxBytes: positive(env['WORKBUDDY_SHAPE_IMAGE_MAX'], DEFAULTS.imageMaxBytes),
    ffmpeg: ffmpeg !== undefined && ffmpeg !== '' ? ffmpeg : 'ffmpeg',
  }
}

interface ImageNode {
  /** 所属的 content 数组与下标，替换占位时用。 */
  container: unknown[]
  index: number
  url: string
}

/** 收集 `messages[].content[]` 里的 `image_url` 图片，按出现顺序（旧 → 新）。 */
function collectImages(body: unknown): ImageNode[] {
  const found: ImageNode[] = []
  if (body === null || typeof body !== 'object') return found
  const messages = (body as Record<string, unknown>)['messages']
  if (!Array.isArray(messages)) return found
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const content = (message as Record<string, unknown>)['content']
    if (!Array.isArray(content)) continue
    content.forEach((part, index) => {
      if (part === null || typeof part !== 'object') return
      const record = part as Record<string, unknown>
      const image = record['image_url']
      const url = typeof image === 'string' ? image
        : image !== null && typeof image === 'object' ? (image as Record<string, unknown>)['url']
        : undefined
      if (typeof url === 'string' && url.startsWith('data:')) found.push({ container: content, index, url })
    })
  }
  return found
}

function placeholder(text: string): Record<string, unknown> {
  return { type: 'text', text }
}

function parseDataUrl(url: string): { mime: string; base64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return match === null ? undefined : { mime: match[1]!, base64: match[2]! }
}

function digest(url: string): string {
  return createHash('sha1').update(url).digest('hex')
}

function run(command: string, args: string[], timeoutMs = 60_000): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolve(-1) })
    child.on('close', code => { clearTimeout(timer); resolve(code ?? -1) })
    child.stdout?.resume()
    child.stderr?.resume()
    child.stdin?.end()
  })
}

/** ffmpeg 第一次就起不来（没装 / 路径错）时置位，后面不再反复尝试。 */
let shrinkerBroken = false

/** 用 ffmpeg 把一张 data URL 缩成 JPEG；失败时返回 undefined（调用方保持原图）。 */
async function shrink(url: string, options: ShapeOptions, into: string): Promise<string | undefined> {
  const parsed = parseDataUrl(url)
  if (parsed === undefined || options.ffmpeg === undefined || shrinkerBroken) return undefined
  const source = Buffer.from(parsed.base64, 'base64')
  if (source.length <= options.imageMaxBytes) return url
  const input = join(into, 'input.bin')
  const output = join(into, 'output.jpg')
  try {
    await writeFile(input, source)
    const scale = `scale='min(${options.imageMaxDim},iw)':'min(${options.imageMaxDim},ih)':force_original_aspect_ratio=decrease`
    const code = await run(options.ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', input, '-vf', scale,
      '-frames:v', '1', '-q:v', String(options.imageQuality), '-pix_fmt', 'yuvj420p', output,
    ])
    if (code === -1) { shrinkerBroken = true; return undefined }
    if (code !== 0) return undefined
    const encoded = await readFile(output)
    return encoded.length >= source.length ? url : `data:image/jpeg;base64,${encoded.toString('base64')}`
  } catch {
    return undefined
  } finally {
    await rm(input, { force: true }).catch(() => {})
    await rm(output, { force: true }).catch(() => {})
  }
}

/**
 * 就地整形一个 chat completions 请求体，返回整形信息。
 * 只改图片节点：重复的旧图、超过 `maxImages` 的旧图、超预算时最旧的图，都会被换成文字占位。
 */
export async function shapeChatBody(body: unknown, options: ShapeOptions): Promise<ShapeInfo> {
  const images = collectImages(body)
  const bytesIn = Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8')
  const base: ShapeInfo = {
    images: images.length, duplicated: 0, shaped: 0, dropped: 0,
    bytesIn, bytesOut: bytesIn, overBudget: false,
    shrinker: options.ffmpeg === undefined || shrinkerBroken ? 'none' : 'ffmpeg',
  }
  if (images.length === 0) return base

  // 1) 去重：同一张图在历史里出现多次时，只有最新那份有意义。
  const newestByDigest = new Map<string, ImageNode>()
  for (const image of images) newestByDigest.set(digest(image.url), image)
  let working = images
  if (newestByDigest.size < images.length) {
    for (const image of images) {
      if (newestByDigest.get(digest(image.url)) === image) continue
      image.container[image.index] = placeholder('[identical image repeated earlier in this conversation; only the newest copy was sent]')
      base.duplicated += 1
    }
    const stale = new Set(images.filter(image => newestByDigest.get(digest(image.url)) !== image))
    working = images.filter(image => !stale.has(image))
  }

  // 2) 张数上限：只保留最新的 N 张，更旧的换占位。
  if (working.length > options.maxImages) {
    for (const image of working.slice(0, working.length - options.maxImages)) {
      image.container[image.index] = placeholder(`[earlier image dropped locally: only the newest ${options.maxImages} images are kept in context]`)
      base.dropped += 1
    }
    working = working.slice(working.length - options.maxImages)
  }

  // 3) 缩图：偏大的图重编码成 JPEG。同一张图在一轮里只处理一次。
  if (options.ffmpeg !== undefined && !shrinkerBroken) {
    let directory: string | undefined
    try {
      for (const image of working) {
        const parsed = parseDataUrl(image.url)
        if (parsed === undefined || Buffer.byteLength(parsed.base64, 'base64') <= options.imageMaxBytes) continue
        directory ??= await mkdtemp(join(tmpdir(), 'workbuddy-shape-'))
        const shaped = await shrink(image.url, options, directory)
        if (shaped !== undefined && shaped !== image.url) {
          image.url = shaped
          image.container[image.index] = { type: 'image_url', image_url: { url: shaped } }
          base.shaped += 1
        }
      }
    } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }

  // 4) 字节预算：还是超，就从最旧的图片开始继续丢，直到进预算或没有图片可丢。
  for (const image of working) {
    if (Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8') <= options.maxBytes) break
    image.container[image.index] = placeholder('[earlier image dropped locally to stay under the upstream body limit]')
    base.dropped += 1
  }

  base.bytesOut = Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8')
  base.overBudget = base.bytesOut > options.maxBytes
  return base
}

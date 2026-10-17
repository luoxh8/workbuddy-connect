import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shapeChatBody, shapeOptionsFromEnv, type ShapeOptions } from '../src/shape.ts'

const small = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64')
const other = 'data:image/png;base64,' + Buffer.from('another-png').toString('base64')

function options(overrides: Partial<ShapeOptions> = {}): ShapeOptions {
  return {
    maxBytes: 24 * 1024 * 1024,
    imageMaxDim: 1536,
    imageQuality: 3,
    maxImages: 64,
    imageMaxBytes: 256 * 1024,
    ffmpeg: undefined,
    ...overrides,
  }
}

function imageMessage(url: string) {
  return { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url } }] }
}

test('a request without images is left byte-identical', async () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hello' }, { role: 'user', content: [{ type: 'text', text: 'x' }] }] }
  const before = JSON.stringify(body)
  const info = await shapeChatBody(body, options())
  assert.equal(info.images, 0)
  assert.equal(info.bytesIn, info.bytesOut)
  assert.equal(JSON.stringify(body), before)
})

test('the same image repeated in history is sent once, the newest copy wins', async () => {
  const body = { messages: [imageMessage(small), { role: 'assistant', content: 'ok' }, imageMessage(small)] }
  const info = await shapeChatBody(body, options())
  assert.equal(info.images, 2)
  assert.equal(info.duplicated, 1)
  const [first, , third] = body.messages as any[]
  assert.match(first.content[1].text, /identical image repeated earlier/)
  assert.equal(third.content[1].image_url.url, small, 'the newest copy must stay intact')
})

test('only the newest maxImages images survive', async () => {
  const body = { messages: [imageMessage(other), imageMessage(other + 'a'), imageMessage(other + 'b')] }
  const info = await shapeChatBody(body, options({ maxImages: 2 }))
  assert.equal(info.dropped, 1)
  assert.match(body.messages[0].content[1].text, /only the newest 2 images/)
  assert.equal(body.messages[2].content[1].image_url.url, other + 'b')
})

test('over budget requests keep shedding the oldest images', async () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(20_000)
  const body = { messages: [imageMessage(big), imageMessage(other), imageMessage(small)] }
  const info = await shapeChatBody(body, options({ maxBytes: 4_000 }))
  assert.equal(info.overBudget, false)
  assert.ok(info.dropped >= 1)
  assert.match(body.messages[0].content[1].text, /dropped locally to stay under the upstream body limit/)
})

test('a body that is too big even without images is reported, not silently forwarded', async () => {
  const body = { messages: [{ role: 'user', content: 'x'.repeat(20_000) }, imageMessage(small)] }
  const info = await shapeChatBody(body, options({ maxBytes: 4_000 }))
  assert.equal(info.overBudget, true)
  assert.match(body.messages[1].content[1].text, /dropped locally to stay under the upstream body limit/)
})

test('dropping stops as soon as the budget is met', async () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(20_000)
  const body = { messages: [imageMessage(big), imageMessage(small)] }
  const info = await shapeChatBody(body, options({ maxBytes: 12_000 }))
  assert.equal(info.overBudget, false)
  assert.equal(info.dropped, 1)
  assert.equal(body.messages[1].content[1].image_url.url, small)
})

test('plain string content and non-image fields are untouched', async () => {
  const body = { model: 'm', temperature: 0.2, tools: [{ type: 'function' }], messages: [{ role: 'user', content: 'plain text stays' }, imageMessage(small)] }
  await shapeChatBody(body, options())
  assert.equal(body.messages[0].content, 'plain text stays')
  assert.equal(body.temperature, 0.2)
  assert.deepEqual(body.tools, [{ type: 'function' }])
})

test('without ffmpeg the shaper still dedupes and drops, and says so', async () => {
  const body = { messages: [imageMessage(small), imageMessage(small)] }
  const info = await shapeChatBody(body, options({ ffmpeg: undefined }))
  assert.equal(info.shrinker, 'none')
  assert.equal(info.duplicated, 1)
})

test('environment knobs are parsed with sane fallbacks', () => {
  const parsed = shapeOptionsFromEnv({
    WORKBUDDY_SHAPE_MAX_BYTES: '1048576',
    WORKBUDDY_SHAPE_MAX_IMAGES: '8',
    WORKBUDDY_SHAPE_FFMPEG: 'C:\\ffmpeg.exe',
  } as NodeJS.ProcessEnv)
  assert.equal(parsed.maxBytes, 1_048_576)
  assert.equal(parsed.maxImages, 8)
  assert.equal(parsed.ffmpeg, 'C:\\ffmpeg.exe')

  const fallback = shapeOptionsFromEnv({
    WORKBUDDY_SHAPE_MAX_BYTES: 'not-a-number',
    WORKBUDDY_SHAPE_MAX_IMAGES: '-3',
  } as NodeJS.ProcessEnv)
  assert.equal(fallback.maxBytes, 24 * 1024 * 1024)
  assert.equal(fallback.maxImages, 64)
  assert.equal(fallback.ffmpeg, 'ffmpeg')
})

test('a real oversized photo is re-encoded smaller when ffmpeg is available', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wb-shape-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const png = join(directory, 'big.png')
  try {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=2000x2000', '-frames:v', '1', png], { stdio: 'ignore' })
  } catch {
    t.skip('ffmpeg is not available on this machine')
    return
  }
  const original = readFileSync(png)
  const url = `data:image/png;base64,${original.toString('base64')}`
  const body = { messages: [imageMessage(url)] }
  const info = await shapeChatBody(body, options({ ffmpeg: 'ffmpeg', imageMaxDim: 512, imageMaxBytes: 1024 }))

  assert.equal(info.shrinker, 'ffmpeg')
  assert.equal(info.shaped, 1)
  assert.ok(info.bytesOut < info.bytesIn, 'the shaped body must be smaller')
  const sent = body.messages[0].content[1].image_url.url as string
  assert.match(sent, /^data:image\/jpeg;base64,/)
  assert.ok(Buffer.from(sent.split(',')[1]!, 'base64').length < original.length)
})

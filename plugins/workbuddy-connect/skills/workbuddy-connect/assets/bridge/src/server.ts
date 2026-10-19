import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { prepareChatBody, normalizeCredits, WorkBuddyUpstreamClient, type WorkBuddyUpstreamModel, type WorkBuddyRegion } from './upstream.ts'
import { CompletionAccumulator, readSse } from './sse.ts'
import { packageName, packageVersion } from './version.ts'
import { shapeChatBody, shapeOptionsFromEnv, type ShapeOptions } from './shape.ts'
import {
  anthropicToChat, chatToAnthropicMessage, AnthropicStreamEncoder,
  responsesToChat, chatToResponsesObject, ResponsesStreamEncoder,
  type FrameWriter,
} from './protocols.ts'

export type Region = WorkBuddyRegion
/** The wire protocol a route speaks. Chat completions is the native one. */
export type RouteProtocol = 'chat' | 'anthropic' | 'responses'
export interface RegionStore {
  resolve(): Promise<any>
  current(): Promise<any>
  status(): Promise<any>
}
export interface BridgeOptions {
  token: string
  port?: number
  stores: Record<Region, RegionStore>
  client?: Pick<WorkBuddyUpstreamClient, 'fetchModels' | 'chatStream' | 'fetchCredits'>
  timeoutMs?: number
  /** 请求体整形参数；默认读 WORKBUDDY_SHAPE_* 环境变量。 */
  shape?: ShapeOptions
}
const errorStatus = { hard_credit: 402, soft_rate: 429, session_dead: 401, not_found: 404, server: 502, client: 400 }
const MAX_BODY = 64 * 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { type: code, code, message } })
}

/** Anthropic error types; clients branch on these strings. */
function anthropicErrorType(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

/** Responses error types, aligned with the OpenAI SDK's mapping. */
function responsesErrorType(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'server_error'
  return 'invalid_request_error'
}

function failProtocol(res: ServerResponse, protocol: RouteProtocol, status: number, code: string, message: string): void {
  if (protocol === 'anthropic') {
    json(res, status, { type: 'error', error: { type: anthropicErrorType(status), message } })
    return
  }
  json(res, status, { error: { message, type: responsesErrorType(status), code } })
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('Request body exceeds 64 MiB'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('Invalid JSON request'), { status: 400 }) }
}
function modelRow(region: Region, model: WorkBuddyUpstreamModel) {
  const credits = normalizeCredits(model.billing?.credits)
  return {
    id: model.id, object: 'model', created: 0, owned_by: `workbuddy-${region}`,
    name: `${model.name}${credits ? ` · ${credits}` : ''}`,
    context_length: model.contextWindow, context_window: model.contextWindow,
    max_output_tokens: model.maxTokens,
    input_modalities: model.supportsImages ? ['text', 'image'] : ['text'],
    output_modalities: ['text'], supports_vision: model.supportsImages,
    reasoning: model.reasoning, billing: model.billing,
  }
}

export function createBridge(options: BridgeOptions) {
  if (options.token.length < 24) throw new Error('Bridge token must contain at least 24 characters')
  const client = options.client ?? new WorkBuddyUpstreamClient()
  const shapeOptions = options.shape ?? shapeOptionsFromEnv()
  const shapeStats = { requests: 0, images: 0, duplicated: 0, shaped: 0, dropped: 0, bytesIn: 0, bytesOut: 0 }
  const cache = new Map<Region, { identity: string; at: number; models: readonly WorkBuddyUpstreamModel[] }>()
  const loads = new Map<string, Promise<readonly WorkBuddyUpstreamModel[]>>()
  async function models(region: Region, credential: any) {
    const identity = `${credential.domain}:${credential.uid}:${credential.enterpriseId ?? ''}`
    const cached = cache.get(region)
    if (cached?.identity === identity && Date.now() - cached.at < 5 * 60_000) return cached.models
    const key = `${region}:${identity}`
    let pending = loads.get(key)
    if (!pending) {
      pending = client.fetchModels(credential).then(found => {
        cache.set(region, { identity, at: Date.now(), models: found })
        return found
      }).finally(() => loads.delete(key))
      loads.set(key, pending)
    }
    return pending
  }
  /**
   * Both credential spellings are accepted: OpenAI-style clients send
   * `Authorization: Bearer`, the Anthropic SDK sends `x-api-key`. Comparing
   * length first keeps `timingSafeEqual` from throwing on a mismatched input.
   */
  function authorized(headers: IncomingMessage['headers']): boolean {
    const expected = Buffer.from(`Bearer ${options.token}`)
    const candidates: string[] = []
    if (typeof headers.authorization === 'string') candidates.push(headers.authorization)
    if (typeof headers['x-api-key'] === 'string') candidates.push(`Bearer ${headers['x-api-key']}`)
    if (Array.isArray(headers['x-api-key'])) {
      for (const key of headers['x-api-key']) candidates.push(`Bearer ${key}`)
    }
    return candidates.some(candidate => {
      const actual = Buffer.from(candidate)
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    })
  }
  const server = createServer((req, res) => { void handle(req, res) })
  server.requestTimeout = 120_000
  server.headersTimeout = 30_000
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = new AbortController()
    const abort = () => { if (!res.writableFinished) controller.abort() }
    res.on('close', abort)
    const timeout = setTimeout(() => controller.abort(new Error('WorkBuddy request timed out')), options.timeoutMs ?? 5 * 60_000)
    timeout.unref()
    let protocol: RouteProtocol = 'chat'
    let encoder: AnthropicStreamEncoder | ResponsesStreamEncoder | undefined
    try {
      if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
        fail(res, 403, 'origin_not_allowed', 'Only localhost requests are accepted'); return
      }
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/$/, '')
      // The protocol is decided before authentication so a rejected request
      // still answers in the envelope that client parses.
      const routeMatch = /^\/(cn|global)\/v1\/(models|chat\/completions|messages|responses|credits)$/.exec(path)
      if (routeMatch) {
        const routeName = routeMatch[2]
        protocol = routeName === 'messages' ? 'anthropic' : routeName === 'responses' ? 'responses' : 'chat'
      }
      if (!authorized(req.headers)) {
        failProtocol(res, protocol, 401, 'unauthorized', 'Missing or invalid bridge API key'); return
      }
      if (req.method === 'GET' && path === '/healthz') {
        json(res, 200, { ok: true, service: 'workbuddy-connect', version: packageVersion() }); return
      }
      if (req.method === 'GET' && path === '/status') {
        const regions = Object.fromEntries(await Promise.all((['cn', 'global'] as const).map(async region => {
          const status = await options.stores[region].status()
          return [region, { state: status.state, domain: status.domain, expiresAtMs: status.expiresAtMs }]
        })))
        json(res, 200, {
          regions,
          protocols: ['openai-chat-completions', 'anthropic-messages', 'openai-responses'],
          shape: {
            ...shapeStats,
            maxBytes: shapeOptions.maxBytes,
            maxImages: shapeOptions.maxImages,
            imageMaxDim: shapeOptions.imageMaxDim,
            shrinker: shapeOptions.ffmpeg === undefined ? 'none' : 'ffmpeg',
          },
        }); return
      }
      const match = routeMatch
      if (match === null) { fail(res, 404, 'not_found', 'Unknown bridge route'); return }
      const region = match[1] as Region
      const route = match[2]
      let credential: any
      try { credential = await options.stores[region].resolve() }
      catch { failProtocol(res, protocol, 401, 'not_signed_in', `Sign in to WorkBuddy ${region} desktop again, then retry`); return }
      if (req.method === 'GET' && route === 'models') {
        json(res, 200, { object: 'list', data: (await models(region, credential)).map(m => modelRow(region, m)) }); return
      }
      if (req.method === 'GET' && route === 'credits') {
        json(res, 200, await client.fetchCredits(credential)); return
      }
      if (req.method !== 'POST' || (route !== 'chat/completions' && route !== 'messages' && route !== 'responses')) {
        failProtocol(res, protocol, 405, 'method_not_allowed', 'Unsupported HTTP method'); return
      }
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
        failProtocol(res, protocol, 415, 'unsupported_media_type', 'Content-Type must be application/json'); return
      }
      const body = await readJson(req)
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') {
        failProtocol(res, protocol, 400, 'invalid_request', 'A model is required'); return
      }
      // Every non-native protocol is rewritten into the one shape the upstream
      // speaks; the rest of this handler is protocol-agnostic.
      const chat: Record<string, any> = protocol === 'anthropic'
        ? anthropicToChat(body)
        : protocol === 'responses' ? responsesToChat(body) : body
      if (!Array.isArray(chat['messages']) || chat['messages'].length === 0) {
        failProtocol(res, protocol, 400, 'invalid_request', protocol === 'anthropic'
          ? 'A non-empty messages array is required'
          : 'A non-empty input is required'); return
      }
      const catalog = await models(region, credential)
      const model = catalog.find(m => m.id === body.model)
      if (!model) {
        failProtocol(res, protocol, 404, 'model_not_found', 'Model is not available in this WorkBuddy region'); return
      }
      const hasImage = chat['messages'].some((m: any) => Array.isArray(m?.content) && m.content.some((p: any) => p?.type === 'image_url'))
      if (hasImage && !model.supportsImages) {
        failProtocol(res, protocol, 400, 'unsupported_image', 'This model does not support image input'); return
      }
      const stream = body.stream === true
      // Global WorkBuddy rejects a user-first conversation with code 11128.
      // Developer messages become system in prepareChatBody below.
      if (region === 'global' && !['system', 'developer'].includes(chat['messages'][0]?.role)) {
        chat['messages'].unshift({ role: 'system', content: 'You are a helpful coding assistant.' })
      }
      if (chat['max_completion_tokens'] !== undefined) {
        chat['max_tokens'] ??= chat['max_completion_tokens']
        delete chat['max_completion_tokens']
      }
      delete chat['stream_options']
      // Only forward efforts declared by this account's live catalog. An
      // unknown Codex default must not break an otherwise supported model.
      if (chat['reasoning_effort'] && !model.reasoning?.supportedEfforts?.includes(chat['reasoning_effort'])) delete chat['reasoning_effort']
      chat['max_tokens'] = Math.min(chat['max_tokens'] ?? model.maxTokens, model.maxTokens)
      // 图片去重 / 缩图 / 超预算丢最旧的图；其余字段原样转发。
      const shaped = await shapeChatBody(chat, shapeOptions)
      if (shaped.images > 0) {
        shapeStats.requests += 1
        shapeStats.images += shaped.images
        shapeStats.duplicated += shaped.duplicated
        shapeStats.shaped += shaped.shaped
        shapeStats.dropped += shaped.dropped
        shapeStats.bytesIn += shaped.bytesIn
        shapeStats.bytesOut += shaped.bytesOut
      }
      if (shaped.overBudget) {
        failProtocol(res, protocol, 413, 'request_too_large', `Request is ${shaped.bytesOut} bytes after local image shaping, over this bridge's ${shapeOptions.maxBytes}-byte budget; send fewer images or raise WORKBUDDY_SHAPE_MAX_BYTES`); return
      }
      const result = await client.chatStream(credential, prepareChatBody(JSON.stringify(chat)), controller.signal)
      if (!result.ok) {
        failProtocol(res, protocol, errorStatus[result.kind], result.kind, `WorkBuddy ${region} rejected the request (${result.kind}, HTTP ${result.status})`); return
      }
      if (!result.response.body || !result.response.headers.get('content-type')?.includes('text/event-stream')) {
        await result.response.body?.cancel()
        failProtocol(res, protocol, 502, 'upstream_protocol', 'WorkBuddy returned an unexpected response format'); return
      }
      if (stream && protocol !== 'chat') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
          ...(protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
        })
        res.flushHeaders()
        const sink: FrameWriter = async frame => {
          if (!res.write(frame)) await once(res, 'drain', { signal: controller.signal })
        }
        encoder = protocol === 'anthropic'
          ? new AnthropicStreamEncoder(sink, model.id)
          : new ResponsesStreamEncoder(sink, model.id)
        await encoder.start()
      } else if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
        res.flushHeaders()
      }
      const accumulator = new CompletionAccumulator()
      let sawDone = false
      let finished = false
      for await (const payload of readSse(result.response.body, controller.signal)) {
        if (payload === '[DONE]') { sawDone = true; break }
        let chunk: any
        try { chunk = JSON.parse(payload) } catch { throw new Error('Malformed upstream stream') }
        if (chunk.error) throw new Error('Upstream stream reported an error')
        if (chunk.choices?.some((choice: any) => choice.finish_reason)) finished = true
        accumulator.add(chunk)
        if (encoder !== undefined) await encoder.push(chunk)
        else if (stream && !res.write(`data: ${payload}\n\n`)) await once(res, 'drain', { signal: controller.signal })
      }
      if (!sawDone || !finished) throw new Error('Upstream stream ended before completion')
      if (stream) {
        if (encoder !== undefined) await encoder.finish()
        else res.end('data: [DONE]\n\n')
        res.end()
      } else if (protocol === 'anthropic') {
        json(res, 200, chatToAnthropicMessage(accumulator.result(), model.id))
      } else if (protocol === 'responses') {
        json(res, 200, chatToResponsesObject(accumulator.result(), model.id))
      } else {
        json(res, 200, accumulator.result())
      }
    } catch (error: any) {
      if (res.destroyed) return
      if (!res.headersSent) {
        failProtocol(res, protocol, error.status ?? 502, 'bridge_error', error.status ? error.message : 'WorkBuddy request failed; retry or check the desktop login and network')
      } else if (encoder !== undefined) {
        await encoder.fail('WorkBuddy stream interrupted; retry the request')
        res.end()
      } else {
        res.end(`data: ${JSON.stringify({ error: { type: 'upstream_stream_error', message: 'WorkBuddy stream interrupted; retry the request' } })}\n\n`)
      }
    } finally {
      clearTimeout(timeout)
      res.off('close', abort)
    }
  }
  return {
    server,
    async listen() {
      server.listen(options.port ?? 10108, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Could not resolve bridge listener')
      return `http://127.0.0.1:${address.port}`
    },
    async close() {
      const done = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await done
    },
  }
}

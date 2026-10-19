/**
 * Anthropic Messages and OpenAI Responses adapters.
 *
 * The upstream only speaks OpenAI Chat Completions, so every other protocol is
 * translated twice: the inbound request is rewritten into a chat-completions
 * body, and the upstream chunk stream is re-encoded into that protocol's event
 * vocabulary. Keeping both directions in one module makes the round trip
 * auditable: every field the inbound side reads has exactly one outbound
 * counterpart.
 *
 * Reference points: ZCode drives its providers through the Vercel AI SDK, whose
 * anthropic and openai-responses parsers are strict about field names and
 * required keys. The emitters below follow those parsers rather than a generic
 * reading of each spec �?see the notes at each event family.
 */

import { randomUUID } from 'node:crypto'

export type Protocol = 'anthropic' | 'responses'

export const PROTOCOLS: readonly Protocol[] = ['anthropic', 'responses']

/** Chat-completions finish reason, as the upstream reports it. */
type ChatFinish = string | null | undefined

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/gu, '')}`
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map(part => isRecord(part) && typeof part.text === 'string' ? part.text : '')
    .filter(text => text !== '')
    .join('\n')
}

function dataUrl(source: Record<string, any>): string | undefined {
  if (source['type'] === 'base64' && typeof source['data'] === 'string') {
    const mediaType = typeof source['media_type'] === 'string' ? source['media_type'] : 'image/png'
    return `data:${mediaType};base64,${source['data']}`
  }
  if (source['type'] === 'url' && typeof source['url'] === 'string') return source['url']
  return undefined
}

// ---------------------------------------------------------------------------
// Inbound: Anthropic Messages -> Chat Completions
// ---------------------------------------------------------------------------

/**
 * Rewrite one Anthropic content array into chat-completions message pieces.
 *
 * Anthropic keeps tool results inside a user turn; chat completions needs them
 * as standalone `tool` messages. The two shapes also differ on images (`source`
 * objects vs. `image_url`), so the split has to happen per block, not per
 * message.
 */
function anthropicContent(content: unknown, role: 'user' | 'assistant'): {
  text: string
  images: any[]
  toolCalls: any[]
  toolResults: any[]
  reasoning: string
} {
  const result = { text: '', images: [] as any[], toolCalls: [] as any[], toolResults: [] as any[], reasoning: '' }
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  const texts: string[] = []
  for (const raw of blocks) {
    if (!isRecord(raw)) continue
    switch (raw['type']) {
      case 'text': {
        if (typeof raw['text'] === 'string') texts.push(raw['text'])
        break
      }
      case 'image': {
        const url = isRecord(raw['source']) ? dataUrl(raw['source']) : undefined
        if (url !== undefined) result.images.push({ type: 'image_url', image_url: { url } })
        break
      }
      case 'document': {
        texts.push('[document attachment omitted: this bridge forwards images only]')
        break
      }
      case 'thinking': {
        if (role === 'assistant' && typeof raw['thinking'] === 'string') result.reasoning += raw['thinking']
        break
      }
      case 'redacted_thinking':
        break
      case 'tool_use': {
        if (role !== 'assistant') break
        result.toolCalls.push({
          id: typeof raw['id'] === 'string' ? raw['id'] : id('call'),
          type: 'function',
          function: {
            name: typeof raw['name'] === 'string' ? raw['name'] : 'tool',
            arguments: JSON.stringify(isRecord(raw['input']) ? raw['input'] : {}),
          },
        })
        break
      }
      case 'tool_result': {
        const toolUseId = typeof raw['tool_use_id'] === 'string' ? raw['tool_use_id'] : ''
        let body = asText(raw['content'])
        if (body === '' && typeof raw['content'] === 'string') body = raw['content']
        if (body === '') body = '(tool returned no text output)'
        if (raw['is_error'] === true) body = `Error: ${body}`
        result.toolResults.push({ role: 'tool', tool_call_id: toolUseId, content: body })
        break
      }
      default:
        break
    }
  }
  result.text = texts.join('\n')
  return result
}

/** Anthropic `system` (string or text blocks) -> one system message body. */
function anthropicSystem(system: unknown): string {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .map(block => isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : '')
    .filter(text => text !== '')
    .join('\n\n')
}

/** Anthropic tool declaration -> chat-completions function declaration. */
function anthropicTools(tools: unknown): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const mapped: any[] = []
  for (const raw of tools) {
    if (!isRecord(raw) || typeof raw['name'] !== 'string' || raw['name'] === '') continue
    mapped.push({
      type: 'function',
      function: {
        name: raw['name'],
        ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
        parameters: isRecord(raw['input_schema']) ? raw['input_schema'] : { type: 'object', properties: {} },
      },
    })
  }
  return mapped.length > 0 ? mapped : undefined
}

function anthropicToolChoice(choice: unknown): any {
  if (!isRecord(choice)) return undefined
  switch (choice['type']) {
    case 'auto': return 'auto'
    case 'any': return 'required'
    case 'none': return 'none'
    case 'tool': return typeof choice['name'] === 'string'
      ? { type: 'function', function: { name: choice['name'] } }
      : 'auto'
    default: return undefined
  }
}

/**
 * Translate an Anthropic Messages body into a chat-completions body.
 *
 * `max_tokens` is required by Anthropic and optional here; the caller clamps it
 * against the live model catalog afterwards. `output_config.effort` is the
 * current Anthropic spelling of a reasoning level and maps straight onto the
 * upstream `reasoning_effort`.
 */
export function anthropicToChat(body: Record<string, any>): Record<string, any> {
  const messages: any[] = []
  const system = anthropicSystem(body['system'])
  if (system !== '') messages.push({ role: 'system', content: system })
  for (const raw of Array.isArray(body['messages']) ? body['messages'] : []) {
    if (!isRecord(raw)) continue
    const role = raw['role'] === 'assistant' ? 'assistant' : 'user'
    const parts = anthropicContent(raw['content'], role)
    if (role === 'assistant') {
      const message: Record<string, any> = {
        role: 'assistant',
        content: parts.text !== '' ? parts.text : parts.images.length > 0 ? parts.images : null,
      }
      if (parts.reasoning !== '') message['reasoning_content'] = parts.reasoning
      if (parts.toolCalls.length > 0) message['tool_calls'] = parts.toolCalls
      messages.push(message)
      continue
    }
    // Tool results are their own turns and must precede the user's text.
    messages.push(...parts.toolResults)
    if (parts.text !== '' || parts.images.length > 0) {
      const content: any = parts.images.length === 0
        ? parts.text
        : [...(parts.text === '' ? [] : [{ type: 'text', text: parts.text }]), ...parts.images]
      messages.push({ role: 'user', content })
    }
  }

  const output: Record<string, any> = { model: body['model'], messages, stream: body['stream'] === true }
  if (typeof body['max_tokens'] === 'number') output['max_tokens'] = body['max_tokens']
  if (typeof body['temperature'] === 'number') output['temperature'] = body['temperature']
  if (typeof body['top_p'] === 'number') output['top_p'] = body['top_p']
  if (Array.isArray(body['stop_sequences']) && body['stop_sequences'].length > 0) output['stop'] = body['stop_sequences']
  const tools = anthropicTools(body['tools'])
  if (tools !== undefined) output['tools'] = tools
  const toolChoice = anthropicToolChoice(body['tool_choice'])
  if (toolChoice !== undefined) output['tool_choice'] = toolChoice
  if (isRecord(body['metadata']) && typeof body['metadata']['user_id'] === 'string') {
    output['user'] = body['metadata']['user_id']
  }
  const effort = isRecord(body['output_config']) ? body['output_config']['effort'] : undefined
  if (typeof effort === 'string' && effort !== '') output['reasoning_effort'] = effort
  return output
}

/** Every tool-result id present in an Anthropic conversation, in order. */
export function anthropicToolResults(body: Record<string, any>): string[] {
  const ids: string[] = []
  for (const message of Array.isArray(body['messages']) ? body['messages'] : []) {
    if (!isRecord(message) || !Array.isArray(message['content'])) continue
    for (const block of message['content']) {
      if (isRecord(block) && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        ids.push(block['tool_use_id'])
      }
    }
  }
  return ids
}

// ---------------------------------------------------------------------------
// Inbound: OpenAI Responses -> Chat Completions
// ---------------------------------------------------------------------------

function responsesContent(content: unknown): { text: string; images: any[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  const texts: string[] = []
  const images: any[] = []
  for (const raw of Array.isArray(content) ? content : []) {
    if (!isRecord(raw)) continue
    switch (raw['type']) {
      case 'input_text':
      case 'output_text':
      case 'text': {
        if (typeof raw['text'] === 'string') texts.push(raw['text'])
        break
      }
      case 'input_image': {
        const image = raw['image_url']
        const url = typeof image === 'string'
          ? image
          : isRecord(image) && typeof image['url'] === 'string' ? image['url'] : undefined
        if (url !== undefined) images.push({ type: 'image_url', image_url: { url } })
        break
      }
      case 'input_file': {
        texts.push('[file attachment omitted: this bridge forwards images only]')
        break
      }
      case 'refusal': {
        if (typeof raw['refusal'] === 'string') texts.push(raw['refusal'])
        break
      }
      default:
        break
    }
  }
  return { text: texts.join('\n'), images }
}

/**
 * Translate an OpenAI Responses body into a chat-completions body.
 *
 * `input` is either a plain string or a list of items. Assistant turns carry
 * `function_call` items as siblings of the message, and their outputs arrive as
 * `function_call_output` items �?the same split Anthropic makes in reverse.
 * `item_reference` cannot be resolved without server-side storage, so it is
 * dropped; this bridge is deliberately stateless.
 */
export function responsesToChat(body: Record<string, any>): Record<string, any> {
  const messages: any[] = []
  if (typeof body['instructions'] === 'string' && body['instructions'].trim() !== '') {
    messages.push({ role: 'system', content: body['instructions'] })
  }
  const input = body['input']
  const items: any[] = typeof input === 'string' ? [{ role: 'user', content: input }] : Array.isArray(input) ? input : []
  for (const raw of items) {
    if (!isRecord(raw)) continue
    const type = raw['type']
    if (type === 'function_call') {
      const callId = typeof raw['call_id'] === 'string' ? raw['call_id'] : id('call')
      const call = {
        id: callId,
        type: 'function',
        function: {
          name: typeof raw['name'] === 'string' ? raw['name'] : 'tool',
          arguments: typeof raw['arguments'] === 'string' ? raw['arguments'] : '{}',
        },
      }
      const last = messages.at(-1)
      if (isRecord(last) && last['role'] === 'assistant') {
        last['tool_calls'] = [...(Array.isArray(last['tool_calls']) ? last['tool_calls'] : []), call]
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [call] })
      }
      continue
    }
    if (type === 'function_call_output') {
      const callId = typeof raw['call_id'] === 'string' ? raw['call_id'] : ''
      let output = asText(raw['output'])
      if (output === '' && typeof raw['output'] === 'string') output = raw['output']
      if (output === '') output = '(tool returned no text output)'
      messages.push({ role: 'tool', tool_call_id: callId, content: output })
      continue
    }
    if (type === 'reasoning') {
      const summary = Array.isArray(raw['summary'])
        ? raw['summary'].map((part: any) => isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '').join('')
        : ''
      const last = messages.at(-1)
      if (summary !== '' && isRecord(last) && last['role'] === 'assistant') last['reasoning_content'] = summary
      continue
    }
    if (type === 'item_reference') continue
    const role = raw['role']
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') {
      // Unknown item kinds are dropped rather than sent upstream as garbage.
      continue
    }
    const parts = responsesContent(raw['content'])
    const chatRole = role === 'developer' ? 'system' : role
    const content: any = parts.images.length === 0
      ? parts.text
      : [...(parts.text === '' ? [] : [{ type: 'text', text: parts.text }]), ...parts.images]
    if (chatRole === 'assistant') {
      messages.push({ role: 'assistant', content: parts.text !== '' || parts.images.length > 0 ? content : null })
    } else {
      messages.push({ role: chatRole, content })
    }
  }

  const output: Record<string, any> = { model: body['model'], messages, stream: body['stream'] === true }
  if (typeof body['max_output_tokens'] === 'number') output['max_tokens'] = body['max_output_tokens']
  if (typeof body['temperature'] === 'number') output['temperature'] = body['temperature']
  if (typeof body['top_p'] === 'number') output['top_p'] = body['top_p']
  if (isRecord(body['reasoning']) && typeof body['reasoning']['effort'] === 'string' && body['reasoning']['effort'] !== '') {
    output['reasoning_effort'] = body['reasoning']['effort']
  }
  if (isRecord(body['text']) && isRecord(body['text']['format'])) {
    const format = body['text']['format']
    if (format['type'] === 'json_schema' && isRecord(format['schema'])) {
      output['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: typeof format['name'] === 'string' ? format['name'] : 'response',
          schema: format['schema'],
          ...(typeof format['strict'] === 'boolean' ? { strict: format['strict'] } : {}),
        },
      }
    } else if (format['type'] === 'json_object') {
      output['response_format'] = { type: 'json_object' }
    }
  }
  if (Array.isArray(body['tools']) && body['tools'].length > 0) {
    const tools: any[] = []
    for (const raw of body['tools']) {
      if (!isRecord(raw) || raw['type'] !== 'function' || typeof raw['name'] !== 'string') continue
      tools.push({
        type: 'function',
        function: {
          name: raw['name'],
          ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
          parameters: isRecord(raw['parameters']) ? raw['parameters'] : { type: 'object', properties: {} },
          ...(typeof raw['strict'] === 'boolean' ? { strict: raw['strict'] } : {}),
        },
      })
    }
    if (tools.length > 0) output['tools'] = tools
  }
  const choice = body['tool_choice']
  if (typeof choice === 'string') output['tool_choice'] = choice
  else if (isRecord(choice) && choice['type'] === 'function' && typeof choice['name'] === 'string') {
    output['tool_choice'] = { type: 'function', function: { name: choice['name'] } }
  }
  return output
}

// ---------------------------------------------------------------------------
// Outbound: chat-completions -> Anthropic Messages
// ---------------------------------------------------------------------------

function anthropicStopReason(finish: ChatFinish, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_use'
  switch (finish) {
    case 'length': return 'max_tokens'
    case 'content_filter': return 'refusal'
    case 'stop': return 'end_turn'
    default: return finish === null || finish === undefined ? 'end_turn' : 'end_turn'
  }
}

function anthropicUsage(usage: any, fallbackOutput = 0): Record<string, number> {
  const input = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const output = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : fallbackOutput
  const result: Record<string, number> = { input_tokens: input, output_tokens: output }
  const cached = usage?.prompt_tokens_details?.cached_tokens
  if (typeof cached === 'number' && cached > 0) result['cache_read_input_tokens'] = cached
  return result
}

/** Parse a chat.completion `message` into the Anthropic content-block list. */
function anthropicContentBlocks(message: Record<string, any>): any[] {
  const blocks: any[] = []
  if (typeof message['reasoning_content'] === 'string' && message['reasoning_content'] !== '') {
    blocks.push({ type: 'thinking', thinking: message['reasoning_content'], signature: '' })
  }
  if (typeof message['content'] === 'string' && message['content'] !== '') {
    blocks.push({ type: 'text', text: message['content'] })
  }
  for (const call of Array.isArray(message['tool_calls']) ? message['tool_calls'] : []) {
    if (!isRecord(call)) continue
    const fn = isRecord(call['function']) ? call['function'] : {}
    let input: unknown = {}
    if (typeof fn['arguments'] === 'string' && fn['arguments'].trim() !== '') {
      try { input = JSON.parse(fn['arguments']) } catch { input = {} }
    }
    blocks.push({
      type: 'tool_use',
      id: typeof call['id'] === 'string' ? call['id'] : id('toolu'),
      name: typeof fn['name'] === 'string' ? fn['name'] : 'tool',
      input,
    })
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

/** Assemble a complete Anthropic Messages response from a chat.completion. */
export function chatToAnthropicMessage(completion: Record<string, any>, model: string): Record<string, any> {
  const choice = Array.isArray(completion?.['choices']) ? completion['choices'][0] ?? {} : {}
  const message = isRecord(choice['message']) ? choice['message'] : {}
  const blocks = anthropicContentBlocks(message)
  return {
    id: typeof completion?.['id'] === 'string' && completion['id'] !== '' ? completion['id'] : id('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content: blocks,
    stop_reason: anthropicStopReason(choice['finish_reason'], Array.isArray(message['tool_calls']) && message['tool_calls'].length > 0),
    stop_sequence: null,
    usage: anthropicUsage(completion?.['usage']),
  }
}

// ---------------------------------------------------------------------------
// Outbound: chat-completions -> OpenAI Responses
// ---------------------------------------------------------------------------

function responsesStatus(finish: ChatFinish): 'completed' | 'incomplete' {
  return finish === 'length' ? 'incomplete' : 'completed'
}

function responsesUsage(usage: any, fallbackOutput = 0): Record<string, any> {
  const input = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const output = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : fallbackOutput
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: typeof usage?.prompt_tokens_details?.cached_tokens === 'number' ? usage.prompt_tokens_details.cached_tokens : 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: typeof reasoning === 'number' ? reasoning : 0 },
    total_tokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : input + output,
  }
}

/** Assemble a complete Responses object from a chat.completion. */
export function chatToResponsesObject(completion: Record<string, any>, model: string): Record<string, any> {
  const choice = Array.isArray(completion?.['choices']) ? completion['choices'][0] ?? {} : {}
  const message = isRecord(choice['message']) ? choice['message'] : {}
  const output: any[] = []
  if (typeof message['reasoning_content'] === 'string' && message['reasoning_content'] !== '') {
    output.push({
      type: 'reasoning',
      id: id('rs'),
      summary: [{ type: 'summary_text', text: message['reasoning_content'] }],
    })
  }
  if (typeof message['content'] === 'string' && message['content'] !== '') {
    // `annotations` and the item `id` are load-bearing: ZCode's Responses parser
    // rejects output_text parts without annotations and messages without an id.
    output.push({
      type: 'message',
      id: id('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message['content'], annotations: [] }],
    })
  }
  for (const call of Array.isArray(message['tool_calls']) ? message['tool_calls'] : []) {
    if (!isRecord(call)) continue
    const fn = isRecord(call['function']) ? call['function'] : {}
    output.push({
      type: 'function_call',
      id: id('fc'),
      call_id: typeof call['id'] === 'string' ? call['id'] : id('call'),
      name: typeof fn['name'] === 'string' ? fn['name'] : 'tool',
      arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : '{}',
      status: 'completed',
    })
  }
  return {
    id: id('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: responsesStatus(choice['finish_reason']),
    ...(choice['finish_reason'] === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    model,
    output,
    usage: responsesUsage(completion?.['usage']),
  }
}

// ---------------------------------------------------------------------------
// Streaming emitters
// ---------------------------------------------------------------------------

/** Writes one protocol frame; resolves once the socket can take more. */
export type FrameWriter = (frame: string) => Promise<void>

interface ToolCallState {
  index: number
  id: string
  name: string
  arguments: string
  started: boolean
}

/**
 * Anthropic's event sequence requires strictly nested content blocks:
 * `content_block_start` -> deltas -> `content_block_stop`, one at a time.
 * Parallel tool calls therefore cannot be relayed as they arrive; they are
 * buffered and flushed sequentially after the active block closes.
 */
export class AnthropicStreamEncoder {
  private readonly emit: FrameWriter
  private readonly model: string
  private readonly messageId = id('msg')
  private blockIndex = -1
  private open: 'text' | 'thinking' | 'tool_use' | null = null
  private activeTool: number | null = null
  private text = ''
  private reasoning = ''
  private readonly tools = new Map<number, ToolCallState>()
  private readonly buffered: number[] = []
  private finishReason: string | null = null
  private usage: any
  private completed = false

  constructor(emit: FrameWriter, model: string) {
    this.emit = emit
    this.model = model
  }

  private async frame(type: string, data: Record<string, any>): Promise<void> {
    await this.emit(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  }

  async start(): Promise<void> {
    await this.frame('message_start', {
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  private async openBlock(kind: 'text' | 'thinking'): Promise<void> {
    if (this.open === kind) return
    await this.closeBlock()
    this.blockIndex += 1
    this.open = kind
    if (kind === 'text') {
      await this.frame('content_block_start', { index: this.blockIndex, content_block: { type: 'text', text: '' } })
    } else {
      await this.frame('content_block_start', { index: this.blockIndex, content_block: { type: 'thinking', thinking: '', signature: '' } })
    }
  }

  private async closeBlock(): Promise<void> {
    if (this.open === null) return
    await this.frame('content_block_stop', { index: this.blockIndex })
    this.open = null
    this.activeTool = null
  }

  private toolState(delta: Record<string, any>): ToolCallState {
    const index = typeof delta['index'] === 'number' ? delta['index'] : 0
    let state = this.tools.get(index)
    if (state === undefined) {
      state = { index, id: '', name: '', arguments: '', started: false }
      this.tools.set(index, state)
    }
    const fn = isRecord(delta['function']) ? delta['function'] : {}
    if (typeof delta['id'] === 'string' && delta['id'] !== '') state.id = delta['id']
    if (typeof fn['name'] === 'string') state.name += fn['name']
    return state
  }

  private async startTool(state: ToolCallState): Promise<void> {
    await this.closeBlock()
    this.blockIndex += 1
    this.open = 'tool_use'
    this.activeTool = state.index
    state.started = true
    if (state.id === '') state.id = id('toolu')
    await this.frame('content_block_start', {
      index: this.blockIndex,
      content_block: { type: 'tool_use', id: state.id, name: state.name === '' ? 'tool' : state.name, input: {} },
    })
  }

  async push(chunk: Record<string, any>): Promise<void> {
    if (isRecord(chunk['usage'])) this.usage = chunk['usage']
    const choice = Array.isArray(chunk['choices']) ? chunk['choices'][0] : undefined
    if (!isRecord(choice)) return
    const delta = isRecord(choice['delta']) ? choice['delta'] : {}
    if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content'] !== '') {
      await this.openBlock('thinking')
      this.reasoning += delta['reasoning_content']
      await this.frame('content_block_delta', { index: this.blockIndex, delta: { type: 'thinking_delta', thinking: delta['reasoning_content'] } })
    }
    if (typeof delta['content'] === 'string' && delta['content'] !== '') {
      await this.openBlock('text')
      this.text += delta['content']
      await this.frame('content_block_delta', { index: this.blockIndex, delta: { type: 'text_delta', text: delta['content'] } })
    }
    for (const raw of Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []) {
      if (!isRecord(raw)) continue
      const state = this.toolState(raw)
      const fn = isRecord(raw['function']) ? raw['function'] : {}
      const fragment = typeof fn['arguments'] === 'string' ? fn['arguments'] : ''
      if (!state.started) {
        // A second call arriving while the first is still streaming has to
        // wait: Anthropic blocks cannot overlap. Its fragments accumulate and
        // are replayed in one delta once the active block closes.
        if (this.activeTool !== null && this.activeTool !== state.index) {
          state.arguments += fragment
          if (!this.buffered.includes(state.index)) this.buffered.push(state.index)
          continue
        }
        // A nameless tool_use is not addressable by any client, so keep
        // collecting until the opening fragment names it.
        if (state.name === '') {
          state.arguments += fragment
          if (!this.buffered.includes(state.index)) this.buffered.push(state.index)
          continue
        }
        await this.startTool(state)
        const pending = state.arguments + fragment
        state.arguments = ''
        if (pending !== '') {
          await this.frame('content_block_delta', { index: this.blockIndex, delta: { type: 'input_json_delta', partial_json: pending } })
        }
        continue
      }
      if (this.activeTool !== state.index) {
        state.arguments += fragment
        if (!this.buffered.includes(state.index)) this.buffered.push(state.index)
        continue
      }
      if (fragment !== '') {
        state.arguments += fragment
        await this.frame('content_block_delta', { index: this.blockIndex, delta: { type: 'input_json_delta', partial_json: fragment } })
      }
    }
    if (typeof choice['finish_reason'] === 'string') this.finishReason = choice['finish_reason']
  }

  private async flushBuffered(): Promise<void> {
    const pending = [...new Set(this.buffered)]
    this.buffered.length = 0
    for (const index of pending) {
      const state = this.tools.get(index)
      if (state === undefined || state.started) continue
      await this.startTool(state)
      if (state.arguments !== '') {
        await this.frame('content_block_delta', { index: this.blockIndex, delta: { type: 'input_json_delta', partial_json: state.arguments } })
        state.arguments = ''
      }
      await this.closeBlock()
    }
  }

  async finish(): Promise<void> {
    if (this.completed) return
    this.completed = true
    await this.closeBlock()
    await this.flushBuffered()
    const hasTools = [...this.tools.values()].some(state => state.started)
    await this.frame('message_delta', {
      delta: {
        stop_reason: anthropicStopReason(this.finishReason, hasTools),
        stop_sequence: null,
      },
      usage: anthropicUsage(this.usage, 0),
    })
    await this.frame('message_stop', {})
  }

  async fail(message: string): Promise<void> {
    if (this.completed) return
    this.completed = true
    await this.frame('error', { error: { type: 'api_error', message } })
  }
}

/**
 * OpenAI Responses event sequence. Unlike Anthropic, items are addressed by
 * `output_index` + `item_id` and may be emitted as they start; parallel tool
 * calls are still buffered for the same reason (a chat delta carries no
 * per-call "started" marker beyond the first fragment).
 */
export class ResponsesStreamEncoder {
  private readonly emit: FrameWriter
  private readonly model: string
  private readonly responseId = id('resp')
  private readonly createdAt = Math.floor(Date.now() / 1000)
  private nextOutputIndex = 0
  /** The text/reasoning item currently accepting deltas. */
  private open: { kind: 'text' | 'reasoning'; index: number; itemId: string; text: string } | null = null
  /** The tool item currently accepting argument deltas. */
  private activeTool: number | null = null
  /**
   * Every item that reached `output_item.done`, in creation order. The final
   * response reuses these exact objects: regenerating ids here would leave the
   * streamed deltas pointing at items the terminal response does not contain.
   */
  private readonly outputItems: any[] = []
  private readonly tools = new Map<number, ToolCallState>()
  private readonly toolOrder: number[] = []
  private readonly buffered: number[] = []
  private readonly toolOutputIndex = new Map<number, number>()
  private readonly toolItemId = new Map<number, string>()
  private finishReason: string | null = null
  private usage: any
  private completed = false

  constructor(emit: FrameWriter, model: string) {
    this.emit = emit
    this.model = model
  }

  private async frame(type: string, data: Record<string, any>): Promise<void> {
    await this.emit(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  }

  async start(): Promise<void> {
    await this.frame('response.created', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'in_progress',
        model: this.model,
        output: [],
      },
    })
  }

  private async openItem(kind: 'text' | 'reasoning'): Promise<void> {
    if (this.open?.kind === kind) return
    // A tool cannot stay open while a text item starts; its done frames have to
    // land before the next item is announced.
    await this.closeActiveTool()
    await this.closeOpen()
    const index = this.nextOutputIndex++
    const itemId = kind === 'text' ? id('msg') : id('rs')
    this.open = { kind, index, itemId, text: '' }
    if (kind === 'reasoning') {
      await this.frame('response.output_item.added', {
        output_index: index,
        item: { type: 'reasoning', id: itemId, summary: [] },
      })
      await this.frame('response.reasoning_summary_part.added', {
        item_id: itemId, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' },
      })
      return
    }
    await this.frame('response.output_item.added', {
      output_index: index,
      item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
    })
    await this.frame('response.content_part.added', {
      item_id: itemId, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
    })
  }

  private async closeOpen(): Promise<void> {
    const open = this.open
    if (open === null) return
    this.open = null
    if (open.kind === 'reasoning') {
      await this.frame('response.reasoning_summary_text.done', {
        item_id: open.itemId, output_index: open.index, summary_index: 0, text: open.text,
      })
      await this.frame('response.reasoning_summary_part.done', {
        item_id: open.itemId, output_index: open.index, summary_index: 0,
      })
      const item = { type: 'reasoning', id: open.itemId, summary: [{ type: 'summary_text', text: open.text }] }
      this.outputItems.push(item)
      await this.frame('response.output_item.done', { output_index: open.index, item })
      return
    }
    await this.frame('response.output_text.done', {
      item_id: open.itemId, output_index: open.index, content_index: 0, text: open.text,
    })
    await this.frame('response.content_part.done', {
      item_id: open.itemId, output_index: open.index, content_index: 0,
      part: { type: 'output_text', text: open.text, annotations: [] },
    })
    const item = {
      type: 'message', id: open.itemId, status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: open.text, annotations: [] }],
    }
    this.outputItems.push(item)
    await this.frame('response.output_item.done', { output_index: open.index, item })
  }

  private toolState(delta: Record<string, any>): ToolCallState {
    const index = typeof delta['index'] === 'number' ? delta['index'] : 0
    let state = this.tools.get(index)
    if (state === undefined) {
      state = { index, id: '', name: '', arguments: '', started: false }
      this.tools.set(index, state)
      this.toolOrder.push(index)
    }
    const fn = isRecord(delta['function']) ? delta['function'] : {}
    if (typeof delta['id'] === 'string' && delta['id'] !== '') state.id = delta['id']
    if (typeof fn['name'] === 'string') state.name += fn['name']
    return state
  }

  private async startTool(state: ToolCallState): Promise<void> {
    await this.closeOpen()
    const index = this.nextOutputIndex++
    state.started = true
    this.activeTool = state.index
    if (state.id === '') state.id = id('call')
    const itemId = id('fc')
    // The item id and output index are reused by every later frame for this
    // call; regenerating either would orphan the deltas.
    this.toolOutputIndex.set(state.index, index)
    this.toolItemId.set(state.index, itemId)
    await this.frame('response.output_item.added', {
      output_index: index,
      item: {
        type: 'function_call', id: itemId, call_id: state.id,
        name: state.name === '' ? 'tool' : state.name, arguments: '', status: 'in_progress',
      },
    })
  }

  /** Emit the argument fragment for the active tool, if this delta belongs to it. */
  private async deltaTool(state: ToolCallState, fragment: string): Promise<void> {
    if (fragment === '') return
    state.arguments += fragment
    await this.frame('response.function_call_arguments.delta', {
      item_id: this.toolItemId.get(state.index),
      output_index: this.toolOutputIndex.get(state.index),
      delta: fragment,
    })
  }

  async push(chunk: Record<string, any>): Promise<void> {
    if (isRecord(chunk['usage'])) this.usage = chunk['usage']
    const choice = Array.isArray(chunk['choices']) ? chunk['choices'][0] : undefined
    if (!isRecord(choice)) return
    const delta = isRecord(choice['delta']) ? choice['delta'] : {}
    if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content'] !== '') {
      await this.openItem('reasoning')
      const open = this.open!
      open.text += delta['reasoning_content']
      await this.frame('response.reasoning_summary_text.delta', {
        item_id: open.itemId, output_index: open.index, summary_index: 0, delta: delta['reasoning_content'],
      })
    }
    if (typeof delta['content'] === 'string' && delta['content'] !== '') {
      await this.openItem('text')
      const open = this.open!
      open.text += delta['content']
      await this.frame('response.output_text.delta', {
        item_id: open.itemId, output_index: open.index, content_index: 0, delta: delta['content'],
      })
    }
    for (const raw of Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []) {
      if (!isRecord(raw)) continue
      const state = this.toolState(raw)
      const fn = isRecord(raw['function']) ? raw['function'] : {}
      const fragment = typeof fn['arguments'] === 'string' ? fn['arguments'] : ''
      if (!state.started) {
        // Same rule as Anthropic: a second call waits until the first finishes,
        // because only one item may be open at a time.
        if (this.activeTool !== null && this.activeTool !== state.index) {
          state.arguments += fragment
          if (!this.buffered.includes(state.index)) this.buffered.push(state.index)
          continue
        }
        if (state.name === '') {
          state.arguments += fragment
          if (!this.buffered.includes(state.index)) this.buffered.push(state.index)
          continue
        }
        await this.startTool(state)
        const pending = state.arguments + fragment
        state.arguments = ''
        await this.deltaTool(state, pending)
        continue
      }
      if (this.activeTool !== state.index) {
        state.arguments += fragment
        if (!this.buffered.includes(state.index)) this.buffered.push(state.index)
        continue
      }
      await this.deltaTool(state, fragment)
    }
    if (typeof choice['finish_reason'] === 'string') this.finishReason = choice['finish_reason']
  }

  /** Close the active tool item with its full argument string. */
  private async closeTool(state: ToolCallState): Promise<void> {
    const outputIndex = this.toolOutputIndex.get(state.index)
    const itemId = this.toolItemId.get(state.index)
    if (outputIndex === undefined || itemId === undefined) return
    await this.frame('response.function_call_arguments.done', {
      item_id: itemId, output_index: outputIndex, arguments: state.arguments,
    })
    const item = {
      type: 'function_call', id: itemId, call_id: state.id,
      name: state.name === '' ? 'tool' : state.name, arguments: state.arguments, status: 'completed',
    }
    this.outputItems.push(item)
    await this.frame('response.output_item.done', { output_index: outputIndex, item })
  }

  private async closeActiveTool(): Promise<void> {
    if (this.activeTool === null) return
    const state = this.tools.get(this.activeTool)
    this.activeTool = null
    if (state !== undefined && state.started) await this.closeTool(state)
  }

  private async flushBuffered(): Promise<void> {
    const pending = [...new Set(this.buffered)]
    this.buffered.length = 0
    for (const index of pending) {
      const state = this.tools.get(index)
      if (state === undefined || state.started) continue
      await this.startTool(state)
      await this.deltaTool(state, state.arguments)
      state.arguments = ''
      await this.closeActiveTool()
    }
  }

  async finish(): Promise<void> {
    if (this.completed) return
    this.completed = true
    await this.closeActiveTool()
    await this.closeOpen()
    await this.flushBuffered()
    const status = responsesStatus(this.finishReason)
    await this.frame(status === 'completed' ? 'response.completed' : 'response.incomplete', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status,
        ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        model: this.model,
        output: this.outputItems,
        usage: responsesUsage(this.usage),
      },
    })
  }

  async fail(message: string): Promise<void> {
    if (this.completed) return
    this.completed = true
    await this.frame('response.failed', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'failed',
        model: this.model,
        error: { code: 'server_error', message },
      },
    })
  }
}

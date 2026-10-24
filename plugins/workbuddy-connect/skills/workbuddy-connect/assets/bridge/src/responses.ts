/**
 * OpenAI Responses adapter — the bridge's only protocol.
 *
 * WorkBuddy upstream speaks OpenAI Chat Completions, so Responses is translated
 * in both directions here: the inbound request body is rewritten into a
 * chat-completions body, and the upstream chunk stream is re-encoded into
 * Responses events. Keeping both directions in one module makes the round trip
 * auditable: every field the inbound side reads has exactly one outbound
 * counterpart.
 *
 * Reference point: ZCode drives its providers through the Vercel AI SDK, and
 * Codex CLI writes the same wire format, so the emitters follow that parser
 * rather than a generic reading of the spec — see the notes at each event family.
 *
 * Why Responses and not Chat Completions: Codex CLI and the ChatGPT desktop app
 * only accept `wire_api = "responses"` (newer builds reject `"chat"` outright),
 * and ZCode supports `api.type = "openai-responses"` too. One protocol that both
 * clients can use beats a "more universal" one that one of them cannot.
 */

import { randomUUID } from 'node:crypto'

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
 * `function_call_output` items. `item_reference` cannot be resolved without
 * server-side storage, so it is dropped; this bridge is deliberately stateless.
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
// Streaming emitter
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
 * OpenAI Responses event sequence. Items are addressed by `output_index` +
 * `item_id` and may be emitted as they start; parallel tool calls are still
 * buffered, because a chat delta carries no per-call "started" marker beyond
 * the first fragment and only one item may be open at a time.
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
        // Only one item may be open at a time, so a second call waits until the
        // first finishes and is replayed with its full argument string.
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

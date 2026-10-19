import test from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicToChat, anthropicToolResults, chatToAnthropicMessage,
  responsesToChat, chatToResponsesObject,
  AnthropicStreamEncoder, ResponsesStreamEncoder,
} from '../src/protocols.ts'

const frames = () => {
  const out: string[] = []
  return { out, write: async (frame: string) => { out.push(frame) } }
}

/** Parse SSE frames into `[event, payload]` pairs. */
function parse(out: string[]): Array<[string, any]> {
  return out.map(frame => {
    const lines = frame.split('\n')
    const event = lines.find(line => line.startsWith('event: '))?.slice(7) ?? ''
    const data = lines.find(line => line.startsWith('data: '))?.slice(6) ?? '{}'
    return [event, JSON.parse(data)]
  })
}

// --- inbound translation ---------------------------------------------------

test('anthropic messages map system, images, tools and tool results', () => {
  const chat = anthropicToChat({
    model: 'm', max_tokens: 100, temperature: 0.2, top_p: 0.9, stop_sequences: ['x'],
    system: [{ type: 'text', text: 'be brief' }, { type: 'text', text: 'and kind' }],
    output_config: { effort: 'high' },
    metadata: { user_id: 'u1' },
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      ] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'file body' }] }] },
    ],
    tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'read' },
  })
  assert.equal(chat['max_tokens'], 100)
  assert.equal(chat['effort'], undefined, 'Anthropic effort is not a chat field')
  assert.equal(chat['reasoning_effort'], 'high')
  assert.deepEqual(chat['stop'], ['x'])
  assert.equal(chat['user'], 'u1')
  assert.deepEqual(chat['messages'][0], { role: 'system', content: 'be brief\n\nand kind' })
  const [user1, assistant, tool, user2] = chat['messages'].slice(1)
  assert.equal(user1.role, 'user')
  assert.equal(user1.content[0].text, 'look')
  assert.equal(user1.content[1].image_url.url, 'data:image/png;base64,AAA')
  assert.equal(assistant.reasoning_content, 'hmm')
  assert.equal(assistant.content, 'checking')
  assert.deepEqual(assistant.tool_calls, [{ id: 'toolu_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }])
  // A tool result becomes its own turn, ahead of any user text.
  assert.deepEqual(tool, { role: 'tool', tool_call_id: 'toolu_1', content: 'file body' })
  assert.equal(user2, undefined)
  assert.equal(chat['tools'][0].function.name, 'read')
  assert.deepEqual(chat['tool_choice'], { type: 'function', function: { name: 'read' } })
  assert.deepEqual(anthropicToolResults({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] }] }), ['toolu_1'])
})

test('anthropic tool_choice spellings collapse onto chat equivalents', () => {
  const choice = (value: any) => anthropicToChat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tool_choice: value })['tool_choice']
  assert.equal(choice({ type: 'auto' }), 'auto')
  assert.equal(choice({ type: 'any' }), 'required')
  assert.equal(choice({ type: 'none' }), 'none')
  assert.equal(choice({ type: 'tool' }), 'auto', 'a nameless tool choice degrades to auto')
})

test('anthropic string content and error tool results survive the rewrite', () => {
  const chat = anthropicToChat({
    model: 'm',
    messages: [{ role: 'user', content: 'plain string' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }] }],
  })
  assert.deepEqual(chat['messages'][0], { role: 'user', content: 'plain string' })
  assert.deepEqual(chat['messages'][1], { role: 'tool', tool_call_id: 't', content: 'Error: boom' })
})

test('responses input maps instructions, images, function calls and outputs', () => {
  const chat = responsesToChat({
    model: 'm', max_output_tokens: 42, instructions: 'stay short',
    reasoning: { effort: 'medium' },
    text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } },
    tools: [{ type: 'function', name: 'search', parameters: { type: 'object' }, strict: false }],
    tool_choice: { type: 'function', name: 'search' },
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'find it' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,BBB' }] },
      { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'found' },
    ],
  })
  assert.deepEqual(chat['messages'][0], { role: 'system', content: 'stay short' })
  assert.equal(chat['max_tokens'], 42)
  assert.equal(chat['reasoning_effort'], 'medium')
  assert.equal(chat['tools'][0].function.name, 'search')
  assert.deepEqual(chat['tool_choice'], { type: 'function', function: { name: 'search' } })
  assert.equal(chat['response_format'].json_schema.name, 'answer')
  const user = chat['messages'][1]
  assert.equal(user.content[1].image_url.url, 'data:image/jpeg;base64,BBB')
  assert.deepEqual(chat['messages'][2], {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
  })
  assert.deepEqual(chat['messages'][3], { role: 'tool', tool_call_id: 'call_1', content: 'found' })
})

test('responses string input and unknown items are handled without crashing', () => {
  const chat = responsesToChat({ model: 'm', input: 'hello' })
  assert.deepEqual(chat['messages'], [{ role: 'user', content: 'hello' }])
  const dropped = responsesToChat({ model: 'm', input: [{ type: 'item_reference', id: 'x' }, { role: 'user', content: 'kept' }] })
  assert.deepEqual(dropped['messages'], [{ role: 'user', content: 'kept' }])
  // developer instructions become system, matching what the upstream accepts.
  const dev = responsesToChat({ model: 'm', input: [{ role: 'developer', content: 'rule' }] })
  assert.deepEqual(dev['messages'], [{ role: 'system', content: 'rule' }])
})

// --- non-streaming responses ----------------------------------------------

const completion = {
  id: 'chat-1',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: 'hello',
      reasoning_content: 'thought',
      tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'run', arguments: '{"a":1}' } }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } },
}

test('chat completions assemble into an anthropic message', () => {
  const message = chatToAnthropicMessage(completion, 'm')
  assert.equal(message.type, 'message')
  assert.equal(message.role, 'assistant')
  assert.equal(message.model, 'm')
  assert.equal(message.stop_reason, 'tool_use')
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: 'thought', signature: '' },
    { type: 'text', text: 'hello' },
    { type: 'tool_use', id: 'call_9', name: 'run', input: { a: 1 } },
  ])
  assert.deepEqual(message.usage, { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 })
})

test('chat completions assemble into a responses object', () => {
  const response = chatToResponsesObject(completion, 'm')
  assert.equal(response.object, 'response')
  assert.equal(response.status, 'completed')
  assert.equal(response.output[0].type, 'reasoning')
  assert.equal(response.output[0].summary[0].text, 'thought')
  assert.equal(response.output[1].type, 'message')
  // ZCode's parser requires annotations on every output_text part and an id on
  // every message item; missing either rejects the whole response.
  assert.deepEqual(response.output[1].content, [{ type: 'output_text', text: 'hello', annotations: [] }])
  assert.equal(typeof response.output[1].id, 'string')
  assert.deepEqual(response.output[2], {
    type: 'function_call', id: response.output[2].id, call_id: 'call_9', name: 'run', arguments: '{"a":1}', status: 'completed',
  })
  assert.equal(response.usage.output_tokens_details.reasoning_tokens, 3)
})

test('a length finish reports max_tokens / incomplete', () => {
  const truncated = { choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }
  assert.equal(chatToAnthropicMessage(truncated, 'm').stop_reason, 'max_tokens')
  assert.equal(chatToResponsesObject(truncated, 'm').status, 'incomplete')
})

// --- streaming ------------------------------------------------------------

const textChunks = [
  { choices: [{ index: 0, delta: { reasoning_content: 'hm' } }] },
  { choices: [{ index: 0, delta: { content: 'Hel' } }] },
  { choices: [{ index: 0, delta: { content: 'lo' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } },
]

test('anthropic stream nests blocks and closes with stop_reason', async () => {
  const sink = frames()
  const encoder = new AnthropicStreamEncoder(sink.write, 'm')
  await encoder.start()
  for (const chunk of textChunks) await encoder.push(chunk)
  await encoder.finish()
  const events = parse(sink.out)
  const names = events.map(([name]) => name)
  assert.deepEqual(names, [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ])
  assert.equal(events[1][1].content_block.type, 'thinking')
  assert.equal(events[3][1].content_block_stop ?? events[3][0], 'content_block_stop')
  assert.equal(events[4][1].content_block.type, 'text')
  assert.equal(events[8][1].delta.stop_reason, 'end_turn')
  assert.equal(events[8][1].usage.output_tokens, 2)
})

test('anthropic stream serializes parallel tool calls instead of interleaving them', async () => {
  const sink = frames()
  const encoder = new AnthropicStreamEncoder(sink.write, 'm')
  await encoder.start()
  await encoder.push({ choices: [{ index: 0, delta: { tool_calls: [
    { index: 0, id: 'a', function: { name: 'one', arguments: '{"x":' } },
    { index: 1, id: 'b', function: { name: 'two', arguments: '{"y":' } },
  ] } }] })
  await encoder.push({ choices: [{ index: 0, delta: { tool_calls: [
    { index: 0, function: { arguments: '1}' } },
    { index: 1, function: { arguments: '2}' } },
  ] } }] })
  await encoder.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  await encoder.finish()
  const events = parse(sink.out)
  // Blocks must rise and fall monotonically: no start before the previous stop.
  let open: number | null = null
  for (const [name, data] of events) {
    if (name === 'content_block_start') { assert.equal(open, null, 'a block was still open'); open = data.index }
    if (name === 'content_block_stop') { assert.equal(open, data.index); open = null }
  }
  assert.equal(open, null)
  const starts = events.filter(([name]) => name === 'content_block_start').map(([, data]) => data)
  assert.equal(starts.length, 2)
  assert.deepEqual(starts.map(block => block.content_block.name), ['one', 'two'])
  // The active call streams fragment-by-fragment; the buffered one is replayed
  // as a single delta. What matters is that each block's fragments concatenate
  // to that call's complete argument object.
  const byBlock = new Map<number, string>()
  for (const [name, data] of events) {
    if (name !== 'content_block_delta') continue
    byBlock.set(data.index, (byBlock.get(data.index) ?? '') + data.delta.partial_json)
  }
  assert.deepEqual([...byBlock.values()], ['{"x":1}', '{"y":2}'])
  assert.equal(events.at(-2)![1].delta.stop_reason, 'tool_use')
})

test('responses stream emits matching item ids and closes with a completed response', async () => {
  const sink = frames()
  const encoder = new ResponsesStreamEncoder(sink.write, 'm')
  await encoder.start()
  for (const chunk of textChunks) await encoder.push(chunk)
  await encoder.finish()
  const events = parse(sink.out)
  const names = events.map(([name]) => name)
  assert.deepEqual(names, [
    'response.created',
    'response.output_item.added', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done',
    'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.delta',
    'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
    'response.completed',
  ])
  const created = events[0][1].response
  const completed = events.at(-1)![1].response
  assert.equal(created.id, completed.id, 'the terminal event names the same response')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.usage.output_tokens, 2)
  // Every delta must address the item opened right above it.
  const idByName = new Map(events.map(([name, data]) => [name, data]))
  assert.equal(idByName.get('response.output_text.delta')!.item_id, completed.output[1].id)
  assert.equal(completed.output[1].content[0].text, 'Hello')
})

test('responses stream closes tool items with their full arguments', async () => {
  const sink = frames()
  const encoder = new ResponsesStreamEncoder(sink.write, 'm')
  await encoder.start()
  await encoder.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'go', arguments: '{"a"' } }] } }] })
  await encoder.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] })
  await encoder.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  await encoder.finish()
  const events = parse(sink.out)
  const done = events.filter(([name, data]) => name === 'response.output_item.done' && data.item.type === 'function_call')
  assert.equal(done.length, 1)
  assert.equal(done[0][1].item.arguments, '{"a":1}')
  assert.equal(done[0][1].item.call_id, 'c1')
  const completed = events.at(-1)![1].response
  assert.equal(completed.output[0].type, 'function_call')
  assert.equal(completed.output[0].arguments, '{"a":1}')
})

test('a failed stream reports a protocol-native terminal error', async () => {
  const anthropic = frames()
  const a = new AnthropicStreamEncoder(anthropic.write, 'm')
  await a.start()
  await a.fail('boom')
  assert.equal(parse(anthropic.out).at(-1)![0], 'error')
  assert.equal(parse(anthropic.out).at(-1)![1].error.type, 'api_error')

  const responses = frames()
  const r = new ResponsesStreamEncoder(responses.write, 'm')
  await r.start()
  await r.fail('boom')
  const last = parse(responses.out).at(-1)!
  assert.equal(last[0], 'response.failed')
  assert.equal(last[1].response.status, 'failed')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createBridge } from '../src/server.ts'
import { prepareChatBody, regionOf } from '../src/upstream.ts'
import { packageVersion } from '../src/version.ts'

const token = 'test-local-token-abcdefghijklmnopqrstuvwxyz'
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const model = { id: 'sample', name: 'Sample', contextWindow: 128000, maxTokens: 1024, supportsImages: false }
const stores = Object.fromEntries(['cn', 'global'].map(region => [region, {
  async resolve() { return { domain: region, uid: region } },
  async current() { return { domain: region, uid: region } },
  async status() { return { state: 'signed-in', domain: region } },
}])) as any
function sse(chunks: any[], done = true) {
  const text = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    // Splits UTF-8 and SSE markers to exercise real network fragmentation.
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
const textChunks = [
  { id: 'chat-1', model: 'sample', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] },
  { id: 'chat-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
]
async function fixture(t: any, chatStream?: any, catalog: any[] = [model]) {
  const seen: any[] = []
  const bridge = createBridge({ port: 0, token, stores, client: {
    async fetchModels(c) { seen.push({ catalogRegion: c.domain }); return catalog },
    async fetchCredits() { return { total: 0, accounts: [] } },
    chatStream: chatStream ?? (async (c, body, signal) => {
      assert.equal(signal.aborted, false, 'a fully read request must not abort upstream')
      seen.push({ region: c.domain, body: JSON.parse(body) })
      return { ok: true, response: sse(textChunks) }
    }),
  } })
  const url = await bridge.listen()
  t.after(() => bridge.close())
  return { url, seen }
}

/** Collect the output_text of a complete Responses object. */
function outputText(body: any): string {
  const parts: string[] = []
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) if (part?.type === 'output_text') parts.push(part.text)
  }
  return parts.join('')
}

test('separate regions, authentication, browser origin gate and model metadata', async t => {
  const { url, seen } = await fixture(t)
  assert.equal((await fetch(`${url}/healthz`)).status, 401)
  assert.equal((await fetch(`${url}/healthz`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403)
  for (const region of ['cn', 'global']) {
    const r = await fetch(`${url}/${region}/v1/models`, { headers })
    const data = await r.json()
    assert.equal(r.status, 200)
    assert.equal(data.data[0].owned_by, `workbuddy-${region}`)
    assert.equal(data.data[0].context_length, 128000)
  }
  assert.deepEqual(seen, [{ catalogRegion: 'cn' }, { catalogRegion: 'global' }])
})

test('nonstream request aggregates fragmented SSE and forwards tools as functions', async t => {
  const { url, seen } = await fixture(t)
  const response = await fetch(`${url}/global/v1/responses`, { method: 'POST', headers, body: JSON.stringify({
    model: 'sample',
    instructions: 'be brief',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'ping' }] },
    ],
    max_output_tokens: 12,
    reasoning: { effort: 'ultra' },
    tools: [{ type: 'function', name: 'foo', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'foo' },
  }) })
  assert.equal(response.status, 200)
  const answer = await response.json()
  assert.equal(answer.object, 'response')
  assert.equal(answer.status, 'completed')
  assert.equal(outputText(answer), '你好')
  assert.equal(answer.usage.total_tokens, 4)

  const sent = seen.find(row => row.body)
  assert.equal(sent.region, 'global')
  assert.equal(sent.body.messages[0].role, 'system')
  assert.equal(sent.body.messages[0].content, 'be brief')
  assert.equal(sent.body.messages[1].content, 'ping')
  // prepareChatBody normalises a function tool_choice to its bare name upstream.
  assert.equal(sent.body.tool_choice, 'foo')
  assert.equal(sent.body.tools[0].function.name, 'foo')
  assert.equal(sent.body.stream, true)
  assert.equal(sent.body.max_tokens, 12)
  assert.equal(sent.body.reasoning_effort, undefined, 'an undeclared effort is not forwarded')
})

test('streaming re-encodes chat chunks into Responses events and preserves tool arguments', async t => {
  const chunks = [
    { id: 'chat-tools', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'test', arguments: '{"x":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] },
  ]
  const { url } = await fixture(t, async () => ({ ok: true, response: sse(chunks) }))
  const res = await fetch(`${url}/cn/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'sample', input: 'test', stream: true }) })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  const text = await res.text()
  assert.match(text, /event: response\.created/)
  assert.match(text, /event: response\.output_item\.added/)
  assert.match(text, /event: response\.function_call_arguments\.delta/)
  assert.match(text, /call-1/)
  assert.match(text, /event: response\.completed/)
  assert.doesNotMatch(text, /data: \[DONE\]/, 'chat sentinels must not leak into a Responses stream')
})

test('a nonstream tool call comes back as a function_call item', async t => {
  const chunks = [
    { id: 'chat-tools', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'test', arguments: '{"x":1}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]
  const { url } = await fixture(t, async () => ({ ok: true, response: sse(chunks) }))
  const res = await fetch(`${url}/cn/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'sample', input: 'test' }) })
  const body = await res.json()
  const call = body.output.find((item: any) => item.type === 'function_call')
  assert.equal(call.call_id, 'call-1')
  assert.equal(call.name, 'test')
  assert.equal(call.arguments, '{"x":1}')
  assert.equal(call.status, 'completed')
})

test('global user-first input receives the required system prefix', async t => {
  const { url, seen } = await fixture(t)
  const response = await fetch(`${url}/global/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'sample', input: 'ping' }) })
  assert.equal(response.status, 200)
  await response.json()
  const body = seen.find(row => row.body).body
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].content, 'ping')
})

test('truncated streams cannot report a successful completion', async t => {
  const { url } = await fixture(t, async () => ({ ok: true, response: sse(textChunks.slice(0, 1), false) }))
  for (const stream of [false, true]) {
    const res = await fetch(`${url}/cn/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'sample', input: 'test', stream }) })
    if (!stream) assert.equal(res.status, 502)
    else {
      const text = await res.text()
      assert.match(text, /response\.failed/)
      assert.doesNotMatch(text, /response\.completed/)
    }
  }
})

test('reject unsupported image input before generating and map upstream credit errors', async t => {
  let calls = 0
  const { url } = await fixture(t, async () => { calls++; return { ok: false, status: 402, kind: 'hard_credit', message: 'private upstream body' } })
  const image = await fetch(`${url}/cn/v1/responses`, { method: 'POST', headers, body: JSON.stringify({
    model: 'sample',
    input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,x' }] }],
  }) })
  assert.equal(image.status, 400)
  assert.equal(calls, 0)
  const credit = await fetch(`${url}/cn/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'sample', input: 'test' }) })
  assert.equal(credit.status, 402)
  assert.doesNotMatch(await credit.text(), /private upstream body/)
})

test('normalization retains tool results and reasoning history; domains select independently', () => {
  const body = { model: 'sample', messages: [{ role: 'assistant', content: null, reasoning_content: 'reason', tool_calls: [{ id: 'call' }] }, { role: 'tool', tool_call_id: 'call', content: 'result' }], tool_choice: 'none', tools: [{}] }
  const out = JSON.parse(prepareChatBody(JSON.stringify(body)))
  assert.deepEqual(out.messages, body.messages)
  assert.equal(out.tools, undefined)
  assert.equal(regionOf('www.workbuddy.ai'), 'global')
  assert.equal(regionOf('www.codebuddy.cn'), 'cn')
})

test('healthz reports the package version instead of a hardcoded one', async t => {
  const { url } = await fixture(t)
  const body = await (await fetch(`${url}/healthz`, { headers })).json()
  assert.equal(body.service, 'workbuddy-connect')
  assert.equal(body.version, packageVersion())
})

test('duplicate images are collapsed before reaching upstream and counted in /status', async t => {
  const vision = { ...model, id: 'vision', supportsImages: true }
  const { url, seen } = await fixture(t, undefined, [vision])
  const image = 'data:image/png;base64,' + Buffer.from('same-bytes').toString('base64')
  const body = { model: 'vision', input: [
    { role: 'user', content: [{ type: 'input_text', text: 'first' }, { type: 'input_image', image_url: image }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'again' }, { type: 'input_image', image_url: image }] },
  ] }
  const response = await fetch(`${url}/cn/v1/responses`, { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal(response.status, 200)

  const forwarded = seen.at(-1).body
  const images = forwarded.messages.flatMap((message: any) => Array.isArray(message.content)
    ? message.content.filter((part: any) => part.type === 'image_url')
    : [])
  assert.equal(images.length, 1, 'only the newest copy of the same image is forwarded')
  assert.equal(forwarded.messages[2].content[1].image_url.url, image)
  assert.match(forwarded.messages[0].content[1].text, /identical image repeated earlier/)

  const status = await (await fetch(`${url}/status`, { headers })).json()
  assert.equal(status.shape.requests, 1)
  assert.equal(status.shape.images, 2)
  assert.equal(status.shape.duplicated, 1)
})

test('x-api-key is accepted as an alternative bearer spelling', async t => {
  const { url, seen } = await fixture(t)
  const response = await fetch(`${url}/cn/v1/responses`, {
    method: 'POST',
    headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'sample', max_output_tokens: 32, input: 'ping' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(outputText(body), '你好')
  assert.equal(seen.find(row => row.body).body.max_tokens, 32)
})

test('retired routes are gone; only responses is served', async t => {
  const { url } = await fixture(t)
  for (const path of ['chat/completions', 'messages']) {
    const response = await fetch(`${url}/cn/v1/${path}`, {
      method: 'POST', headers, body: JSON.stringify({ model: 'sample', input: 'x' }),
    })
    assert.equal(response.status, 404, `${path} must not be routed any more`)
    const body = await response.json()
    assert.equal(body.error.code, 'not_found')
  }
})

test('protocol errors use the Responses error envelope', async t => {
  const { url } = await fixture(t)
  const response = await fetch(`${url}/cn/v1/responses`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'missing', input: 'x' }),
  })
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error.code, 'model_not_found')
  assert.equal(body.error.type, 'not_found_error')
})

test('status advertises the single protocol this bridge serves', async t => {
  const { url } = await fixture(t)
  const body = await (await fetch(`${url}/status`, { headers })).json()
  assert.equal(body.protocol, 'openai-responses')
})

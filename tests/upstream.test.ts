import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

test('CN and global model discovery use their respective real client paths', async () => {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url))
    return Response.json({ code: 0, data: { models: [{ id: 'test', maxInputTokens: 100, maxOutputTokens: 10 }], agents: [{ name: 'cli', models: ['test'] }] } })
  }) as typeof fetch
  try {
    const client = new WorkBuddyUpstreamClient()
    for (const domain of ['www.codebuddy.cn', 'www.workbuddy.ai']) await client.fetchModels({ domain, accessToken: 'fixture', uid: 'fixture', expiresAtMs: 1, refreshToken: '', source: 'desktop' })
    assert.deepEqual(urls, ['https://copilot.tencent.com/console/enterprises/personal/models', 'https://www.workbuddy.ai/v2/enterprises/personal/models'])
  } finally { globalThis.fetch = original }
})

test('chat requests carry the channel-verification IDs required by upstream', async () => {
  const original = globalThis.fetch
  let headers: Record<string, string> | undefined
  globalThis.fetch = (async (_url: any, init: any) => {
    headers = init?.headers
    return new Response('ok', { status: 200 })
  }) as typeof fetch
  try {
    const client = new WorkBuddyUpstreamClient()
    await client.chatStream(
      { domain: 'www.workbuddy.ai', accessToken: 'fixture', uid: 'fixture', expiresAtMs: 1, refreshToken: '', source: 'desktop' },
      '{}',
    )
    for (const id of ['X-Request-ID', 'X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID']) {
      assert.ok(headers?.[id], `chat header ${id} must be present`)
      assert.match(headers![id], /^[0-9a-f-]+$/u, `chat header ${id} must be a uuid-like id`)
    }
    assert.ok(headers?.['X-Request-ID']?.includes('-') === false, 'X-Request-ID must be dashless')
  } finally { globalThis.fetch = original }
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  defaultOpenCodeConfigPath,
  installOpenCode,
  modelEntry,
  opencodeBaseUrl,
  opencodeProviderId,
  removeOpenCode,
  stripJsonComments,
} from '../src/opencode.ts'

const token = 'bridge-token-abcdefghijklmnopqrstuvwxyz'
const bridgeUrl = 'http://127.0.0.1:10108'

const freeRow = {
  id: 'hy3', name: 'Hy3 · x0.00', context_window: 192000, max_output_tokens: 64000,
  supports_vision: true,
  reasoning: { supports: true, canDisableThinking: false, supportedEfforts: ['high'] },
  billing: { free: true },
}
const paidRow = {
  id: 'glm-5.3', name: 'GLM-5.3 · x0.69', context_window: 1000000, max_output_tokens: 64000,
  supports_vision: true,
  reasoning: { supports: true, canDisableThinking: true, supportedEfforts: ['low', 'high', 'max'] },
  billing: { free: false },
}
const textOnlyRow = {
  id: 'legacy', name: 'Legacy', context_window: 32000, max_output_tokens: 8000,
  supports_vision: false, reasoning: { supports: false }, billing: { free: false },
}

async function withFetch<T>(rows: Array<Record<string, unknown>>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ object: 'list', data: rows })) as typeof fetch
  try { return await run() } finally { globalThis.fetch = original }
}

async function fixture(): Promise<{ root: string, configPath: string, cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(process.cwd(), '.test-opencode-config-'))
  return { root, configPath: join(root, 'opencode.json'), cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('stripJsonComments keeps URLs and drops comments and trailing commas', () => {
  const source = '{\n  // note\n  "url": "https://a.example/v1", /* block */\n  "list": [1, 2,],\n}'
  const { json, hadComments } = stripJsonComments(source)
  assert.equal(hadComments, true)
  assert.deepEqual(JSON.parse(json), { url: 'https://a.example/v1', list: [1, 2] })
})

test('stripJsonComments leaves plain JSON untouched', () => {
  const source = '{"a":1}'
  const { json, hadComments } = stripJsonComments(source)
  assert.equal(hadComments, false)
  assert.equal(json, source)
})

test('defaultOpenCodeConfigPath prefers the file the client already reads', () => {
  const previous = process.env['XDG_CONFIG_HOME']
  try {
    process.env['XDG_CONFIG_HOME'] = 'C:\\xdg'
    assert.equal(defaultOpenCodeConfigPath(), join('C:\\xdg', 'opencode', 'opencode.json'))
  } finally {
    if (previous === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = previous
  }
})

test('provider ids and base urls follow the region', () => {
  assert.equal(opencodeProviderId('cn'), 'workbuddy')
  assert.equal(opencodeProviderId('global'), 'workbuddy-global')
  assert.equal(opencodeBaseUrl('http://127.0.0.1:10108/', 'cn'), 'http://127.0.0.1:10108/cn/v1')
})

test('model entries describe tools, media, limits and reasoning variants', () => {
  const paid = modelEntry({ ...paidRow, reasons: true, canDisableThinking: true, efforts: ['low', 'high', 'max'], free: false, supportsImages: true, contextWindow: 1_000_000, maxTokens: 64_000 } as never)
  assert.deepEqual(paid, {
    name: 'GLM-5.3 · x0.69',
    capabilities: {
      tools: true,
      input: ['text', 'image'],
      output: ['text'],
      reasoning: { supported: true, toggle: true, effort: ['low', 'high', 'max'] },
    },
    limit: { context: 1_000_000, output: 64_000 },
  })
  const plain = modelEntry({ ...textOnlyRow, reasons: false, canDisableThinking: false, efforts: [], free: false, supportsImages: false, contextWindow: 32_000, maxTokens: 8_000 } as never)
  assert.deepEqual((plain['capabilities'] as Record<string, unknown>)['input'], ['text'])
  assert.equal((plain['capabilities'] as Record<string, unknown>)['reasoning'], undefined)
})

test('install adds one provider and preserves unrelated configuration', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    await writeFile(configPath, JSON.stringify({
      mcp: { servers: { tdx: { type: 'remote', url: 'https://txmcp.tdx.com.cn:3001/txmcp' } } },
      providers: { other: { name: 'Other', package: '@opencode/ai/providers/openai' } },
      model: 'other/x',
    }, null, 2))

    const reports = await withFetch([freeRow, paidRow], () => installOpenCode({ bridgeUrl, token, regions: ['cn'], configPath }))
    assert.equal(reports.length, 1)
    assert.equal(reports[0]!.action, 'installed')
    assert.equal(reports[0]!.models, 2)
    assert.equal(reports[0]!.freeModels, 1)

    const written = JSON.parse(await readFile(configPath, 'utf8'))
    assert.equal(written['$schema'], 'https://opencode.ai/config.json')
    assert.equal(written['model'], 'other/x')
    assert.deepEqual(written['providers']['other'], { name: 'Other', package: '@opencode/ai/providers/openai' })
    assert.deepEqual(written['mcp'], { servers: { tdx: { type: 'remote', url: 'https://txmcp.tdx.com.cn:3001/txmcp' } } })

    const provider = written['providers']['workbuddy']
    assert.equal(provider.name, 'WorkBuddy CN')
    assert.equal(provider.package, '@opencode/ai/providers/openai-compatible/responses')
    assert.deepEqual(provider.settings, { baseURL: 'http://127.0.0.1:10108/cn/v1', apiKey: token })
    assert.deepEqual(Object.keys(provider.models).sort(), ['glm-5.3', 'hy3'])
    assert.deepEqual(provider.models.hy3.capabilities.reasoning, { supported: true, effort: ['high'] })
  } finally {
    await cleanup()
  }
})

test('install is idempotent and free-only installs skip paid models', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    const first = await withFetch([freeRow, paidRow], () => installOpenCode({ bridgeUrl, token, regions: ['cn'], configPath, freeOnly: true }))
    assert.equal(first[0]!.models, 1)
    const once = await readFile(configPath, 'utf8')

    const second = await withFetch([freeRow, paidRow], () => installOpenCode({ bridgeUrl, token, regions: ['cn'], configPath, freeOnly: true }))
    assert.equal(second[0]!.action, 'unchanged')
    assert.equal(await readFile(configPath, 'utf8'), once)
  } finally {
    await cleanup()
  }
})

test('both regions produce two independent providers', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    const reports = await withFetch([freeRow], () => installOpenCode({ bridgeUrl, token, regions: ['cn', 'global'], configPath }))
    assert.deepEqual(reports.map(report => report.provider), ['workbuddy', 'workbuddy-global'])
    const written = JSON.parse(await readFile(configPath, 'utf8'))
    assert.equal(written['providers']['workbuddy-global'].settings.baseURL, 'http://127.0.0.1:10108/global/v1')
  } finally {
    await cleanup()
  }
})

test('install rewrites a JSONC config into valid JSON without losing settings', async () => {
  const { root, configPath, cleanup } = await fixture()
  try {
    const jsoncPath = join(root, 'opencode.jsonc')
    await writeFile(jsoncPath, '{\n  // keep my mcp server\n  "mcp": { "servers": { "x": { "url": "https://x.example/mcp" } } },\n}\n')
    const reports = await withFetch([freeRow], () => installOpenCode({ bridgeUrl, token, regions: ['cn'], configPath: jsoncPath }))
    assert.equal(reports[0]!.action, 'installed')
    const written = JSON.parse(await readFile(jsoncPath, 'utf8'))
    assert.equal(written['mcp']['servers']['x']['url'], 'https://x.example/mcp')
    assert.ok(written['providers']['workbuddy'])
  } finally {
    await cleanup()
  }
})

test('remove deletes only entries this module wrote', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    await withFetch([freeRow], () => installOpenCode({ bridgeUrl, token, regions: ['cn'], configPath }))
    const written = JSON.parse(await readFile(configPath, 'utf8'))
    written['providers']['workbuddy-global'] = { name: 'Mine', package: 'something-else', settings: { baseURL: 'http://127.0.0.1:9999/global/v1' } }
    await writeFile(configPath, JSON.stringify(written, null, 2))

    const reports = await removeOpenCode({ bridgeUrl, regions: ['cn', 'global'], configPath })
    assert.deepEqual(reports.map(report => report.action), ['removed', 'skipped'])
    const after = JSON.parse(await readFile(configPath, 'utf8'))
    assert.equal(after['providers']['workbuddy'], undefined)
    assert.ok(after['providers']['workbuddy-global'])
  } finally {
    await cleanup()
  }
})

test('remove on a machine without a config reports absent', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    const reports = await removeOpenCode({ bridgeUrl, regions: ['cn'], configPath })
    assert.equal(reports[0]!.action, 'absent')
  } finally {
    await cleanup()
  }
})

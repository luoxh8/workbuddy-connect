import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  CODEX_BASE_INSTRUCTIONS,
  codexBaseUrl,
  codexProviderId,
  installCodex,
  readCodexRegistration,
  removeCodex,
} from '../src/codex.ts'

const token = 'bridge-token-abcdefghijklmnopqrstuvwxyz'
const bridgeUrl = 'http://127.0.0.1:10108'

/** A Codex config as the ChatGPT app / CLI already has it before we touch it. */
function existingConfig(): string {
  return [
    '# user notes that must survive',
    'model = "deepseek-flash"',
    'model_provider = "deepseek"',
    'web_search = "disabled"',
    '',
    '[model_providers.deepseek]',
    'name = "deepseek"',
    'base_url = "http://127.0.0.1:5231/"',
    'wire_api = "responses"',
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
  ].join('\n')
}

const freeRow = {
  id: 'hy3', context_window: 192000, max_output_tokens: 64000, supports_vision: true,
  reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false },
  billing: { credits: 'x0.00 credits', free: true },
}
const paidRow = {
  id: 'glm-5.3', context_window: 1000000, max_output_tokens: 64000, supports_vision: true,
  reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'] },
  billing: { credits: 'x0.79 credits', free: false },
}
const noEffortRow = {
  id: 'kimi-k3-1', context_window: 1000000, max_output_tokens: 32000, supports_vision: true,
  reasoning: { supports: false }, billing: { free: false },
}

/** A catalog the machine already had, in the client's own (strict) shape. */
function inheritedCatalog(): string {
  return JSON.stringify({
    models: [{
      slug: 'deepseek-flash',
      display_name: 'DeepSeek-Flash',
      context_window: 1048576,
      max_context_window: 1048576,
      max_output_tokens: 64000,
      truncation_policy: { mode: 'tokens', limit: 10000 },
      input_modalities: ['text', 'image'],
      supports_parallel_tool_calls: true,
      supported_reasoning_levels: [{ effort: 'high', description: 'deep' }],
      default_reasoning_level: 'high',
      base_instructions: 'original instructions',
      model_messages: { instructions_template: 'original', instructions_variables: {}, approvals: null },
    }],
  })
}

async function withFetch<T>(rows: Array<Record<string, unknown>>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ object: 'list', data: rows })) as typeof fetch
  try { return await run() } finally { globalThis.fetch = original }
}

async function fixture(): Promise<{ root: string, configPath: string, catalogPath: string, cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(process.cwd(), '.test-codex-config-'))
  const configPath = join(root, 'config.toml')
  const catalogPath = join(root, 'previous-models.json')
  await writeFile(configPath, existingConfig())
  await writeFile(catalogPath, inheritedCatalog())
  // Point the config at its own catalog so install has something to inherit.
  const withCatalog = (await readFile(configPath, 'utf8')).replace(
    'web_search = "disabled"',
    `web_search = "disabled"\nmodel_catalog_json = "${catalogPath.replace(/\\/g, '\\\\')}"`,
  )
  await writeFile(configPath, withCatalog)
  return { root, configPath, catalogPath, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('codex base URL and provider id per region', () => {
  assert.equal(codexBaseUrl('http://127.0.0.1:10108', 'cn'), 'http://127.0.0.1:10108/cn/v1')
  assert.equal(codexBaseUrl('http://127.0.0.1:10108/', 'global'), 'http://127.0.0.1:10108/global/v1')
  assert.equal(codexProviderId('cn'), 'workbuddy')
  assert.equal(codexProviderId('global'), 'workbuddy-global')
})

test('the substitute system prompt does not contain the filtered wording', () => {
  // WorkBuddy's upstream rejects OpenAI's agent prompt; these phrases are the
  // ones that were confirmed to trigger it.
  assert.doesNotMatch(CODEX_BASE_INSTRUCTIONS, /Codex CLI/)
  assert.doesNotMatch(CODEX_BASE_INSTRUCTIONS, /led by OpenAI/)
  assert.match(CODEX_BASE_INSTRUCTIONS, /coding agent/)
})

test('installing writes a provider block and keeps the other providers', async () => {
  const { configPath, catalogPath, cleanup } = await fixture()
  try {
    await withFetch([freeRow, paidRow], () => installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    const text = await readFile(configPath, 'utf8')
    assert.match(text, /\[model_providers\.workbuddy\]/)
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:10108\/cn\/v1"/)
    assert.match(text, /wire_api = "responses"/)
    // Untouched: the user's comment, their other provider, their other tables.
    assert.match(text, /# user notes that must survive/)
    assert.match(text, /\[model_providers\.deepseek\]/)
    assert.match(text, /\[windows\]/)
    // The active provider and catalog now point at this bridge. The previous
    // path may still appear inside the restore comments, so only the real
    // assignment counts.
    assert.match(text, /^model_provider = "workbuddy"$/m)
    const assignments = text.split('\n').filter(line => !line.trimStart().startsWith('#'))
    assert.match(assignments.join('\n'), /^model_catalog_json = ".*workbuddy-models\.json"$/m)
    assert.doesNotMatch(assignments.join('\n'), /previous-models\.json/)
    // hy3 is free, so it becomes the default rather than a paid model.
    assert.match(text, /^model = "hy3"$/m)
    assert.ok(catalogPath.endsWith('previous-models.json'))
  } finally { await cleanup() }
})

test('the generated catalog clones the client schema and replaces the prompt', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    const [report] = await withFetch([freeRow, paidRow, noEffortRow], () =>
      installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    const catalog = JSON.parse(await readFile(report!.catalogPath, 'utf8')) as { models: Array<Record<string, any>> }
    const bySlug = new Map(catalog.models.map(model => [model['slug'], model]))
    assert.deepEqual([...bySlug.keys()].sort(), ['deepseek-flash', 'glm-5.3', 'hy3', 'kimi-k3-1'])

    const free = bySlug.get('hy3')!
    assert.equal(free['display_name'], 'hy3')
    assert.equal(free['context_window'], 192000)
    assert.equal(free['max_output_tokens'], 64000)
    // Every entry must carry the substitute prompt, or the client sends its own.
    assert.equal(free['base_instructions'], CODEX_BASE_INSTRUCTIONS)
    assert.equal(free['model_messages']['instructions_template'], CODEX_BASE_INSTRUCTIONS)
    // Required by the client even for a model with no adjustable effort.
    assert.deepEqual(free['supported_reasoning_levels'], [{ effort: 'none', description: 'No extra reasoning' }])
    assert.equal(free['default_reasoning_level'], 'none')
    // Fields the client requires come from the cloned entry, not a guess.
    assert.deepEqual(free['truncation_policy'], { mode: 'tokens', limit: 10000 })

    const paid = bySlug.get('glm-5.3')!
    assert.deepEqual(paid['supported_reasoning_levels'].map((level: any) => level.effort), ['low', 'high', 'max'])
    assert.equal(paid['default_reasoning_level'], 'high')

    // The model that lived in the previous catalog keeps its entry.
    const carried = bySlug.get('deepseek-flash')!
    assert.equal(carried['base_instructions'], 'original instructions')
  } finally { await cleanup() }
})

test('a model with no stated effort still names one supported level', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    const [report] = await withFetch([noEffortRow], () => installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    const catalog = JSON.parse(await readFile(report!.catalogPath, 'utf8')) as { models: Array<Record<string, any>> }
    const entry = catalog.models.find(model => model['slug'] === 'kimi-k3-1')!
    assert.equal(entry['supported_reasoning_levels'].length, 1)
    assert.equal(entry['supported_reasoning_levels'][0].effort, 'none')
    assert.equal(entry['supports_reasoning_summaries'], false)
  } finally { await cleanup() }
})

test('free-only registers just the zero-credit models', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    const [report] = await withFetch([freeRow, paidRow], () =>
      installCodex({ bridgeUrl, token, regions: ['cn'], configPath, freeOnly: true }))
    const catalog = JSON.parse(await readFile(report!.catalogPath, 'utf8')) as { models: Array<Record<string, any>> }
    const slugs = catalog.models.map(model => model['slug'])
    assert.ok(slugs.includes('hy3'))
    assert.ok(!slugs.includes('glm-5.3'))
    assert.equal(report!.freeModels, 1)
  } finally { await cleanup() }
})

test('a rerun reports unchanged and leaves both files byte-identical', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    const [first] = await withFetch([freeRow, paidRow], () => installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    const configAfterFirst = await readFile(configPath, 'utf8')
    const catalogAfterFirst = await readFile(first!.catalogPath, 'utf8')

    const [second] = await withFetch([freeRow, paidRow], () => installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    assert.equal(second!.action, 'unchanged')
    assert.equal(second!.models, first!.models)
    assert.equal(await readFile(configPath, 'utf8'), configAfterFirst)
    assert.equal(await readFile(first!.catalogPath, 'utf8'), catalogAfterFirst)
  } finally { await cleanup() }
})

test('removal restores the file byte for byte', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    const original = await readFile(configPath, 'utf8')
    await withFetch([freeRow, paidRow], () => installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    await removeCodex({ configPath })
    assert.equal(await readFile(configPath, 'utf8'), original)
  } finally { await cleanup() }
})

test('removal deletes this bridge catalog and reports what it did', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    const [report] = await withFetch([freeRow], () => installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    const removed = await removeCodex({ configPath })
    assert.equal(removed.action, 'removed')
    await assert.rejects(readFile(report!.catalogPath, 'utf8'))
    // A removal with no block is a no-op rather than an error.
    assert.equal((await removeCodex({ configPath })).action, 'skipped')
  } finally { await cleanup() }
})

test('a model the user picked from this bridge survives a reinstall', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    await withFetch([freeRow, paidRow], () => installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    const text = await readFile(configPath, 'utf8')
    await writeFile(configPath, text.replace('model = "hy3"', 'model = "glm-5.3"'))
    await withFetch([freeRow, paidRow], () => installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    // The user's choice is honored, not reset to the free default.
    assert.match(await readFile(configPath, 'utf8'), /^model = "glm-5\.3"$/m)
  } finally { await cleanup() }
})

test('both regions register side by side and share one catalog', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    await withFetch([freeRow, paidRow], () => installCodex({ bridgeUrl, token, regions: ['cn', 'global'], configPath }))
    const text = await readFile(configPath, 'utf8')
    assert.match(text, /\[model_providers\.workbuddy\]/)
    assert.match(text, /\[model_providers\.workbuddy-global\]/)
    assert.match(text, /\/global\/v1/)
    assert.match(text, /^model_provider = "workbuddy"$/m)
  } finally { await cleanup() }
})

test('registration summary reads back what install wrote', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    assert.equal(readCodexRegistration(configPath).installed, false)
    const [report] = await withFetch([freeRow, paidRow], () => installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    const summary = readCodexRegistration(configPath)
    assert.equal(summary.installed, true)
    assert.deepEqual(summary.providers, ['workbuddy'])
    assert.equal(summary.catalogPath, report!.catalogPath)
    assert.equal(summary.catalogModels, 3)
  } finally { await cleanup() }
})

test('an unreachable bridge changes nothing', async () => {
  const { configPath, cleanup } = await fixture()
  try {
    const original = await readFile(configPath, 'utf8')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('fetch failed') }) as typeof fetch
    try {
      await assert.rejects(installCodex({ bridgeUrl, token, regions: ['cn'], configPath }), /fetch failed/)
    } finally { globalThis.fetch = originalFetch }
    assert.equal(await readFile(configPath, 'utf8'), original)
  } finally { await cleanup() }
})

test('an absent config is created instead of failing', async () => {
  const root = await mkdtemp(join(process.cwd(), '.test-codex-new-'))
  const configPath = join(root, 'nested', 'config.toml')
  try {
    const [report] = await withFetch([freeRow], () => installCodex({ bridgeUrl, token, regions: ['cn'], configPath }))
    assert.equal(report!.action, 'installed')
    const text = await readFile(configPath, 'utf8')
    assert.match(text, /^model_provider = "workbuddy"$/m)
    // Nothing was there before, so removal has to delete what install added.
    assert.match(text, /^# restore model_provider = absent$/m)
    const removed = await removeCodex({ configPath })
    assert.equal(removed.action, 'removed')
    const after = await readFile(configPath, 'utf8')
    assert.doesNotMatch(after, /^model_provider =/m)
    assert.doesNotMatch(after, /^model_catalog_json =/m)
  } finally { await rm(root, { recursive: true, force: true }) }
})

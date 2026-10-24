import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { bridgeRegionBaseUrl, defaultProviderConfigPath, installZCode, listZCodeProviders, providerIdFor, pruneLegacyZCode, readZCodeRegistration, removeZCode } from '../src/zcode.ts'

const token = 'bridge-token-abcdefghijklmnopqrstuvwxyz'
const bridgeUrl = 'http://127.0.0.1:10108'

/** A personal provider config as ZCode already has it before we touch it. */
function existingConfig(): string {
  return JSON.stringify({
    schemaVersion: 1,
    config: {
      providerOrder: ['deepseek'],
      providerConfigRules: {
        providerRules: [{
          providerId: 'deepseek',
          templateId: 'deepseek',
          providerName: 'DeepSeek',
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: 'sk-user-key' },
            api: { type: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic' },
            personalModelIds: [],
            modelOrder: ['deepseek-flash'],
          },
        }],
      },
      modelConfigRules: {
        providerModelRules: [{ providerId: 'deepseek', modelId: 'deepseek-flash', config: { enabled: true } }],
        manualProviderModelRules: [{ providerId: 'deepseek', modelId: 'deepseek-flash', config: { enabled: true } }],
      },
    },
  }, null, 2)
}

/** Bridge catalog rows, shaped like the real `/cn/v1/models` answer. */
function catalog(rows: Array<Record<string, unknown>>): Response {
  return Response.json({ object: 'list', data: rows })
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

async function withFetch<T>(handler: (url: string) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: any) => handler(String(url))) as typeof fetch
  try { return await run() } finally { globalThis.fetch = original }
}

async function fixture(): Promise<{ path: string, cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(process.cwd(), '.test-zcode-config-'))
  const path = join(root, 'provider_config.json')
  await writeFile(path, existingConfig())
  return { path, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('bridge region base URL is derived and validated', () => {
  assert.equal(bridgeRegionBaseUrl('http://127.0.0.1:10108', 'cn'), 'http://127.0.0.1:10108/cn/v1')
  assert.equal(bridgeRegionBaseUrl('http://localhost:10108/', 'global'), 'http://localhost:10108/global/v1')
  assert.throws(() => bridgeRegionBaseUrl('https://example.com', 'cn'), /loopback/)
  assert.throws(() => bridgeRegionBaseUrl('http://127.0.0.1:10108/nested', 'cn'), /must not include a path/)
})

test('provider ids are one per region, with no protocol suffix', () => {
  assert.equal(providerIdFor('cn'), 'workbuddy-cn')
  assert.equal(providerIdFor('global'), 'workbuddy-global')
})

test('installs exactly one provider per region without disturbing existing providers', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const reports = await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({
    bridgeUrl, token, regions: ['cn'], configPath: f.path,
  }))
  assert.deepEqual(reports, [
    { provider: 'workbuddy-cn', region: 'cn', action: 'installed', models: 2, freeModels: 1 },
  ])

  const written = JSON.parse(await readFile(f.path, 'utf8'))
  assert.deepEqual(written.config.providerOrder, ['deepseek'])
  const rules = written.config.providerConfigRules.providerRules
  assert.deepEqual(rules.map((rule: any) => rule.providerId), ['deepseek', 'workbuddy-cn'])
  assert.equal(rules[0].config.api.baseUrl, 'https://api.deepseek.com/anthropic')
  assert.equal(rules[0].config.access.apiKey, 'sk-user-key')
  const ours = rules[1]
  assert.equal(ours.config.group, 'standard-personal')
  assert.equal(ours.config.api.type, 'openai-responses')
  assert.equal(ours.config.api.baseUrl, 'http://127.0.0.1:10108/cn/v1')
  assert.equal(ours.config.access.apiKey, token)
  assert.deepEqual(ours.config.personalModelIds, ['hy3', 'glm-5.3'])
  assert.equal(ours.config.visibility, 'visible')

  // The other provider's model rules and the untouched manual rules survive.
  const modelRules = written.config.modelConfigRules.providerModelRules
  assert.deepEqual(modelRules.map((rule: any) => `${rule.providerId}/${rule.modelId}`), [
    'deepseek/deepseek-flash',
    'workbuddy-cn/hy3', 'workbuddy-cn/glm-5.3',
  ])
  assert.equal(written.config.modelConfigRules.manualProviderModelRules.length, 1)
})

test('model metadata mirrors the bridge catalog in Responses field names', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  const written = JSON.parse(await readFile(f.path, 'utf8'))
  const rules = written.config.modelConfigRules.providerModelRules.filter((rule: any) => rule.providerId === 'workbuddy-cn')
  const hy3 = rules.find((rule: any) => rule.modelId === 'hy3')
  assert.equal(hy3.config.properties.contextWindow, 192000)
  assert.equal(hy3.config.properties.inputFormat.supportsImage, true)
  assert.equal(hy3.config.properties.supportsToolCall, true)
  assert.equal(hy3.config.optionSpecs.maxOutputTokens.max, 64000)
  assert.equal(hy3.config.optionSpecs.maxOutputTokens.map, '{"max_output_tokens": maxOutputTokens}')
  // A model with no advertised efforts must not offer a reasoning selector.
  assert.equal(hy3.config.optionSpecs.reasoningLevel, undefined)
  const glm = rules.find((rule: any) => rule.modelId === 'glm-5.3')
  assert.deepEqual(glm.config.optionSpecs.reasoningLevel.values, ['low', 'high', 'max'])
  assert.equal(glm.config.optionSpecs.reasoningLevel.map, '{"reasoning": {"effort": reasoningLevel}}')
})

test('free-only registration keeps just the zero-credit models', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const reports = await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({
    bridgeUrl, token, regions: ['cn'], freeOnly: true, configPath: f.path,
  }))
  assert.deepEqual(reports, [
    { provider: 'workbuddy-cn', region: 'cn', action: 'installed', models: 1, freeModels: 1 },
  ])
  const written = JSON.parse(await readFile(f.path, 'utf8'))
  assert.deepEqual(written.config.providerConfigRules.providerRules[1].config.personalModelIds, ['hy3'])
})

test('free-only registration fails loudly when nothing is free', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await assert.rejects(
    () => withFetch(() => catalog([paidRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], freeOnly: true, configPath: f.path })),
    /no free models/,
  )
  assert.equal(await readFile(f.path, 'utf8'), existingConfig())
})

test('a rerun reports unchanged and leaves the file byte-identical', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  const first = await readFile(f.path, 'utf8')
  const reports = await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  assert.deepEqual(reports.map(report => report.action), ['unchanged'])
  assert.equal(await readFile(f.path, 'utf8'), first)
})

test('a model that left the catalog also leaves ZCode', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  await withFetch(() => catalog([freeRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  const written = JSON.parse(await readFile(f.path, 'utf8'))
  assert.deepEqual(written.config.providerConfigRules.providerRules[1].config.personalModelIds, ['hy3'])
  assert.deepEqual(
    written.config.modelConfigRules.providerModelRules.filter((rule: any) => rule.providerId === 'workbuddy-cn').map((rule: any) => rule.modelId),
    ['hy3'],
  )
})

test('an unreachable bridge changes nothing', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await assert.rejects(
    () => withFetch(() => new Response('nope', { status: 502 }), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path })),
    /model discovery failed/,
  )
  assert.equal(await readFile(f.path, 'utf8'), existingConfig())
})

test('removal drops only this bridge and keeps the other provider intact', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  const reports = await removeZCode({ bridgeUrl, regions: ['cn'], configPath: f.path })
  assert.deepEqual(reports.filter(report => report.action !== 'skipped').map(report => report.provider), ['workbuddy-cn'])
  const written = JSON.parse(await readFile(f.path, 'utf8'))
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), ['deepseek'])
  assert.deepEqual(written.config.modelConfigRules.providerModelRules.map((rule: any) => rule.providerId), ['deepseek'])
  assert.equal(written.config.modelConfigRules.manualProviderModelRules.length, 1)
})

test('removal refuses a provider the user re-pointed at another endpoint', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(() => catalog([freeRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  // The user edited the base URL by hand: it is theirs now, not ours.
  const edited = JSON.parse(await readFile(f.path, 'utf8'))
  edited.config.providerConfigRules.providerRules[1].config.api.baseUrl = 'http://127.0.0.1:9099/cn/v1'
  await writeFile(f.path, JSON.stringify(edited, null, 2))
  const reports = await removeZCode({ bridgeUrl, regions: ['cn'], configPath: f.path })
  assert.deepEqual(reports[0], { provider: 'workbuddy-cn', region: 'cn', action: 'skipped', reason: 'not_owned' })
  const written = JSON.parse(await readFile(f.path, 'utf8'))
  assert.equal(written.config.providerConfigRules.providerRules.length, 2)
})

test('removal without a bridge URL still claims a loopback region endpoint', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(() => catalog([freeRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  assert.deepEqual((await removeZCode({ regions: ['cn'], configPath: f.path })).filter(report => report.action !== 'skipped').map(report => report.action), ['removed'])
})

test('an absent config is created instead of failing', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-zcode-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'nested', 'provider_config.json')
  await withFetch(() => catalog([freeRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: path }))
  const written = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(written.schemaVersion, 1)
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), ['workbuddy-cn'])
})

test('registration summary reads back what install wrote', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  assert.deepEqual((await readZCodeRegistration(f.path)).map(entry => [entry.provider, entry.models]), [['workbuddy-cn', 2]])
  assert.deepEqual(await readZCodeRegistration(join(f.path, '..', 'absent.json')), [])
})

test('both regions register side by side', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(url => url.includes('/cn/') ? catalog([freeRow]) : catalog([paidRow]), () => installZCode({
    bridgeUrl, token, regions: ['cn', 'global'], configPath: f.path,
  }))
  const written = JSON.parse(await readFile(f.path, 'utf8'))
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), [
    'deepseek', 'workbuddy-cn', 'workbuddy-global',
  ])
  await removeZCode({ regions: ['cn'], configPath: f.path })
  const after = JSON.parse(await readFile(f.path, 'utf8'))
  assert.deepEqual(after.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), [
    'deepseek', 'workbuddy-global',
  ])
})

test('a short bridge token is refused before any write', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await assert.rejects(() => installZCode({ bridgeUrl, token: 'too-short', regions: ['cn'], configPath: f.path }), /at least 24 characters/)
  assert.equal(await readFile(f.path, 'utf8'), existingConfig())
})

test('the default config path honours ZCODE_HOME and ignores relative overrides', () => {
  const originalHome = process.env.ZCODE_HOME
  const originalPath = process.env.ZCODE_PROVIDER_CONFIG
  // Absolute on every platform the suite runs on: the resolver rejects a
  // relative override precisely because it would retarget the write.
  const fakeHome = process.platform === 'win32' ? 'C:\\custom-zcode' : '/tmp/custom-zcode'
  try {
    delete process.env.ZCODE_PROVIDER_CONFIG
    process.env.ZCODE_HOME = fakeHome
    assert.equal(defaultProviderConfigPath(), join(fakeHome, 'v2', 'provider_config.json'))
    process.env.ZCODE_PROVIDER_CONFIG = 'relative/config.json'
    assert.equal(defaultProviderConfigPath(), join(fakeHome, 'v2', 'provider_config.json'))
    process.env.ZCODE_PROVIDER_CONFIG = join(fakeHome, 'pinned', 'config.json')
    assert.equal(defaultProviderConfigPath(), join(fakeHome, 'pinned', 'config.json'))
  } finally {
    if (originalHome === undefined) delete process.env.ZCODE_HOME
    else process.env.ZCODE_HOME = originalHome
    if (originalPath === undefined) delete process.env.ZCODE_PROVIDER_CONFIG
    else process.env.ZCODE_PROVIDER_CONFIG = originalPath
  }
})

test('the default config path follows a custom ZCode data directory', async t => {
  const home = await mkdtemp(join(process.cwd(), '.test-zcode-datadir-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const zcodeHome = join(home, '.zcode')
  const settings = join(zcodeHome, 'v2', 'setting.json')
  await mkdir(join(zcodeHome, 'v2'), { recursive: true })
  const defaultPath = join(zcodeHome, 'v2', 'provider_config.json')
  const originalHome = process.env.ZCODE_HOME
  const originalPath = process.env.ZCODE_PROVIDER_CONFIG
  try {
    delete process.env.ZCODE_PROVIDER_CONFIG
    process.env.ZCODE_HOME = zcodeHome
    // Settings → Data directory moved the client's data: the client reads that
    // registry, so a write to the default path would register nothing.
    const moved = join(home, 'codex_proj')
    await writeFile(settings, JSON.stringify({ dataBaseDir: moved }))
    assert.equal(defaultProviderConfigPath(), join(moved, '.zcode', 'v2', 'provider_config.json'))
    // An explicit override still wins over the recorded data directory.
    process.env.ZCODE_PROVIDER_CONFIG = join(home, 'pinned', 'config.json')
    assert.equal(defaultProviderConfigPath(), join(home, 'pinned', 'config.json'))
    delete process.env.ZCODE_PROVIDER_CONFIG
    // A relative or empty value is not a data directory the client would write.
    await writeFile(settings, JSON.stringify({ dataBaseDir: 'relative/dir' }))
    assert.equal(defaultProviderConfigPath(), defaultPath)
    await writeFile(settings, JSON.stringify({ dataBaseDir: '' }))
    assert.equal(defaultProviderConfigPath(), defaultPath)
    // The home root as the data directory is the default path, not a second file.
    await writeFile(settings, JSON.stringify({ dataBaseDir: home }))
    assert.equal(defaultProviderConfigPath(), defaultPath)
    // No settings file at all: the registry under the default root.
    await rm(settings)
    assert.equal(defaultProviderConfigPath(), defaultPath)
  } finally {
    if (originalHome === undefined) delete process.env.ZCODE_HOME
    else process.env.ZCODE_HOME = originalHome
    if (originalPath === undefined) delete process.env.ZCODE_PROVIDER_CONFIG
    else process.env.ZCODE_PROVIDER_CONFIG = originalPath
  }
})

/** A config left behind by bridge 1.4, which registered three providers per region. */
function legacyConfig(): string {
  const ours = (suffix: string, type: string, name: string) => ({
    providerId: `workbuddy-cn${suffix}`,
    providerName: name,
    enabled: true,
    config: {
      group: 'standard-personal',
      access: { type: 'api-key', apiKey: token },
      api: { type, baseUrl: 'http://127.0.0.1:10108/cn/v1' },
      personalModelIds: ['hy3'],
      modelOrder: ['hy3'],
      visibility: 'visible',
    },
  })
  return JSON.stringify({
    schemaVersion: 1,
    config: {
      providerOrder: ['deepseek', 'workbuddy-cn', 'workbuddy-cn-anthropic', 'workbuddy-cn-responses'],
      providerConfigRules: {
        providerRules: [
          { providerId: 'deepseek', config: { access: { type: 'api-key', apiKey: 'sk-user-key' }, api: { type: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic' } } },
          ours('', 'openai-chat-completions', 'WorkBuddy CN'),
          ours('-anthropic', 'anthropic-messages', 'WorkBuddy CN · Anthropic'),
          ours('-responses', 'openai-responses', 'WorkBuddy CN · Responses'),
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId: 'deepseek', modelId: 'deepseek-flash', config: { enabled: true } },
          { providerId: 'workbuddy-cn', modelId: 'hy3', config: { enabled: true } },
          { providerId: 'workbuddy-cn-anthropic', modelId: 'hy3', config: { enabled: true } },
          { providerId: 'workbuddy-cn-responses', modelId: 'hy3', config: { enabled: true } },
        ],
        manualProviderModelRules: [],
      },
    },
  }, null, 2)
}

test('installing over the retired three-protocol layout cleans the extra providers', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-zcode-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'provider_config.json')
  await writeFile(path, legacyConfig())

  const reports = await withFetch(() => catalog([freeRow]), () => installZCode({
    bridgeUrl, token, regions: ['cn'], configPath: path,
  }))
  assert.deepEqual(reports, [{
    provider: 'workbuddy-cn', region: 'cn', action: 'updated', models: 1, freeModels: 1,
    cleaned: ['workbuddy-cn-anthropic', 'workbuddy-cn-responses'],
  }])

  const written = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), ['deepseek', 'workbuddy-cn'])
  assert.equal(written.config.providerConfigRules.providerRules[1].config.api.type, 'openai-responses')
  assert.deepEqual(written.config.modelConfigRules.providerModelRules.map((rule: any) => `${rule.providerId}/${rule.modelId}`), [
    'deepseek/deepseek-flash', 'workbuddy-cn/hy3',
  ])
  // Ordering keeps the user's other entries but forgets the retired ids.
  assert.deepEqual(written.config.providerOrder, ['deepseek', 'workbuddy-cn'])
})

test('a re-pointed legacy provider is left alone, not deleted', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-zcode-legacy-owned-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'provider_config.json')
  const config = JSON.parse(legacyConfig())
  // The user turned the retired provider into their own endpoint.
  config.config.providerConfigRules.providerRules[2].config.api.baseUrl = 'http://127.0.0.1:8080/cn/v1'
  await writeFile(path, JSON.stringify(config, null, 2))

  const reports = await withFetch(() => catalog([freeRow]), () => installZCode({
    bridgeUrl, token, regions: ['cn'], configPath: path,
  }))
  // The re-pointed anthropic provider is the user's now; the untouched
  // responses one still belongs to this bridge and is swept.
  assert.deepEqual(reports[0].cleaned, ['workbuddy-cn-responses'])
  const written = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), [
    'deepseek', 'workbuddy-cn', 'workbuddy-cn-anthropic',
  ])
  assert.equal(written.config.providerConfigRules.providerRules[2].config.api.baseUrl, 'http://127.0.0.1:8080/cn/v1')
})

test('removal also sweeps the retired protocol providers', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-zcode-legacy-remove-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'provider_config.json')
  await writeFile(path, legacyConfig())

  const reports = await removeZCode({ bridgeUrl, regions: ['cn'], configPath: path })
  assert.deepEqual(reports.map(report => [report.provider, report.action]), [
    ['workbuddy-cn', 'removed'],
    ['workbuddy-cn-anthropic', 'removed'],
    ['workbuddy-cn-responses', 'removed'],
  ])
  const written = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), ['deepseek'])
})

test('prune deletes the retired providers without needing a running bridge', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-zcode-prune-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'provider_config.json')
  await writeFile(path, legacyConfig())

  // No fetch stub at all: prune must not talk to the bridge.
  const reports = await pruneLegacyZCode({ regions: ['cn'], configPath: path })
  assert.deepEqual(reports.map(report => [report.provider, report.action]), [
    ['workbuddy-cn-anthropic', 'removed'],
    ['workbuddy-cn-responses', 'removed'],
  ])

  const written = JSON.parse(await readFile(path, 'utf8'))
  // The surviving chat-completions provider is untouched: prune only clears
  // the retired layout, it never re-registers anything.
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), ['deepseek', 'workbuddy-cn'])
  assert.deepEqual(written.config.providerOrder, ['deepseek', 'workbuddy-cn'])
  assert.deepEqual(written.config.modelConfigRules.providerModelRules.map((rule: any) => rule.providerId), [
    'deepseek', 'workbuddy-cn',
  ])
})

test('prune keeps a retired id the user repurposed as a different format', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-zcode-prune-owned-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'provider_config.json')
  const config = JSON.parse(legacyConfig())
  // The user turned the retired entry into their own OpenAI Responses endpoint
  // on another host: neither the format nor the region path is ours any more.
  config.config.providerConfigRules.providerRules[2].config.api.baseUrl = 'http://127.0.0.1:8080/cn/v1'
  config.config.providerConfigRules.providerRules[2].config.api.type = 'openai-chat-completions'
  await writeFile(path, JSON.stringify(config, null, 2))

  const reports = await pruneLegacyZCode({ regions: ['cn'], configPath: path })
  assert.deepEqual(reports.map(report => [report.provider, report.action]), [
    ['workbuddy-cn-anthropic', 'skipped'],
    ['workbuddy-cn-responses', 'removed'],
  ])
  assert.equal(reports[0].reason, 'not_owned')
  const written = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), [
    'deepseek', 'workbuddy-cn', 'workbuddy-cn-anthropic',
  ])
})

test('prune on a clean config writes nothing and reports not_found', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const reports = await pruneLegacyZCode({ regions: ['cn'], configPath: f.path })
  assert.deepEqual(reports.map(report => [report.provider, report.action, report.reason]), [
    ['workbuddy-cn-anthropic', 'skipped', 'not_found'],
    ['workbuddy-cn-responses', 'skipped', 'not_found'],
  ])
  assert.equal(await readFile(f.path, 'utf8'), existingConfig())
})

test('providers lists every registry entry and flags the retired layout', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-zcode-list-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'provider_config.json')
  await writeFile(path, legacyConfig())

  const providers = await listZCodeProviders(path)
  assert.deepEqual(providers.map(entry => entry.provider), [
    'deepseek', 'workbuddy-cn', 'workbuddy-cn-anthropic', 'workbuddy-cn-responses',
  ])
  assert.deepEqual(providers.map(entry => entry.retired), [false, false, true, true])
  const chat = providers.find(entry => entry.provider === 'workbuddy-cn')
  // The fixture is the 1.4.x layout, where this id carried chat completions.
  assert.equal(chat.apiType, 'openai-chat-completions')
  assert.equal(chat.baseUrl, 'http://127.0.0.1:10108/cn/v1')
  assert.equal(chat.modelRules, 1)
  assert.equal(chat.enabled, true)
  // An absent `enabled` flag is how the client's own rules look: enabled.
  assert.equal(providers[0].enabled, true)
  assert.deepEqual(await listZCodeProviders(join(root, 'absent.json')), [])
})

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { bridgeRegionBaseUrl, defaultProviderConfigPath, installZCode, providerIdFor, readZCodeRegistration, removeZCode } from '../src/zcode.ts'

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

test('provider ids are stable and namespaced', () => {
  assert.equal(providerIdFor('cn'), 'workbuddy-cn')
  assert.equal(providerIdFor('global'), 'workbuddy-global')
  assert.equal(providerIdFor('cn', 'anthropic'), 'workbuddy-cn-anthropic')
  assert.equal(providerIdFor('cn', 'responses'), 'workbuddy-cn-responses')
})

test('installs a provider without disturbing the providers already configured', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const reports = await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({
    bridgeUrl, token, regions: ['cn'], configPath: f.path,
  }))
  assert.deepEqual(reports, [
    { provider: 'workbuddy-cn', region: 'cn', protocol: 'chat', action: 'installed', models: 2, freeModels: 1 },
    { provider: 'workbuddy-cn-anthropic', region: 'cn', protocol: 'anthropic', action: 'installed', models: 2, freeModels: 1 },
    { provider: 'workbuddy-cn-responses', region: 'cn', protocol: 'responses', action: 'installed', models: 2, freeModels: 1 },
  ])

  const written = JSON.parse(await readFile(f.path, 'utf8'))
  assert.deepEqual(written.config.providerOrder, ['deepseek'])
  const rules = written.config.providerConfigRules.providerRules
  assert.deepEqual(rules.map((rule: any) => rule.providerId), ['deepseek', 'workbuddy-cn', 'workbuddy-cn-anthropic', 'workbuddy-cn-responses'])
  assert.equal(rules[0].config.api.baseUrl, 'https://api.deepseek.com/anthropic')
  assert.equal(rules[0].config.access.apiKey, 'sk-user-key')
  const ours = rules[1]
  assert.equal(ours.config.group, 'standard-personal')
  assert.equal(ours.config.api.type, 'openai-chat-completions')
  assert.equal(ours.config.api.baseUrl, 'http://127.0.0.1:10108/cn/v1')
  assert.equal(ours.config.access.apiKey, token)
  assert.deepEqual(ours.config.personalModelIds, ['hy3', 'glm-5.3'])
  assert.equal(ours.config.visibility, 'visible')

  // The other provider's model rules and the untouched manual rules survive.
  const modelRules = written.config.modelConfigRules.providerModelRules
  assert.deepEqual(modelRules.map((rule: any) => `${rule.providerId}/${rule.modelId}`), [
    'deepseek/deepseek-flash',
    'workbuddy-cn/hy3', 'workbuddy-cn/glm-5.3',
    'workbuddy-cn-anthropic/hy3', 'workbuddy-cn-anthropic/glm-5.3',
    'workbuddy-cn-responses/hy3', 'workbuddy-cn-responses/glm-5.3',
  ])
  assert.equal(written.config.modelConfigRules.manualProviderModelRules.length, 1)
})

test('model metadata mirrors the bridge catalog', async t => {
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
  assert.equal(hy3.config.optionSpecs.maxOutputTokens.map, '{"max_tokens": maxOutputTokens}')
  // A model with no advertised efforts must not offer a reasoning selector.
  assert.equal(hy3.config.optionSpecs.reasoningLevel, undefined)
  const glm = rules.find((rule: any) => rule.modelId === 'glm-5.3')
  assert.deepEqual(glm.config.optionSpecs.reasoningLevel.values, ['low', 'high', 'max'])
  assert.equal(glm.config.optionSpecs.reasoningLevel.map, '{"reasoning_effort": reasoningLevel}')

  // Each protocol's option map must write that protocol's own field names.
  const rulesFor = (providerId: string) => written.config.modelConfigRules.providerModelRules
    .filter((rule: any) => rule.providerId === providerId && rule.modelId === 'glm-5.3')[0]
  const anthropic = rulesFor('workbuddy-cn-anthropic')
  assert.equal(anthropic.config.optionSpecs.reasoningLevel.map, '{"output_config": {"effort": reasoningLevel}}')
  assert.equal(anthropic.config.optionSpecs.maxOutputTokens.map, '{"max_tokens": maxOutputTokens}')
  const responses = rulesFor('workbuddy-cn-responses')
  assert.equal(responses.config.optionSpecs.reasoningLevel.map, '{"reasoning": {"effort": reasoningLevel}}')
  assert.equal(responses.config.optionSpecs.maxOutputTokens.map, '{"max_output_tokens": maxOutputTokens}')
  const chat = rulesFor('workbuddy-cn')
  assert.equal(chat.config.optionSpecs.maxOutputTokens.map, '{"max_tokens": maxOutputTokens}')
})

test('free-only registration keeps just the zero-credit models', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const reports = await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({
    bridgeUrl, token, regions: ['cn'], freeOnly: true, configPath: f.path,
  }))
  assert.deepEqual(reports, [
    { provider: 'workbuddy-cn', region: 'cn', protocol: 'chat', action: 'installed', models: 1, freeModels: 1 },
    { provider: 'workbuddy-cn-anthropic', region: 'cn', protocol: 'anthropic', action: 'installed', models: 1, freeModels: 1 },
    { provider: 'workbuddy-cn-responses', region: 'cn', protocol: 'responses', action: 'installed', models: 1, freeModels: 1 },
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
  assert.deepEqual(reports.map(report => report.action), ['unchanged', 'unchanged', 'unchanged'])
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
  assert.deepEqual(reports.map(report => report.provider), ['workbuddy-cn', 'workbuddy-cn-anthropic', 'workbuddy-cn-responses'])
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
  assert.deepEqual(reports[0], { provider: 'workbuddy-cn', region: 'cn', protocol: 'chat', action: 'skipped', reason: 'not_owned' })
  const written = JSON.parse(await readFile(f.path, 'utf8'))
  assert.equal(written.config.providerConfigRules.providerRules.length, 2)
})

test('removal without a bridge URL still claims a loopback region endpoint', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(() => catalog([freeRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  assert.deepEqual((await removeZCode({ regions: ['cn'], configPath: f.path })).map(report => report.action), ['removed', 'removed', 'removed'])
})

test('an absent config is created instead of failing', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-zcode-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'nested', 'provider_config.json')
  await withFetch(() => catalog([freeRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: path }))
  const written = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(written.schemaVersion, 1)
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), ['workbuddy-cn', 'workbuddy-cn-anthropic', 'workbuddy-cn-responses'])
})

test('registration summary reads back what install wrote', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(() => catalog([freeRow, paidRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  assert.deepEqual((await readZCodeRegistration(f.path)).map(entry => [entry.provider, entry.protocol, entry.models]), [
    ['workbuddy-cn', 'chat', 2],
    ['workbuddy-cn-anthropic', 'anthropic', 2],
    ['workbuddy-cn-responses', 'responses', 2],
  ])
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
    'deepseek',
    'workbuddy-cn', 'workbuddy-cn-anthropic', 'workbuddy-cn-responses',
    'workbuddy-global', 'workbuddy-global-anthropic', 'workbuddy-global-responses',
  ])
  await removeZCode({ regions: ['cn'], configPath: f.path })
  const after = JSON.parse(await readFile(f.path, 'utf8'))
  assert.deepEqual(after.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), [
    'deepseek', 'workbuddy-global', 'workbuddy-global-anthropic', 'workbuddy-global-responses',
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

test('installing one protocol leaves the others untouched', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const reports = await withFetch(() => catalog([freeRow]), () => installZCode({
    bridgeUrl, token, regions: ['cn'], protocols: ['anthropic'], configPath: f.path,
  }))
  assert.deepEqual(reports, [
    { provider: 'workbuddy-cn-anthropic', region: 'cn', protocol: 'anthropic', action: 'installed', models: 1, freeModels: 1 },
  ])
  const written = JSON.parse(await readFile(f.path, 'utf8'))
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), ['deepseek', 'workbuddy-cn-anthropic'])
  const ours = written.config.providerConfigRules.providerRules[1]
  assert.equal(ours.config.api.type, 'anthropic-messages')
  assert.equal(ours.providerName, 'WorkBuddy CN · Anthropic')
  assert.deepEqual(written.config.modelConfigRules.providerModelRules.map((rule: any) => rule.providerId), ['deepseek', 'workbuddy-cn-anthropic'])
})

test('a protocol-scoped removal keeps the other protocol providers', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await withFetch(() => catalog([freeRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], configPath: f.path }))
  const reports = await removeZCode({ bridgeUrl, regions: ['cn'], protocols: ['responses'], configPath: f.path })
  assert.deepEqual(reports, [
    { provider: 'workbuddy-cn-responses', region: 'cn', protocol: 'responses', action: 'removed' },
  ])
  const written = JSON.parse(await readFile(f.path, 'utf8'))
  assert.deepEqual(written.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId), [
    'deepseek', 'workbuddy-cn', 'workbuddy-cn-anthropic',
  ])
})

test('an unknown protocol is refused before any write', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  await assert.rejects(
    () => withFetch(() => catalog([freeRow]), () => installZCode({ bridgeUrl, token, regions: ['cn'], protocols: ['gemini' as any], configPath: f.path })),
    /protocols must contain/,
  )
  assert.equal(await readFile(f.path, 'utf8'), existingConfig())
})

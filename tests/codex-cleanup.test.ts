import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { codexProvidersFromText, defaultCodexConfigPath, listCodexProviders, pruneCodex } from '../src/codex-cleanup.ts'

const token = 'bridge-token-abcdefghijklmnopqrstuvwxyz'

/** A config shaped like the real one after 1.4's install-codex ran and was disabled by hand. */
function configWithRetiredBlock(): string {
  return [
    '# Codex CLI config',
    '',
    'model = "deepseek-flash"',
    'model_provider = "deepseek-direct"',
    'model_catalog_json = "C:\\\\Users\\\\me\\\\.codex\\\\models.json"',
    '',
    '[model_providers.deepseek-direct]',
    'name = "DeepSeek (official)"',
    'base_url = "https://api.deepseek.com"',
    'wire_api = "responses"',
    '',
    '[desktop]',
    'autoArchiveAfterDays = 7',
    '',
    '# >>> workbuddy-connect >>> (2026-10-24 disabled)',
    '# [model_providers.workbuddy]',
    '# name = "WorkBuddy CN"',
    '# base_url = "http://127.0.0.1:10108/cn/v1"',
    '# wire_api = "responses"',
    `# experimental_bearer_token = "${token}"`,
    '# restore model = "glm-5.3-flash"',
    '# <<< workbuddy-connect <<<',
    '',
    '[mcp_servers.cua_repl]',
    'command = "node.exe"',
    'enabled = true',
    '',
  ].join('\n')
}

async function fixture(text = configWithRetiredBlock()) {
  const root = await mkdtemp(join(process.cwd(), '.test-codex-'))
  const configPath = join(root, 'config.toml')
  await writeFile(configPath, text)
  return { root, configPath, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('providers are read from active and commented tables alike', () => {
  const providers = codexProvidersFromText(configWithRetiredBlock())
  assert.deepEqual(providers.map(entry => entry.id), ['deepseek-direct', 'workbuddy'])
  assert.deepEqual(providers.map(entry => entry.active), [true, false])
  assert.deepEqual(providers.map(entry => entry.retired), [false, true])
  const direct = providers[0]
  assert.equal(direct.baseUrl, 'https://api.deepseek.com')
  assert.equal(direct.wireApi, 'responses')
  assert.equal(direct.name, 'DeepSeek (official)')
})

test('a commented table still reports the values the installer wrote', () => {
  const workbuddy = codexProvidersFromText(configWithRetiredBlock()).find(entry => entry.retired)!
  assert.equal(workbuddy.baseUrl, 'http://127.0.0.1:10108/cn/v1')
  assert.equal(workbuddy.name, 'WorkBuddy CN')
  assert.equal(workbuddy.active, false)
})

test('prune removes the marker block, the token and nothing else', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const report = await pruneCodex({ configPath: f.configPath })
  assert.equal(report.blockRemoved, true)
  assert.deepEqual(report.tablesRemoved, [])
  assert.equal(report.catalogRemoved, undefined, 'no catalog file exists in this fixture')

  const after = await readFile(f.configPath, 'utf8')
  assert.doesNotMatch(after, /workbuddy-connect/)
  assert.doesNotMatch(after, /experimental_bearer_token/, 'the retired block carried the bridge key')
  // Everything unrelated survives byte for byte.
  for (const keep of ['model = "deepseek-flash"', 'model_provider = "deepseek-direct"', '[model_providers.deepseek-direct]',
    'base_url = "https://api.deepseek.com"', '[desktop]', 'autoArchiveAfterDays = 7',
    '[mcp_servers.cua_repl]', 'command = "node.exe"']) {
    assert.ok(after.includes(keep), `expected to keep: ${keep}`)
  }
})

test('prune also drops a live workbuddy table left outside the marked block', async t => {
  const text = [
    'model = "x"',
    '',
    '[model_providers.workbuddy]',
    'name = "WorkBuddy CN"',
    'base_url = "http://127.0.0.1:10108/cn/v1"',
    'wire_api = "responses"',
    '',
    '[tui]',
    'screen_reader_detection_done = true',
    '',
  ].join('\n')
  const f = await fixture(text)
  t.after(f.cleanup)
  const report = await pruneCodex({ configPath: f.configPath })
  assert.equal(report.blockRemoved, false)
  assert.deepEqual(report.tablesRemoved, ['workbuddy'])

  const after = await readFile(f.configPath, 'utf8')
  assert.doesNotMatch(after, /model_providers\.workbuddy/)
  assert.match(after, /\[tui\]/)
  assert.match(after, /screen_reader_detection_done = true/)
})

test('prune deletes the generated catalog when nothing reads it', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const catalogPath = join(f.root, 'workbuddy-models.json')
  await writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'hy3' }] }))
  const report = await pruneCodex({ configPath: f.configPath })
  assert.equal(report.catalogRemoved, catalogPath)
  assert.equal(existsSync(catalogPath), false)
})

test('prune keeps a catalog the live config still points at', async t => {
  const text = configWithRetiredBlock().replace(
    'model_catalog_json = "C:\\\\Users\\\\me\\\\.codex\\\\models.json"',
    'model_catalog_json = "C:\\\\Users\\\\me\\\\.codex\\\\workbuddy-models.json"',
  )
  const f = await fixture(text)
  t.after(f.cleanup)
  const catalogPath = join(f.root, 'workbuddy-models.json')
  await writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'hy3' }] }))
  const report = await pruneCodex({ configPath: f.configPath })
  assert.equal(report.catalogKept, catalogPath)
  assert.equal(report.catalogRemoved, undefined)
  assert.equal(existsSync(catalogPath), true, 'a catalog the config still reads must survive')
})

test('prune on an already clean config changes nothing', async t => {
  const text = 'model = "x"\n\n[desktop]\nautoArchiveAfterDays = 7\n'
  const f = await fixture(text)
  t.after(f.cleanup)
  const report = await pruneCodex({ configPath: f.configPath })
  assert.equal(report.blockRemoved, false)
  assert.deepEqual(report.tablesRemoved, [])
  assert.equal(await readFile(f.configPath, 'utf8'), text)
})

test('prune refuses a missing config instead of creating one', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-codex-absent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(() => pruneCodex({ configPath: join(root, 'config.toml') }), /nothing to prune/)
})

test('listing a missing config returns an empty list', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-codex-list-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await listCodexProviders(join(root, 'config.toml')), [])
})

test('the default config path follows CODEX_HOME when absolute', () => {
  const original = process.env.CODEX_HOME
  try {
    delete process.env.CODEX_HOME
    assert.match(defaultCodexConfigPath(), /\.codex[\\/]config\.toml$/)
    process.env.CODEX_HOME = 'relative/dir'
    assert.match(defaultCodexConfigPath(), /\.codex[\\/]config\.toml$/, 'a relative CODEX_HOME is ignored')
    const absolute = process.platform === 'win32' ? 'C:\\custom-codex' : '/tmp/custom-codex'
    process.env.CODEX_HOME = absolute
    assert.equal(defaultCodexConfigPath(), join(absolute, 'config.toml'))
  } finally {
    if (original === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = original
  }
})

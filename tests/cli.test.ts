import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { bridgeIsDown, parseRegionChoice, programName, regionsOf, removalIsBlocked, signedInRegions, usage } from '../src/cli.ts'
import { packageVersion } from '../src/version.ts'

test('auto selection uses only regions with a read-only signed-in status', () => {
  assert.deepEqual(signedInRegions({
    cn: { state: 'signed-in' },
    global: { state: 'signed-out' },
  }), ['cn'])
  assert.deepEqual(signedInRegions({
    cn: { state: 'signed-out' },
    global: { state: 'signed-in' },
  }), ['global'])
  assert.deepEqual(signedInRegions({
    cn: { state: 'signed-out' },
    global: { state: 'signed-out' },
  }), [])
})

test('region choices support explicit one, both, and auto only', () => {
  assert.equal(parseRegionChoice(undefined), 'auto')
  assert.equal(parseRegionChoice('both'), 'both')
  assert.throws(() => parseRegionChoice('all'), /auto, cn, global, or both/)
})

test('uninstall does not continue after an ownership skip', () => {
  assert.equal(removalIsBlocked([{ provider: 'workbuddy-cn', region: 'cn', action: 'skipped', reason: 'not_found' }]), false)
  assert.equal(removalIsBlocked([{ provider: 'workbuddy-cn', region: 'cn', action: 'skipped', reason: 'not_owned' }]), true)
})

test('auto and both expand to two regions, explicit choices stay single', () => {
  assert.deepEqual(regionsOf('auto'), ['cn', 'global'])
  assert.deepEqual(regionsOf('both'), ['cn', 'global'])
  assert.deepEqual(regionsOf('cn'), ['cn'])
  assert.deepEqual(regionsOf('global'), ['global'])
})

test('program name follows how the CLI was started', () => {
  assert.equal(programName('C:\\app\\node_modules\\.bin\\workbuddy-connect'), 'workbuddy-connect')
  assert.equal(programName('/usr/local/bin/workbuddy-connect'), 'workbuddy-connect')
  // 安装后 argv[1] 是包内的 bin/cli.mjs：名字靠 moduleUrl 是否在 node_modules 里判断。
  assert.equal(programName('C:\\app\\node_modules\\workbuddy-connect\\bin\\cli.mjs', 'file:///C:/app/node_modules/workbuddy-connect/bin/cli.mjs'), 'workbuddy-connect')
  // 仓库里直跑：仍然是 node src/cli.ts。
  assert.equal(programName('D:\\repo\\bin\\cli.mjs', 'file:///D:/repo/bin/cli.mjs'), 'node src/cli.ts')
  assert.equal(programName('D:\\repo\\src\\cli.ts', 'file:///D:/repo/src/cli.ts'), 'node src/cli.ts')
})

test('usage names every command and the two universal flags', () => {
  const text = usage('workbuddy-connect')
  for (const command of ['serve', 'status', 'accounts', 'models', 'install', 'remove', 'smoke']) {
    assert.match(text, new RegExp(`\\b${command}\\b`))
  }
  assert.match(text, /--help/)
  assert.match(text, /--version/)
  // The retired multi-protocol surface must not come back through the help text.
  assert.doesNotMatch(text, /install-codex|--protocol/)
  assert.ok(text.startsWith('Usage: workbuddy-connect'))
})

test('a refused local connection is reported as "bridge not running"', () => {
  assert.equal(bridgeIsDown({ cause: { code: 'ECONNREFUSED' } }), true)
  assert.equal(bridgeIsDown({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }), true)
  assert.equal(bridgeIsDown({ message: 'connect ECONNREFUSED 127.0.0.1:10108' }), true)
  assert.equal(bridgeIsDown({ cause: { code: 'ETIMEDOUT' } }), false)
  assert.equal(bridgeIsDown(undefined), false)
})

test('the reported version comes from package.json, so it cannot drift', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageVersion(), manifest.version)
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/)
})

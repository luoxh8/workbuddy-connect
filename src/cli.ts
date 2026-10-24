#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { RegionCredentialStore } from './auth.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { createBridge, type Region } from './server.ts'
import { writeJsonAtomic } from './storage.ts'
import { packageName, packageVersion } from './version.ts'
import type { ZCodeRemoveReport } from './zcode.ts'

export type RegionChoice = 'auto' | 'cn' | 'global' | 'both'
export type State = { version: 1; token: string; port: number }

type ParsedArgs = ReturnType<typeof parseArgs>
let args: ParsedArgs
let command: string
let stateDir: string
let stateFile: string

/**
 * Default bridge home. `~/.workbuddy-connect` is the product's own location;
 * older installs kept their token and port under `~/.zcode/workbuddy-connect`,
 * so migrate that directory once (rename keeps the token, which is what every
 * already-registered client uses) and fall back to it if the rename is blocked.
 */
export function defaultStateDir(): string {
  const next = join(homedir(), '.workbuddy-connect')
  const legacy = join(homedir(), '.zcode', 'workbuddy-connect')
  if (!existsSync(next) && existsSync(legacy)) {
    try {
      renameSync(legacy, next)
    } catch {
      return legacy
    }
  }
  return next
}

/**
 * 命令行里显示的程序名。
 * - npm 安装后：argv[1] 是包内的 `bin/cli.mjs`（basename 只剩 `cli`），此时用包名；
 * - 仓库里直跑：`node src/cli.ts`，因为 `cli.ts` 不是可执行文件名。
 */
export function programName(argv1: string | undefined = process.argv[1], moduleUrl: string = import.meta.url): string {
  // 两种分隔符都认：Windows 路径可能在 Linux 上出现在 argv 里（测试、CI 日志），
  // 而 path.basename 只认当前平台的分隔符。
  const segments = (argv1 ?? '').replace(/\\/g, '/').split('/')
  const name = (segments.pop() ?? '').replace(/\.(?:mjs|cjs|js|ts)$/i, '')
  if (name !== '' && name !== 'cli') return name
  if (/[\\/]node_modules[\\/]/.test(moduleUrl)) return packageName()
  return 'node src/cli.ts'
}

export function usage(program = programName()): string {
  return [
    `Usage: ${program} <command> [options]`,
    '',
    'Commands:',
    '  serve                 run the bridge in the foreground (127.0.0.1:10108)',
    '  status                bridge health + region sign-in state (default command)',
    '  accounts              read-only WorkBuddy desktop login state',
    '  models                model catalog for a region, with billing badges',
    '  install               register/refresh this bridge as a ZCode provider',
    '  remove                remove only the provider entries this bridge added',
    '  providers             list every provider in the ZCode registry (read-only)',
    '  prune                 delete providers left by retired bridge layouts; works',
    '                        without the bridge running',
    '  install-codex         register this bridge in ~/.codex/config.toml (Codex CLI',
    '                        and the ChatGPT desktop app share that file)',
    '  remove-codex          undo install-codex, keeping unrelated providers',    '  smoke                 one real call through the bridge (spends credits).',
    '                        Requires --region cn|global --model ID',
    '',
    'The bridge serves one wire protocol only: OpenAI Responses',
    '(<base>/<region>/v1/responses). ZCode registers it as `openai-responses`, and',
    'Codex speaks `wire_api = "responses"`, so both clients reach the same route.',
    '',
    'Options:',
    '  --region <auto|cn|global|both>   which region to touch (default: auto)',
    '  --model <id>                     required by smoke',
    '  --prompt <text>                  smoke prompt (default: a fixed ping)',
    '  --state-dir <path>               bridge home (default: ~/.workbuddy-connect)',
    '  --port <1024-65535>              bridge port (default: 10108)',
    '  --config <path>                  ZCode provider config to edit',
    '  --codex-config <path>            Codex config (default: $CODEX_HOME or',
    '                                   ~/.codex/config.toml)',
    '  --free-only                      install: register only free (x0.00) models',
    '  --keep-default                   install-codex: add the provider and catalog but',
    '                                   leave model/model_provider pointing where they',
    '                                   already point',
    '  -h, --help                       this text',
    '  -v, --version                    print the version',
  ].join('\n')
}

function initializeArguments(): void {
  try {
    args = parseArgs({ allowPositionals: true, options: {
      'state-dir': { type: 'string' }, port: { type: 'string' }, region: { type: 'string' },
      model: { type: 'string' }, prompt: { type: 'string' }, config: { type: 'string' },
      'codex-config': { type: 'string' }, 'codex-catalog': { type: 'string' },
      'free-only': { type: 'boolean' }, 'keep-default': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    } })
  } catch (error: any) {
    throw new Error(`${error.message}\nRun ${programName()} --help for usage`)
  }
  command = args.positionals[0] ?? 'status'
  stateDir = resolve(args.values['state-dir'] ?? process.env.WORKBUDDY_BRIDGE_HOME ?? defaultStateDir())
  stateFile = join(stateDir, 'bridge.json')
}

/** auto/both 展开成两个区域，其余原样成单元素数组。 */
export function regionsOf(choice: RegionChoice): Region[] {
  return choice === 'auto' || choice === 'both' ? ['cn', 'global'] : [choice]
}

export function parseRegionChoice(value: string | undefined): RegionChoice {
  const choice = value ?? 'auto'
  if (choice === 'auto' || choice === 'cn' || choice === 'global' || choice === 'both') return choice
  throw new Error('Region must be auto, cn, global, or both')
}

export function signedInRegions(status: Record<Region, { state?: unknown }>): Region[] {
  return (['cn', 'global'] as const).filter(region => status[region]?.state === 'signed-in')
}

export function removalIsBlocked(reports: readonly ZCodeRemoveReport[]): boolean {
  return reports.some(report => report.action === 'skipped' && report.reason === 'not_owned')
}

/** 连接被拒 = 桥没在跑（本机端口不会出现 DNS/TLS 这类失败）。 */
export function bridgeIsDown(error: any): boolean {
  const code = error?.cause?.code ?? error?.code
  if (code === 'ECONNREFUSED') return true
  return /ECONNREFUSED|fetch failed|connect ECONNREFUSED/i.test(String(error?.message ?? ''))
}

function portFromArgs(): number | undefined {
  if (args.values.port === undefined) return undefined
  const port = Number(args.values.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535')
  return port
}

async function state(create = false): Promise<State> {
  const requestedPort = portFromArgs()
  try {
    const data = JSON.parse(await readFile(stateFile, 'utf8'))
    if (data.version !== 1 || typeof data.token !== 'string' || data.token.length < 24 || !Number.isInteger(data.port)) throw new Error('Invalid bridge state')
    if (requestedPort !== undefined && requestedPort !== data.port) {
      throw new Error(`Bridge state already uses port ${data.port}; choose that port or remove only this bridge state first`)
    }
    return data
  } catch (error: any) {
    if (error.code !== 'ENOENT' || !create) throw error
    const port = requestedPort ?? 10108
    const data: State = { version: 1, token: randomBytes(32).toString('base64url'), port }
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    try { await writeFile(stateFile, JSON.stringify(data), { flag: 'wx', mode: 0o600 }) }
    catch (cause: any) { if (cause.code === 'EEXIST') return state(); throw cause }
    return data
  }
}

function storesFor(directory: string): Record<Region, RegionCredentialStore> {
  const client = new WorkBuddyUpstreamClient()
  return Object.fromEntries((['cn', 'global'] as const).map(region => [region, new RegionCredentialStore({
    region, stateDir: directory,
    desktopPath: process.env[region === 'cn' ? 'WORKBUDDY_CN_AUTH_FILE' : 'WORKBUDDY_GLOBAL_AUTH_FILE'],
    refresh: credential => client.refreshToken(credential),
  })])) as Record<Region, RegionCredentialStore>
}

async function selectedInstallRegions(choice: RegionChoice): Promise<Region[]> {
  const stores = storesFor(stateDir)
  const statuses = Object.fromEntries(await Promise.all((['cn', 'global'] as const).map(async region => [region, await stores[region].status()]))) as Record<Region, { state: string }>
  const selected: Region[] = choice === 'auto' ? signedInRegions(statuses) : choice === 'both' ? ['cn', 'global'] : [choice]
  const missing = selected.filter(region => statuses[region].state !== 'signed-in')
  if (missing.length > 0) throw new Error(`No signed-in WorkBuddy desktop account for: ${missing.join(', ')}. Sign in there first, then retry.`)
  if (selected.length === 0) throw new Error('No signed-in WorkBuddy CN or Global desktop account was found. Sign in to one region first.')
  return selected
}

export async function main(): Promise<void> {
  initializeArguments()
  const program = programName()
  if (args.values.version === true) { console.log(packageVersion()); return }
  if (args.values.help === true || command === 'help') { console.log(usage(program)); return }
  if (command === 'accounts') {
    const stores = storesFor(stateDir)
    const regions = await Promise.all((['cn', 'global'] as const).map(async region => {
      const status = await stores[region].status()
      return { region, state: status.state, ...(status.domain === undefined ? {} : { domain: status.domain }), ...(status.expiresAtMs === undefined ? {} : { expiresAtMs: status.expiresAtMs }) }
    }))
    console.log(JSON.stringify({ regions }, null, 2))
    return
  }
  // These two only read and rewrite the ZCode registry: they must work while
  // the bridge is stopped, which is exactly when the stale entries matter.
  if (command === 'providers') {
    const { defaultProviderConfigPath, listZCodeProviders } = await import('./zcode.ts')
    const configPath = args.values.config ?? defaultProviderConfigPath()
    const providers = await listZCodeProviders(configPath)
    console.log(JSON.stringify({ providerConfig: configPath, providers }, null, 2))
    return
  }
  if (command === 'prune') {
    const { defaultProviderConfigPath, pruneLegacyZCode } = await import('./zcode.ts')
    const configPath = args.values.config ?? defaultProviderConfigPath()
    const reports = await pruneLegacyZCode({
      regions: regionsOf(parseRegionChoice(args.values.region)),
      ...args.values.config === undefined ? {} : { configPath: args.values.config },
    })
    console.log(JSON.stringify({ providerConfig: configPath, reports }, null, 2))
    if (removalIsBlocked(reports)) process.exitCode = 2
    return
  }
  let config: State
  try {
    config = await state(command === 'serve')
  } catch (error: any) {
    // 全新机器上先跑 status/install 时，状态文件还不存在：给出"先起一次桥"的动作提示。
    if (error?.code === 'ENOENT') throw new Error(`No bridge state in ${stateDir} yet. Start the bridge once with ${program} serve (or run the installer), then retry.`)
    throw error
  }
  const baseUrl = `http://127.0.0.1:${config.port}`
  const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }
  const regionChoice = parseRegionChoice(args.values.region)
  const request = async (path: string, init: RequestInit = {}) => {
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(command === 'smoke' ? 180_000 : 60_000),
      })
    } catch (error: any) {
      // 桥没起来是最常见的失败：fetch 只会给一句 "fetch failed"，这里换成能照做的提示。
      if (bridgeIsDown(error)) {
        const start = program === 'node src/cli.ts' ? 'node src/cli.ts serve' : `${program} serve`
        throw new Error(`Bridge is not running at ${baseUrl}. Start it with "${start}" (or scripts\\Start-Bridge.ps1), then retry.`)
      }
      throw error
    }
    const body = await response.json().catch(() => undefined) as any
    if (!response.ok) throw new Error(`Bridge HTTP ${response.status}: ${body?.error?.message ?? 'request failed'}`)
    return body
  }
  if (command === 'serve') {
    const stores = storesFor(stateDir)
    const bridge = createBridge({ token: config.token, port: config.port, stores, client: new WorkBuddyUpstreamClient() })
    const url = await bridge.listen()
    await writeJsonAtomic(join(stateDir, 'runtime.json'), { pid: process.pid, url, startedAt: new Date().toISOString() })
    console.log(JSON.stringify({ service: 'workbuddy-connect', url, pid: process.pid }))
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void bridge.close().then(() => process.exit(0)) })
    return
  }
  if (command === 'status') {
    console.log(JSON.stringify({ ...(await request('/healthz')), ...(await request('/status')) }, null, 2)); return
  }
  if (command === 'models') {
    for (const region of regionsOf(regionChoice)) {
      try { console.log(JSON.stringify({ region, ...(await request(`/${region}/v1/models`)) }, null, 2)) }
      catch (error: any) { console.log(JSON.stringify({ region, error: error.message })); process.exitCode = 1 }
    }
    return
  }
  if (command === 'install') {
    const regions = await selectedInstallRegions(regionChoice)
    const { defaultProviderConfigPath, installZCode } = await import('./zcode.ts')
    const configPath = args.values.config ?? defaultProviderConfigPath()
    console.log(JSON.stringify(await installZCode({
      bridgeUrl: baseUrl, token: config.token, regions,
      ...args.values.config === undefined ? {} : { configPath: args.values.config },
      ...args.values['free-only'] === true ? { freeOnly: true } : {},
    }), null, 2))
    // Name the file that was edited: with a custom Settings → Data directory,
    // the default path is not the registry the client actually reads.
    console.error(`provider config: ${configPath}`)
    return
  }
  if (command === 'remove') {
    const { removeZCode } = await import('./zcode.ts')
    const reports = await removeZCode({
      bridgeUrl: baseUrl, regions: regionsOf(regionChoice),
      ...args.values.config === undefined ? {} : { configPath: args.values.config },
    })
    console.log(JSON.stringify(reports, null, 2))
    if (removalIsBlocked(reports)) process.exitCode = 2
    return
  }
  if (command === 'smoke') {
    if ((regionChoice !== 'cn' && regionChoice !== 'global') || !args.values.model) throw new Error('smoke requires --region cn|global --model ID')
    const { smokeBody, smokeSummary, SMOKE_ROUTE } = await import('./smoke.ts')
    const body = await request(`/${regionChoice}/v1/${SMOKE_ROUTE}`, {
      method: 'POST', body: JSON.stringify(smokeBody(args.values.model, args.values.prompt)),
    })
    console.log(JSON.stringify({ region: regionChoice, model: args.values.model, ...smokeSummary(body) }, null, 2))
    return
  }
  if (command === 'install-codex') {
    const regions = await selectedInstallRegions(regionChoice)
    const { defaultCodexConfigPath, installCodex } = await import('./codex.ts')
    const configPath = args.values['codex-config'] ?? defaultCodexConfigPath()
    const reports = await installCodex({
      bridgeUrl: baseUrl, token: config.token, regions,
      ...args.values['codex-config'] === undefined ? {} : { configPath: args.values['codex-config'] },
      ...args.values['codex-catalog'] === undefined ? {} : { catalogPath: args.values['codex-catalog'] },
      ...args.values['free-only'] === true ? { freeOnly: true } : {},
      ...args.values['keep-default'] === true ? { keepDefaultProvider: true } : {},
    })
    console.log(JSON.stringify(reports, null, 2))
    // Codex reads one catalog file; name it so the merge note is actionable.
    console.error(`codex config: ${configPath}`)
    console.error('restart the ChatGPT desktop app (or start a new codex session) to pick up the change')
    return
  }
  if (command === 'remove-codex') {
    const { removeCodex } = await import('./codex.ts')
    const report = await removeCodex({
      ...args.values['codex-config'] === undefined ? {} : { configPath: args.values['codex-config'] },
      ...args.values['codex-catalog'] === undefined ? {} : { catalogPath: args.values['codex-catalog'] },
    })
    console.log(JSON.stringify(report, null, 2))
    return
  }
  throw new Error(`Unknown command: ${command}\nRun ${program} --help for usage`)
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}

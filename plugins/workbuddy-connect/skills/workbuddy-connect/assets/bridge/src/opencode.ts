/**
 * OpenCode provider registration.
 *
 * OpenCode reads a single JSON (or JSONC) document, so this module only owns
 * `providers.workbuddy` / `providers.workbuddy-global` and leaves every other
 * key — MCP servers, agents, plugins, the user's default model — untouched.
 *
 * The bridge speaks OpenAI Responses only, which maps to OpenCode's
 * `@opencode/ai/providers/openai-compatible/responses` package. Model metadata
 * (context window, vision input, reasoning efforts) is copied from
 * `<bridge>/<region>/v1/models` so the picker shows the catalog the account
 * actually has, and a reinstall refreshes it when WorkBuddy adds models.
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from './storage.ts'
import type { Region } from './server.ts'

/** Runtime package that speaks the Responses wire protocol. */
export const OPENCODE_PACKAGE = '@opencode/ai/providers/openai-compatible/responses'
const PROVIDER_PREFIX = 'workbuddy'
const REQUEST_TIMEOUT_MS = 30_000

export interface OpenCodeInstallOptions {
  bridgeUrl: string
  token: string
  regions: readonly Region[]
  configPath?: string
  freeOnly?: boolean
}

export interface OpenCodeInstallReport {
  configPath: string
  provider: string
  region: Region
  models: number
  freeModels: number
  action: 'installed' | 'updated' | 'unchanged'
}

export interface OpenCodeRemoveReport {
  configPath: string
  provider: string
  action: 'removed' | 'absent' | 'skipped'
  reason?: string
}

/** One model as the bridge's `/v1/models` advertises it. */
interface BridgeModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  supportsImages: boolean
  free: boolean
  reasons: boolean
  canDisableThinking: boolean
  efforts: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `$XDG_CONFIG_HOME/opencode/opencode.json`, falling back to
 * `~/.config/opencode/opencode.json`. A machine that already runs OpenCode
 * from a JSONC file keeps that file: it is the document the server reads.
 */
export function defaultOpenCodeConfigPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME']
  const directory = xdg !== undefined && xdg.trim() !== '' ? join(xdg, 'opencode') : join(homedir(), '.config', 'opencode')
  const json = join(directory, 'opencode.json')
  const jsonc = join(directory, 'opencode.jsonc')
  return !existsSync(json) && existsSync(jsonc) ? jsonc : json
}

/** Provider id for a region; `cn` keeps the bare id, mirroring the Codex client. */
export function opencodeProviderId(region: Region): string {
  return region === 'cn' ? PROVIDER_PREFIX : `${PROVIDER_PREFIX}-${region}`
}

export function opencodeProviderName(region: Region): string {
  return region === 'cn' ? 'WorkBuddy CN' : 'WorkBuddy Global'
}

/** The bridge serves Responses from `/<region>/v1`; that is the provider base URL. */
export function opencodeBaseUrl(bridgeUrl: string, region: Region): string {
  return `${bridgeUrl.replace(/\/+$/, '')}/${region}/v1`
}

/**
 * Strip `//` and `/* *\/` comments plus trailing commas so a JSONC document can
 * be read and rewritten as JSON. Strings are tracked, so a `//` inside a URL is
 * never mistaken for a comment.
 */
export function stripJsonComments(text: string): { json: string; hadComments: boolean } {
  let out = ''
  let hadComments = false
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    const next = text[index + 1]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === '/' && next === '/') {
      hadComments = true
      while (index < text.length && text[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      hadComments = true
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 1
      continue
    }
    out += char
  }
  // Trailing commas are legal in JSONC and illegal in JSON.
  const withoutTrailing = out.replace(/,(\s*[}\]])/g, '$1')
  if (withoutTrailing !== out) hadComments = true
  return { json: withoutTrailing, hadComments }
}

async function readConfig(path: string): Promise<{ config: Record<string, unknown>; hadComments: boolean }> {
  if (!existsSync(path)) return { config: {}, hadComments: false }
  const raw = await readFile(path, 'utf8')
  if (raw.trim() === '') return { config: {}, hadComments: false }
  const { json, hadComments } = stripJsonComments(raw)
  const parsed: unknown = JSON.parse(json)
  if (!isRecord(parsed)) throw new Error(`${path} does not contain a JSON object`)
  return { config: parsed, hadComments }
}

async function fetchBridgeModels(url: string, token: string, freeOnly: boolean): Promise<{ models: BridgeModel[]; free: number }> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`bridge /v1/models returned HTTP ${response.status}`)
  const body = await response.json() as { data?: unknown }
  const rows = Array.isArray(body.data) ? body.data : []
  const models: BridgeModel[] = []
  let free = 0
  for (const raw of rows) {
    if (!isRecord(raw) || typeof raw['id'] !== 'string') continue
    const reasoning = isRecord(raw['reasoning']) ? raw['reasoning'] : undefined
    const billing = isRecord(raw['billing']) ? raw['billing'] : undefined
    const isFree = billing?.['free'] === true
    const efforts = reasoning !== undefined && Array.isArray(reasoning['supportedEfforts'])
      ? reasoning['supportedEfforts'].filter((value): value is string => typeof value === 'string')
      : []
    if (isFree) free += 1
    if (freeOnly && !isFree) continue
    models.push({
      id: raw['id'],
      ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
      ...(typeof raw['context_window'] === 'number' ? { contextWindow: raw['context_window'] } : {}),
      ...(typeof raw['max_output_tokens'] === 'number' ? { maxTokens: raw['max_output_tokens'] } : {}),
      supportsImages: raw['supports_vision'] === true,
      free: isFree,
      reasons: reasoning?.['supports'] === true,
      canDisableThinking: reasoning?.['canDisableThinking'] === true,
      efforts,
    })
  }
  return { models, free }
}

/**
 * One OpenCode model entry, in the models.dev v2 shape OpenCode documents.
 *
 * `capabilities.reasoning` is what makes reasoning levels selectable as
 * variants (`workbuddy/<model>#high`); a model that reasons without adjustable
 * effort reports `supported: true` and no variant list.
 */
export function modelEntry(model: BridgeModel): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {
    tools: true,
    input: model.supportsImages ? ['text', 'image'] : ['text'],
    output: ['text'],
  }
  if (model.reasons) {
    const reasoning: Record<string, unknown> = { supported: true }
    if (model.canDisableThinking) reasoning['toggle'] = true
    if (model.efforts.length > 0) reasoning['effort'] = [...model.efforts]
    capabilities['reasoning'] = reasoning
  }
  return {
    name: model.name ?? model.id,
    capabilities,
    limit: {
      context: model.contextWindow !== undefined && model.contextWindow > 0 ? model.contextWindow : 200_000,
      output: model.maxTokens !== undefined && model.maxTokens > 0 ? model.maxTokens : 32_000,
    },
  }
}

function providerDocument(region: Region, bridgeUrl: string, token: string, models: readonly BridgeModel[]): Record<string, unknown> {
  return {
    name: opencodeProviderName(region),
    package: OPENCODE_PACKAGE,
    settings: { baseURL: opencodeBaseUrl(bridgeUrl, region), apiKey: token },
    models: Object.fromEntries(models.map(model => [model.id, modelEntry(model)])),
  }
}

function providersOf(config: Record<string, unknown>): Record<string, unknown> {
  const providers = config['providers']
  if (isRecord(providers)) return providers
  const created: Record<string, unknown> = {}
  config['providers'] = created
  return created
}

function regionsFor(value: readonly Region[] | undefined): Region[] {
  const regions = [...new Set(value ?? [])]
  if (regions.length === 0 || regions.some(region => region !== 'cn' && region !== 'global')) {
    throw new Error('regions must contain cn and/or global')
  }
  return regions
}

export async function installOpenCode(options: OpenCodeInstallOptions): Promise<OpenCodeInstallReport[]> {
  const configPath = resolve(options.configPath ?? defaultOpenCodeConfigPath())
  const { config, hadComments } = await readConfig(configPath)
  if (hadComments) {
    // The document is rewritten as JSON: every setting survives, comments do not.
    console.error(`${configPath} contained JSONC comments or trailing commas; they are not preserved by this rewrite`)
  }
  if (config['$schema'] === undefined) config['$schema'] = 'https://opencode.ai/config.json'
  const providers = providersOf(config)
  const regions = regionsFor(options.regions)
  const reports: OpenCodeInstallReport[] = []
  for (const region of regions) {
    const id = opencodeProviderId(region)
    const url = `${options.bridgeUrl.replace(/\/+$/, '')}/${region}/v1/models`
    const { models, free } = await fetchBridgeModels(url, options.token, options.freeOnly === true)
    const planned = providerDocument(region, options.bridgeUrl, options.token, models)
    const previous = providers[id]
    const unchanged = previous !== undefined && JSON.stringify(previous) === JSON.stringify(planned)
    providers[id] = planned
    reports.push({
      configPath,
      provider: id,
      region,
      models: models.length,
      freeModels: free,
      action: previous === undefined ? 'installed' : unchanged ? 'unchanged' : 'updated',
    })
  }
  if (reports.some(report => report.action !== 'unchanged')) await writeJsonAtomic(configPath, config)
  return reports
}

/**
 * Remove only the providers this module wrote. An entry the user has since
 * pointed elsewhere (different package or base URL) is reported as skipped, so
 * hand-made configuration is never deleted by an uninstall.
 */
export async function removeOpenCode(options: { bridgeUrl?: string; regions?: readonly Region[]; configPath?: string } = {}): Promise<OpenCodeRemoveReport[]> {
  const configPath = resolve(options.configPath ?? defaultOpenCodeConfigPath())
  if (!existsSync(configPath)) {
    return regionsFor(options.regions ?? ['cn', 'global']).map(region => ({ configPath, provider: opencodeProviderId(region), action: 'absent' as const }))
  }
  const { config } = await readConfig(configPath)
  const providers = config['providers']
  const reports: OpenCodeRemoveReport[] = []
  let changed = false
  for (const region of regionsFor(options.regions ?? ['cn', 'global'])) {
    const id = opencodeProviderId(region)
    const entry = isRecord(providers) ? providers[id] : undefined
    if (!isRecord(entry)) {
      reports.push({ configPath, provider: id, action: 'absent' })
      continue
    }
    const settings = isRecord(entry['settings']) ? entry['settings'] : {}
    const baseURL = typeof settings['baseURL'] === 'string' ? settings['baseURL'] : undefined
    const owns = entry['package'] === OPENCODE_PACKAGE
      && baseURL !== undefined
      && (options.bridgeUrl === undefined || baseURL === opencodeBaseUrl(options.bridgeUrl, region))
    if (!owns) {
      reports.push({ configPath, provider: id, action: 'skipped', reason: 'not_owned' })
      continue
    }
    delete (providers as Record<string, unknown>)[id]
    changed = true
    reports.push({ configPath, provider: id, action: 'removed' })
  }
  if (changed) await writeJsonAtomic(configPath, config)
  return reports
}

/** Directory that holds the OpenCode config, exported for reporting. */
export function defaultOpenCodeConfigDirectory(): string {
  return dirname(defaultOpenCodeConfigPath())
}

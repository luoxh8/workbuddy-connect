/**
 * ZCode provider registration for the loopback WorkBuddy bridge.
 *
 * ZCode has no plugin-facing provider API, so the personal provider registry is
 * edited directly: `<home>/.zcode/v2/provider_config.json`. That file is the
 * client's own personal config — the same one Settings → Models writes — and it
 * is a single strict document, so every write is a full-document atomic
 * replace that preserves unrelated providers, rules and ordering.
 *
 * Only the bridge's own entries are ever touched: a provider is claimed by
 * `providerId`, and removal additionally re-checks the stored base URL and API
 * format, so a provider a user re-pointed elsewhere is left alone.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { readJsonFile, writeJsonAtomic } from './storage.ts'

export type ZCodeRegion = 'cn' | 'global'

export interface ZCodeInstallOptions {
  /** Loopback bridge origin, e.g. `http://127.0.0.1:10108`. */
  bridgeUrl: string
  /** The bridge's own Bearer key; it becomes the provider's API key. */
  token: string
  regions?: readonly ZCodeRegion[]
  /** Register only models WorkBuddy currently bills at zero credits. */
  freeOnly?: boolean
  /** Test or portable override; production defaults to the ZCode personal config. */
  configPath?: string
}

export interface ZCodeRemoveOptions {
  regions?: readonly ZCodeRegion[]
  bridgeUrl?: string
  configPath?: string
}

export interface ZCodeInstallReport {
  provider: string
  region: ZCodeRegion
  action: 'installed' | 'updated' | 'unchanged'
  models: number
  freeModels: number
}

export interface ZCodeRemoveReport {
  provider: string
  region: ZCodeRegion
  action: 'removed' | 'skipped'
  reason?: 'not_found' | 'not_owned'
}

type JsonRecord = Record<string, unknown>

/** One model as the bridge's `/v1/models` advertises it. */
interface BridgeModel {
  id: string
  contextWindow?: number
  maxTokens?: number
  supportsImages: boolean
  free: boolean
  credits?: string
  reasoningEfforts?: readonly string[]
}

const API_FORMAT = 'openai-chat-completions'
const GROUP = 'standard-personal'
const DEFAULT_REGIONS: readonly ZCodeRegion[] = ['cn', 'global']
const REQUEST_TIMEOUT_MS = 30_000
const SUPPORTED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function regionsFor(value: readonly ZCodeRegion[] | undefined): ZCodeRegion[] {
  const regions = value === undefined ? [...DEFAULT_REGIONS] : [...new Set(value)]
  if (regions.length === 0 || regions.some(region => region !== 'cn' && region !== 'global')) {
    throw new Error('regions must contain cn and/or global')
  }
  return regions
}

/** Provider identifiers owned by this bridge. */
export function providerIdFor(region: ZCodeRegion): string {
  return `workbuddy-${region}`
}

export function providerDisplayName(region: ZCodeRegion): string {
  return region === 'cn' ? 'WorkBuddy CN' : 'WorkBuddy Global'
}

/** The region's bridge base URL, as stored in the provider's `api.baseUrl`. */
export function bridgeRegionBaseUrl(bridgeUrl: string, region: ZCodeRegion): string {
  let parsed: URL
  try { parsed = new URL(bridgeUrl) } catch { throw new Error('bridgeUrl must be an absolute HTTP loopback URL') }
  const hostname = parsed.hostname.toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  if (parsed.protocol !== 'http:' || !loopback || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('bridgeUrl must be an absolute HTTP loopback URL')
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new Error('bridgeUrl must not include a path')
  return `${parsed.origin}/${region}/v1`
}

/**
 * Resolve the personal provider config. `ZCODE_PROVIDER_CONFIG` is honoured
 * only as an absolute path, so a relative value cannot silently retarget the
 * write into the current directory.
 */
export function defaultProviderConfigPath(): string {
  const configured = process.env['ZCODE_PROVIDER_CONFIG']?.trim()
  if (configured !== undefined && configured !== '' && isAbsolute(configured)) return configured
  const home = process.env['ZCODE_HOME']?.trim()
  const root = home !== undefined && home !== '' && isAbsolute(home) ? home : join(homedir(), '.zcode')
  return join(root, 'v2', 'provider_config.json')
}

async function readConfig(path: string): Promise<JsonRecord> {
  const value = await readJsonFile(path)
  if (value === undefined) {
    return {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }
  }
  if (!isRecord(value)) throw new Error('The ZCode provider config is not a JSON object; it was not changed')
  return value
}

function configBody(document: JsonRecord): JsonRecord {
  const config = document['config']
  if (!isRecord(config)) throw new Error('The ZCode provider config has no `config` object; it was not changed')
  return config
}

function rulesArray(holder: JsonRecord, key: string): unknown[] {
  const value = holder[key]
  return Array.isArray(value) ? value : []
}

function arraySection(holder: JsonRecord, key: string): unknown[] {
  const value = holder[key]
  if (!Array.isArray(value)) {
    const created: unknown[] = []
    holder[key] = created
    return created
  }
  return value
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Bridge catalog row → the metadata ZCode's model rule needs. */
function bridgeModels(body: unknown, freeOnly: boolean): { models: BridgeModel[], free: number } {
  if (!isRecord(body) || !Array.isArray(body['data'])) throw new Error('WorkBuddy bridge returned an invalid model catalog')
  const seen = new Set<string>()
  const models: BridgeModel[] = []
  for (const raw of body['data']) {
    if (!isRecord(raw) || typeof raw['id'] !== 'string' || raw['id'].trim() === '' || seen.has(raw['id'])) continue
    const billing = isRecord(raw['billing']) ? raw['billing'] : {}
    const free = billing['free'] === true
    if (freeOnly && !free) continue
    seen.add(raw['id'])
    const reasoning = isRecord(raw['reasoning']) ? raw['reasoning'] : {}
    const rawEfforts = reasoning['supportedEfforts']
    const efforts = Array.isArray(rawEfforts)
      ? SUPPORTED_EFFORTS.filter(effort => rawEfforts.includes(effort))
      : []
    models.push({
      id: raw['id'],
      contextWindow: positiveInteger(raw['context_window']) ?? positiveInteger(raw['context_length']),
      maxTokens: positiveInteger(raw['max_output_tokens']),
      supportsImages: raw['supports_vision'] === true,
      free,
      ...(typeof billing['credits'] === 'string' && billing['credits'] !== '' ? { credits: billing['credits'] } : {}),
      ...efforts.length === 0 ? {} : { reasoningEfforts: efforts },
    })
  }
  if (models.length === 0) {
    throw new Error(freeOnly
      ? 'WorkBuddy reported no free models for this account; rerun without --free-only'
      : 'WorkBuddy bridge returned no usable models')
  }
  return { models, free: models.filter(model => model.free).length }
}

/** The ZCode model rule for one bridge model. */
function modelRule(providerId: string, model: BridgeModel): JsonRecord {
  const contextWindow = model.contextWindow ?? 200_000
  const properties: JsonRecord = {
    requiresMfjsToolSchema: false,
    contextWindow,
    inputFormat: {
      supportsText: true,
      supportsImage: model.supportsImages,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    // Every WorkBuddy catalog model advertises tool calls; the bridge rejects an
    // image the model cannot read before the request reaches the upstream.
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  }
  const optionSpecs: JsonRecord = {}
  if (model.reasoningEfforts !== undefined) {
    optionSpecs['reasoningLevel'] = {
      values: [...model.reasoningEfforts],
      // The bridge forwards `reasoning_effort` only when the model declares it.
      map: '{"reasoning_effort": reasoningLevel}',
    }
  }
  if (model.maxTokens !== undefined) {
    optionSpecs['maxOutputTokens'] = { max: model.maxTokens, map: '{"max_tokens": maxOutputTokens}' }
  }
  return {
    providerId,
    modelId: model.id,
    config: {
      enabled: true,
      properties,
      ...Object.keys(optionSpecs).length === 0 ? {} : { optionSpecs },
    },
  }
}

function providerRule(providerId: string, region: ZCodeRegion, baseUrl: string, token: string, modelIds: readonly string[]): JsonRecord {
  return {
    providerId,
    providerName: providerDisplayName(region),
    enabled: true,
    config: {
      group: GROUP,
      access: { type: 'api-key', apiKey: token },
      api: { type: API_FORMAT, baseUrl },
      personalModelIds: [...modelIds],
      modelOrder: [...modelIds],
      visibility: 'visible',
    },
  }
}

/** True when an existing rule is the one this bridge wrote for that region. */
function isOwnProvider(rule: unknown, providerId: string): boolean {
  return isRecord(rule) && rule['providerId'] === providerId
}

/** True when a stored provider still points at this bridge's region endpoint. */
function ownsBaseUrl(rule: JsonRecord, region: ZCodeRegion): boolean {
  const config = rule['config']
  if (!isRecord(config)) return false
  const api = config['api']
  if (!isRecord(api) || api['type'] !== API_FORMAT || typeof api['baseUrl'] !== 'string') return false
  try {
    const parsed = new URL(api['baseUrl'])
    const hostname = parsed.hostname.toLowerCase()
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
    return loopback && parsed.pathname.replace(/\/+$/, '') === `/${region}/v1`
  } catch {
    return false
  }
}

async function fetchBridgeModels(baseUrl: string, token: string, region: ZCodeRegion, freeOnly: boolean): Promise<{ models: BridgeModel[], free: number }> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new Error(`WorkBuddy ${region} model discovery failed; is the bridge running?`)
  }
  if (!response.ok) throw new Error(`WorkBuddy ${region} model discovery failed (HTTP ${response.status})`)
  return bridgeModels(await response.json().catch(() => undefined), freeOnly)
}

/**
 * Register one provider per selected region. The bridge catalog is fetched
 * before any write, so an unreachable region cannot leave a half-written file.
 */
export async function installZCode(options: ZCodeInstallOptions): Promise<ZCodeInstallReport[]> {
  if (options.token.trim().length < 24) throw new Error('Bridge token must contain at least 24 characters')
  const regions = regionsFor(options.regions)
  const configPath = options.configPath ?? defaultProviderConfigPath()
  const catalogs = new Map<ZCodeRegion, { models: BridgeModel[], free: number }>()
  for (const region of regions) {
    catalogs.set(region, await fetchBridgeModels(bridgeRegionBaseUrl(options.bridgeUrl, region), options.token, region, options.freeOnly === true))
  }

  const before = await readConfig(configPath)
  const after = structuredClone(before)
  const body = configBody(after)
  const providerRules = body['providerConfigRules']
  if (!isRecord(providerRules)) throw new Error('The ZCode provider config has no `providerConfigRules`; it was not changed')
  const rules = rulesArray(providerRules, 'providerRules')
  const modelConfigRules = body['modelConfigRules']
  if (!isRecord(modelConfigRules)) throw new Error('The ZCode provider config has no `modelConfigRules`; it was not changed')
  const modelRules = arraySection(modelConfigRules, 'providerModelRules')

  const reports: ZCodeInstallReport[] = []
  for (const region of regions) {
    const providerId = providerIdFor(region)
    const baseUrl = bridgeRegionBaseUrl(options.bridgeUrl, region)
    const catalog = catalogs.get(region)!
    const modelIds = catalog.models.map(model => model.id)
    const nextProvider = providerRule(providerId, region, baseUrl, options.token, modelIds)
    const ownedModelRules = catalog.models.map(model => modelRule(providerId, model))

    const existingIndex = rules.findIndex(rule => isOwnProvider(rule, providerId))
    const previousProvider = existingIndex === -1 ? undefined : rules[existingIndex]
    const previousModelRules = modelRules.filter(rule => isRecord(rule) && rule['providerId'] === providerId)

    if (existingIndex === -1) rules.push(nextProvider)
    else rules[existingIndex] = { ...(isRecord(rules[existingIndex]) ? rules[existingIndex] as JsonRecord : {}), ...nextProvider }

    // A model rule for another provider is never touched; ours are replaced
    // wholesale so a model that left the WorkBuddy catalog also leaves ZCode.
    const kept = modelRules.filter(rule => !(isRecord(rule) && rule['providerId'] === providerId))
    kept.push(...ownedModelRules)

    const unchanged = previousProvider !== undefined
      && isDeepStrictEqual(previousProvider, nextProvider)
      && isDeepStrictEqual(previousModelRules, ownedModelRules)
    reports.push({
      provider: providerId,
      region,
      action: existingIndex === -1 ? 'installed' : unchanged ? 'unchanged' : 'updated',
      models: modelIds.length,
      freeModels: catalog.free,
    })

    const target = arraySection(modelConfigRules, 'providerModelRules')
    target.length = 0
    target.push(...kept)
    providerRules['providerRules'] = rules
  }

  if (!isDeepStrictEqual(before, after)) await writeJsonAtomic(configPath, after)
  return reports
}

/** Remove only this bridge's providers and their model rules. */
export async function removeZCode(options: ZCodeRemoveOptions = {}): Promise<ZCodeRemoveReport[]> {
  const regions = regionsFor(options.regions)
  const configPath = options.configPath ?? defaultProviderConfigPath()
  const before = await readConfig(configPath)
  const after = structuredClone(before)
  const body = configBody(after)
  const providerRules = body['providerConfigRules']
  const modelConfigRules = body['modelConfigRules']
  if (!isRecord(providerRules) || !isRecord(modelConfigRules)) throw new Error('The ZCode provider config is not shaped like a personal provider registry')
  const rules = rulesArray(providerRules, 'providerRules')
  const modelRules = arraySection(modelConfigRules, 'providerModelRules')
  const reports: ZCodeRemoveReport[] = []

  for (const region of regions) {
    const providerId = providerIdFor(region)
    const index = rules.findIndex(rule => isOwnProvider(rule, providerId))
    if (index === -1) {
      reports.push({ provider: providerId, region, action: 'skipped', reason: 'not_found' })
      continue
    }
    const rule = rules[index] as JsonRecord
    const expected = options.bridgeUrl === undefined ? undefined : bridgeRegionBaseUrl(options.bridgeUrl, region)
    const storedApi = isRecord(rule['config']) && isRecord((rule['config'] as JsonRecord)['api'])
      ? (rule['config'] as JsonRecord)['api'] as JsonRecord
      : undefined
    // Without an explicit bridge URL, ownership is structural: the stored base
    // URL must be a loopback endpoint for this very region.
    const owned = expected === undefined
      ? ownsBaseUrl(rule, region)
      : storedApi !== undefined && storedApi['type'] === API_FORMAT && storedApi['baseUrl'] === expected
    if (!owned) {
      reports.push({ provider: providerId, region, action: 'skipped', reason: 'not_owned' })
      continue
    }
    rules.splice(index, 1)
    for (let i = modelRules.length - 1; i >= 0; i -= 1) {
      const entry = modelRules[i]
      if (isRecord(entry) && entry['providerId'] === providerId) modelRules.splice(i, 1)
    }
    // The provider order list is a preference, not ownership: drop our id but
    // leave every other entry exactly where the user put it.
    const order = body['providerOrder']
    if (Array.isArray(order)) {
      const filtered = order.filter(entry => entry !== providerId)
      order.length = 0
      order.push(...filtered)
    }
    reports.push({ provider: providerId, region, action: 'removed' })
  }

  if (!isDeepStrictEqual(before, after)) await writeJsonAtomic(configPath, after)
  return reports
}

/** Read-only summary of what this bridge currently has registered. */
export async function readZCodeRegistration(configPath = defaultProviderConfigPath()): Promise<Array<{ provider: string, region: ZCodeRegion, baseUrl: string, models: number }>> {
  let document: JsonRecord
  try {
    document = JSON.parse(await readFile(configPath, 'utf8')) as JsonRecord
  } catch {
    return []
  }
  const config = document['config']
  if (!isRecord(config) || !isRecord(config['providerConfigRules'])) return []
  const rules = arraySection(config['providerConfigRules'] as JsonRecord, 'providerRules')
  const registered: Array<{ provider: string, region: ZCodeRegion, baseUrl: string, models: number }> = []
  for (const region of DEFAULT_REGIONS) {
    const providerId = providerIdFor(region)
    const rule = rules.find(entry => isOwnProvider(entry, providerId))
    if (!isRecord(rule)) continue
    const entry = rule['config']
    if (!isRecord(entry) || !isRecord(entry['api'])) continue
    const api = entry['api'] as JsonRecord
    const ids = entry['personalModelIds']
    registered.push({
      provider: providerId,
      region,
      baseUrl: typeof api['baseUrl'] === 'string' ? api['baseUrl'] : '',
      models: Array.isArray(ids) ? ids.length : 0,
    })
  }
  return registered
}

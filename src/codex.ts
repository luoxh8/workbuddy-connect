/**
 * Codex / ChatGPT desktop app registration for the loopback WorkBuddy bridge.
 *
 * The ChatGPT desktop app on Windows (MSIX `OpenAI.Codex`, display name
 * "ChatGPT") is Codex with a UI; it and the `codex` CLI read the *same*
 * `~/.codex/config.toml` and the same model catalog. So one writer serves both:
 * point a `model_providers` entry at this bridge and add a catalog the client
 * reads through `model_catalog_json`.
 *
 * Why a catalog and not just a base URL
 * -------------------------------------
 * Codex sends its own ~17 KB system prompt as a `developer` message. WorkBuddy's
 * upstream rejects OpenAI's prompt verbatim (HTTP 400) — and the rejection is
 * triggered by content, not length, so it survives any trimming. Codex lets a
 * catalog override that prompt through `base_instructions`, which is the
 * documented extension point: the client never sends the rejected text, and this
 * bridge stays a pure protocol translator instead of rewriting prompts.
 *
 * Everything here is additive and reversible: one provider table and one catalog
 * path are written into a marker-delimited block, and removal restores the file
 * byte for byte when nothing else changed.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { writeJsonAtomic } from './storage.ts'

export type CodexRegion = 'cn' | 'global'

export interface CodexInstallOptions {
  /** Loopback bridge origin, e.g. `http://127.0.0.1:10108`. */
  bridgeUrl: string
  /** The bridge's own Bearer key; becomes the provider's bearer token. */
  token: string
  regions?: readonly CodexRegion[]
  /** Register only models WorkBuddy bills at zero credits. */
  freeOnly?: boolean
  /** Test/portable override; defaults to `$CODEX_HOME/config.toml`. */
  configPath?: string
  /** Test/portable override for the catalog; defaults to a fixed name next to the config. */
  catalogPath?: string
  /** Test/portable override for the model list endpoint. */
  modelsUrl?: string
}

export interface CodexRemoveOptions {
  configPath?: string
  catalogPath?: string
}

export interface CodexInstallReport {
  configPath: string
  catalogPath: string
  provider: string
  region: CodexRegion
  models: number
  freeModels: number
  action: 'installed' | 'updated' | 'unchanged'
  /** Set when a pre-existing catalog was adopted instead of overwritten. */
  note?: string
}

/** One model as the bridge's `/v1/models` advertises it. */
interface BridgeModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  supportsImages: boolean
  free: boolean
  reasoningEfforts?: readonly string[]
}

const PROVIDER_PREFIX = 'workbuddy'
const DEFAULT_REGIONS: readonly CodexRegion[] = ['cn', 'global']
const MARKER = '# >>> workbuddy-connect >>>'
const MARKER_END = '# <<< workbuddy-connect <<<'
/**
 * Restore record written inside the managed block. It holds the root values
 * that were there before the first install, so removal puts the client back on
 * the provider and catalog it was using instead of leaving dangling pointers.
 */
const RESTORE_PREFIX = '# restore '
const CATALOG_FILE = 'workbuddy-models.json'
const REQUEST_TIMEOUT_MS = 30_000

/**
 * System prompt handed to WorkBuddy in place of Codex's own.
 *
 * Two constraints shape the wording: it must describe an agentic coding
 * assistant well enough for tool use to work, and it must not reproduce the
 * phrasing WorkBuddy's upstream filters. It is deliberately general — the
 * bridge serves every model the account can reach, not one vendor's.
 */
const BASE_INSTRUCTIONS = `You are a coding agent running inside the user's terminal, in their local workspace. You are precise, careful, and direct.

Work with the user until their goal is genuinely handled. Lead with the outcome rather than the steps you took to reach it. Match the user's language; they normally write Chinese, so answer in Chinese unless they write in another language.

## Working style

- Say what you are about to do before running a command that changes state.
- Verify with real output. Never claim success you have not observed.
- Keep edits scoped to the task and preserve changes you did not make.
- Read a file instead of guessing its contents.
- When the request is ambiguous and a wrong assumption would be costly, ask.
- Reply in plain language; use structure only when it makes an answer easier to read.

## Tool use

Call tools when they help. Prefer several independent calls in parallel over a long serial chain. Check the exact target before a destructive command, and never point a recursive or destructive command at a home directory or a whole drive.
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function regionsFor(value: readonly CodexRegion[] | undefined): CodexRegion[] {
  const regions = value === undefined ? [...DEFAULT_REGIONS] : [...new Set(value)]
  if (regions.length === 0 || regions.some(region => region !== 'cn' && region !== 'global')) {
    throw new Error('regions must contain cn and/or global')
  }
  return regions
}

/** `$CODEX_HOME/config.toml`, falling back to `~/.codex/config.toml`. */
export function defaultCodexConfigPath(): string {
  const home = process.env['CODEX_HOME']
  return join(home !== undefined && home.trim() !== '' ? home : join(homedir(), '.codex'), 'config.toml')
}

/** Provider id for a region; `cn` keeps the historical bare id. */
export function codexProviderId(region: CodexRegion): string {
  return region === 'cn' ? PROVIDER_PREFIX : `${PROVIDER_PREFIX}-${region}`
}

export function codexProviderName(region: CodexRegion): string {
  return region === 'cn' ? 'WorkBuddy CN' : 'WorkBuddy Global'
}

/** The bridge serves all three protocols from `/<region>/v1`; Codex wants Responses. */
export function codexBaseUrl(bridgeUrl: string, region: CodexRegion): string {
  return `${bridgeUrl.replace(/\/+$/, '')}/${region}/v1`
}

/** Default catalog location: next to the config, so both move together. */
export function defaultCodexCatalogPath(configPath: string = defaultCodexConfigPath()): string {
  return join(dirname(configPath), CATALOG_FILE)
}

/**
 * Read the root-level `model` key, if any. Only the leading section counts, so
 * a `model` inside some nested table is not mistaken for the active model.
 */
function activeModelFromConfig(text: string): string | undefined {
  const { leading } = splitLeadingSection(text)
  const match = /^\s*model\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(leading)
  return match?.[1]
}

/** Catalog marker in the config; a catalog the user pointed elsewhere is left alone. */
function catalogPathFromConfig(text: string): string | undefined {
  const match = /^\s*model_catalog_json\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(text)
  return match?.[1]?.replace(/\\\\/g, '\\')
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Remove the block this module owns, if present. */
function stripBlock(text: string): { text: string; present: boolean; restore: Record<string, string> } {
  const pattern = new RegExp(`\\n?${escapeRegExp(MARKER)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`, 'm')
  const found = pattern.exec(text)
  const restore: Record<string, string> = {}
  if (found !== null) {
    for (const line of found[0].split('\n')) {
      const match = /^#\s*restore\s+([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line.trim())
      if (match === null) continue
      // `absent` records that the key did not exist at all, which is different
      // from an empty value and must be restored by deleting the line.
      restore[match[1]!] = match[2]!.trim()
    }
  }
  const stripped = found === null ? text : text.replace(pattern, '\n')
  return {
    text: found === null ? text : stripped.replace(/\n{3,}/g, '\n\n'),
    present: found !== null,
    restore,
  }
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
    const model: BridgeModel = {
      id: raw['id'],
      ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
      ...(typeof raw['context_window'] === 'number' ? { contextWindow: raw['context_window'] } : {}),
      ...(typeof raw['max_output_tokens'] === 'number' ? { maxTokens: raw['max_output_tokens'] } : {}),
      supportsImages: raw['supports_vision'] === true,
      free: isFree,
      ...(efforts.length === 0 ? {} : { reasoningEfforts: efforts }),
    }
    if (isFree) free += 1
    if (freeOnly && !isFree) continue
    models.push(model)
  }
  return { models, free }
}

/** Codex reasoning effort labels, in the client's own vocabulary. */
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: 'No extra reasoning',
  minimal: 'Minimal reasoning',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balanced reasoning depth',
  high: 'Deeper reasoning for harder problems',
  xhigh: 'Extra high reasoning depth',
  ultra: 'Highest available reasoning depth',
  max: 'Maximum reasoning depth',
}

/**
 * One catalog model entry.
 *
 * Codex validates this document strictly (`truncation_policy`,
 * `supported_reasoning_levels`, `model_messages` and friends are all required),
 * so the shape is taken from a known-good entry and only the fields this bridge
 * actually knows are replaced. Building an entry from scratch silently drifts
 * out of the schema every time the client adds a required field.
 */
function catalogEntry(template: Record<string, unknown>, model: BridgeModel, priority: number): Record<string, unknown> {
  const context = model.contextWindow !== undefined && model.contextWindow > 0 ? model.contextWindow : 128000
  const maxTokens = model.maxTokens !== undefined && model.maxTokens > 0 ? model.maxTokens : 32000
  // A model with no adjustable effort still needs one level: Codex requires the
  // array to be non-empty and the default level to name one of its entries.
  const efforts = model.reasoningEfforts !== undefined && model.reasoningEfforts.length > 0
    ? [...model.reasoningEfforts]
    : ['none']
  const preferred = ['high', 'medium', 'low', 'xhigh', 'max'].find(level => efforts.includes(level)) ?? efforts[0]!
  const supportsReasoning = efforts.some(effort => effort !== 'none')
  const entry: Record<string, unknown> = {
    ...template,
    slug: model.id,
    display_name: model.name ?? model.id,
    description: `${model.name ?? model.id} via WorkBuddy`,
    context_window: context,
    max_context_window: context,
    max_output_tokens: maxTokens,
    input_modalities: model.supportsImages ? ['text', 'image'] : ['text'],
    supports_image_detail_original: model.supportsImages,
    supports_reasoning_summaries: supportsReasoning,
    supported_reasoning_levels: efforts.map(effort => ({ effort, description: EFFORT_LABELS[effort] ?? effort })),
    default_reasoning_level: preferred,
    priority,
    base_instructions: BASE_INSTRUCTIONS,
    model_messages: {
      ...(isRecord(template['model_messages']) ? template['model_messages'] : {}),
      instructions_template: BASE_INSTRUCTIONS,
    },
  }
  // Not a Codex field; kept so a reinstall can prefer a zero-cost default.
  if (model.free) entry['free'] = true
  else delete entry['free']
  return entry
}

/**
 * A structurally complete entry to clone. The caller passes the catalog that
 * was already on the machine when it exists (so the schema matches this client
 * version exactly); otherwise a minimal entry is emitted and the client reports
 * whatever it still wants.
 */
function catalogTemplate(inherited: unknown): Record<string, unknown> | undefined {
  if (!isRecord(inherited) || !Array.isArray(inherited['models'])) return undefined
  return inherited['models'].find((model): model is Record<string, unknown> => isRecord(model)) ?? undefined
}

function catalogDocument(models: readonly BridgeModel[], template: Record<string, unknown> | undefined): Record<string, unknown> {
  const shape = template ?? FALLBACK_ENTRY
  return { models: models.map((model, index) => catalogEntry(shape, model, index)) }
}

/**
 * Shape used when the machine has no catalog to clone. Covers every field the
 * client has required so far; a newer client rejects the file loudly rather
 * than silently misbehaving, and the fix is to install with an existing catalog
 * present (which is the normal case, since Codex ships one).
 */
const FALLBACK_ENTRY: Record<string, unknown> = {
  apply_patch_tool_type: 'freeform',
  web_search_tool_type: 'text',
  input_modalities: ['text'],
  supports_image_detail_original: false,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: true,
  tool_mode: null,
  multi_agent_version: 'v2',
  use_responses_lite: false,
  include_skills_usage_instructions: false,
  auto_review_model_override: null,
  effective_context_window_percent: 95,
  auto_compact_token_limit: null,
  comp_hash: '3000',
  reasoning_summary_format: 'experimental',
  default_reasoning_summary: 'none',
  shell_type: 'shell_command',
  visibility: 'list',
  minimal_client_version: '0.144.0',
  supported_in_api: true,
  availability_nux: null,
  upgrade: null,
  experimental_supported_tools: [],
  supports_search_tool: true,
  default_service_tier: null,
  model_messages: { instructions_template: '', instructions_variables: {}, approvals: null },
}

/**
 * Merge an already-installed catalog into the one this module writes.
 *
 * Codex reads exactly one catalog file, so pointing `model_catalog_json` here
 * would otherwise hide models the user had before (typically a second provider
 * such as a local DeepSeek proxy). Entries are combined by slug, with this
 * bridge's own entries winning on a collision because their instructions are
 * the ones that survive the upstream filter.
 */
function mergeCatalog(base: Record<string, unknown>, existing: unknown): { catalog: Record<string, unknown>; adopted: number } {
  if (!isRecord(existing) || !Array.isArray(existing['models'])) return { catalog: base, adopted: 0 }
  const ours = new Set((base['models'] as Array<Record<string, unknown>>).map(model => String(model['slug'])))
  const extra = (existing['models'] as unknown[]).filter(
    (model): model is Record<string, unknown> => isRecord(model) && typeof model['slug'] === 'string' && !ours.has(model['slug']),
  )
  if (extra.length === 0) return { catalog: base, adopted: 0 }
  return { catalog: { ...base, models: [...(base['models'] as unknown[]), ...extra] }, adopted: extra.length }
}

/** Provider block for one region, as TOML text. */
function providerBlock(region: CodexRegion, baseUrl: string, token: string): string {
  return [
    `[model_providers.${codexProviderId(region)}]`,
    `name = ${tomlString(codexProviderName(region))}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    `experimental_bearer_token = ${tomlString(token)}`,
  ].join('\n')
}

export interface CodexPlan {
  /** Provider blocks, in region order. */
  providers: string
  /** `model_provider` value for the region the user will actually talk to. */
  activeProvider: string
  catalog: Record<string, unknown>
  models: number
  freeModels: number
}

/**
 * Split a TOML document into its leading section — everything before the first
 * table header — and the rest. Only the leading section may hold root keys.
 */
function splitLeadingSection(text: string): { leading: string; rest: string } {
  const lines = text.split('\n')
  const index = lines.findIndex(line => /^\s*\[/.test(line))
  if (index < 0) return { leading: text, rest: '' }
  return { leading: lines.slice(0, index).join('\n'), rest: lines.slice(index).join('\n') }
}

/**
 * Root keys as they were before this module first touched them, rendered as
 * comment lines inside the managed block. Values are re-emitted verbatim, so a
 * removal restores the original text rather than a re-serialized guess.
 */
function restoreLines(previous: Readonly<Record<string, string | undefined>>): string {
  const lines = Object.entries(previous).map(([key, value]) =>
    `${RESTORE_PREFIX}${key} = ${value === undefined ? 'absent' : value}`)
  return lines.length === 0 ? '' : lines.join('\n')
}

/** Strip inline comments and quotes from a root TOML value, for round-tripping. */
function rawRootValue(text: string, key: string): string | undefined {
  const { leading } = splitLeadingSection(text)
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, 'm').exec(leading)
  return match?.[1]
}
function setRootKeys(text: string, entries: Readonly<Record<string, string>>): { text: string; changed: string[] } {
  const { leading, rest } = splitLeadingSection(text)
  const lines = leading === '' ? [] : leading.split('\n')
  const changed: string[] = []
  // Values are replaced in place, so line order and every line this module does
  // not own survive untouched; only the absence of the key forces an append.
  const next = [...lines]
  for (const [key, rendered] of Object.entries(entries)) {
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
    const at = next.findIndex(line => pattern.test(line))
    const line = `${key} = ${rendered}`
    if (at < 0) {
      next.push(line)
      changed.push(key)
      continue
    }
    if (next[at] !== line) {
      // An identical value must not count as a change, or a re-install reports
      // "updated" forever and the restore record drifts.
      if (next[at]!.trim() !== line) changed.push(key)
      next[at] = line
    }
  }
  if (changed.length === 0) return { text, changed }
  const head = next.join('\n').replace(/\s+$/, '')
  const tail = rest.replace(/^\s+/, '')
  return { text: tail === '' ? `${head}\n` : `${head}\n\n${tail}`, changed }
}


async function plan(options: CodexInstallOptions, template: Record<string, unknown> | undefined, restore: string): Promise<CodexPlan> {
  const regions = regionsFor(options.regions)
  const freeOnly = options.freeOnly === true
  const collected: BridgeModel[] = []
  const seen = new Set<string>()
  let freeModels = 0
  const blocks: string[] = []
  for (const region of regions) {
    const url = options.modelsUrl !== undefined
      ? options.modelsUrl
      : `${codexBaseUrl(options.bridgeUrl, region)}/models`
    const { models, free } = await fetchBridgeModels(url, options.token, freeOnly)
    if (region === regions[0]) freeModels = free
    blocks.push(providerBlock(region, codexBaseUrl(options.bridgeUrl, region), options.token))
    for (const model of models) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      collected.push(model)
    }
  }
  return {
    providers: [
      MARKER,
      blocks.join('\n\n'),
      restore === '' ? undefined : restore,
      MARKER_END,
    ].filter((part): part is string => part !== undefined).join('\n'),
    activeProvider: codexProviderId(regions[0]!),
    catalog: catalogDocument(collected, template),
    models: collected.length,
    freeModels,
  }
}

export async function installCodex(options: CodexInstallOptions): Promise<CodexInstallReport[]> {
  const configPath = resolve(options.configPath ?? defaultCodexConfigPath())
  const existing = existsSync(configPath) ? await readFile(configPath, 'utf8') : ''
  const withoutBlock = stripBlock(existing)

  // Never silently take over a catalog the user already had: if the config
  // points somewhere else, its models are carried into the file this module
  // writes, so nothing disappears from the client's model picker.
  const previousCatalog = catalogPathFromConfig(withoutBlock.text)
  const catalogPath = resolve(
    options.catalogPath
    ?? defaultCodexCatalogPath(configPath),
  )
  const inherited = options.catalogPath !== undefined || previousCatalog === undefined
    ? undefined
    : resolve(previousCatalog)
  const inheritedCatalog = inherited === undefined ? undefined : readCatalogJson(inherited)
  // A previous run may already have carried another provider's models into this
  // file; re-reading it keeps them, so re-installing never shrinks the picker.
  const ownCatalog = readCatalogJson(catalogPath)

  // Clone the shape the client itself shipped, so generated entries stay inside
  // this client version's schema instead of drifting from a hand-copied field list.
  //
  // A previous install already recorded the original root values; re-installing
  // keeps that first record so the restore point never drifts forward.
  const restore = Object.keys(withoutBlock.restore).length > 0
    ? Object.entries(withoutBlock.restore).map(([key, value]) => `${RESTORE_PREFIX}${key} = ${value}`).join('\n')
    : restoreLines({
        model: rawRootValue(withoutBlock.text, 'model'),
        model_provider: rawRootValue(withoutBlock.text, 'model_provider'),
        model_catalog_json: rawRootValue(withoutBlock.text, 'model_catalog_json'),
      })
  const planned = await plan(options, catalogTemplate(inheritedCatalog) ?? catalogTemplate(ownCatalog), restore)
  let merged = inherited !== undefined && inherited !== resolve(catalogPath)
    ? mergeCatalog(planned.catalog, inheritedCatalog)
    : { catalog: planned.catalog, adopted: 0 }
  if (inherited !== undefined) {
    const again = mergeCatalog(merged.catalog, ownCatalog)
    merged = { catalog: again.catalog, adopted: merged.adopted + again.adopted }
  }
  const regions = regionsFor(options.regions)

  // Order matters: the managed block is stripped first so its own tables can
  // never be mistaken for the leading section, then root keys are set, and the
  // provider tables are appended last (TOML tables always come after root keys).
  //
  // `model` is only set when it is absent or not one of *this bridge's* models:
  // a slug that merely exists in the merged catalog may belong to a different
  // provider, and pairing it with this provider would fail at request time.
  // A model the user picked from this bridge is left alone, so re-running
  // install never fights the user.
  const bridgeSlugs = new Set((planned.catalog['models'] as Array<Record<string, unknown>>).map(model => String(model['slug'])))
  const currentModel = activeModelFromConfig(withoutBlock.text)
  const fallbackModel = preferredModel(planned.catalog)
  const modelEntry = currentModel !== undefined && bridgeSlugs.has(currentModel)
    ? {}
    : fallbackModel === undefined ? {} : { model: tomlString(fallbackModel) }
  const rooted = setRootKeys(withoutBlock.text, {
    model_provider: tomlString(planned.activeProvider),
    model_catalog_json: tomlString(catalogPath),
    ...modelEntry,
  })
  const next = `${rooted.text.replace(/\s+$/, '')}\n\n${planned.providers}\n`

  await mkdir(dirname(configPath), { recursive: true })
  const catalogBefore = readCatalogText(catalogPath)
  await writeFile(configPath, next, 'utf8')
  await writeJsonAtomic(catalogPath, merged.catalog)
  const catalogText = readCatalogText(catalogPath)

  // Report against what was on disk, not against intermediate decisions: this
  // makes "unchanged" mean the files really did not change.
  const configChanged = next !== existing
  const catalogChanged = catalogText !== catalogBefore
  return [{
    configPath,
    catalogPath,
    provider: planned.activeProvider,
    region: regions[0]!,
    models: (merged.catalog['models'] as unknown[]).length,
    freeModels: planned.freeModels,
    action: existing === '' ? 'installed' : configChanged || catalogChanged ? 'updated' : 'unchanged',
    ...(merged.adopted === 0 ? {} : {
      note: `kept ${merged.adopted} model(s) from ${inherited !== undefined && inherited !== catalogPath ? inherited : 'the existing catalog'}`,
    }),
  }]
}

/** Parse a catalog, tolerating a missing or malformed file. */
function readCatalogJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Model to select when the configured one no longer exists. A free model is
 * preferred because installing this bridge should not start spending credits.
 */
function preferredModel(catalog: Record<string, unknown>): string | undefined {
  const models = catalog['models']
  if (!Array.isArray(models) || models.length === 0) return undefined
  const entries = models.filter((model): model is Record<string, unknown> => isRecord(model) && typeof model['slug'] === 'string')
  const free = entries.find(model => model['free'] === true)
  return String((free ?? entries[0])['slug'])
}

/** Read a catalog back as the canonical text used for comparison. */
function readCatalogText(path: string): string {
  try {
    return JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return ''
  }
}

export interface CodexRemoveReport {
  configPath: string
  catalogPath?: string
  action: 'removed' | 'cleaned' | 'skipped'
  reason?: 'no_block' | 'catalog_not_ours'
}

/**
 * Undo `installCodex`. The provider block always goes; the catalog is deleted
 * only when the config still points at the path this module wrote, so a catalog
 * the user has since re-pointed is preserved.
 */
export async function removeCodex(options: CodexRemoveOptions = {}): Promise<CodexRemoveReport> {
  const configPath = resolve(options.configPath ?? defaultCodexConfigPath())
  if (!existsSync(configPath)) return { configPath, action: 'skipped', reason: 'no_block' }
  const existing = await readFile(configPath, 'utf8')
  const stripped = stripBlock(existing)
  if (!stripped.present) return { configPath, action: 'skipped', reason: 'no_block' }

  const catalogPath = options.catalogPath !== undefined
    ? resolve(options.catalogPath)
    : defaultCodexCatalogPath(configPath)

  // Put the root keys back the way they were before the first install, then
  // drop the provider tables. Keys recorded as `absent` never existed, so their
  // lines are deleted rather than set to an empty value.
  let restored = stripped.text
  for (const [key, value] of Object.entries(stripped.restore)) {
    restored = value === 'absent'
      ? removeRootKey(restored, key)
      : setRootKeys(restored, { [key]: value }).text
  }

  // Restoring is byte-exact: the original trailing-newline state is preserved
  // so an install/remove round trip leaves the file untouched.
  const trimmed = existing.replace(/\s+$/, '')
  const trailing = existing.slice(trimmed.length)
  await writeFile(configPath, `${restored.replace(/\s+$/, '')}${trailing}`, 'utf8')

  // Delete the catalog only when this module owns it: a path the user wrote
  // themselves is a file this module never created.
  const pointer = catalogPathFromConfig(existing)
  const ours = pointer === undefined || resolve(pointer) === catalogPath
  if (!ours) return { configPath, action: 'cleaned', reason: 'catalog_not_ours' }
  if (existsSync(catalogPath)) {
    const { rm } = await import('node:fs/promises')
    await rm(catalogPath, { force: true })
  }
  return { configPath, catalogPath, action: 'removed' }
}

/** Delete a root-level key from the leading section. */
function removeRootKey(text: string, key: string): string {
  const { leading, rest } = splitLeadingSection(text)
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*\\n?`, 'm')
  const next = leading.replace(pattern, '')
  const tail = rest.replace(/^\s+/, '')
  const head = next.replace(/\s+$/, '')
  return tail === '' ? `${head}\n` : `${head}\n\n${tail}`
}

/** Read-only view of what this module has registered, for `status`-style output. */
export function readCodexRegistration(configPath: string = defaultCodexConfigPath()): {
  configPath: string
  installed: boolean
  providers: string[]
  catalogPath?: string
  catalogModels?: number
} {
  if (!existsSync(configPath)) return { configPath, installed: false, providers: [] }
  const text = readFileSync(configPath, 'utf8')
  const providers = [...text.matchAll(/\[model_providers\.([A-Za-z0-9_-]+)\]/g)]
    .map(match => match[1]!)
    .filter(id => id === PROVIDER_PREFIX || id.startsWith(`${PROVIDER_PREFIX}-`))
  const catalogPath = catalogPathFromConfig(text)
  let catalogModels: number | undefined
  if (catalogPath !== undefined && existsSync(catalogPath)) {
    try {
      const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as { models?: unknown }
      catalogModels = Array.isArray(parsed.models) ? parsed.models.length : undefined
    } catch {
      catalogModels = undefined
    }
  }
  return { configPath, installed: providers.length > 0, providers, ...(catalogPath === undefined ? {} : { catalogPath }), ...(catalogModels === undefined ? {} : { catalogModels }) }
}

/** The instructions block, exported so tests and docs can assert on it. */
export const CODEX_BASE_INSTRUCTIONS = BASE_INSTRUCTIONS

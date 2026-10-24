/**
 * Codex-side cleanup for entries the retired 1.4.x `install-codex` left behind.
 *
 * 2.0 dropped Codex support: current Codex builds refuse `wire_api = "chat"`
 * and only speak `responses`, which this bridge no longer serves. That makes any
 * `[model_providers.workbuddy*]` table and generated catalog on disk dead weight
 * — and the disabled block does not even stay harmless, because it still holds
 * the bridge's local API key in plain text.
 *
 * This module only *reads and removes* those leftovers. It never registers a
 * provider, so it needs no protocol support and no running bridge.
 *
 * Parsing is deliberately shallow: config.toml is scanned line by line for
 * `[model_providers.<id>]` headers (active or commented out) and the key/value
 * pairs directly under them. Nothing else in the file is interpreted, so every
 * unrelated table — desktop, tui, mcp_servers, hooks, marketplaces — is carried
 * through byte for byte.
 */

import { readFileSync, existsSync } from 'node:fs'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export interface CodexProviderSummary {
  id: string
  name: string
  baseUrl: string
  wireApi: string
  /** False when the whole table is commented out, i.e. not in effect. */
  active: boolean
  /** True for tables this bridge's retired installer wrote. */
  retired: boolean
}

export interface CodexPruneReport {
  configPath: string
  /** Marker block removed in full, or false when there was none. */
  blockRemoved: boolean
  /** Table headers removed because they were left outside the marker block. */
  tablesRemoved: string[]
  /** Generated catalog deleted; absent when it was missing or still referenced. */
  catalogRemoved?: string
  /** Catalog left in place because the live config still points at it. */
  catalogKept?: string
}

const MARK_START = '# >>> workbuddy-connect >>>'
const MARK_END = '# <<< workbuddy-connect <<<'
const RETIRED_PREFIX = 'workbuddy'
const CATALOG_NAME = 'workbuddy-models.json'

/** `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. */
export function defaultCodexConfigPath(): string {
  const home = process.env['CODEX_HOME']?.trim()
  const root = home !== undefined && home !== '' && isAbsolute(home) ? home : join(homedir(), '.codex')
  return join(root, 'config.toml')
}

interface ScannedTable {
  id: string
  active: boolean
  startLine: number
  endLine: number
  values: Record<string, string>
}

/** Strip one layer of quotes from a TOML string value. */
function unquote(raw: string): string {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function splitKeyValue(line: string): [string, string] | undefined {
  const index = line.indexOf('=')
  if (index === -1) return undefined
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()]
}

/** Find `[model_providers.<id>]` headers, including commented-out ones. */
function scanTables(lines: string[]): ScannedTable[] {
  const tables: ScannedTable[] = []
  let current: ScannedTable | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const commented = /^\s*#/.test(raw)
    const body = commented ? raw.replace(/^\s*#\s?/, '') : raw
    const header = /^\[model_providers\.([^\]]+)\]\s*$/.exec(body.trim())
    if (header) {
      if (current) current.endLine = index - 1
      current = { id: header[1].trim(), active: !commented, startLine: index, endLine: lines.length - 1, values: {} }
      tables.push(current)
      continue
    }
    // Any other table header closes the current one.
    if (/^\s{0,1}\[/.test(raw.trim()) || /^\s*#\s*\[/.test(raw)) {
      if (current) { current.endLine = index - 1; current = undefined }
      continue
    }
    if (current) {
      const pair = splitKeyValue(body)
      if (pair && !commented) current.values[pair[0]] = unquote(pair[1])
      else if (pair && commented) current.values[pair[0]] ??= unquote(pair[1])
    }
  }
  return tables
}

/** Every model provider in the config, with retired ones flagged. */
export function codexProvidersFromText(text: string): CodexProviderSummary[] {
  return scanTables(text.split(/\r?\n/)).map(table => ({
    id: table.id,
    name: table.values['name'] ?? '',
    baseUrl: table.values['base_url'] ?? '',
    wireApi: table.values['wire_api'] ?? '',
    active: table.active,
    retired: table.id.startsWith(RETIRED_PREFIX),
  }))
}

export async function listCodexProviders(configPath = defaultCodexConfigPath()): Promise<CodexProviderSummary[]> {
  let text: string
  try { text = await readFile(configPath, 'utf8') } catch { return [] }
  return codexProvidersFromText(text)
}

/** True when a TOML value line assigns the given key, quoted or not. */
function assignsCatalog(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.startsWith('#')) return false
  const pair = splitKeyValue(trimmed)
  return pair?.[0] === 'model_catalog_json'
}

/**
 * Remove the retired installer's traces: the marker block, any stray
 * `[model_providers.workbuddy*]` table outside it, and the generated catalog.
 *
 * The catalog is deleted only when no *active* `model_catalog_json` still points
 * at it — if the user re-pointed Codex at that file, it is their config now and
 * removing it would break their setup.
 */
export async function pruneCodex(options: { configPath?: string } = {}): Promise<CodexPruneReport> {
  const configPath = options.configPath ?? defaultCodexConfigPath()
  let text: string
  try { text = await readFile(configPath, 'utf8') } catch {
    throw new Error(`No Codex config at ${configPath}; nothing to prune`)
  }
  const report: CodexPruneReport = { configPath, blockRemoved: false, tablesRemoved: [] }
  const kept: string[] = []

  let inBlock = false
  let skippingTable = false
  for (const line of text.split(/\r?\n/)) {
    if (inBlock) {
      if (line.trimStart().startsWith(MARK_END)) inBlock = false
      continue
    }
    if (line.trimStart().startsWith(MARK_START)) { inBlock = true; report.blockRemoved = true; continue }

    const retiredTable = /^\s*\[model_providers\.(workbuddy[^\]]*)\]\s*$/.exec(line)
    if (retiredTable) {
      report.tablesRemoved.push(retiredTable[1].trim())
      skippingTable = true
      continue
    }
    // Any other table header ends the body of a removed one.
    if (/^\s*\[/.test(line)) skippingTable = false
    if (skippingTable) continue
    kept.push(line)
  }

  // Collapse the blank runs the deletions can leave behind (keep at most one).
  const collapsed: string[] = []
  for (const line of kept) {
    const blank = line.trim() === ''
    if (blank && collapsed.at(-1)?.trim() === '') continue
    collapsed.push(line)
  }
  const output = collapsed.join('\n').replace(/\s*$/, '\n')

  if (output !== text) {
    const leftover = output.split(/\r?\n/).some(line =>
      line.trimStart().startsWith(MARK_START) || /^\s*\[model_providers\.workbuddy/.test(line))
    if (leftover) throw new Error('Codex config still contains workbuddy entries after pruning; it was not changed')
    await writeFile(configPath, output, { encoding: 'utf8' })
  }

  const catalogPath = join(dirname(configPath), CATALOG_NAME)
  if (existsSync(catalogPath)) {
    // Never delete a catalog the active config still reads.
    const activeReference = output.split(/\r?\n/).some(line => assignsCatalog(line) && line.includes(CATALOG_NAME))
    if (activeReference) report.catalogKept = catalogPath
    else {
      let looksLikeCatalog = false
      try {
        const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as { models?: unknown }
        looksLikeCatalog = Array.isArray(parsed.models)
      } catch { looksLikeCatalog = false }
      if (looksLikeCatalog) {
        await unlink(catalogPath)
        report.catalogRemoved = catalogPath
      }
    }
  }

  return report
}

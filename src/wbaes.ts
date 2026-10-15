/**
 * Decrypt WorkBuddy desktop `{$wbEncrypted:1, envelope}` credential fields.
 *
 * WorkBuddy 5.6.2+ stores auth tokens as AES-256-GCM envelopes instead of
 * plain strings. The at-rest key lives inside the app's own Electron runtime
 * (a `workbuddy_storage` linked binding), so the only supported way to get it
 * is to spawn the app binary once with `-e` and read the helper's stdout.
 *
 * This module is a local addition: upstream `opencodex-workbuddy-connect`
 * expects a plain `accessToken` string and reports `signed-out` otherwise.
 *
 * Nothing is written by this module; it only reads the desktop auth file and
 * spawns the app binary read-only. No token is persisted or logged.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The helper script: runs inside WorkBuddy's Electron as plain Node. */
const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

const HELPER_TIMEOUT_MS = 15_000

/** Matches the app's `buildAuthenticatedContextAad` for field envelopes. */
function buildAuthenticatedContextAad(keyId: string, suite: number): Buffer {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    prefix,
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/** Derive the protector key the same way the app does. */
function deriveProtectorKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

interface ParsedEnvelope {
  readonly suite: number
  readonly keyId: string
  readonly nonce: Buffer
  readonly authTag: Buffer
  readonly ciphertext: Buffer
}

function parseEnvelope(wrapped: unknown): ParsedEnvelope | undefined {
  if (typeof wrapped !== 'object' || wrapped === null) return undefined
  const record = wrapped as Record<string, unknown>
  if (record['$wbEncrypted'] !== 1 || typeof record['envelope'] !== 'string') return undefined
  let parts: Record<string, unknown>
  try {
    parts = JSON.parse(Buffer.from(record['envelope'], 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (typeof parts['keyId'] !== 'string' || !/^[0-9a-f]{16}$/u.test(parts['keyId'])) return undefined
  if (typeof parts['nonce'] !== 'string' || typeof parts['authTag'] !== 'string'
    || typeof parts['ciphertext'] !== 'string') return undefined
  const suite = typeof parts['suite'] === 'number' ? parts['suite'] : 1
  return {
    suite,
    keyId: parts['keyId'],
    nonce: Buffer.from(parts['nonce'], 'base64'),
    authTag: Buffer.from(parts['authTag'], 'base64'),
    ciphertext: Buffer.from(parts['ciphertext'], 'base64'),
  }
}

function openField(key: Buffer, envelope: ParsedEnvelope): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/** Candidate app binaries able to run the helper, most specific first. */
function helperCandidates(): readonly string[] {
  const fromEnv = process.env['WORKBUDDY_ELECTRON_PATH']?.trim()
  const explicit = fromEnv === undefined || fromEnv === '' ? [] : [fromEnv]
  // A scheduled task may start without the user-environment variables this
  // process would normally inherit, so fall back to the profile-derived
  // defaults before giving up.
  const home = homedir()
  const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const discovered: string[] = []
  discovered.push(`${localAppData}\\Programs\\WorkBuddy\\WorkBuddy.exe`)
  discovered.push(`${programFiles}\\WorkBuddy\\WorkBuddy.exe`)
  discovered.push(`${programFiles}\\WorkBuddy AI\\WorkBuddyAI.exe`)
  discovered.push('C:\\Program Files\\WorkBuddy\\WorkBuddy.exe')
  return [...explicit, ...discovered]
}

async function spawnHelper(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    // Under a scheduled task the child may never start or never exit, and
    // execFile's own timeout only covers a running process. Race it against
    // a wall clock so a hung spawn cannot block a bridge request forever.
    const timer = setTimeout(() => finish(undefined), HELPER_TIMEOUT_MS)
    timer.unref?.()
    execFile(
      binary,
      ['-e', HELPER_SCRIPT],
      {
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        // Without this the Electron binary boots its own GUI instead of acting
        // as a plain Node host, and never prints the helper payload.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
      (error, stdout) => {
        if (error !== null || typeof stdout !== 'string' || stdout === '') {
          finish(undefined)
          return
        }
        finish(stdout)
      },
    )
  })
}

async function protectorKeyFor(requested: readonly string[]): Promise<Buffer | undefined> {
  if (requested.length === 0) return undefined
  for (const binary of helperCandidates()) {
    try {
      await access(binary, constants.X_OK)
    } catch {
      continue
    }
    const stdout = await spawnHelper(binary)
    if (stdout === undefined) continue
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(stdout) as Record<string, unknown>
    } catch {
      continue
    }
    if (payload['version'] !== 1 || typeof payload['atRestSecretKey'] !== 'string') continue
    const key = deriveProtectorKey(payload['atRestSecretKey'])
    if (!requested.includes(keyIdOf(key))) continue
    return key
  }
  return undefined
}

/**
 * Replace every `{$wbEncrypted:1, ...}` string field in `document` with its
 * plaintext, in place. Fields already holding strings are left untouched, so
 * older WorkBuddy builds keep working unchanged.
 *
 * Returns `false` when something was still wrapped after the attempt.
 */
export async function unwrapEncryptedFields(document: Record<string, unknown>): Promise<boolean> {
  const wrapped: Array<{ holder: Record<string, unknown>, field: string, envelope: ParsedEnvelope }> = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const holder = value as Record<string, unknown>
    for (const field of Object.keys(holder)) {
      const current = holder[field]
      if (typeof current === 'object' && current !== null) {
        const envelope = parseEnvelope(current)
        if (envelope !== undefined) {
          wrapped.push({ holder, field, envelope })
          continue
        }
        walk(current)
      }
    }
  }
  walk(document)
  if (wrapped.length === 0) return true

  const key = await protectorKeyFor([...new Set(wrapped.map((entry) => entry.envelope.keyId))])
  if (key === undefined) return false

  for (const entry of wrapped) {
    const plaintext = openField(key, entry.envelope)
    if (plaintext === undefined) return false
    entry.holder[entry.field] = plaintext
  }
  return true
}

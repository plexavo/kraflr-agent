import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

interface Settings { burpMcpUrl?: string }

const settingsPath = (dataDir: string) => join(dataDir, 'settings.json')

export function readKraflrSettings(dataDir: string): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(dataDir), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Settings : {}
  } catch { return {} }
}

/** A blank value for a key removes it, so clearing a setting (e.g. the Burp URL) actually clears it rather than saving an empty string. */
export function writeKraflrSettings(dataDir: string, patch: Settings) {
  const next: Settings = { ...readKraflrSettings(dataDir), ...patch }
  for (const key of Object.keys(next) as (keyof Settings)[]) if (!next[key]) delete next[key]
  const target = settingsPath(dataDir), temp = target + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  try { renameSync(temp, target) } finally { try { unlinkSync(temp) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
}

/**
 * The researcher's Burp MCP endpoint. KRAFLR_BURP_MCP_URL (an env var set before launching Kraflr) is a one-off
 * override for advanced use; the saved setting is the normal path, since depending on a shell env var to be present
 * every time Kraflr starts is fragile — many launch contexts (a non-interactive shell, a systemd unit, a different
 * terminal profile) never source a researcher's .bashrc at all.
 */
export function resolveBurpUrl(dataDir: string): string | undefined {
  const env = process.env.KRAFLR_BURP_MCP_URL?.trim()
  return env || readKraflrSettings(dataDir).burpMcpUrl
}

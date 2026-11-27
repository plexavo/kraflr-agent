import { release } from 'node:os'

export const inWsl = () => process.platform === 'linux' && /microsoft/i.test(release())

/** Why a connection to Burp's MCP server failed, in words: fetch keeps the useful part in its cause. */
export function burpFailure(error: unknown) {
  if (!(error instanceof Error)) return 'Could not reach the Burp MCP server.'
  const code = (error.cause as { code?: unknown } | undefined)?.code
  return error.message === 'fetch failed' && typeof code === 'string' ? `nothing answered at that address (${code})` : error.message
}

/**
 * Advice for a failed connection from WSL, where Burp on Windows is reached through the relay on 9877: the usual mistake is saving Burp's own
 * port, where nothing listens inside WSL, and the other is a relay that is not running. Empty when neither applies.
 */
export function burpHint(url: string | undefined, reason = '', wsl = inWsl()) {
  if (!wsl || !url) return ''
  try {
    const { hostname, port, pathname } = new URL(url)
    if (!['127.0.0.1', 'localhost'].includes(hostname)) return ''
    if (port === '9876') return `If Burp runs on Windows, save the relay’s address instead: http://127.0.0.1:9877${pathname} (Burp itself stays on 9876).`
    if (port === '9877' && /ECONNREFUSED/.test(reason)) return 'The Burp relay is not running. Start it in WSL with: systemctl --user start burp-relay'
    return ''
  } catch { return '' }
}

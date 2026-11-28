import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A response up to this many characters is passed on as it is. */
export const trimOver = 6000
const headLimit = 4000, bodyShown = 2000, matchLimit = 20, around = 120

export interface TrimOptions { full?: boolean; headersOnly?: boolean; find?: string }

/** Extra arguments the gateway adds to Burp's request tools and takes off again before the call reaches Burp. */
export const trimProperties = {
  kraflr_find: { type: 'string', description: 'Return only the parts of the response matching this regular expression (case-insensitive).' },
  kraflr_headers_only: { type: 'boolean', description: 'Return only the status line and response headers.' },
  kraflr_full: { type: 'boolean', description: 'Return the whole response, however long.' },
}

/** The status line and headers, and the body after the first blank line. Text that holds no HTTP response is all body. */
function split(text: string) {
  const start = /HTTP\/(?:1\.[01]|2(?:\.0)?|3) \d{3}/.exec(text)
  if (!start) return { head: '', body: text }
  // Burp prints its request and notes around the response; only the response is kept.
  const response = text.slice(start.index).replace(/,\s*messageAnnotations=[\s\S]*$/, '')
  const gap = /\r?\n\r?\n/.exec(response)
  return gap ? { head: response.slice(0, gap.index), body: response.slice(gap.index + gap[0].length) } : { head: response, body: '' }
}

/** Pages that differ only in their per-request script nonce are the same page. Nothing else is ignored: an ID or token that differs may be the finding. */
const fingerprint = (body: string) => createHash('sha256').update(body.replace(/(nonce=)(["'])[^"']*\2/gi, '$1')).digest('hex')

function matches(text: string, pattern: string) {
  let expression: RegExp
  try { expression = new RegExp(pattern, 'gi') } catch { expression = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') }
  const found: string[] = []; let total = 0, shownTo = 0
  for (const match of text.matchAll(expression)) {
    total++
    if (found.length >= matchLimit || match.index < shownTo) continue
    const from = Math.max(0, match.index - around), to = Math.min(text.length, match.index + Math.min(match[0].length, 600) + around)
    found.push(`@${match.index}: ${text.slice(from, to)}`); shownTo = to
  }
  return total ? `${total} match(es) for ${pattern}:\n${found.join('\n---\n')}` : `No match for ${pattern}.`
}

/**
 * Saves an agent's tokens on web responses: a long one is cut to its headers and the start of its body, a body already seen is not repeated, and the
 * agent can ask for just the headers or the matching parts. Whatever is cut is first saved whole in the session folder, where the agent can search it.
 */
export function createResponseTrimmer(folder: string) {
  const seen = new Map<string, string>()
  let count = 0
  return (text: string, options: TrimOptions = {}) => {
    const asked = Boolean(options.headersOnly || options.find)
    if (options.full || (!asked && text.length <= trimOver)) return text
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const file = join(folder, `response-${String(++count).padStart(4, '0')}.txt`)
    writeFileSync(file, text, { mode: 0o600 })
    const { head, body } = split(text)
    const key = body.length > 500 ? fingerprint(body) : '', earlier = key ? seen.get(key) : undefined
    if (key && !earlier) seen.set(key, file)
    const parts = [head.slice(0, headLimit)]
    if (earlier) parts.push(`[Body is the same as in ${earlier}, apart from any script nonce.]`)
    if (options.find) parts.push(matches(head ? head + '\n\n' + body : body, options.find))
    else if (!options.headersOnly && !earlier) parts.push(body.slice(0, bodyShown))
    parts.push(`[Kraflr shortened this result from ${text.length} characters (body ${body.length}). Full copy: ${file}. Search or read that file, or send again with kraflr_find or kraflr_full.]`)
    return parts.filter(Boolean).join('\n\n')
  }
}

/**
 * Authorized web targets, as the researcher writes them: one or more of a host (`app.example.com`), a wildcard (`*.example.com`), a host with a
 * port (`app.example.com:8443`) or a URL (`https://app.example.com/shop/`). A URL with a path limits testing to that path and below.
 * Kraflr records and shows them to every agent. Its scope proxy enforces them for requests that go through it; a tool that ignores proxy settings is not stopped.
 */
export interface WebTarget {
  /** As written. */
  text: string
  host: string
  wildcard: boolean
  port?: string
  /** Only requests at or below this path are authorized. Empty means the whole host. */
  path: string
}

const hostPattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const scheme = /^[a-z][a-z0-9+.-]*:\/\//i
const wildcardEntry = /^([a-z][a-z0-9+.-]*:\/\/)?\*\.(.+)$/i
const trailingSlashes = /\/+$/

export function parseWebTarget(entry: string): WebTarget | undefined {
  const raw = entry.trim()
  if (!raw || raw.length > 300 || /[\s\u0000-\u001f]/.test(raw)) return
  let host: string, port: string | undefined, path = ''
  // A leading "*." (after an optional scheme) marks a wildcard; the URL parser only sees the part after it.
  const wild = wildcardEntry.exec(raw), plain = wild ? (wild[1] ?? '') + wild[2] : raw
  try {
    const url = new URL(scheme.test(plain) ? plain : 'https://' + plain)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return
    host = (wild ? '*.' : '') + url.hostname.toLowerCase()
    port = url.port || undefined
    path = url.pathname.replace(trailingSlashes, '')
  } catch { return }
  const bare = host.replace(/^\*\./, '')
  if (!hostPattern.test(host) && !ipv4.test(bare)) return
  // A bare TLD or a single label is almost always a typo, and a wildcard over one is never intended.
  if (!ipv4.test(bare) && !bare.includes('.') && bare !== 'localhost') return
  return { text: raw, host, wildcard: host.startsWith('*.'), ...(port ? { port } : {}), path }
}

/** The targets in a text field (one per line, comma or semicolon separated), and the entries that could not be understood. */
export function parseWebTargets(text: string): { targets: WebTarget[]; invalid: string[] } {
  const targets: WebTarget[] = [], invalid: string[] = []
  for (const entry of text.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean)) {
    const target = parseWebTarget(entry)
    if (target) targets.push(target); else invalid.push(entry)
  }
  return { targets, invalid }
}

const defaultPort = (protocol: string) => protocol === 'https:' ? '443' : '80'

/**
 * Whether a request is at an authorized target. A host matches exactly or, for a wildcard, as a subdomain (`*.example.com` does not include
 * `example.com` itself). A target without a port covers only the scheme's default port; a target with a path covers that path and below.
 * With `hostOnly` (an HTTPS tunnel, whose path Kraflr cannot see) a path-limited target counts as soon as its host and port match.
 */
export function inWebScope(targets: WebTarget[], url: URL, hostOnly = false): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''), port = url.port || defaultPort(url.protocol)
  return targets.some((target) => {
    const bare = target.host.replace(/^\*\./, '')
    if (!(target.wildcard ? host.endsWith('.' + bare) : host === bare)) return false
    if ((target.port ?? defaultPort(url.protocol)) !== port) return false
    return hostOnly || !target.path || url.pathname === target.path || url.pathname.startsWith(target.path + '/')
  })
}

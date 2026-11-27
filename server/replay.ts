import http from 'node:http'
import https from 'node:https'
import { StoreError, type ResearchStore } from './db.ts'
import type { TrafficLog } from './traffic-log.ts'
import { inWebScope, parseWebTargets } from '../shared/web-scope.ts'

const bodyLimit = 64 * 1024
const hopByHop = new Set(['host', 'content-length', 'connection', 'proxy-authorization', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade'])

export interface DirectResponse { status: number; headers: Record<string, string>; body: string }

/**
 * Sends one request straight to its real target — not through the scope proxy, so a decrypted body comes back even for an HTTPS target that the
 * proxy itself can only tunnel blind. The caller checks scope before calling this; it does not check it itself.
 */
export function sendDirect(method: string, url: string, headers: Record<string, string>, body: string, timeout = 15000): Promise<DirectResponse> {
  return new Promise((resolve, reject) => {
    let target: URL
    try { target = new URL(url) } catch { reject(new Error('Not a valid URL.')); return }
    if (!['http:', 'https:'].includes(target.protocol)) { reject(new Error('Only http and https can be replayed.')); return }
    const client = target.protocol === 'https:' ? https : http
    const outgoing: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(headers)) if (!hopByHop.has(name.toLowerCase())) outgoing[name] = value
    outgoing.host = target.host
    outgoing.connection = 'close'
    const req = client.request({ method, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname + target.search, headers: outgoing, timeout }, (res) => {
      const chunks: Buffer[] = []; let bytes = 0
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (chunks.reduce((n, c) => n + c.length, 0) < bodyLimit) chunks.push(chunk) })
      res.on('end', () => {
        const flat: Record<string, string> = {}
        for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(', ') : String(value)
        resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', (error) => reject(new Error('Could not reach the target: ' + error.message)))
    req.on('timeout', () => { req.destroy(); reject(new Error('The target did not answer in time.')) })
    if (body) req.write(body)
    req.end()
  })
}

/** A rough, honestly-labelled comparison: exact match, or "the shorter body's start appears inside the longer one" as a stand-in for "looks like the same page". */
export function diffBodies(a: string, b: string) {
  const norm = (text: string) => text.replace(/\s+/g, ' ').trim()
  const na = norm(a), nb = norm(b), lengthDelta = Math.abs(na.length - nb.length)
  if (na === nb) return { similarity: 1, lengthDelta }
  if (!na || !nb) return { similarity: 0, lengthDelta }
  const sample = (na.length < nb.length ? na : nb).slice(0, 300)
  const similarity = sample.length > 20 && (na.includes(sample) ? nb : na).includes(sample) ? 0.85 : 0
  return { similarity, lengthDelta }
}

export interface CrossAccountResult {
  originalStatus: number; replayStatus: number; lengthDelta: number; similarity: number; verdict: string; headerSwapped: string; body: string
}

/**
 * The Autorize pattern: take a request Kraflr already captured, resend it with one header swapped for a different account's value (a session
 * cookie, a bearer token), and diff the live response against the one the original account got. A match in status and body on a request that
 * should have needed the original account's identity is the signal a researcher is looking for — broken access control, most often IDOR.
 * This only works for a plain `http` entry: Kraflr cannot read inside an HTTPS tunnel, so it never captured that request well enough to resend it.
 */
export function createReplay(store: Pick<ResearchStore, 'readPanel'>, traffic: Pick<TrafficLog, 'get' | 'append'>) {
  return {
    async crossAccount(panelId: string, entryId: string, headerName: string, altValue: string): Promise<CrossAccountResult> {
      const panel = store.readPanel(panelId)
      const original = traffic.get(panelId, entryId)
      if (!original || original.kind !== 'http' || !original.request || !original.url) {
        throw new StoreError(400, 'Pick a plain HTTP request from the traffic log to replay. An HTTPS tunnel is not captured in enough detail to resend.')
      }
      const name = headerName.trim()
      if (!name) throw new StoreError(400, 'Name the header to swap, for example Cookie or Authorization.')
      if (!altValue.trim()) throw new StoreError(400, "Give the other account's value for that header.")
      const { targets } = parseWebTargets(panel.scopeHistory[0]?.webTargets ?? '')
      const target = new URL(original.url)
      if (!inWebScope(targets, target)) throw new StoreError(403, 'This request is outside the targets currently authorized for this panel.')
      const headers = { ...original.request.headers, [name]: altValue.trim() }
      const replay = await sendDirect(original.method ?? 'GET', original.url, headers, original.request.body ?? '')
      const diff = diffBodies(original.response?.body ?? '', replay.body)
      const verdict = replay.status === original.status && diff.similarity >= 0.6
        ? `The response with ${name} swapped looks the same as the original (status ${replay.status}, body ${diff.lengthDelta === 0 ? 'identical length' : `within ${diff.lengthDelta} characters`}). Worth checking by hand for broken access control.`
        : `The response differs from the original (status ${original.status} → ${replay.status}, body length delta ${diff.lengthDelta}). On its own this does not suggest a problem.`
      traffic.append({ panelId, agentId: 'researcher', agent: 'Researcher (replay)', kind: 'http', method: original.method, url: original.url, status: replay.status })
      return { originalStatus: original.status ?? 0, replayStatus: replay.status, lengthDelta: diff.lengthDelta, similarity: diff.similarity, verdict, headerSwapped: name, body: replay.body.slice(0, 4000) }
    },
  }
}
export type Replay = ReturnType<typeof createReplay>

import http from 'node:http'
import net from 'node:net'
import { inWebScope, type WebTarget } from '../shared/web-scope.ts'
import type { TrafficEntry, TrafficSide } from './traffic-log.ts'

/** Who is asking, resolved from the agent's own credentials. `undefined` means the request is not from a running Kraflr agent. */
export interface ProxyIdentity { panelId: string; agentId: string; agent: string; targets: WebTarget[] }

export interface ScopeProxyOptions {
  identify(agentId: string, token: string): ProxyIdentity | undefined
  log(entry: Omit<TrafficEntry, 'id' | 'at'>): void
  /**
   * What to do with an HTTPS tunnel (CONNECT), where only the host and port are visible and never the traffic. `pass` (the default) tunnels everything and
   * records each connection to a host that is not an authorized target, flagged as out of scope. `strict` refuses those instead.
   */
  https?: 'pass' | 'strict'
  /** Extra hosts an agent's own tooling needs, added to the built-in infrastructure list. Never recorded, never refused. */
  allowHosts?: string[]
}

const excerpt = 4096
const hopByHop = new Set(['proxy-authorization', 'proxy-connection', 'proxy-authenticate', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade'])

/**
 * Services an agent's own tools reach regardless of the target (model providers, package registries). They are listed in the agent's NO_PROXY, so the
 * agent's own connectivity never depends on the proxy, and a tunnel to one of them is never recorded or refused.
 */
export const infrastructureHosts = [
  'api.anthropic.com', 'anthropic.com', 'claude.ai', 'claude.com', 'openai.com', 'openrouter.ai', 'googleapis.com', 'google.com', 'cline.bot', 'opencode.ai', 'models.dev', 'sst.dev',
  'github.com', 'githubusercontent.com', 'npmjs.org', 'npmjs.com', 'pypi.org', 'pythonhosted.org', 'docker.io', 'docker.com', 'ubuntu.com', 'debian.org',
  'golang.org', 'crates.io', 'rust-lang.org', 'sentry.io', 'statsig.com', 'datadoghq.com',
]
const infrastructure = (host: string, extra: string[]) => [...infrastructureHosts, ...extra].some((suffix) => host === suffix || host.endsWith('.' + suffix))

/**
 * The environment variables that point an agent's HTTP and HTTPS tools at its proxy. Credentials in the URL identify the agent. NO_PROXY lists the
 * infrastructure hosts, because the agent's own model traffic follows these variables too (Claude Code hangs if its API calls hit a proxy that says no).
 * A local lab is deliberately not in NO_PROXY, so it goes through the proxy.
 */
export function proxyEnvironment(port: number, agentId: string, token: string, extraHosts: string[] = []): Record<string, string> {
  const url = `http://${agentId}:${token}@127.0.0.1:${port}`
  const bypass = [...new Set([...infrastructureHosts, ...extraHosts.map((host) => host.toLowerCase())])].flatMap((host) => [host, '.' + host]).join(',')
  return { HTTP_PROXY: url, http_proxy: url, HTTPS_PROXY: url, https_proxy: url, NO_PROXY: bypass, no_proxy: bypass }
}

function side(headers: http.IncomingHttpHeaders | http.OutgoingHttpHeaders, chunks: Buffer[], bytes: number): TrafficSide {
  const flat: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !hopByHop.has(name.toLowerCase())) flat[name] = Array.isArray(value) ? value.join(', ') : String(value)
  const raw = Buffer.concat(chunks).subarray(0, excerpt)
  const encoded = flat['content-encoding'] && flat['content-encoding'] !== 'identity'
  const body = encoded ? `[${flat['content-encoding']} compressed, ${bytes} bytes]` : raw.includes(0) ? `[binary, ${bytes} bytes]` : raw.toString('utf8')
  return { headers: flat, body: bytes > excerpt && !encoded && !raw.includes(0) ? body + `\n… ${bytes - excerpt} more bytes` : body, bytes }
}

/**
 * A forward proxy on the loopback interface for the agents of web research panels. Plain-HTTP requests to an authorized target are forwarded and
 * recorded with their headers and the start of each body; a request to anything else is refused with a message the agent can act on, and recorded
 * as blocked. Agents identify themselves with the credentials Kraflr put in their proxy URL, so every entry names the agent and the panel.
 * It only covers tools that honour proxy settings: a tool that ignores them is neither recorded nor blocked.
 */
export async function createScopeProxy(options: ScopeProxyOptions) {
  const extra = (options.allowHosts ?? []).map((host) => host.toLowerCase())
  const sockets = new Set<{ destroy(): unknown }>()
  let port = 0

  function authorize(header: string | undefined) {
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header ?? '')
    if (!match) return
    const decoded = Buffer.from(match[1]!, 'base64').toString('utf8'), at = decoded.indexOf(':')
    if (at < 1) return
    const id = decoded.slice(0, at), token = decoded.slice(at + 1)
    if (id.length > 100 || !token) return
    return options.identify(id, token)
  }
  const refusal = (who: ProxyIdentity, host: string) =>
    `Kraflr blocked this request: ${host} is not one of the authorized targets for this research panel (${who.targets.map((target) => target.text).join(', ') || 'none saved'}). Test only the authorized targets.`
  const selfRequest = (host: string, targetPort: string) => String(port) === targetPort && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase())

  const server = http.createServer((req, res) => {
    const who = authorize(req.headers['proxy-authorization'])
    if (!who) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="kraflr"', 'content-type': 'text/plain' }); res.end('Kraflr proxy: this request is not from a running Kraflr agent.\n'); return }
    let target: URL
    try { target = new URL(req.url ?? '') } catch { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('Send an absolute http:// URL through this proxy.\n'); return }
    if (target.protocol !== 'http:') { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('Only http:// requests are proxied here; use a CONNECT tunnel for https.\n'); return }
    const started = Date.now(), url = target.href, base = { panelId: who.panelId, agentId: who.agentId, agent: who.agent, kind: 'http' as const, method: req.method ?? 'GET', url }
    const requestChunks: Buffer[] = []; let requestBytes = 0, requestKept = 0
    const requestSide = () => side(req.headers, requestChunks, requestBytes)
    if (selfRequest(target.hostname, target.port || '80') || !inWebScope(who.targets, target)) {
      const reason = selfRequest(target.hostname, target.port || '80') ? 'The proxy cannot be used to reach itself.' : refusal(who, target.host)
      res.writeHead(403, { 'content-type': 'text/plain', 'x-kraflr-blocked': '1' }); res.end(reason + '\n')
      options.log({ ...base, status: 403, blocked: true, reason, ms: Date.now() - started, request: side(req.headers, [], 0) })
      req.resume(); return
    }
    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) if (!hopByHop.has(name.toLowerCase())) headers[name] = value
    headers.connection = 'close'
    let logged = false
    const finish = (status: number, response: TrafficSide | undefined, reason?: string) => {
      if (logged) return; logged = true
      options.log({ ...base, status, ...(reason ? { reason } : {}), ms: Date.now() - started, request: requestSide(), ...(response ? { response } : {}) })
    }
    const upstream = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers, agent: false }, (answer) => {
      const chunks: Buffer[] = []; let bytes = 0, kept = 0
      res.writeHead(answer.statusCode ?? 502, Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !hopByHop.has(name))) as http.OutgoingHttpHeaders)
      answer.on('data', (chunk: Buffer) => { bytes += chunk.length; if (kept < excerpt) { chunks.push(chunk); kept += chunk.length } })
      answer.on('end', () => finish(answer.statusCode ?? 502, side(answer.headers, chunks, bytes)))
      answer.on('error', () => finish(502, side(answer.headers, chunks, bytes), 'The target closed the connection mid-response.'))
      answer.pipe(res)
    })
    upstream.on('error', (error) => {
      const reason = `Kraflr could not reach ${target.host}: ${error.message}`
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(reason + '\n') } else res.destroy()
      finish(502, undefined, reason)
    })
    req.on('data', (chunk: Buffer) => { requestBytes += chunk.length; if (requestKept < excerpt) { requestChunks.push(chunk); requestKept += chunk.length } })
    res.on('close', () => { if (!logged) { finish(0, undefined, 'The agent closed the connection before the response finished.'); upstream.destroy() } })
    req.pipe(upstream)
  })

  server.on('connect', (req, client, head) => {
    // A socket without an error listener would take the whole runtime down on a reset, so it is attached before anything else can happen.
    client.on('error', () => {})
    const who = authorize(req.headers['proxy-authorization'])
    const end = (status: string, text: string) => client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`)
    if (!who) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="kraflr"\r\nContent-Length: 0\r\n\r\n'); return }
    let target: URL
    try { target = new URL('https://' + req.url) } catch { end('400 Bad Request', 'Send host:port to CONNECT.\n'); return }
    const started = Date.now(), host = target.hostname.toLowerCase(), targetPort = target.port || '443'
    const base = { panelId: who.panelId, agentId: who.agentId, agent: who.agent, kind: 'tunnel' as const, method: 'CONNECT', url: `${host}:${targetPort}` }
    const scoped = !selfRequest(host, targetPort) && inWebScope(who.targets, target, true), routine = infrastructure(host, extra)
    if (selfRequest(host, targetPort) || (options.https === 'strict' && !scoped && !routine)) {
      const reason = selfRequest(host, targetPort) ? 'The proxy cannot be used to reach itself.' : refusal(who, host)
      end('403 Forbidden', reason + '\n'); options.log({ ...base, status: 403, blocked: true, reason, ms: 0 }); return
    }
    const upstream = net.connect(Number(targetPort), host.replace(/^\[|\]$/g, ''), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client); client.pipe(upstream)
      // Infrastructure traffic is not research evidence. Everything else is recorded, and a host that is not an authorized target is flagged.
      if (!routine) options.log({ ...base, status: 200, ms: Date.now() - started, ...(scoped ? {} : { outOfScope: true, reason: `HTTPS connection to ${host}, which is not an authorized target. Kraflr can see the host but cannot read or block HTTPS content.` }) })
    })
    sockets.add(client); sockets.add(upstream)
    const drop = () => { sockets.delete(client); sockets.delete(upstream); client.destroy(); upstream.destroy() }
    upstream.on('error', (error) => { if (!client.destroyed && !client.writableEnded) end('502 Bad Gateway', `Kraflr could not reach ${host}: ${error.message}\n`); drop() })
    client.on('error', drop); client.on('close', drop); upstream.on('close', drop)
  })
  server.on('clientError', (_error, socket) => { socket.destroy() })
  // Belt and braces: whatever happens to any socket this proxy owns, it must never become an unhandled error in the runtime.
  server.on('connection', (socket) => { socket.on('error', () => {}) })

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as net.AddressInfo).port
  return {
    port,
    async close() {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
export type ScopeProxy = Awaited<ReturnType<typeof createScopeProxy>>

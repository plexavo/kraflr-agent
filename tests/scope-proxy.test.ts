import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScopeProxy, proxyEnvironment, type ProxyIdentity } from '../server/scope-proxy.ts'
import { createTrafficLog, type TrafficEntry } from '../server/traffic-log.ts'
import { inWebScope, parseWebTargets } from '../shared/web-scope.ts'

const listen = (server: http.Server | net.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
const close = (server: http.Server | net.Server) => new Promise<void>((resolve) => { (server as http.Server).closeAllConnections?.(); server.close(() => resolve()) })
const basic = (id: string, token: string) => 'Basic ' + Buffer.from(`${id}:${token}`).toString('base64')

/** Sends one request through the proxy the way curl does: an absolute URL on the request line. */
function viaProxy(proxyPort: number, url: string, init: { method?: string; auth?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: init.method ?? 'GET', path: url, headers: { host: new URL(url).host, ...(init.auth ? { 'proxy-authorization': init.auth } : {}), ...init.headers }, agent: false }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }))
    })
    req.on('error', reject); req.end(init.body)
  })
}

async function setup(scopeOf: (target: number) => string, options: { https?: 'pass' | 'strict'; allowHosts?: string[] } = {}) {
  const hits: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = []
  const target = http.createServer((req, res) => { let body = ''; req.on('data', (chunk) => { body += chunk }); req.on('end', () => { hits.push({ method: req.method, url: req.url, headers: req.headers, body }); res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'sid=abc' }); res.end('hello from the lab ' + req.url) }) })
  const other = http.createServer((_req, res) => { hits.push({ url: 'OTHER', headers: {}, body: '' }); res.end('should never be reached') })
  const targetPort = await listen(target), otherPort = await listen(other)
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-proxy-'))), log = createTrafficLog(folder)
  const panelId = '11111111-1111-4111-8111-111111111111'
  const identity: ProxyIdentity = { panelId, agentId: 'agent-1', agent: 'Parent', targets: parseWebTargets(scopeOf(targetPort)).targets }
  const proxy = await createScopeProxy({ identify: (id, token) => id === 'agent-1' && token === 'secret' ? identity : undefined, log: (entry) => log.append(entry), ...options })
  return { hits, target, other, targetPort, otherPort, log, panelId, proxy, folder, async done() { await proxy.close(); await close(target); await close(other); await rm(folder, { recursive: true, force: true }) } }
}

test('the scope matcher: hosts, wildcards, ports and path prefixes', () => {
  const u = (text: string) => new URL(text)
  const t = (text: string) => parseWebTargets(text).targets
  assert.equal(inWebScope(t('shop.example.com'), u('http://shop.example.com/a')), true)
  assert.equal(inWebScope(t('shop.example.com'), u('http://SHOP.example.com/a')), true)
  assert.equal(inWebScope(t('shop.example.com'), u('http://evil.example.com/')), false)
  assert.equal(inWebScope(t('shop.example.com'), u('http://shop.example.com.evil.net/')), false)
  assert.equal(inWebScope(t('*.example.com'), u('http://api.example.com/')), true)
  assert.equal(inWebScope(t('*.example.com'), u('http://example.com/')), false, 'a wildcard is subdomains only')
  assert.equal(inWebScope(t('*.example.com'), u('http://notexample.com/')), false)
  assert.equal(inWebScope(t('192.0.2.10:8080'), u('http://192.0.2.10:8080/x')), true)
  assert.equal(inWebScope(t('192.0.2.10:8080'), u('http://192.0.2.10/x')), false)
  assert.equal(inWebScope(t('192.0.2.10:8080'), u('http://192.0.2.10:9090/x')), false)
  assert.equal(inWebScope(t('shop.example.com'), u('http://shop.example.com:8080/')), false, 'no port means the default port only')
  assert.equal(inWebScope(t('http://shop.example.com/store'), u('http://shop.example.com/store')), true)
  assert.equal(inWebScope(t('http://shop.example.com/store'), u('http://shop.example.com/store/cart')), true)
  assert.equal(inWebScope(t('http://shop.example.com/store'), u('http://shop.example.com/storefront')), false, 'a path prefix is a path boundary')
  assert.equal(inWebScope(t('http://shop.example.com/store'), u('https://shop.example.com/store'), true), true, 'a tunnel cannot show its path')
  assert.equal(inWebScope([], u('http://shop.example.com/')), false)
})

test('an authorized request is forwarded and recorded in full; the proxy credentials never reach the target', async () => {
  const lab = await setup((port) => `127.0.0.1:${port}`)
  try {
    const answer = await viaProxy(lab.proxy.port, `http://127.0.0.1:${lab.targetPort}/api/items?id=1`, { auth: basic('agent-1', 'secret'), headers: { cookie: 'session=xyz' } })
    assert.equal(answer.status, 200); assert.equal(answer.body, 'hello from the lab /api/items?id=1'); assert.equal(answer.headers['set-cookie']?.[0], 'sid=abc')
    assert.equal(lab.hits.length, 1); assert.equal(lab.hits[0]!.url, '/api/items?id=1'); assert.equal(lab.hits[0]!.headers['proxy-authorization'], undefined); assert.equal(lab.hits[0]!.headers.cookie, 'session=xyz')
    const [entry] = lab.log.list(lab.panelId).entries
    assert.equal(entry!.kind, 'http'); assert.equal(entry!.method, 'GET'); assert.equal(entry!.status, 200); assert.equal(entry!.blocked, undefined); assert.equal(entry!.agent, 'Parent')
    const full = lab.log.get(lab.panelId, entry!.id)!
    assert.equal(full.response!.body, 'hello from the lab /api/items?id=1'); assert.equal(full.response!.headers['set-cookie'], 'sid=abc'); assert.equal(full.request!.headers.cookie, 'session=xyz')
    assert.equal(JSON.stringify(full).includes('secret'), false, 'the agent token is never logged'); assert.equal(full.request!.headers['proxy-authorization'], undefined)
  } finally { await lab.done() }
})

test('a request body is forwarded and its start is recorded', async () => {
  const lab = await setup((port) => `127.0.0.1:${port}`)
  try {
    const answer = await viaProxy(lab.proxy.port, `http://127.0.0.1:${lab.targetPort}/login`, { method: 'POST', auth: basic('agent-1', 'secret'), body: 'user=admin&pass=' + 'x'.repeat(6000), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    assert.equal(answer.status, 200); assert.equal(lab.hits[0]!.method, 'POST'); assert.equal(lab.hits[0]!.body.length, 6000 + 'user=admin&pass='.length)
    const full = lab.log.get(lab.panelId, lab.log.list(lab.panelId).entries[0]!.id)!
    assert.match(full.request!.body, /^user=admin&pass=x+\n… \d+ more bytes$/); assert.equal(full.request!.bytes, 6016); assert.ok(full.request!.body.length < 4200)
  } finally { await lab.done() }
})

test('a request to anything outside the authorized targets is refused, never reaches the host, and is recorded as blocked', async () => {
  const lab = await setup((port) => `127.0.0.1:${port}`)
  try {
    const answer = await viaProxy(lab.proxy.port, `http://127.0.0.1:${lab.otherPort}/secret`, { auth: basic('agent-1', 'secret') })
    assert.equal(answer.status, 403); assert.equal(answer.headers['x-kraflr-blocked'], '1')
    assert.match(answer.body, /not one of the authorized targets/); assert.match(answer.body, new RegExp(`127\\.0\\.0\\.1:${lab.targetPort}`))
    assert.equal(lab.hits.length, 0, 'the other server was never contacted')
    const [entry] = lab.log.list(lab.panelId).entries
    assert.equal(entry!.blocked, true); assert.equal(entry!.status, 403); assert.match(entry!.reason!, /authorized targets/)
    // A path-limited target blocks the rest of the host.
    const limited = await setup((port) => `http://127.0.0.1:${port}/store`)
    try {
      assert.equal((await viaProxy(limited.proxy.port, `http://127.0.0.1:${limited.targetPort}/store/cart`, { auth: basic('agent-1', 'secret') })).status, 200)
      assert.equal((await viaProxy(limited.proxy.port, `http://127.0.0.1:${limited.targetPort}/admin`, { auth: basic('agent-1', 'secret') })).status, 403)
      assert.equal(limited.hits.length, 1)
    } finally { await limited.done() }
  } finally { await lab.done() }
})

test('a request without valid agent credentials is refused, and the proxy cannot be pointed at itself', async () => {
  const lab = await setup((port) => `127.0.0.1:${port}`)
  try {
    const none = await viaProxy(lab.proxy.port, `http://127.0.0.1:${lab.targetPort}/`)
    assert.equal(none.status, 407); assert.match(none.headers['proxy-authenticate'] as string, /Basic/)
    assert.equal((await viaProxy(lab.proxy.port, `http://127.0.0.1:${lab.targetPort}/`, { auth: basic('agent-1', 'wrong') })).status, 407)
    assert.equal((await viaProxy(lab.proxy.port, `http://127.0.0.1:${lab.targetPort}/`, { auth: basic('someone-else', 'secret') })).status, 407)
    assert.equal(lab.hits.length, 0); assert.equal(lab.log.list(lab.panelId).total, 0, 'an unidentified caller is not attributed to any panel')
    const self = await setup(() => 'localhost')
    try {
      // Even if the targets listed the proxy's own address, it would not forward to itself.
      const loop = await viaProxy(self.proxy.port, `http://localhost:${self.proxy.port}/`, { auth: basic('agent-1', 'secret') })
      assert.equal(loop.status, 403)
    } finally { await self.done() }
  } finally { await lab.done() }
})

test('an unreachable target returns a clear 502 and is recorded', async () => {
  const lab = await setup(() => '127.0.0.1:1')
  try {
    const answer = await viaProxy(lab.proxy.port, 'http://127.0.0.1:1/', { auth: basic('agent-1', 'secret') })
    assert.equal(answer.status, 502); assert.match(answer.body, /could not reach/)
    assert.equal(lab.log.list(lab.panelId).entries[0]!.status, 502)
  } finally { await lab.done() }
})

/** Opens a CONNECT tunnel through the proxy the way an HTTPS client does and returns the proxy's answer and the live socket. */
const connect = (proxyPort: number, hostPort: string, auth = basic('agent-1', 'secret')) => new Promise<{ head: string; socket: net.Socket }>((resolve, reject) => {
  const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\nProxy-Authorization: ${auth}\r\n\r\n`))
  let head = ''; socket.setEncoding('utf8'); socket.once('data', (chunk) => { head = String(chunk); resolve({ head, socket }) }); socket.on('error', reject)
})
const echoServer = async () => { const echo = net.createServer((socket) => { socket.on('data', (chunk) => socket.write('echo:' + String(chunk))) }); return { echo, port: await listen(echo) } }
const roundTrip = (socket: net.Socket) => new Promise<string>((resolve) => { socket.once('data', (chunk) => resolve(String(chunk))); socket.write('ping') })

test('HTTPS tunnels pass by default: an authorized host is recorded, an unauthorized one is let through but flagged, infrastructure is neither recorded nor flagged', async () => {
  const { echo, port } = await echoServer(), { echo: other, port: otherPort } = await echoServer()
  const lab = await setup(() => `127.0.0.1:${port}`, { allowHosts: ['localhost'] })
  try {
    const inScope = await connect(lab.proxy.port, `127.0.0.1:${port}`); assert.match(inScope.head, /^HTTP\/1\.1 200/); assert.equal(await roundTrip(inScope.socket), 'echo:ping'); inScope.socket.destroy()
    const outside = await connect(lab.proxy.port, `127.0.0.1:${otherPort}`); assert.match(outside.head, /^HTTP\/1\.1 200/, 'passed through, so an agent’s own tooling is never stalled'); assert.equal(await roundTrip(outside.socket), 'echo:ping'); outside.socket.destroy()
    const entries = lab.log.list(lab.panelId).entries.filter((entry) => entry.kind === 'tunnel')
    assert.equal(entries.length, 2); const flagged = entries.find((entry) => entry.url === `127.0.0.1:${otherPort}`)!, authorized = entries.find((entry) => entry.url === `127.0.0.1:${port}`)!
    assert.equal(flagged.outOfScope, true); assert.match(flagged.reason!, /not an authorized target/); assert.equal(flagged.blocked, undefined); assert.equal(authorized.outOfScope, undefined)
    const before = lab.log.list(lab.panelId).total
    const routine = await connect(lab.proxy.port, `localhost:${port}`).catch(() => undefined); routine?.socket.destroy()
    assert.equal(lab.log.list(lab.panelId).total, before, 'a configured infrastructure host is not recorded')
    const anonymous = await connect(lab.proxy.port, `127.0.0.1:${port}`, basic('agent-1', 'nope')); assert.match(anonymous.head, /^HTTP\/1\.1 407/); anonymous.socket.destroy()
  } finally { await lab.done(); await close(echo); await close(other) }
})

test('strict HTTPS mode refuses a tunnel to a host that is not an authorized target or infrastructure', async () => {
  const { echo, port } = await echoServer()
  const lab = await setup(() => `127.0.0.1:${port}`, { https: 'strict', allowHosts: ['allowed.test'] })
  try {
    const open = await connect(lab.proxy.port, `127.0.0.1:${port}`); assert.match(open.head, /^HTTP\/1\.1 200/); assert.equal(await roundTrip(open.socket), 'echo:ping'); open.socket.destroy()
    const refused = await connect(lab.proxy.port, `127.0.0.1:${port + 1}`); assert.match(refused.head, /^HTTP\/1\.1 403/); assert.match(refused.head, /not one of the authorized targets/); refused.socket.destroy()
    assert.equal(lab.log.list(lab.panelId).entries.some((entry) => entry.blocked && entry.kind === 'tunnel'), true)
  } finally { await lab.done(); await close(echo) }
})

test('a tunnel that resets, a bad CONNECT line and an unauthenticated client can never crash the process', async () => {
  const lab = await setup(() => '127.0.0.1:1')
  const crashes: unknown[] = []; const catcher = (error: unknown) => { crashes.push(error) }; process.on('uncaughtException', catcher)
  try {
    for (const line of ['CONNECT not-a-host-port HTTP/1.1', 'CONNECT 127.0.0.1:1 HTTP/1.1', 'CONNECT 127.0.0.1:1 HTTP/1.1\r\nProxy-Authorization: ' + basic('agent-1', 'secret')]) {
      const socket = net.connect(lab.proxy.port, '127.0.0.1'); socket.on('error', () => {}); socket.write(line + '\r\n\r\n'); await new Promise((done) => setTimeout(done, 60)); socket.resetAndDestroy()
    }
    const half = net.connect(lab.proxy.port, '127.0.0.1'); half.on('error', () => {}); half.write('GET http://127.0.0.1:1/ HTTP'); await new Promise((done) => setTimeout(done, 60)); half.resetAndDestroy()
    await new Promise((done) => setTimeout(done, 200))
    assert.deepEqual(crashes, [], 'no unhandled socket error escaped')
    assert.equal((await viaProxy(lab.proxy.port, 'http://127.0.0.1:1/', { auth: basic('agent-1', 'secret') })).status, 502, 'the proxy still serves requests')
  } finally { process.off('uncaughtException', catcher); await lab.done() }
})

test('the proxy environment sends HTTP and HTTPS tools to the proxy but keeps the agent’s own providers off it, and never exempts a local lab', () => {
  const env = proxyEnvironment(4321, 'agent-1', 'secret', ['custom-llm.internal'])
  assert.equal(env.HTTP_PROXY, 'http://agent-1:secret@127.0.0.1:4321'); assert.equal(env.http_proxy, env.HTTP_PROXY); assert.equal(env.HTTPS_PROXY, env.HTTP_PROXY); assert.equal(env.https_proxy, env.HTTP_PROXY)
  const bypass = env.NO_PROXY!.split(','); assert.equal(env.no_proxy, env.NO_PROXY)
  for (const host of ['api.anthropic.com', 'anthropic.com', '.anthropic.com', 'claude.ai', '.claude.ai', 'openrouter.ai', 'custom-llm.internal', '.custom-llm.internal']) assert.ok(bypass.includes(host), host)
  for (const host of ['127.0.0.1', 'localhost', '192.0.2.10', '']) assert.equal(bypass.includes(host), false, 'a local lab must go through the proxy: ' + host)
})

test('the traffic log lists newest first without bodies, finds an entry, rolls over at its limit, and refuses a bad panel id', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-traffic-'))), panelId = '22222222-2222-4222-8222-222222222222'
  try {
    const log = createTrafficLog(folder, 2000)
    const add = (n: number): TrafficEntry => log.append({ panelId, agentId: 'a', agent: 'Parent', kind: 'http', method: 'GET', url: 'http://lab/' + n, status: 200, request: { headers: {}, body: 'x'.repeat(300), bytes: 300 } })
    for (let n = 0; n < 12; n++) add(n)
    const page = log.list(panelId, 0, 5)
    assert.equal(page.entries.length, 5); assert.equal(page.entries[0]!.url, 'http://lab/11'); assert.equal(page.more, true); assert.equal('request' in page.entries[0]!, false); assert.equal(page.entries[0]!.hasBodies, true)
    assert.ok(log.list(panelId, 0, 100).total >= 6, 'the previous file is still read after a rollover')
    const newest = log.list(panelId, 0, 1).entries[0]!; assert.equal(log.get(panelId, newest.id)?.request?.body.length, 300)
    assert.equal(log.get(panelId, 'no-such-entry'), undefined)
    assert.throws(() => log.list('../../etc/passwd'), /Invalid panel/)
    log.append({ panelId, agentId: 'a', agent: 'Parent', kind: 'command', text: 'Bash: nmap -sV 127.0.0.1' })
    assert.equal(log.list(panelId, 0, 1).entries[0]!.text, 'Bash: nmap -sV 127.0.0.1')
  } finally { await rm(folder, { recursive: true, force: true }) }
})

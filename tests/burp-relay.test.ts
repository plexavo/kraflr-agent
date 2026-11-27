import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { burpFailure, burpHint } from '../shared/burp.ts'

const script = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'burp-relay.mjs')).href
const { createRelay } = await import(script) as { createRelay: (options: { targetPort: number; host: () => string; connectTimeoutMs?: number }) => http.Server }
const listen = (server: http.Server) => new Promise<number>((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)))
const close = (server: http.Server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) })
const send = (port: number, options: { host?: string; path?: string; body?: string } = {}) => new Promise<{ status: number; text: string }>((done, fail) => {
  const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: options.path ?? '/mcp', agent: false, headers: { host: options.host ?? `127.0.0.1:${port}`, 'content-type': 'application/json' } }, (reply) => {
    let text = ''; reply.setEncoding('utf8'); reply.on('data', (chunk) => { text += chunk }); reply.on('end', () => done({ status: reply.statusCode!, text }))
  })
  request.on('error', fail); request.end(options.body ?? '{}')
})

test('the relay listens on its own port and reaches a Burp that accepts only its own port in the Host header', async () => {
  let burpPort = 0
  const seen: string[] = []
  // Burp's real rule: the Host must be a loopback name and, if it names a port, Burp's own.
  const burp = http.createServer((request, response) => {
    const host = request.headers.host ?? ''
    if (!['127.0.0.1:' + burpPort, 'localhost:' + burpPort].includes(host)) { response.writeHead(403).end(); return }
    let body = ''; request.on('data', (chunk) => { body += chunk })
    request.on('end', () => { seen.push(request.method + ' ' + request.url + ' ' + body); response.writeHead(200, { 'content-type': 'text/plain' }).end('burp answered') })
  })
  burpPort = await listen(burp)
  const relay = createRelay({ targetPort: burpPort, host: () => '127.0.0.1' }), relayPort = await listen(relay)
  try {
    assert.notEqual(relayPort, burpPort)
    assert.deepEqual(await send(relayPort, { body: '{"id":1}' }), { status: 200, text: 'burp answered' })
    assert.equal((await send(relayPort, { host: 'localhost:' + relayPort })).status, 200)
    assert.deepEqual(seen.slice(0, 1), ['POST /mcp {"id":1}'])
    // A page that rebinds its own domain to loopback is stopped here, before the Host header is rewritten.
    assert.equal((await send(relayPort, { host: 'attacker.example:' + relayPort })).status, 403)
    assert.equal(seen.length, 2)
  } finally { await close(relay); await close(burp) }
})

test('an event stream is passed on as it arrives, and an unreachable Burp is said so', async () => {
  let finish = () => {}
  const burp = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: first\n\n'); finish = () => response.end('data: last\n\n') })
  const burpPort = await listen(burp)
  const relay = createRelay({ targetPort: burpPort, host: () => '127.0.0.1' }), relayPort = await listen(relay)
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/mcp`)
    const reader = response.body!.getReader(), read = async () => new TextDecoder().decode((await reader.read()).value)
    assert.match(await read(), /data: first/, 'the first event arrives while the stream is still open')
    finish()
    assert.match(await read(), /data: last/)
    await close(burp)
    const down = await send(relayPort)
    assert.equal(down.status, 502); assert.match(down.text, /Burp is not reachable/)
  } finally { await close(relay); if (burp.listening) await close(burp) }
})

test('a Burp that never answers is reported within the connect limit, and the reason reaches the MCP client', async () => {
  // A private address nothing answers on stands in for the Windows host dropping connections to a closed Burp.
  const relay = createRelay({ targetPort: 9, host: () => '10.255.255.1', connectTimeoutMs: 300 }), relayPort = await listen(relay)
  const client = new Client({ name: 'relay-check', version: '1.0.0' })
  try {
    const started = Date.now()
    await assert.rejects(client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${relayPort}/mcp`)), { timeout: 5000 }), /Burp is not reachable from the relay/)
    assert.ok(Date.now() - started < 4000, 'it does not hang until the caller gives up')
  } finally { await client.close(); await close(relay) }
})

test('a failed connection from WSL says what to change', () => {
  assert.match(burpHint('http://127.0.0.1:9876/mcp', '', true), /save the relay’s address instead: http:\/\/127\.0\.0\.1:9877\/mcp \(Burp itself stays on 9876\)/)
  assert.match(burpHint('http://localhost:9877/mcp', 'nothing answered at that address (ECONNREFUSED)', true), /systemctl --user start burp-relay/)
  assert.equal(burpHint('http://127.0.0.1:9877/mcp', 'Burp is not reachable from the relay', true), '', 'the relay already says what is wrong')
  assert.equal(burpHint('http://127.0.0.1:9876/mcp', '', false), '', 'outside WSL Burp’s own port is right')
  assert.equal(burpHint('http://192.168.1.5:9876/mcp', '', true), ''); assert.equal(burpHint('not a url', '', true), '')
  assert.equal(burpFailure(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })), 'nothing answered at that address (ECONNREFUSED)')
  assert.equal(burpFailure(new Error('HTTP 403')), 'HTTP 403')
})

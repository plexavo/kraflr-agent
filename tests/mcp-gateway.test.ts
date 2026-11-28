import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { createGateway } from '../server/mcp-gateway.ts'
import { clineMcpSettings, gatewayServerConfig } from '../server/mcp-gateway-config.ts'

/** Stands in for `spawn('semgrep', …)`, matching the fake used in tests/semgrep-scan.test.ts. */
function fakeProcess() {
  const proc = new EventEmitter() as unknown as ChildProcess & EventEmitter
  const stdout = new EventEmitter()
  ;(proc as unknown as { stdout: EventEmitter }).stdout = stdout
  return { proc, stdout, finish: (json: string, code = 1) => { stdout.emit('data', Buffer.from(json)); proc.emit('close', code) } }
}

async function connectedClient(server: Server) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  await client.connect(clientSide)
  return client
}

test('tools/list always offers semgrep_scan and burp_status, and tools/call runs a scan through the injected spawn function', async () => {
  const fake = fakeProcess()
  // The call crosses the in-memory MCP transport before our handler calls runSemgrep, so the test must wait for that
  // call (and the listeners it attaches, in the same synchronous stack) before emitting on the fake process.
  let spawned: () => void = () => {}
  const spawnedPromise = new Promise<void>((resolve) => { spawned = resolve })
  const gateway = createGateway({ runSemgrep: () => { spawned(); return fake.proc } })
  const client = await connectedClient(gateway)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['burp_status', 'semgrep_scan'])

  const resultPromise = client.callTool({ name: 'semgrep_scan', arguments: { path: '/workspace' } })
  await spawnedPromise
  fake.finish(JSON.stringify({ results: [{ check_id: 'rules.sql-injection', path: 'app.py', start: { line: 5 }, end: { line: 5 }, extra: { message: 'SQL injection', severity: 'error' } }] }), 1)
  const result = await resultPromise as { content: { type: string; text: string }[] }
  assert.match(result.content[0]!.text, /1 hit\(s\)/)
  assert.match(result.content[0]!.text, /app\.py:5/)
})

test('burp_status reports unconfigured when no URL is set, and unreachable when the configured endpoint refuses to connect', async () => {
  const unconfigured = await connectedClient(createGateway())
  const first = await unconfigured.callTool({ name: 'burp_status', arguments: {} }) as { content: { text: string }[] }
  assert.match(first.content[0]!.text, /not configured/)

  const unreachable = await connectedClient(createGateway({ burpUrl: 'http://127.0.0.1:1', connectBurp: async () => { throw new Error('ECONNREFUSED') } }))
  const second = await unreachable.callTool({ name: 'burp_status', arguments: {} }) as { content: { text: string }[]; isError?: boolean }
  assert.match(second.content[0]!.text, /not reachable: ECONNREFUSED/)
  assert.equal(second.isError, true)
})

test('a connected Burp link is listed and proxied under a burp_ prefix, forwarding the call and its result unchanged', async () => {
  const burpServer = new Server({ name: 'burp', version: '1.0.0' }, { capabilities: { tools: {} } })
  burpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'send_http_request', description: 'Sends a request.', inputSchema: { type: 'object', properties: {} } }] }))
  burpServer.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: 'text', text: 'echo:' + JSON.stringify(request.params.arguments) }] }))
  const fakeBurpClient = await connectedClient(burpServer)

  const gateway = createGateway({ burpUrl: 'http://fake-burp.invalid', connectBurp: async () => fakeBurpClient })
  const agent = await connectedClient(gateway)

  const { tools } = await agent.listTools()
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['burp_send_http_request', 'burp_status', 'semgrep_scan'])

  const result = await agent.callTool({ name: 'burp_send_http_request', arguments: { url: 'https://example.test' } }) as { content: { text: string }[] }
  assert.equal(result.content[0]!.text, 'echo:{"url":"https://example.test"}')

  const unknown = await agent.callTool({ name: 'burp_not_a_real_tool', arguments: {} }) as { content: { text: string }[]; isError?: boolean }
  assert.match(unknown.content[0]!.text, /does not report a tool named/)
  assert.equal(unknown.isError, true)
})

test('long Burp responses are shortened, saved whole, searchable, and a repeated page is not sent twice', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'kraflr-responses-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const page = (nonce: string, extra = '') => `HttpRequestResponse{httpRequest=GET /a HTTP/1.1\r\nCookie: session=SECRET\r\n\r\n, httpResponse=HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\n\r\n<script nonce="${nonce}"></script>${'<nav>menu</nav>'.repeat(900)}<p>needle-${extra}</p>, messageAnnotations=Annotations{}}`
  const forwarded: unknown[] = []
  let reply = page('one')
  const burpServer = new Server({ name: 'burp', version: '1.0.0' }, { capabilities: { tools: {} } })
  burpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['send_http1_request', 'get_proxy_http_history'].map((name) => ({ name, inputSchema: { type: 'object' as const, properties: { content: { type: 'string' } } } })) }))
  burpServer.setRequestHandler(CallToolRequestSchema, async (request) => { forwarded.push(request.params.arguments); return { content: [{ type: 'text', text: reply }] } })
  const burp = await connectedClient(burpServer)
  const agent = await connectedClient(createGateway({ burpUrl: 'http://fake-burp.invalid', connectBurp: async () => burp, responseDir: folder }))

  const tools = (await agent.listTools()).tools
  assert.ok(tools.find((tool) => tool.name === 'burp_send_http1_request')!.inputSchema.properties!.kraflr_find)
  assert.equal(tools.find((tool) => tool.name === 'burp_get_proxy_http_history')!.inputSchema.properties!.kraflr_find, undefined)
  const send = async (args: Record<string, unknown> = {}, name = 'burp_send_http1_request') => ((await agent.callTool({ name, arguments: { content: 'GET /a', ...args } })) as { content: { text: string }[] }).content[0]!.text

  const first = await send()
  assert.ok(first.length < 3000, 'shortened'); assert.match(first, /^HTTP\/1\.1 404 Not Found\r?\nContent-Type/); assert.doesNotMatch(first, /SECRET/)
  assert.equal(await readFile(join(folder, 'response-0001.txt'), 'utf8'), reply, 'the whole result is kept')
  reply = page('two')
  assert.match(await send(), /Body is the same as in .*response-0001\.txt/)
  reply = page('two', 'other-user')
  assert.doesNotMatch(await send(), /Body is the same/, 'any other difference is shown')
  assert.match(await send({ kraflr_find: 'needle-[a-z-]+' }), /1 match\(es\)[\s\S]*needle-other-user/)
  const headers = await send({ kraflr_headers_only: true })
  assert.match(headers, /404 Not Found/); assert.doesNotMatch(headers, /<nav>/)
  assert.equal(await send({ kraflr_full: true }), reply)
  assert.deepEqual(forwarded.at(-1), { content: 'GET /a' }, 'Burp never sees the gateway’s own arguments')
  assert.equal(await send({}, 'burp_get_proxy_http_history'), reply, 'other tools are untouched')
  reply = 'HTTP/1.1 200 OK\r\n\r\nsmall'
  assert.equal(await send(), reply, 'a short response is passed on as it is')
})

test('a Burp URL saved after the session started reaches the running gateway, which tells the agent its tool list changed', async () => {
  const burpServer = new Server({ name: 'burp', version: '1.0.0' }, { capabilities: { tools: {} } })
  burpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'send_http_request', inputSchema: { type: 'object', properties: {} } }] }))
  const burp = await connectedClient(burpServer)
  const dials: string[] = []
  let saved: string | undefined
  const agent = await connectedClient(createGateway({ burpUrl: () => saved, connectBurp: async (url) => { dials.push(url); return burp } }))
  let changes = 0
  agent.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changes++ })
  const status = async () => ((await agent.callTool({ name: 'burp_status', arguments: {} })) as { content: { text: string }[] }).content[0]!.text
  const names = async () => (await agent.listTools()).tools.map((tool) => tool.name).sort()

  assert.deepEqual(await names(), ['burp_status', 'semgrep_scan'])
  assert.match(await status(), /not configured/); assert.deepEqual(dials, [])
  saved = 'http://127.0.0.1:9876/mcp'
  assert.match(await status(), /Connected to Burp MCP at http:\/\/127\.0\.0\.1:9876\/mcp\. Proxying 1 tool/)
  await new Promise((done) => setTimeout(done, 20))
  assert.equal(changes, 1)
  assert.deepEqual(await names(), ['burp_send_http_request', 'burp_status', 'semgrep_scan'])
})

test('every agent is handed the data folder, and a Cline session file keeps the researcher’s own MCP servers', () => {
  const gateway = gatewayServerConfig('/node', '/app', '/data', '')
  assert.deepEqual(gateway.env, { KRAFLR_SETTINGS_DIR: '/data' })
  assert.equal(gatewayServerConfig('/node', '/app', '/data', 'http://127.0.0.1:1/mcp').env.KRAFLR_BURP_MCP_URL, 'http://127.0.0.1:1/mcp')
  const mine = JSON.stringify({ mcpServers: { notes: { transport: { type: 'stdio', command: 'notes' } } } })
  const merged = clineMcpSettings(mine, gateway).mcpServers as Record<string, any>
  assert.deepEqual(Object.keys(merged).sort(), ['kraflr', 'notes'])
  assert.equal(merged.kraflr.transport.type, 'stdio'); assert.equal(merged.kraflr.transport.env.KRAFLR_SETTINGS_DIR, '/data')
  assert.deepEqual(Object.keys(clineMcpSettings('not json', gateway).mcpServers), ['kraflr'])
})

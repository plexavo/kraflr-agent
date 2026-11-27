import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { openStore } from '../server/db.ts'
import { createTrafficLog } from '../server/traffic-log.ts'
import { createReplay } from '../server/replay.ts'
import { emptyScope } from '../shared/research.ts'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A tiny app: /account returns "owner data" only for the owner's session, "forbidden" for anyone else. */
async function targetServer() {
  const server = http.createServer((req, res) => {
    const cookie = req.headers.cookie ?? ''
    if (cookie.includes('session=owner-token')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('{"account":"owner","balance":500}') }
    else { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden') }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  return { server, port, url: `http://127.0.0.1:${port}/account` }
}

async function setup(webTargets: string) {
  const store = openStore(':memory:'), panel = store.createPanel({ name: 'Target', type: 'web' })
  store.saveScope(panel.id, 0, { ...emptyScope, targetName: 'Target', webTargets, notes: 'Local lab only.' })
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-replay-')))
  const traffic = createTrafficLog(folder)
  return { store, panel, traffic, folder }
}

test('a captured request replayed with a different account’s cookie, getting the same owner data back, is flagged as looking like broken access control', async () => {
  const target = await targetServer()
  const { store, panel, traffic, folder } = await setup(`127.0.0.1:${target.port}`)
  try {
    const original = traffic.append({ panelId: panel.id, agentId: 'a', agent: 'Parent', kind: 'http', method: 'GET', url: target.url, status: 200,
      request: { headers: { cookie: 'session=owner-token' }, body: '', bytes: 0 },
      response: { headers: { 'content-type': 'text/plain' }, body: '{"account":"owner","balance":500}', bytes: 34 } })
    const replay = createReplay(store, traffic)
    const result = await replay.crossAccount(panel.id, original.id, 'Cookie', 'session=owner-token')
    assert.equal(result.originalStatus, 200); assert.equal(result.replayStatus, 200)
    assert.match(result.verdict, /looks the same/); assert.match(result.body, /owner/)
    // A replay is itself logged, so the researcher's own check leaves a trail.
    assert.equal(traffic.list(panel.id, 0, 10).entries.some((entry) => entry.agent === 'Researcher (replay)'), true)
  } finally { target.server.close(); await rm(folder, { recursive: true, force: true }); store.close() }
})

test('a replay as an unrelated account gets refused, and the diff says the response differs', async () => {
  const target = await targetServer()
  const { store, panel, traffic, folder } = await setup(`127.0.0.1:${target.port}`)
  try {
    const original = traffic.append({ panelId: panel.id, agentId: 'a', agent: 'Parent', kind: 'http', method: 'GET', url: target.url, status: 200,
      request: { headers: { cookie: 'session=owner-token' }, body: '', bytes: 0 },
      response: { headers: {}, body: '{"account":"owner","balance":500}', bytes: 34 } })
    const result = await createReplay(store, traffic).crossAccount(panel.id, original.id, 'Cookie', 'session=someone-elses-token')
    assert.equal(result.replayStatus, 403); assert.match(result.verdict, /differs/)
  } finally { target.server.close(); await rm(folder, { recursive: true, force: true }); store.close() }
})

test('replay refuses a tunnel entry, a missing header name or value, and a request that fell outside the current scope', async () => {
  const target = await targetServer()
  const { store, panel, traffic, folder } = await setup(`127.0.0.1:${target.port}`)
  try {
    const httpEntry = traffic.append({ panelId: panel.id, agentId: 'a', agent: 'Parent', kind: 'http', method: 'GET', url: target.url, status: 200,
      request: { headers: { cookie: 'x' }, body: '', bytes: 0 }, response: { headers: {}, body: 'y', bytes: 1 } })
    const tunnelEntry = traffic.append({ panelId: panel.id, agentId: 'a', agent: 'Parent', kind: 'tunnel', method: 'CONNECT', url: '127.0.0.1:443', status: 200 })
    const replay = createReplay(store, traffic)
    await assert.rejects(replay.crossAccount(panel.id, tunnelEntry.id, 'Cookie', 'x'), /not captured in enough detail/)
    await assert.rejects(replay.crossAccount(panel.id, httpEntry.id, '', 'x'), /Name the header/)
    await assert.rejects(replay.crossAccount(panel.id, httpEntry.id, 'Cookie', ''), /other account's value/)
    store.saveScope(panel.id, 1, { ...emptyScope, targetName: 'Target', webTargets: 'example.com', notes: 'Local lab only.' })
    await assert.rejects(replay.crossAccount(panel.id, httpEntry.id, 'Cookie', 'x'), /outside the targets/)
  } finally { target.server.close(); await rm(folder, { recursive: true, force: true }); store.close() }
})

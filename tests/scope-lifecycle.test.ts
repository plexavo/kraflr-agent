import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { IPty } from 'node-pty'
import { createAgentTerminals } from '../server/agent-terminals.ts'
import { openStore } from '../server/db.ts'
import { buildApp } from '../server/app.ts'
import { emptyScope } from '../shared/research.ts'
import type { PanelDetail } from '../shared/research.ts'
import type { VerificationRecord } from '../shared/verification.ts'

test('scope changes stop only the affected panel’s native agents and block old-scope input and resume', async (t) => {
  const temp = await realpath(tmpdir())
  const directory = await mkdtemp(join(temp, 'kraflr-scope-runtime-'))
  const store = openStore(':memory:')
  const processes: { killed: number; writes: string[] }[] = []
  let serverCloses = 0
  let gate: Promise<void> | undefined
  let release = () => {}
  let entered = () => {}
  const terminals = createAgentTerminals(directory, store, {
    stopTerminal: async (terminal) => { terminal.kill() },
    resolveAgent: () => 'fixture.exe',
    async startPrivateOpenCode() {
      entered()
      await gate
      let closed = false
      return { url: 'http://127.0.0.1:0', credentials: { OPENCODE_SERVER_USERNAME: 'fixture', OPENCODE_SERVER_PASSWORD: 'fixture' },
        async close() { if (!closed) serverCloses++; closed = true },
        async request() { return { data: { id: `ses_${randomUUID()}` } } },
      }
    },
    spawn() {
      const state = { killed: 0, writes: [] as string[] }
      processes.push(state)
      let exited = (_event: { exitCode: number }) => {}
      return { onData: () => ({ dispose() {} }), onExit(callback: typeof exited) { exited = callback; return { dispose() {} } },
        write(text: string) { state.writes.push(text) }, resize() {}, kill() { state.killed++; exited({ exitCode: 0 }) },
      } as unknown as IPty
    },
  })
  t.after(async () => {
    await terminals.close()
    store.close()
    const resolved = await realpath(directory)
    if (/^kraflr-scope-runtime-[^\\/]+$/.test(relative(temp, resolved))) await rm(resolved, { recursive: true, force: true })
  })
  const panel = store.createPanel({ name: 'Export review', type: 'source' })
  const other = store.createPanel({ name: 'Separate review', type: 'source' })
  const scope = { ...emptyScope, targetName: 'Synthetic export', repository: 'https://example.test/export', revision: 'v1' }
  const size = { cols: 100, rows: 26 }
  await assert.rejects(terminals.start(store.readPanel(panel.id), { ...size, kind: 'opencode' }), /scope/)
  store.saveScope(panel.id, 0, scope)
  store.saveScope(other.id, 0, scope)
  const parent = await terminals.start(store.readPanel(panel.id), { ...size, kind: 'opencode' })
  const manual = await terminals.start(store.readPanel(panel.id), { ...size, kind: 'cline' })
  const away = await terminals.start(store.readPanel(other.id), { ...size, kind: 'cline' })
  terminals.input(panel.id, parent.id, 'review\r')
  store.saveScope(panel.id, 0, scope) // Idempotent retry of the same content.
  assert.equal(terminals.list().find(({ id }) => id === parent.id)?.state, 'running')
  assert.throws(() => store.saveScope(panel.id, 0, { ...scope, notes: 'Conflicting draft.' }), /another tab/)
  assert.equal(processes[0]?.killed, 0)
  store.saveScope(panel.id, 1, { ...scope, restrictions: 'Review only the preview route.' })
  assert.deepEqual(processes.map(({ killed }) => killed), [1, 1, 0])
  assert.equal(serverCloses, 1)
  assert.equal(terminals.list().find(({ id }) => id === parent.id)?.state, 'exited')
  assert.equal(terminals.list().find(({ id }) => id === manual.id)?.state, 'exited')
  assert.equal(terminals.list().find(({ id }) => id === away.id)?.state, 'running')
  assert.match(terminals.list().find(({ id }) => id === parent.id)?.detail ?? '', /scope changed/)
  assert.throws(() => terminals.input(panel.id, parent.id, 'continue\r'), /stopped/)
  assert.deepEqual(processes[0]?.writes, ['review\r'])
  await assert.rejects(terminals.resume(store.readPanel(panel.id), parent.id, size), /earlier scope/)
  assert.throws(() => store.assignAgentParent(panel.id, parent.id), /scope/)
  // Scope revision changes while a new CLI server is still starting.
  const started = new Promise<void>((resolve) => { entered = resolve })
  gate = new Promise<void>((resolve) => { release = resolve })
  const opening = terminals.start(store.readPanel(panel.id), { ...size, kind: 'opencode' })
  await started
  store.saveScope(panel.id, 2, { ...scope, restrictions: 'Only the patched revision.', revision: 'v2' })
  release()
  await assert.rejects(opening, /scope/)
  assert.equal(processes.length, 3)
  assert.equal(serverCloses, 2)
  assert.equal(store.listSavedAgents().length, 3)
})

test('failed managed OpenCode startup cannot fall back to an unmanaged terminal', async (t) => {
  const temp = await realpath(tmpdir())
  const directory = await mkdtemp(join(temp, 'kraflr-fail-closed-'))
  const store = openStore(':memory:')
  let spawned = false
  const terminals = createAgentTerminals(directory, store, {
    resolveAgent: () => 'fixture.exe',
    async startPrivateOpenCode() { throw new Error('Synthetic connection failure.') },
    spawn() { spawned = true; throw new Error('Must not reach native spawn.') },
  })
  t.after(async () => {
    await terminals.close()
    store.close()
    const resolved = await realpath(directory)
    if (/^kraflr-fail-closed-[^\\/]+$/.test(relative(temp, resolved))) await rm(resolved, { recursive: true, force: true })
  })
  const panel = store.createPanel({ name: 'Startup failure', type: 'source' })
  store.saveScope(panel.id, 0, { ...emptyScope, targetName: 'Synthetic', repository: 'https://example.test/repo', revision: 'v1' })
  await assert.rejects(terminals.start(store.readPanel(panel.id), { kind: 'opencode', cols: 100, rows: 26 }), /managed API/)
  assert.equal(spawned, false)
  assert.equal(store.listSavedAgents().length, 0)
})

test('a changed scope cancels an already executing verification and prevents finding acceptance', async (t) => {
  const store = openStore(':memory:')
  let executions = 0
  let cancelled = false
  const app = buildApp(store, 4317, { verificationRunner: {
    async available() { return { ready: true, detail: 'Synthetic scope test runner.', image: '' } },
    async run(_plan, _id, signal, beforeStart) {
      beforeStart()
      executions++
      try { await delay(10_000, undefined, { signal }) }
      catch (error) { cancelled = signal.aborted; throw error }
      return { ownerStatus: 200, ownerRecordReturned: true, foreignStatus: 200, foreignRecordReturned: true }
    },
  } })
  t.after(() => app.close())
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
  const post = (url: string, payload: object) => app.inject({ url, payload, headers, method: 'POST' })
  const panel = (await post('/api/verification/fixture', {})).json<PanelDetail>()
  const route = `/api/panels/${panel.id}/verification`
  const requested = (await post(route, { variant: 'vulnerable' })).json<VerificationRecord>()
  assert.equal((await post(`${route}/${requested.id}/decision`, { choice: 'approve', note: '', planHash: requested.planHash })).statusCode, 202)
  assert.equal(executions, 1)
  const other = store.createPanel({ name: 'Unrelated research', type: 'source' })
  store.saveScope(other.id, 0, { ...emptyScope, targetName: 'Other', repository: 'https://example.test/other', revision: 'v1' })
  assert.equal(cancelled, false)
  const { version: _version, savedAt: _savedAt, ...scope } = panel.scopeHistory[0]!
  assert.equal((await app.inject({ method: 'PUT', url: `/api/panels/${panel.id}/scope`, headers,
    payload: { expectedVersion: 1, scope: { ...scope, restrictions: 'Paused for scope review.' } } })).statusCode, 200)
  for (let attempt = 0; attempt < 30 && store.readTest(panel.id, requested.id).status === 'running'; attempt++) await delay(10)
  assert.ok(cancelled)
  const stopped = store.readTest(panel.id, requested.id)
  assert.equal(stopped.status, 'stale')
  assert.match(stopped.detail ?? '', /scope changed/)
  assert.equal(stopped.finding, undefined)
  assert.equal((await post(`${route}/${requested.id}/finding`, { note: 'Must not accept an aborted test.' })).statusCode, 409)
  assert.equal((await post(`${route}/${requested.id}/decision`, { choice: 'approve', note: '', planHash: requested.planHash })).statusCode, 409)
  assert.equal(executions, 1)
})

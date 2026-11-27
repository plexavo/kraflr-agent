import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm,readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { IPty } from 'node-pty'
import test from 'node:test'
import { buildApp } from '../server/app.ts'
import { createAgentTerminals } from '../server/agent-terminals.ts'
import { openStore } from '../server/db.ts'
import { emptyScope } from '../shared/research.ts'

const scope = { ...emptyScope, targetName: 'Synthetic team', repository: 'https://example.test/team', revision: 'v1' }
const size = { cols: 100, rows: 26 }
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
const wrap = (value: object) => '```kraflr-result\n' + JSON.stringify(value) + '\n```'

test('two independent Cline sessions act as parent and worker, delegate, persist models, and reject unsafe role changes', async (t) => {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'kraflr-agent-models-'))
  const file = join(root, 'workspace.sqlite')
  const store = openStore(file)
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const calls: string[] = []
  let opened = 0
  const terminals = createAgentTerminals(root, store, {
    resolveAgent: () => 'fixture.exe',
    async openClineWorker(options) {
      const role = opened++ === 0 ? 'parent' : 'worker'
      let current = options.preferredModel ?? 'fixture/default'
      const nativeId = options.nativeId ?? `cline_${randomUUID()}`
      let saved = Boolean(options.nativeId)
      let markClosed = (_code: number | null) => {}
      const closed = new Promise<number | null>((resolve) => { markClosed = resolve })
      return {
        id: nativeId, closed, modelSelectionRequired: false,
        models: () => ({ current, choices: ['fixture/default', 'fixture/parent', 'fixture/worker'].map((id) => ({ id, name: id })) }),
        async selectModel(id) { current = id; return id },
        async telemetry() { return {} }, async messages() { return [] },
        async attention() { return { permissions: [], question: false } }, async decide() {},
        async close() { markClosed(0) },
        async runTurn(text, checkCurrent, signal) {
          checkCurrent(); signal.throwIfAborted()
          if (!saved) { options.onSaved(nativeId); saved = true }
          calls.push(`${role}:${current}`)
          if (role === 'worker') return wrap({ summary: 'Worker inspected the synthetic route.', deadEnds: ['No database query exists in this route.'] })
          if (text.includes('Consolidate this investigation')) {
            assert.match(text, /Worker inspected the synthetic route/)
            return wrap({ summary: 'Cline parent consolidated the Cline worker’s evidence.', nextSteps: ['Review the next synthetic route.'] })
          }
          assert.match(text, /worker-1 \(Cline reviewer, Cline\)/)
          await gate
          return wrap({ tasks: [{ worker: 'worker-1', objective: 'Inspect the synthetic route without executing it.' }] })
        },
      }
    },
    spawn() {
      let exited = (_event: { exitCode: number }) => {}
      return { onData: () => ({ dispose() {} }), onExit(callback: typeof exited) { exited = callback; return { dispose() {} } },
        write() {}, resize() {}, kill() { exited({ exitCode: 0 }) } } as unknown as IPty
    }, stopTerminal: async (terminal) => { terminal.kill() },
  })
  const panel = store.createPanel({ name: 'Cline-led investigation', type: 'source' })
  const other = store.createPanel({ name: 'Separate panel', type: 'source' })
  store.saveScope(panel.id, 0, scope)
  const parent = await terminals.start(store.readPanel(panel.id), { ...size, kind: 'cline', mode: 'cline-worker', label: 'Cline lead' })
  const worker = await terminals.start(store.readPanel(panel.id), { ...size, kind: 'cline', mode: 'cline-worker', label: 'Cline reviewer' })
  const manual = await terminals.start(store.readPanel(panel.id), { ...size, kind: 'cline', mode: 'terminal', label: 'Manual Cline' })
  assert.equal(parent.parent, true)
  assert.equal(worker.parent, false)
  const app = buildApp(store, 4317, { terminals })
  t.after(async () => {
    release(); await app.close()
    const resolved = await realpath(root)
    if (/^kraflr-agent-models-[^\\/]+$/.test(relative(base, resolved))) await rm(resolved, { recursive: true, force: true })
  })
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload })
  const route = (id: string) => `/api/panels/${panel.id}/terminal/${id}`
  for (const [session, model] of [[parent, 'fixture/parent'], [worker, 'fixture/worker']] as const) {
    const response = await app.inject({ method: 'PUT', url: `${route(session.id)}/models`, headers, payload: { id: model } })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().model, model)
  }
  assert.equal((await post(`${route(manual.id)}/parent`, {})).statusCode, 409)
  assert.equal((await post(`/api/panels/${other.id}/terminal/${parent.id}/parent`, {})).statusCode, 409)
  const runId = randomUUID()
  assert.equal((await post(`/api/panels/${panel.id}/research-runs`, { id: runId, objective: 'Review the synthetic fixture.' })).statusCode, 202)
  assert.equal((await post(`${route(worker.id)}/parent`, {})).statusCode, 409)
  assert.equal((await app.inject({ method: 'PUT', url: `${route(parent.id)}/models`, headers, payload: { id: 'fixture/default' } })).statusCode, 409)
  release()
  for (let attempt = 0; attempt < 80 && store.readResearchRun(panel.id, runId).status === 'running'; attempt++) await delay(5)
  const run = store.readResearchRun(panel.id, runId)
  assert.equal(run.status, 'completed')
  assert.deepEqual(calls, ['parent:fixture/parent', 'worker:fixture/worker', 'parent:fixture/parent'])
  assert.equal(run.tasks[0]?.status, 'completed')
  assert.deepEqual(run.deadEnds, ['No database query exists in this route.'])
  assert.equal((await post(`${route(worker.id)}/parent`, {})).statusCode, 204)
  assert.equal(store.agentParent(panel.id), worker.id)
  await app.close()
  const reopened = openStore(file)
  assert.equal(reopened.agentParent(panel.id), worker.id)
  assert.equal(reopened.findSavedAgent(panel.id, parent.id)?.model, 'fixture/parent')
  assert.equal(reopened.findSavedAgent(panel.id, worker.id)?.model, 'fixture/worker')
  assert.equal(reopened.readResearchRun(panel.id, runId).status, 'completed')
  reopened.close()
})

test('OpenCode picker saves a verified native selection and restores it when the session is reopened', async (t) => {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'kraflr-agent-models-'))
  const store = openStore(':memory:')
  const switches: object[] = []
  const terminals = createAgentTerminals(root, store, {
    sessionInstructions:(id,_panel,role)=>`\nSession ${id}; current launch role ${role}.\n`,
    resolveAgent: () => 'fixture.exe', stopTerminal: async (terminal) => { terminal.kill() },
    async startPrivateOpenCode() {
      let model = { providerID: 'fixture', id: 'default' }
      const id = `ses_${randomUUID()}`
      return { url: 'http://127.0.0.1:0', credentials: { OPENCODE_SERVER_USERNAME: 'fixture', OPENCODE_SERVER_PASSWORD: 'fixture-password' },
        async close() {}, async request(path, options) {
          if (path === '/api/session') return { data: { id } }
          if (path === '/api/model') return { data: ['default', 'chosen'].map((id) => ({ providerID: 'fixture', id, name: id, enabled: true })) }
          if (path === '/api/model/default') return { data: { providerID: 'fixture', id: 'default' } }
          if (path.endsWith('/model')) { model = (options!.body as { model: typeof model }).model; switches.push(model); return }
          return { data: { id: path.split('/').at(-1), model } }
        } }
    },
    spawn() {
      let exited = (_event: { exitCode: number }) => {}
      return { onData: () => ({ dispose() {} }), onExit(callback: typeof exited) { exited = callback; return { dispose() {} } },
        write() {}, resize() {}, kill() { exited({ exitCode: 0 }) } } as unknown as IPty
    },
  })
  t.after(async () => {
    await terminals.close(); store.close()
    const resolved = await realpath(root)
    if (/^kraflr-agent-models-[^\\/]+$/.test(relative(base, resolved))) await rm(resolved, { recursive: true, force: true })
  })
  const panel = store.createPanel({ name: 'OpenCode model persistence', type: 'source' })
  store.saveScope(panel.id, 0, scope)
  const agent = await terminals.start(store.readPanel(panel.id), { ...size, kind: 'opencode' })
  assert.match(await readFile(join(root,agent.id,'AGENTS.md'),'utf8'),/current launch role parent/)
  assert.equal(agent.modelSelectionRequired, true)
  await assert.rejects(terminals.selectWorkerModel(panel.id, agent.id, 'fixture/unknown'), /available model/)
  assert.equal(terminals.list().find((item) => item.id === agent.id)?.modelSelectionRequired, true)
  await assert.rejects(terminals.researchTurn(panel.id, agent.id, 'Must not dispatch.', 1, new AbortController().signal), /confirm this session/)
  assert.equal((await terminals.workerModels(panel.id, agent.id)).current, 'fixture/default')
  assert.equal((await terminals.selectWorkerModel(panel.id, agent.id, 'fixture/chosen')).model, 'fixture/chosen')
  assert.equal(store.findSavedAgent(panel.id, agent.id)?.model, 'fixture/chosen')
  await terminals.stop(panel.id, agent.id)
  await terminals.resume(store.readPanel(panel.id), agent.id, size)
  assert.equal(terminals.list().find((item) => item.id === agent.id)?.modelSelectionRequired, false)
  assert.equal((await terminals.workerModels(panel.id, agent.id)).current, 'fixture/chosen')
  assert.equal(switches.length, 2)
  store.saveScope(panel.id, 1, { ...scope, restrictions: 'Changed scope.' })
  await assert.rejects(terminals.selectWorkerModel(panel.id, agent.id, 'fixture/default'), /stopped/)
})

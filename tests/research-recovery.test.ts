import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import { emptyScope } from '../shared/research.ts'
import type { ResearchRun } from '../shared/research-run.ts'
import { buildApp } from '../server/app.ts'
import { createAgentTerminals } from '../server/agent-terminals.ts'
import { openStore } from '../server/db.ts'
import { researchBrief } from '../server/research-brief.ts'

for (const changeScope of [false, true]) test(changeScope
  ? 'scope edits interrupt research, preserve finished assignments, and reach the next scoped parent after restart'
  : 'stopping research preserves finished assignments and a fresh parent receives the saved panel brief after restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kraflr-recovery-'))
  const file = join(dir, 'workspace.sqlite')
  let store = openStore(file)
  let app: ReturnType<typeof buildApp> | undefined
  let exported: string | undefined
  t.after(async () => {
    await app?.close()
    if (exported) await unlink(exported)
    await unlink(file)
    await rmdir(dir)
  })
  const panel = store.createPanel({ type: 'source', name: 'Resume fixture' })
  const other = store.createPanel({ type: 'source', name: 'Other investigation' })
  const scope = { ...emptyScope, targetName: 'Export fixture', repository: 'https://example.test/source.git', revision: 'v1', workspacePath: dir }
  store.saveScope(panel.id, 0, scope)
  store.saveScope(other.id, 0, scope)
  const old: ResearchRun = {
    id: randomUUID(), panelId: panel.id, parentId: randomUUID(), parentName: 'Previous parent', scopeVersion: 1,
    objective: 'Trace authorization.', status: 'running', phase: 'Investigating', startedAt: new Date().toISOString(),
    endedAt: null, summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [],
  }
  store.startResearchRun(old)
  store.saveResearchRun({ ...old, status: 'completed', summary: 'Checked direct downloads.', deadEnds: ['No SQL sink in the direct route.'],
    leads: [{ title: 'Direct download', path: 'direct.ts', startLine: 1, endLine: 2, explanation: 'Review ownership.' }],
    nextSteps: ['Trace preview authorization.'] })
  store.saveLeadReview(panel.id, old.id + ':0', { expectedVersion: 0, status: 'closed', note: 'Direct downloads already verify the owner.', nextAction: '' })
  const sessions: AgentTerminalInfo[] = ['Parent', 'Finished reviewer', 'Waiting reviewer'].map((label, index) => ({
    id: randomUUID(), panelId: panel.id, kind: 'opencode', mode: 'terminal', label, state: 'running',
    startedAt: old.startedAt, exitCode: null, scopeVersion: 1, parent: index === 0, chat: true,
  }))
  const wrap = (value: object) => '```kraflr-result\n' + JSON.stringify(value) + '\n```'
  let resuming = false
  let workerCancelled = false
  const startApp = () => buildApp(store, 4317, { terminals: {
    ...createAgentTerminals(dir, store), list: () => sessions,
    async researchTurn(_panel, id, prompt, _scope, signal) {
      assert.match(prompt, /Saved investigation history/)
      assert.match(prompt, /Direct downloads already verify the owner/)
      if (resuming) {
        assert.match(prompt, /Finished reviewer/)
        assert.match(prompt, /Validated the owner path/)
        assert.match(prompt, /No SQL sink/)
        return wrap({ summary: 'Resumed with the known negative result.' })
      }
      if (id === sessions[0]?.id) return wrap({ summary: 'Distributed the review.',
        tasks: [{ worker: 'worker-1', objective: 'Check direct access.' }, { worker: 'worker-2', objective: 'Check preview.' }] })
      if (id === sessions[1]?.id) return wrap({ summary: 'Validated the owner path.', nextSteps: ['Inspect preview permissions.'] })
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => { workerCancelled = true; reject(signal.reason) }, { once: true })
      })
    },
  } })
  app = startApp()
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
  const base = `/api/panels/${panel.id}`
  const post = (url: string, payload: object) => app!.inject({ url, method: 'POST', headers, payload })
  const id = randomUUID()
  assert.equal((await post(base + '/research-runs', { id, objective: 'Review both paths.' })).statusCode, 202)
  for (let attempt = 0; attempt < 40 && store.readResearchRun(panel.id, id).tasks[0]?.status !== 'completed'; attempt++) await delay(10)
  assert.equal(store.readResearchRun(panel.id, id).tasks[0]?.status, 'completed')
  assert.equal((await post(`/api/panels/${other.id}/research-runs/cancel`, { id })).statusCode, 404)
  if (changeScope) {
    assert.equal((await app.inject({ method: 'PUT', url: base + '/scope', headers,
      payload: { expectedVersion: 1, scope: { ...scope, restrictions: 'Review the patched preview route only.' } } })).statusCode, 200)
  } else assert.equal((await post(base + '/research-runs/cancel', { id })).statusCode, 202)
  for (let attempt = 0; attempt < 40 && store.readResearchRun(panel.id, id).status === 'running'; attempt++) await delay(10)
  const stopped = store.readResearchRun(panel.id, id)
  assert.equal(stopped.status, 'interrupted')
  if (changeScope) assert.match(stopped.phase, /scope changed/)
  assert.equal(stopped.tasks[0]?.result, 'Validated the owner path.')
  assert.equal(stopped.tasks[1]?.status, 'interrupted')
  assert.ok(workerCancelled)
  assert.equal((await post(base + '/research-runs/cancel', { id })).statusCode, 202)
  await app.close()
  store = openStore(file)
  resuming = true
  if (changeScope) for (const session of sessions) { session.id = randomUUID(); session.scopeVersion = 2 }
  app = startApp()
  const brief = researchBrief(store, panel.id)
  assert.equal(brief.latestRun?.status, 'interrupted')
  assert.equal(brief.latestRun?.tasks[0]?.result, stopped.tasks[0]?.result)
  assert.equal(brief.decisions[0]?.status, 'closed')
  assert.ok(brief.deadEnds.some((item) => item.text.includes('No SQL sink')))
  assert.equal(researchBrief(store, other.id).latestRun, null)
  const result = await post(base + '/research-brief/export', {})
  assert.equal(result.statusCode, 200, result.body)
  exported = result.json<{ path: string }>().path
  assert.match(await readFile(exported, 'utf8'), /Validated the owner path/)
  const next = randomUUID()
  assert.equal((await post(base + '/research-runs', { id: next, objective: 'Continue after restart.' })).statusCode, 202)
  for (let attempt = 0; attempt < 40 && store.readResearchRun(panel.id, next).status === 'running'; attempt++) await delay(10)
  assert.equal(store.readResearchRun(panel.id, next).summary, 'Resumed with the known negative result.')
})

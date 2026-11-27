import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import type { EvidenceLead, EvidencePage, EvidenceSummary } from '../shared/evidence.ts'
import { emptyScope } from '../shared/research.ts'
import type { ResearchRun } from '../shared/research-run.ts'
import type { AgentTerminals } from '../server/agent-terminals.ts'
import { createAgentTerminals } from '../server/agent-terminals.ts'
import { buildApp } from '../server/app.ts'
import { openStore } from '../server/db.ts'

test('saved leads survive migration, retain decisions, and reach a fresh parent and worker', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kraflr-evidence-test-'))
  const file = join(dir, 'workspace.sqlite')
  let app: ReturnType<typeof buildApp> | undefined
  let store = openStore(file)
  t.after(async () => {
    if (app) await app.close()
    else store.close()
    await unlink(file)
    await rmdir(dir)
  })
  const { id: panelId } = store.createPanel({ name: 'Export review', type: 'source' })
  const other = store.createPanel({ name: 'Unrelated', type: 'source' })
  const scope = { ...emptyScope, targetName: 'Synthetic export', repository: 'https://example.test/export', revision: 'v1' }
  store.saveScope(panelId, 0, scope)
  store.saveScope(other.id, 0, scope)
  const original: ResearchRun = {
    id: randomUUID(), panelId, parentId: randomUUID(), parentName: 'Earlier OpenCode',
    scopeVersion: 1, objective: 'Trace the download handler.', status: 'running', phase: 'Reviewing',
    startedAt: new Date().toISOString(), endedAt: null, summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [],
  }
  store.startResearchRun(original)
  const id = `${original.id}:0`
  const code = 'SYNTHETIC_OLD_CODE'
  store.saveResearchRun({ ...original, status: 'completed', summary: 'Ownership is checked before download.',
    leads: [{ title: 'Review delegated export access', explanation: 'Check the separate preview route.',
      path: 'src/export.ts', startLine: 22, endLine: 22, commit: 'a'.repeat(40), evidence: [code] }],
    deadEnds: ['Direct download already checks ownership.'], nextSteps: ['Inspect the preview route.'] })
  store.close()

  const beforeEvidence = new DatabaseSync(file)
  beforeEvidence.exec('DROP TABLE agent_records; ALTER TABLE scope_revisions DROP COLUMN roeReference; ALTER TABLE agent_sessions DROP COLUMN role; DROP TABLE verification_runs; DROP TABLE verification_fixture; DROP TABLE lead_reviews; PRAGMA user_version = 8')
  beforeEvidence.close()
  store = openStore(file)
  const sessions: AgentTerminalInfo[] = ['opencode', 'cline'].map((kind, index) => ({
    id: randomUUID(), panelId, kind: kind as AgentTerminalInfo['kind'], label: index === 0 ? 'New parent' : 'New worker',
    mode: index === 0 ? 'terminal' : 'cline-worker', scopeVersion: 2, state: 'running', startedAt: original.startedAt,
    exitCode: null, chat: true, parent: index === 0,
  }))
  const calls: string[] = []
  const wrap = (value: object) => '```kraflr-result\n' + JSON.stringify(value) + '\n```'
  const terminals = {
    list: () => sessions,
    async researchTurn(receivedPanelId, sessionId, prompt, scopeVersion) {
      assert.equal(receivedPanelId, panelId)
      assert.equal(scopeVersion, 2)
      calls.push(sessionId)
      if (prompt.includes('Consolidate this investigation')) {
        assert.match(prompt, /Found the preview route/)
        return wrap({ summary: 'Follow-up completed.' })
      }
      for (const context of ['src/export.ts', 'Direct download already checks ownership.', 'Preview is a separate route.',
        'Prior static review ruled out direct download.', 'Inspect the preview authorization.']) assert.ok(prompt.includes(context))
      assert.ok(!prompt.includes(code))
      return sessionId === sessions[0]?.id
        ? wrap({ tasks: [{ worker: 'worker-1', objective: 'Trace preview.' }] })
        : wrap({ summary: 'Found the preview route.' })
    },
  } satisfies Pick<AgentTerminals, 'list' | 'researchTurn'>
  const startApp = () => buildApp(store, 4317, { terminals: { ...createAgentTerminals(dir, store), ...terminals } })
  app = startApp()
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
  const evidence = `/api/panels/${panelId}/evidence`
  const lead = `${evidence}/${encodeURIComponent(id)}`
  const runs = `/api/panels/${panelId}/research-runs`
  const get = (url: string) => app!.inject({ method: 'GET', url, headers })
  const review = (payload: object) => app!.inject({ method: 'PUT', url: lead, headers, payload })
  const send = (payload: object) => app!.inject({ method: 'POST', url: runs, headers, payload })
  const request = { id: randomUUID(), objective: 'Continue the saved lead on the current scope.', leadId: id }
  const existing = (await get(`${evidence}?offset=0`)).json<{ leads: EvidenceSummary[] }>()
  assert.deepEqual(existing.leads.map((item) => item.id), [id])
  assert.equal(existing.leads[0]?.tag, 'general')
  assert.equal((await get(`/api/panels/${other.id}/evidence/${encodeURIComponent(id)}`)).statusCode, 404)
  assert.deepEqual((await get(lead)).json<EvidenceLead>().evidence, [code])
  const closed = { expectedVersion: 0, status: 'closed', note: 'Prior static review ruled out direct download.', nextAction: '' }
  assert.equal((await review({ ...closed, note: ' ' })).statusCode, 400)
  assert.equal((await review(closed)).statusCode, 200)
  assert.equal((await get(lead)).json<EvidenceLead>().tag, 'killed_lead')
  assert.deepEqual((await get('/api/investigation')).json<{ counts: object[] }>().counts, [{ panelId, total: 1, closed: 1, findings: 0 }])
  assert.equal((await send(request)).statusCode, 409)
  const reopened = { expectedVersion: 1, status: 'open', note: 'Preview is a separate route.',
    nextAction: 'Inspect the preview authorization.' }
  assert.equal((await review({ ...reopened, expectedVersion: 0 })).statusCode, 409)
  assert.equal((await review(reopened)).statusCode, 200)
  assert.equal((await review(reopened)).json<EvidenceLead>().reviews.length, 2)
  store.saveScope(panelId, 1, { ...scope, restrictions: 'Current scope excludes unrelated routes.' })
  await app.close()
  store = openStore(file)
  app = startApp()
  assert.deepEqual((await get(lead)).json<EvidenceLead>().reviews.map((item) => item.status), ['open', 'closed'])
  const posted = await send(request)
  assert.equal(posted.statusCode, 202, posted.body)
  assert.equal(posted.json<ResearchRun>().leadReviewVersion, 2)
  let finished = store.readResearchRun(panelId, request.id)
  for (let attempt = 0; attempt < 30 && finished.status === 'running'; attempt++) {
    await delay(10)
    finished = store.readResearchRun(panelId, request.id)
  }
  assert.equal(finished.status, 'completed')
  assert.equal(finished.summary, 'Follow-up completed.')
  assert.equal(finished.tasks[0]?.status, 'completed')
  assert.deepEqual(calls, [sessions[0]?.id, sessions[1]?.id, sessions[0]?.id])
})

test('evidence categories filter before pagination and retain tags and reasons across restarts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kraflr-evidence-tags-'))
  const file = join(dir, 'workspace.sqlite')
  let store = openStore(file)
  let app: ReturnType<typeof buildApp>
  t.after(async () => {
    await app.close()
    await unlink(file)
    await rmdir(dir)
  })
  const panel = store.createPanel({ name: 'Categories', type: 'source' })
  const other = store.createPanel({ name: 'Separate panel', type: 'source' })
  store.saveScope(panel.id, 0, { ...emptyScope, targetName: 'Fixture', repository: 'https://example.test/repo', revision: 'v1' })
  const run: ResearchRun = {
    id: randomUUID(), panelId: panel.id, parentId: randomUUID(), parentName: 'Parent', scopeVersion: 1,
    objective: 'Record metadata and security hypotheses.', status: 'running', phase: 'Reviewing',
    startedAt: new Date().toISOString(), endedAt: null, summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [],
  }
  store.startResearchRun(run)
  const entry = { title: 'Repository fact', explanation: 'Inspected background context.', path: 'README.md', startLine: 1, endLine: 1 }
  store.saveResearchRun({ ...run, status: 'completed', leads: [
    ...Array.from({ length: 27 }, (_, index) => ({ ...entry, title: `Metadata ${index}`, kind: 'general' as const })),
    { ...entry, title: 'Potential ownership issue', kind: 'lead', security: {
      hypothesis: 'The export route appears to omit an ownership check.',
      attackPath: 'An authenticated account supplies another account’s export ID to the route.',
      impact: 'The caller could receive private data belonging to another account.',
    } }, { ...entry, title: 'Already guarded route' },
  ] })
  const hypothesis = `${run.id}:27`
  const killed = `${run.id}:28`
  app = buildApp(store, 4317)
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
  const route = `/api/panels/${panel.id}/evidence`
  const get = (query: string) => app.inject({ url: route + query, headers })
  const review = (id: string, payload: object) => app.inject({ method: 'PUT', url: `${route}/${encodeURIComponent(id)}`, headers, payload })
  const reason = 'Ownership is checked before this route reads the export.'
  assert.equal((await review(killed, { expectedVersion: 0, status: 'closed', tag: 'killed_lead', note: '', nextAction: '' })).statusCode, 400)
  assert.equal((await review(killed, { expectedVersion: 0, status: 'closed', tag: 'killed_lead', note: reason, nextAction: '' })).statusCode, 200)
  const general = (await get('?offset=0&tag=general')).json<EvidencePage>()
  assert.equal(general.leads.length, 25)
  assert.equal(general.more, true)
  assert.deepEqual(general.counts, { general: 27, lead: 1, killed_lead: 1, finding: 0 })
  const second = (await get('?offset=25&tag=general')).json<EvidencePage>()
  assert.equal(second.leads.length, 2)
  assert.equal(second.more, false)
  assert.equal(new Set([...general.leads, ...second.leads].map(({ id }) => id)).size, 27)
  assert.deepEqual((await get('?offset=0&tag=lead')).json<EvidencePage>().leads.map(({ id }) => id), [hypothesis])
  assert.deepEqual((await get('?offset=0&tag=killed_lead')).json<EvidencePage>().leads.map(({ id }) => id), [killed])
  assert.equal((await get('?tag=finding')).json<EvidencePage>().leads.length, 0)
  assert.equal((await get('?tag=untrusted')).statusCode, 400)
  const unrelated = await app.inject({ url: `/api/panels/${other.id}/evidence?tag=general`, headers })
  assert.equal(unrelated.json<EvidencePage>().leads.length, 0)
  const reclassify = { expectedVersion: 0, status: 'open', tag: 'general', note: 'This is background context.', nextAction: '' }
  assert.equal((await review(hypothesis, { ...reclassify, tag: 'finding', note: '' })).statusCode, 400, 'accepting a Finding needs the researcher’s evidence note')
  assert.equal((await review(hypothesis, { ...reclassify, status: 'closed' })).statusCode, 400)
  assert.equal((await review(hypothesis, reclassify)).statusCode, 200)
  assert.equal((await review(hypothesis, reclassify)).json<EvidenceLead>().reviews.length, 1)
  assert.deepEqual(store.countLeads().map((item) => ({ ...item })), [{ panelId: panel.id, total: 1, closed: 1, findings: 0 }])
  await app.close()
  store = openStore(file)
  app = buildApp(store, 4317)
  assert.equal(store.readEvidence(panel.id, hypothesis).tag, 'general')
  assert.equal(store.readEvidence(panel.id, killed).reviews[0]?.note, reason)
  assert.equal(store.listEvidence(panel.id, 0, 'general').counts.general, 28)
  assert.equal((await review(hypothesis, { ...reclassify, expectedVersion: 0, tag: 'lead' })).statusCode, 409)
  // An older client can still reopen a killed lead; the new label follows its lifecycle.
  assert.equal((await review(killed, { expectedVersion: 1, status: 'open', note: 'New evidence warrants a second look.', nextAction: '' })).statusCode, 200)
  assert.equal(store.readEvidence(panel.id, killed).tag, 'lead')
})

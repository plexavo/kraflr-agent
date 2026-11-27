import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { AgentTerminalInfo, SavedAgentSession } from '../shared/agent-terminal.ts'
import { emptyScope } from '../shared/research.ts'
import { openStore } from '../server/db.ts'
import { createResearchTeam } from '../server/research-team.ts'
import { buildApp } from '../server/app.ts'
import { createAgentTerminals } from '../server/agent-terminals.ts'
import type { PanelDetail } from '../shared/research.ts'
import type { ResearchRun, SavedRepositorySuggestion } from '../shared/research-run.ts'

test('parent dispatch is limited to running workers in the same current scope', async () => {
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Review project', type: 'source' })
  const unrelated = store.createPanel({ name: 'Unrelated project', type: 'source' })
  const scope = { ...emptyScope, targetName: 'Fixture', repository: 'https://example.test/source.git', revision: 'v1' }
  store.saveScope(panel.id, 0, scope)
  store.saveScope(unrelated.id, 0, scope)
  const makeSession = (label: string, panelId: string, nativeId: string | null,
    kind: SavedAgentSession['kind'] = 'opencode', mode: SavedAgentSession['mode'] = 'terminal'): AgentTerminalInfo => {
    const saved: SavedAgentSession = {
      id: randomUUID(), panelId, label, nativeId, startedAt: new Date().toISOString(), kind, mode, scopeVersion: 1,
    }
    store.saveAgentSession(saved)
    return { id: saved.id, panelId, label, kind, mode, startedAt: saved.startedAt, scopeVersion: 1,
      state: 'running', exitCode: null, chat: Boolean(nativeId), parent: store.agentParent(panelId) === saved.id }
  }
  const parent = makeSession('Lead', panel.id, 'ses_parent')
  const worker = makeSession('Reviewer', panel.id, 'cline_worker', 'cline', 'cline-worker')
  const manual = makeSession('Manual terminal', panel.id, null, 'cline')
  const other = makeSession('Away', unrelated.id, 'ses_other')
  const needsModel = { ...makeSession('Needs model', panel.id, 'cline_unavailable', 'cline', 'cline-worker'),
    modelSelectionRequired: true }
  const nativeDraft={...makeSession('Native draft',panel.id,'pty:conversation','cline','terminal'),promptReady:false}
  assert.equal(store.agentParent(panel.id), parent.id)
  assert.throws(() => store.assignAgentParent(panel.id, other.id), /managed OpenCode/)

  const wrap = (value: object) => '```kraflr-result\n' + JSON.stringify(value) + '\n```'
  const calls: string[] = []
  const team = createResearchTeam(store, {
    list: () => [other, manual, parent, needsModel, nativeDraft, worker],
    async researchTurn(panelId, id, text) {
      assert.equal(panelId, panel.id)
      if (id === parent.id && !text.includes('Consolidate this investigation')) assert.match(text, /kraflr agent lead/)
      calls.push(id)
      if (text.includes('Consolidate this investigation')) {
        assert.ok(text.includes('Traced the call path.'))
        return wrap({ summary: 'Recorded the result.', nextSteps: ['Review caller authorization.'], leads: [
          { kind: 'general', title: 'Repository identity', explanation: 'Background fact.', path: 'README.md', startLine: 1, endLine: 1 },
          { kind: 'finding', title: 'Unverified claim', explanation: 'Requires verification.', path: 'export.js', startLine: 2, endLine: 2 },
          { kind: 'lead', title: 'Missing export ownership guard', explanation: 'Check the handler’s authorization.', path: 'export.js', startLine: 3, endLine: 4,
            security: {
              hypothesis: 'The export handler appears to omit an ownership check.',
              attackPath: 'An authenticated account can supply another account’s export ID.',
              impact: 'The caller could receive private data belonging to another account.',
            } },
        ] })
      }
      if (id === worker.id) return wrap({ summary: 'Traced the call path.', deadEnds: ['No SQL access in this path.'], leads: [
        { kind: 'lead', title: 'Missing export ownership guard', explanation: 'Check the handler’s authorization.', path: 'export.js', startLine: 3, endLine: 4 },
      ] })
      assert.equal(id, parent.id)
      assert.match(text, /worker-1 \(Reviewer, Cline\)/)
      assert.doesNotMatch(text, /worker-2|Away|Manual terminal|Needs model|Native draft/)
      return wrap({ tasks: [{ worker: 'worker-1', objective: 'Trace the call.' },
        { worker: 'worker-1', objective: 'Redundant assignment' }, { worker: 'worker-2', objective: 'Unknown worker' }] })
    },
  })
  try {
    const id = randomUUID()
    team.start(panel.id, 'Review the public fixture.', id)
    team.start(panel.id, 'Review the public fixture.', id)
    for (let attempt = 0; attempt < 20 && store.readResearchRun(panel.id, id).status === 'running'; attempt++) {
      await delay(5)
    }
    const finished = store.readResearchRun(panel.id, id)
    assert.equal(finished.status, 'completed')
    assert.deepEqual(calls, [parent.id, worker.id, parent.id])
    assert.equal(finished.tasks.length, 1)
    assert.equal(finished.tasks[0]?.status, 'completed')
    assert.deepEqual(finished.deadEnds, ['No SQL access in this path.'])
    assert.equal(finished.leads.find((lead) => lead.title === 'Repository identity')?.kind, 'general')
    assert.deepEqual(store.listEvidence(panel.id, 0, 'general').leads.map(({ title }) => title), ['Repository identity', 'Unverified claim'])
    assert.equal(store.listEvidence(panel.id, 0, 'lead').leads[0]?.title, 'Missing export ownership guard')
    assert.equal(finished.leads.filter((lead) => lead.title === 'Missing export ownership guard').length, 1)
    assert.equal(store.listEvidence(panel.id, 0, 'finding').leads.length, 0)
    assert.equal(store.listResearchRuns(unrelated.id).length, 0)
    parent.promptReady=false
    assert.throws(()=>team.start(panel.id,'Do not type into an unclear native prompt.',randomUUID()),/prompt is clear|native Cline/)
    assert.equal(store.listResearchRuns(panel.id).length,1)
  } finally {
    await team.close()
    store.close()
  }
})

test('repository discovery stores a reviewable suggestion and leaves scope under researcher control', async (t) => {
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Calender fixture', type: 'source' })
  const discovery = { ...emptyScope, targetName: 'Calender fixture', repositoryMode: 'discover' as const,
    repositoryDiscovery: 'Check the developer website.', restrictions: 'Public source review only.' }
  store.saveScope(panel.id, 0, discovery)
  const parent: AgentTerminalInfo = {
    id: randomUUID(), panelId: panel.id, kind: 'opencode', mode: 'terminal', label: 'Discovery parent',
    state: 'running', startedAt: panel.createdAt, exitCode: null, scopeVersion: 1, chat: true, parent: true,
  }
  const candidate = { targetName: 'Calendar fixture', url: 'https://github.com/example/calendar',
    revision: 'v1.0.0', sourceUrl: 'https://example.test/calendar', reason: 'Developer page links to the upstream repository.' }
  const app = buildApp(store, 4317, { terminals: {
    ...createAgentTerminals('.', store), list: () => [parent],
    async researchTurn(_panel, _agent, prompt) {
      assert.match(prompt, /spelling\/name variants/)
      assert.match(prompt, /For repository discovery/)
      const url = prompt.endsWith('Reject this candidate') ? 'https://user:password@github.com/example/calendar' : candidate.url
      return '```kraflr-result\n' + JSON.stringify({ summary: 'Checked public metadata.',
        repositorySuggestion: { ...candidate, url } }) + '\n```'
    },
  } })
  t.after(() => app.close())
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
  const route = `/api/panels/${panel.id}`
  const get = (url: string) => app.inject({ url, headers })
  const discover = async (objective: string) => {
    const id = randomUUID()
    const started = await app.inject({ method: 'POST', url: `${route}/research-runs`, headers, payload: { id, objective } })
    assert.equal(started.statusCode, 202, started.body)
    let run: ResearchRun = store.readResearchRun(panel.id, id)
    for (let attempt = 0; attempt < 30 && run.status === 'running'; attempt++) {
      await delay(10)
      run = store.readResearchRun(panel.id, id)
    }
    assert.equal(run.status, 'completed')
    return id
  }
  const suggestions = `${route}/repository-suggestion`
  await discover('Reject this candidate')
  assert.equal((await get(suggestions)).json(), null)
  const runId = await discover('Find the upstream.')
  assert.deepEqual((await get(suggestions)).json<SavedRepositorySuggestion>(),
    { ...candidate, runId, scopeVersion: 1, parentName: parent.label })
  assert.equal((await get(route)).json<PanelDetail>().repositoryMode, 'discover')
  const save = await app.inject({ method: 'PUT', url: `${route}/scope`, headers, payload: {
    expectedVersion: 1, scope: { ...discovery, targetName: candidate.targetName, repositoryMode: 'known',
      repository: candidate.url, revision: candidate.revision },
  } })
  assert.equal(save.statusCode, 200, save.body)
  const scoped = save.json<PanelDetail>()
  assert.equal(scoped.repositoryMode, 'known')
  assert.equal(scoped.scopeHistory[0]?.restrictions, discovery.restrictions)
  assert.equal(scoped.scopeHistory[1]?.repositoryMode, 'discover')
  assert.equal((await get(suggestions)).json(), null)
})

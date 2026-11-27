import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { PanelDetail } from '../shared/research.ts'
import type { ProjectVerificationInput, VerificationQueueData, VerificationRecord, VerificationVariant } from '../shared/verification.ts'
import { isProjectPlan } from '../shared/verification.ts'
import { buildApp } from '../server/app.ts'
import { openStore } from '../server/db.ts'
import type { VerificationRunner } from '../server/verification-runner.ts'
import { emptyScope } from '../shared/research.ts'
import type { ResearchRun } from '../shared/research-run.ts'
import { createResearchTeam } from '../server/research-team.ts'

test('verification binds one approval to the current plan and persists decisions and observations', async (t) => {
  const store = openStore(':memory:')
  let launches = 0
  let hold = false
  let startGate: Promise<void> | undefined
  let ready = true
  const runner: VerificationRunner = {
    async available() { return { ready, detail: 'Fixture Docker engine.', image: '' } },
    async run(plan, _id, signal, beforeStart) {
      if (isProjectPlan(plan)) throw new Error('Use the project runner fixture.')
      await startGate
      signal.throwIfAborted()
      beforeStart()
      launches++
      if (hold) await delay(10_000, undefined, { signal })
      const vulnerable = plan.variant === 'vulnerable'
      return { ownerStatus: 200, ownerRecordReturned: true, foreignStatus: vulnerable ? 200 : 403,
        foreignRecordReturned: vulnerable }
    },
  }
  const app = buildApp(store, 4317, { verificationRunner: runner })
  t.after(() => app.close())
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
  const post = (url: string, payload: object) => app.inject({ headers, url, payload, method: 'POST' })
  const fixture = async () => (await post('/api/verification/fixture', {})).json<PanelDetail>()
  const panel = await fixture()
  assert.equal((await fixture()).id, panel.id)
  assert.equal(store.listEvidence(panel.id, 0).leads.length, 1)
  const other = store.createPanel({ type: 'source', name: 'Unrelated panel' })
  const route = `/api/panels/${panel.id}/verification`
  assert.equal((await post(`/api/panels/${other.id}/verification`, { variant: 'vulnerable' })).statusCode, 409)
  assert.equal((await post(route, { variant: 'vulnerable', command: 'arbitrary' })).statusCode, 400)
  const queue = async (variant: VerificationVariant = 'vulnerable') => {
    const response = await post(route, { variant })
    assert.equal(response.statusCode, 201, response.body)
    return response.json<VerificationRecord>()
  }
  const decide = (record: VerificationRecord, choice: 'approve' | 'deny' | 'cancel', note = '', hash = record.planHash) =>
    post(`${route}/${record.id}/decision`, { choice, note, planHash: hash })
  const settled = async (record: VerificationRecord) => {
    let saved = store.readTest(panel.id, record.id)
    for (let attempt = 0; attempt < 30 && saved.status === 'running'; attempt++) {
      await delay(10)
      saved = store.readTest(panel.id, record.id)
    }
    return saved
  }
  const denied = await queue()
  assert.equal((await decide(denied, 'deny', ' ')).statusCode, 400)
  assert.equal((await decide(denied, 'deny', 'Scope review needed.')).json<VerificationRecord>().status, 'denied')
  assert.equal((await decide(denied, 'approve')).statusCode, 409)
  assert.equal(launches, 0)

  const vulnerable = await queue()
  assert.equal((await decide(vulnerable, 'approve', '', 'a'.repeat(64))).statusCode, 409)
  ready = false
  assert.equal((await decide(vulnerable, 'approve')).statusCode, 503)
  ready = true
  const approvals = await Promise.all([decide(vulnerable, 'approve'), decide(vulnerable, 'approve')])
  assert.deepEqual(approvals.map((result) => result.statusCode).sort(), [202, 409])
  const reproduced = await settled(vulnerable)
  assert.equal(reproduced.status, 'reproduced')
  const leadId = store.listEvidence(panel.id, 0).leads[0]!.id
  assert.equal(store.readEvidence(panel.id, leadId).tag, 'lead')
  assert.equal(store.readEvidence(panel.id, leadId).hasAcceptedFinding, false)
  assert.equal(reproduced.observation && 'foreignStatus' in reproduced.observation && reproduced.observation.foreignStatus, 200)
  const finding = await post(`${route}/${vulnerable.id}/finding`, { note: 'Cross-account retrieval reproduced in the fixture.' })
  assert.equal(finding.json<VerificationRecord>().finding?.note, 'Cross-account retrieval reproduced in the fixture.')
  assert.equal(store.countLeads()[0]?.findings, 1)
  assert.equal(store.readEvidence(panel.id, leadId).tag, 'finding')
  assert.equal(store.readEvidence(panel.id, leadId).hasAcceptedFinding, true)
  assert.equal(store.readEvidence(panel.id, leadId).reviews[0]?.tag, 'finding')
  assert.equal(store.listEvidence(panel.id, 0, 'finding').leads[0]?.id, leadId)
  const version = store.readEvidence(panel.id, leadId).reviews[0]!.version
  assert.throws(() => store.saveLeadReview(panel.id, leadId, {
    expectedVersion: version, status: 'open', tag: 'general', note: '', nextAction: '',
  }), /reason for changing a confirmed finding/)
  store.saveLeadReview(panel.id, leadId, { expectedVersion: version, status: 'open', tag: 'lead',
    note: 'Reassess the impact before classifying this as a finding.', nextAction: '' })
  assert.equal(store.readEvidence(panel.id, leadId).tag, 'lead')
  assert.equal(store.countLeads()[0]?.findings, 0)
  assert.ok(store.readTest(panel.id, vulnerable.id).finding)
  store.saveLeadReview(panel.id, leadId, { expectedVersion: version + 1, status: 'open', tag: 'finding',
    note: 'Impact reviewed; keep the accepted reproduction.', nextAction: '' })
  assert.equal(store.countLeads()[0]?.findings, 1)

  assert.equal((await post(route, { variant: 'patched' })).statusCode, 409)
  assert.equal(store.listVerification(panel.id).canRequest, false)
  store.saveLeadReview(panel.id, leadId, { expectedVersion: version + 2, status: 'open', tag: 'lead',
    note: 'Reopen the hypothesis to test the patched variant before final review.', nextAction: '' })
  const patched = await queue('patched')
  assert.equal((await decide(patched, 'approve')).statusCode, 202)
  const blocked = await settled(patched)
  assert.equal(blocked.status, 'not_reproduced')
  assert.equal(blocked.observation && 'foreignStatus' in blocked.observation && blocked.observation.foreignStatus, 403)
  assert.equal((await post(`${route}/${patched.id}/finding`, { note: 'This should fail.' })).statusCode, 409)

  hold = true
  const cancelled = await queue()
  assert.equal((await decide(cancelled, 'approve')).statusCode, 202)
  assert.equal((await decide(cancelled, 'cancel')).statusCode, 202)
  assert.equal((await settled(cancelled)).status, 'cancelled')
  hold = false

  const expired = store.addVerification({ ...await queue(), id: randomUUID(), expiresAt: new Date(0).toISOString() })
  assert.equal((await decide(expired, 'approve')).statusCode, 409)
  assert.equal(store.listVerification(panel.id).records.find(({ id }) => id === expired.id)?.status, 'expired')

  const staleAtApproval = await queue()
  const staleAtDispatch = await queue()
  let release = () => {}
  startGate = new Promise<void>((resolve) => { release = resolve })
  assert.equal((await decide(staleAtDispatch, 'approve')).statusCode, 202)
  store.saveScope(panel.id, 1, { ...panel.scopeHistory[0]!, notes: 'A revised fixture scope.' })
  release()
  assert.equal((await decide(staleAtApproval, 'approve')).statusCode, 409)
  assert.equal((await settled(staleAtDispatch)).status, 'stale')
  assert.equal(launches, 3)

  const recovery = await queue()
  store.resolveVerification(panel.id, recovery.id, recovery.planHash, 'approve', '')
  assert.deepEqual(store.interruptVerification(), [recovery.id])
  assert.equal((await decide(recovery, 'approve')).statusCode, 409)
  assert.equal(store.readTest(panel.id, recovery.id).status, 'interrupted')
})

test('project tests stay with their evidence lead and appear in the shared queue and agent handoff', async (t) => {
  const store = openStore(':memory:')
  const panel = store.createPanel({ type: 'source', name: 'Custom research' })
  const other = store.createPanel({ type: 'source', name: 'Another project' })
  const scope = { ...emptyScope, targetName: 'Custom export', repository: 'https://example.test/repo.git', revision: 'v1' }
  store.saveScope(panel.id, 0, scope)
  store.saveScope(other.id, 0, scope)
  const leadRun: ResearchRun = {
    id: randomUUID(), panelId: panel.id, parentId: randomUUID(), parentName: 'Fixture parent', scopeVersion: 1,
    objective: 'Check authorization.', status: 'running', phase: 'Investigating', startedAt: new Date().toISOString(),
    endedAt: null, summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [],
  }
  const plan: ProjectVerificationInput = { title: 'Cross-account export', image: 'sha256:' + 'c'.repeat(64),
    command: ['/usr/local/bin/node', '/app/test.mjs'], action: 'Compare owner and cross-account access.',
    expected: 'Owner control succeeds and cross-account access is denied after the fix.' }
  store.startResearchRun(leadRun)
  store.saveResearchRun({ ...leadRun, status: 'completed', leads: [
    { title: 'Export ownership', explanation: 'An ownership guard appears absent.', path: 'export.js', startLine: 1, endLine: 2, verification: plan,
      kind: 'lead', security: {
        hypothesis: 'The export handler appears to omit the account ownership check.',
        attackPath: 'An authenticated account requests the export ID of another account.',
        impact: 'The caller could obtain another account’s private export data.',
      } },
  ] })
  const leadId = leadRun.id + ':0'
  let calls = 0
  let controlPassed = true
  const runner: VerificationRunner = {
    async available(approved) {
      if (approved) {
        assert.ok(isProjectPlan(approved))
        assert.equal(approved.repository, scope.repository)
        assert.equal(approved.targetVersion, scope.revision)
      }
      return { ready: true, detail: 'Test image available.', image: plan.image }
    },
    async run(approved, _id, signal, beforeStart) {
      signal.throwIfAborted()
      beforeStart()
      assert.ok(isProjectPlan(approved))
      assert.deepEqual(approved.command, plan.command)
      calls++
      return { kind: 'project', outcome: 'reproduced', controlPassed,
        summary: 'Cross-account read was observed.', evidence: 'Owner HTTP 200. Other account HTTP 200.' }
    },
  }
  const parent = { id: randomUUID(), panelId: panel.id, kind: 'opencode', mode: 'terminal', label: 'Parent', state: 'running', startedAt: leadRun.startedAt, exitCode: null, scopeVersion: 1, parent: true, chat: true }
  const app = buildApp(store, 4317, { verificationRunner: runner, terminals: { list: () => [parent], async close() {}, async dashboardSessions() { return [] } } as never })
  t.after(() => app.close())
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
  const post = (url: string, payload: object) => app.inject({ headers, url, payload, method: 'POST' })
  const route = `/api/panels/${panel.id}/verification`
  const payload = { id: randomUUID(), leadId, scopeVersion: 1, plan }
  const report = (id: string, outcome: object) => post(`${route}/${id}/report`, { image: plan.image, observation: outcome })
  assert.equal((await post(`/api/panels/${other.id}/verification/project`, payload)).statusCode, 404)
  assert.equal((await post(route + '/project', { ...payload, plan: { ...plan, command: ['docker', 'run', '--privileged'] } })).statusCode, 400)
  assert.equal((await post(route + '/project', { ...payload, plan: { ...plan, image: 'mutable:latest' } })).statusCode, 400)
  const requested = await post(route + '/project', payload)
  assert.equal(requested.statusCode, 201, requested.body)
  const record = requested.json<VerificationRecord>()
  assert.equal(record.panelId, panel.id)
  assert.equal(record.leadId, leadId)
  assert.equal((await post(route + '/project', payload)).statusCode, 200)
  assert.equal(calls, 0)
  for (const tag of ['general', 'killed_lead'] as const) {
    store.saveLeadReview(panel.id, leadId, { expectedVersion: store.readEvidence(panel.id, leadId).reviews[0]?.version ?? 0,
      status: tag === 'killed_lead' ? 'closed' : 'open', tag, note: 'Researcher is reclassifying this hypothesis.', nextAction: '' })
    assert.equal((await post(route + '/project', { ...payload, id: randomUUID() })).statusCode, 409)
    assert.equal((await post(`${route}/${record.id}/decision`, { choice: 'approve', note: '', planHash: record.planHash })).statusCode, 409)
    const history = store.listVerification(panel.id, leadId)
    assert.equal(history.canRequest, false)
    assert.equal(history.records[0]?.id, record.id)
    assert.equal(calls, 0)
  }
  store.saveLeadReview(panel.id, leadId, { expectedVersion: store.readEvidence(panel.id, leadId).reviews[0]!.version,
    status: 'open', tag: 'lead', note: 'Security hypothesis ready for its isolated test.', nextAction: '' })
  assert.equal(store.listVerification(panel.id, leadId).canRequest, false,'The existing pending test is the continuation; do not offer a duplicate request')
  const queue = await app.inject({ url: '/api/verification?offset=0', headers })
  assert.deepEqual(queue.json<VerificationQueueData>().records.map(({ id }) => id), [record.id])
  assert.equal((await post(`${route}/${record.id}/decision`, { choice: 'approve', executor: 'parent', note: '', planHash: record.planHash })).statusCode, 202)
  assert.equal((await report(record.id, { outcome: 'reproduced', controlPassed: true, summary: 'Cross-account read was observed.', evidence: 'Owner HTTP 200. Other account HTTP 200.', environment: { fidelity: 'full', real: ['Synthetic application at the recorded commit', 'Synthetic database server'], substituted: [] } })).statusCode, 200)
  const result = store.readTest(panel.id, record.id)
  assert.equal(result.status, 'reproduced')
  assert.equal(store.readEvidence(panel.id, leadId).tag, 'finding', 'the verifying agent’s report marks the lead')
  assert.equal(calls, 0, 'Kraflr’s runner never executes a researched lead')
  assert.deepEqual(store.readEvidence(panel.id, leadId).verificationResults[0]?.observation, result.observation)
  controlPassed = false
  store.saveLeadReview(panel.id,leadId,{expectedVersion:store.readEvidence(panel.id,leadId).reviews[0]?.version??0,status:'open',tag:'lead',note:'Explicitly reopen for a controlled retest with a failed control.',nextAction:''})
  const failedControl = (await post(route + '/project', { ...payload, id: randomUUID() })).json<VerificationRecord>()
  assert.equal((await post(`${route}/${failedControl.id}/decision`, { choice: 'approve', executor: 'parent', note: '', planHash: failedControl.planHash })).statusCode, 202)
  assert.equal((await report(failedControl.id, { outcome: 'reproduced', controlPassed: false, summary: 'The control failed.', evidence: 'Owner HTTP 500.' })).statusCode, 200)
  assert.equal(store.readTest(panel.id, failedControl.id).status, 'inconclusive')
  assert.equal(store.readEvidence(panel.id, leadId).tag, 'lead', 'a failed control proves nothing')
  assert.equal((await post(`${route}/${failedControl.id}/finding`, { note: 'This must be refused.' })).statusCode, 409)
  assert.equal((await post(`${route}/${record.id}/finding`, { note: 'Already saved by the verifier.' })).statusCode, 409)
  assert.ok(store.listVerification(panel.id, leadId).records.some((item) => item.finding))
  const team = createResearchTeam(store, {
    list: () => [{
      id: randomUUID(), panelId: panel.id, kind: 'opencode', mode: 'terminal', label: 'New parent',
      state: 'running', startedAt: leadRun.startedAt, exitCode: null, scopeVersion: 1, parent: true, chat: true,
    }],
    async researchTurn(_panel, _agent, prompt) {
      assert.match(prompt, /Cross-account read was observed/)
      assert.match(prompt, /Owner HTTP 200/)
      return '```kraflr-result\n{"summary":"Reviewed the saved Docker observation."}\n```'
    },
  })
  const next = team.start(panel.id, 'Evaluate the Docker evidence.', randomUUID(), leadId)
  for (let attempt = 0; attempt < 30 && store.readResearchRun(panel.id, next.id).status === 'running'; attempt++) await delay(10)
  await team.close()
  assert.equal(store.readResearchRun(panel.id, next.id).summary, 'Reviewed the saved Docker observation.')
})

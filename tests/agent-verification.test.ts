import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../server/app.ts'
import { openStore, StoreError } from '../server/db.ts'
import { ContainerFailure, verificationFailure } from '../server/verification-runner.ts'
import type { VerificationRunner } from '../server/verification-runner.ts'
import type { AgentTerminals } from '../server/agent-terminals.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import type { VerificationRecord } from '../shared/verification.ts'
import { agentVerification } from '../cli/agent-verification.ts'
import { verificationNotifications } from '../cli/verification-notifications.ts'
import { createDelivery } from '../cli/delivery.ts'
import { createHandoff } from '../cli/handoff.ts'
import { leadVerification } from '../shared/lead-verification.ts'
import { labPreparationPrompt } from '../server/lab-preparation.ts'

const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
const image = 'sha256:' + 'c'.repeat(64)
const fullEnvironment = { fidelity: 'full', real: ['Synthetic application at the recorded commit', 'Synthetic database server'], substituted: [] }
const observation = { outcome: 'reproduced', controlPassed: true, summary: 'Synthetic reproduction with a passing control', evidence: 'Synthetic container output', environment: fullEnvironment }
const missing = { outcome: 'not_reproduced', controlPassed: true, summary: 'The control passed and the foreign request was refused', evidence: 'HTTP 403', environment: fullEnvironment }

async function setup(options: { leaseMs?: number; parent?: boolean; child?: boolean } = {}) {
  const store = openStore(':memory:')
  const grants: VerificationRecord[] = [], results: VerificationRecord[] = []
  // Kraflr's own runner is never asked to run a researched lead; it only inspects images, and this one has no engine at all.
  const runner: VerificationRunner = {
    async available() { return { ready: true, detail: 'Synthetic image inspection', image: '' } },
    async run() { throw new Error('Kraflr’s runner must never execute a researched lead.') },
  }
  const listed: AgentTerminalInfo[] = []
  const terminals = { list: () => listed, async close() {}, async dashboardSessions() { return [] } } as unknown as AgentTerminals
  const app = buildApp(store, 4317, { verificationRunner: runner, terminals, onVerificationGrant: (record) => grants.push(record),
    onVerificationResult: (record) => results.push(record), verificationLeaseMs: options.leaseMs })
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await app.inject({ url: path, method: method as 'GET' | 'POST', headers, payload: body as object })
    if (response.statusCode >= 400) throw new StoreError(response.statusCode, response.json().message)
    return response.json()
  }
  const panel = await api('/api/verification/fixture', 'POST', {})
  const lead = store.listEvidence(panel.id, 0).leads[0]!
  const agent = (over: Partial<AgentTerminalInfo> = {}): AgentTerminalInfo => ({ id: randomUUID(), panelId: panel.id, parent: true, kind: 'cline', mode: 'terminal', label: 'Parent',
    state: 'running', scopeVersion: 1, chat: true, promptReady: true, startedAt: 'now', exitCode: null, ...over })
  const parent = agent(), child = agent({ parent: false, label: 'Child', kind: 'opencode' })
  if (options.parent !== false) listed.push(parent)
  if (options.child) listed.push(child)
  const plan = async () => api(`/api/panels/${panel.id}/verification/project`, 'POST', { id: randomUUID(), leadId: lead.id, scopeVersion: 1,
    plan: { title: 'Synthetic project plan', image, command: ['/usr/local/bin/php', '/app/verify.php'], action: 'Run the synthetic check', expected: 'A control and an observation' } }) as Promise<VerificationRecord>
  const decide = (record: VerificationRecord, body: object = {}) => api(`/api/panels/${panel.id}/verification/${record.id}/decision`, 'POST',
    { planHash: record.planHash, choice: 'approve', executor: 'parent', note: 'Reviewed the exact plan.', ...body }) as Promise<VerificationRecord>
  const ask = (who: AgentTerminalInfo, operation: string, target?: string, payload?: unknown): Promise<any> => agentVerification(store, api, who, operation, target, payload)
  return { store, app, api, panel, lead, parent, child, agent, plan, decide, ask, grants, results, listed }
}

test('an approved test is leased to the Parent, who runs the exact approved container and its report marks a Finding', async () => {
  const s = await setup()
  try {
    const record = await s.plan()
    const approved = await s.decide(record)
    assert.equal(approved.status, 'running'); assert.equal(approved.executor, 'parent'); assert.equal(approved.lease?.agentId, s.parent.id)
    assert.equal(approved.decision?.saveFindingOnSuccess, true, 'approving authorizes the agent to mark the lead')
    assert.equal(s.grants.length, 1); assert.equal(s.grants[0]!.id, record.id)
    assert.equal(s.store.readEvidence(s.panel.id, s.lead.id).verificationProgress?.label, 'Verifying · Parent is running the test')

    const docker = await s.ask(s.parent, 'docker', record.id)
    for (const flag of ['--read-only', '--network', '--cap-drop', '--tmpfs']) assert.ok(docker.argv.includes(flag), flag)
    assert.ok(docker.argv.includes(image)); assert.ok(!docker.argv.includes('--privileged')); assert.ok(!docker.argv.includes('-v'))
    assert.ok(docker.notes.some((note: string) => /MSYS_NO_PATHCONV/.test(note))); assert.ok(docker.notes.some((note: string) => /verification fail/.test(note)))

    await assert.rejects(s.ask(s.agent(), 'report', record.id, JSON.stringify({ ...observation })), /not for you/)
    await assert.rejects(s.ask(s.agent({ parent: false }), 'docker', record.id), /not for you/)
    await assert.rejects(s.ask(s.parent, 'report', record.id, JSON.stringify({ ...observation, image: 'sha256:' + 'd'.repeat(64) })), /not the approved image/)
    await assert.rejects(s.ask(s.parent, 'report', record.id, JSON.stringify({ ...observation, evidence: false })), /evidence must be a string/)
    await assert.rejects(s.ask(s.parent, 'report', record.id, 'not json'), /JSON object/)
    await assert.rejects(s.ask(s.parent, 'exec', record.id), /Verification commands/)
    assert.equal(s.store.readTest(s.panel.id, record.id).status, 'running', 'rejected reports must leave the grant open')

    const done = await s.ask(s.parent, 'report', record.id, JSON.stringify({ ...observation, image, exitCode: 0, command: 'docker run ...' }))
    assert.equal(done.record.status, 'reproduced'); assert.equal(done.record.report.via, 'agent-docker'); assert.match(done.record.detail, /^Parent ran the test:/)
    assert.equal(done.record.finding?.acceptance, 'conditional'); assert.match(done.message, /Finding/)
    assert.equal(s.store.readEvidence(s.panel.id, s.lead.id).tag, 'finding')
    assert.equal(s.results.length, 0, 'the Parent already knows what it reported, so nothing is sent back to it')
    await assert.rejects(s.ask(s.parent, 'report', record.id, JSON.stringify(observation)), /not approved this test for an agent/)
  } finally { await s.app.close() }
})

test('a Child verifies when the researcher chooses it, and the Parent hears the result without being asked', async () => {
  const s = await setup({ child: true })
  try {
    const record = await s.plan()
    await assert.rejects(s.decide(record, { executor: 'child', agentId: randomUUID() }), /Child agent/)
    const approved = await s.decide(record, { executor: 'child' })
    assert.equal(approved.executor, 'child'); assert.equal(approved.lease?.agentId, s.child.id); assert.equal(approved.lease?.agentLabel, 'Child')
    assert.equal(s.store.readEvidence(s.panel.id, s.lead.id).verificationProgress?.label, 'Verifying · Child is running the test')

    await assert.rejects(s.ask(s.parent, 'report', record.id, JSON.stringify(observation)), /not for you/)
    assert.ok((await s.ask(s.child, 'docker', record.id)).argv.includes(image), 'a Child holding the grant may use the lease operations')
    await assert.rejects(s.ask(s.child, 'prepare', s.lead.id), /Parent manages verification/)

    const done = await s.ask(s.child, 'report', record.id, JSON.stringify(observation))
    assert.equal(done.record.status, 'reproduced'); assert.match(done.record.detail, /^Child ran the test:/); assert.equal(done.record.finding?.acceptance, 'conditional')
    assert.equal(s.results.length, 1); assert.equal(s.results[0]!.id, record.id, 'the Parent is notified of a Child’s result')
  } finally { await s.app.close() }
})

test('with several Children the researcher names the verifier, and an agent that already stopped is never offered', async () => {
  const s = await setup({ child: true })
  const second = s.agent({ parent: false, label: 'Second child' })
  s.listed.push(second)
  try {
    const record = await s.plan()
    await assert.rejects(s.decide(record, { executor: 'child' }), /Choose which Child/)
    s.child.stoppage = { kind: 'limit', reason: 'usage limit', at: 'now' }
    const approved = await s.decide(record, { executor: 'child' })
    assert.equal(approved.lease?.agentId, second.id, 'the Child that hit its limit cannot be chosen')
    const stopped = await setup({ child: true })
    try {
      stopped.child.stoppage = { kind: 'limit', reason: 'usage limit', at: 'now' }
      const request = await stopped.plan()
      await assert.rejects(stopped.decide(request, { executor: 'child' }), /Start a Child agent/)
    } finally { await stopped.app.close() }
  } finally { await s.app.close() }
})

test('a result that did not reproduce with a passing control kills the lead, and a failed control leaves it open', async () => {
  const s = await setup()
  try {
    const killing = await s.plan()
    await s.decide(killing)
    const done = await s.ask(s.parent, 'report', killing.id, JSON.stringify(missing))
    assert.equal(done.record.status, 'not_reproduced'); assert.match(done.record.killedLead.note, /Parent ran the approved test/); assert.match(done.message, /killed/)
    const lead = s.store.readEvidence(s.panel.id, s.lead.id)
    assert.equal(lead.tag, 'killed_lead'); assert.equal(lead.status, 'closed'); assert.equal(lead.verificationProgress?.label, 'Not reproduced · lead killed')
  } finally { await s.app.close() }
  const open = await setup()
  try {
    const record = await open.plan()
    await open.decide(record)
    const done = await open.ask(open.parent, 'report', record.id, JSON.stringify({ ...missing, controlPassed: false }))
    assert.equal(done.record.status, 'inconclusive'); assert.equal(done.record.killedLead, undefined); assert.equal(done.record.finding, undefined)
    assert.equal(open.store.readEvidence(open.panel.id, open.lead.id).tag, 'lead', 'a failed control proves nothing, so the lead stays open')
  } finally { await open.app.close() }
})

test('approval needs a named verifier for a researched lead and the bundled fixture never goes to an agent', async () => {
  const none = await setup({ parent: false })
  try {
    const record = await none.plan()
    await assert.rejects(none.decide(record), /Start this panel’s Parent/)
    await assert.rejects(none.decide(record, { executor: undefined }), /Choose who verifies/)
    await assert.rejects(none.decide(record, { executor: 'kraflr' }), /Choose who verifies/)
    assert.equal(none.store.readTest(none.panel.id, record.id).status, 'pending')
  } finally { await none.app.close() }
  const fixture = await setup()
  try {
    const response = await fixture.app.inject({ method: 'POST', url: `/api/panels/${fixture.panel.id}/verification`, headers, payload: { variant: 'vulnerable' } })
    await assert.rejects(fixture.decide(response.json<VerificationRecord>()), /bundled fixture/)
  } finally { await fixture.app.close() }
})

test('an agent that cannot finish reports the failure: the lead shows Error faced, and the researcher can cancel so approval is needed again', async () => {
  const s = await setup()
  try {
    const record = await s.plan()
    await s.decide(record)
    await assert.rejects(s.ask(s.parent, 'fail', record.id, JSON.stringify({ message: '  ' })), /Say what went wrong/)
    await assert.rejects(s.ask(s.agent(), 'fail', record.id, JSON.stringify({ message: 'nope' })), /not for you/)
    const failed = await s.ask(s.parent, 'fail', record.id, JSON.stringify({ message: 'Dockerfile COPY failed: config.php not found', output: 'COPY failed\nfile not found', exitCode: 1 }))
    assert.equal(failed.record.status, 'error'); assert.equal(failed.record.failure.code, 'agent_reported'); assert.equal(failed.record.failure.retryable, false)
    assert.equal(failed.record.failure.exitCode, 1); assert.match(failed.record.failure.output, /file not found/); assert.match(failed.record.detail, /Parent could not complete the test/)
    assert.equal(s.store.readEvidence(s.panel.id, s.lead.id).verificationProgress?.label, 'Error faced'); assert.equal(s.store.readEvidence(s.panel.id, s.lead.id).tag, 'lead')
    assert.match(failed.message, /Error faced/)

    const cancelled = await s.api(`/api/panels/${s.panel.id}/verification/${record.id}/decision`, 'POST', { planHash: record.planHash, choice: 'cancel', note: '' })
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.lease, undefined); assert.match(cancelled.detail, /ask for approval again/)
    await assert.rejects(s.ask(s.parent, 'report', record.id, JSON.stringify(observation)), /not approved this test for an agent/)
    const next = await s.plan()
    assert.equal(next.status, 'pending', 'after cancelling, the agent has to queue a plan and win a fresh approval')
    assert.equal((await s.decide(next)).status, 'running')
  } finally { await s.app.close() }
})

test('the lead reads Analysing verification error while an agent repairs a failed test, and the repair prompt carries the failure', () => {
  const lead = { tag: 'lead' as const, status: 'open' as const, reviews: [], verificationResults: [{ id: 'a', scopeVersion: 1, status: 'error', createdAt: new Date().toISOString(), plan: {}, planHash: '', panelId: '', leadId: '', expiresAt: '' }] }
  const run = { id: 'p', scopeVersion: 1, status: 'running', purpose: 'verification' } as never
  assert.equal(leadVerification(lead as never, 1, run).label, 'Verifying · preparing lab')
  const repairing = leadVerification(lead as never, 1, { ...(run as object), repairOf: 'a' } as never)
  assert.equal(repairing.state, 'analysing'); assert.equal(repairing.label, 'Analysing verification error'); assert.equal(repairing.active, true)
  assert.equal(leadVerification(lead as never, 1).label, 'Error faced')
  const prompt = labPreparationPrompt({ id: 'lead-1', title: 'T', explanation: 'E', path: 'a.php', startLine: 1, endLine: 2 } as never, { repository: 'https://example.test/r' } as never, '/lab',
    { id: 'failed-1', status: 'error', detail: 'Parent could not complete the test: config.php missing', failure: { code: 'agent_reported', hint: 'h', output: 'COPY failed' }, plan: { image, command: ['/x'] } } as never)
  assert.match(prompt, /second run/); assert.match(prompt, /config\.php missing/); assert.match(prompt, /COPY failed/); assert.match(prompt, /untrusted/)
  assert.doesNotMatch(labPreparationPrompt({ id: 'lead-1', title: 'T', explanation: 'E', path: 'a.php', startLine: 1, endLine: 2 } as never, { repository: 'https://example.test/r' } as never), /second run/)
})

test('an unreported grant expires into interrupted, a researcher can cancel it, and a scope change stops it', async () => {
  const quick = await setup({ leaseMs: 40 })
  try {
    const record = await quick.plan()
    await quick.decide(record)
    for (let i = 0; i < 100 && quick.store.readTest(quick.panel.id, record.id).status === 'running'; i++) await delay(10)
    const expired = quick.store.readTest(quick.panel.id, record.id)
    assert.equal(expired.status, 'interrupted'); assert.match(expired.detail!, /Parent did not report/); assert.notEqual(expired.cleanupPending, true)
    assert.equal(quick.store.readEvidence(quick.panel.id, quick.lead.id).verificationProgress?.label, 'Error faced · test did not finish')
    await assert.rejects(quick.ask(quick.parent, 'report', record.id, JSON.stringify(observation)), /not approved this test for an agent/)
  } finally { await quick.app.close() }
  const cancelled = await setup()
  try {
    const record = await cancelled.plan()
    await cancelled.decide(record)
    await cancelled.api(`/api/panels/${cancelled.panel.id}/verification/${record.id}/decision`, 'POST', { planHash: record.planHash, choice: 'cancel', note: '' })
    assert.equal(cancelled.store.readTest(cancelled.panel.id, record.id).status, 'cancelled')
  } finally { await cancelled.app.close() }
  const moved = await setup()
  try {
    const record = await moved.plan()
    await moved.decide(record)
    moved.store.saveScope(moved.panel.id, 1, { ...moved.panel.scopeHistory[0]!, notes: 'A new source scope' })
    const stopped = moved.store.readTest(moved.panel.id, record.id)
    assert.equal(stopped.status, 'stale')
  } finally { await moved.app.close() }
})

test('the approved agent receives the grant with the exact commands, and a Child’s grant never goes to the Parent', async () => {
  const s = await setup({ child: true })
  const received: { to: string; text: string }[] = []
  const terminals = { list: () => s.listed, async researchTurn(_panel: string, id: string, text: string) { received.push({ to: id, text }); return 'Running it now.' } }
  const delivery = createDelivery(s.store, terminals as never)
  const notifications = verificationNotifications(terminals as never, delivery)
  try {
    const record = await s.plan()
    const approved = await s.decide(record, { executor: 'child' })
    notifications.grant(approved); notifications.grant(approved)
    for (let i = 0; i < 100 && !s.store.listResearchRuns(s.panel.id).some((run) => run.phase === 'Approved test handed to Child'); i++) await delay(10)
    assert.equal(received.length, 1, 'a repeated grant is delivered once')
    assert.equal(received[0]!.to, s.child.id)
    for (const command of [`verification docker ${record.id}`, `verification report ${record.id}`, `verification fail ${record.id}`]) assert.match(received[0]!.text, new RegExp(command))
    assert.match(received[0]!.text, /untrusted/); assert.match(received[0]!.text, /killed|kills the lead/)
    assert.doesNotMatch(received[0]!.text, /verification exec/)
    assert.equal(s.store.listEvidence(s.panel.id, 0).leads.length, 1, 'a grant never creates leads')
  } finally { await delivery.close(); await s.app.close() }
})

test('a teammate’s reply to a send is delivered into the asking agent’s prompt, once, without polling the inbox', async () => {
  const { createCollaboration } = await import('../cli/collaboration.ts')
  const s = await setup({ child: true })
  const received: { to: string; text: string }[] = []
  const terminals = { list: () => s.listed, async researchTurn(_panel: string, id: string, text: string) { received.push({ to: id, text }); return id === s.child.id ? 'Child analysis: the check is missing.' : 'Noted.' } }
  const delivery = createDelivery(s.store, terminals as never)
  const collaboration = createCollaboration(s.store, terminals as never, (_id, text) => text, delivery)
  try {
    const exchange = collaboration.start(s.parent, s.child.id, 'Review the export handler', { notify: true })
    await exchange.done()
    for (let i = 0; i < 200 && received.length < 2; i++) await delay(10)
    assert.equal(received.length, 2); assert.equal(received[0]!.to, s.child.id); assert.equal(received[1]!.to, s.parent.id)
    assert.match(received[1]!.text, /Child analysis: the check is missing/); assert.match(received[1]!.text, /do not need to check the inbox/)
    const quiet = collaboration.start(s.parent, s.child.id, 'A blocking question')
    await quiet.done(); await delay(100)
    assert.equal(received.filter((item) => item.to === s.parent.id).length, 1, 'a blocking ask returns its answer directly and is not pushed again')
  } finally { await collaboration.close(); await delivery.close(); await s.app.close() }
})

test('a stopped agent’s saved context goes to a running teammate, together with the approved test it held', async () => {
  const s = await setup({ child: true })
  const received: { to: string; text: string }[] = []
  const terminals = { list: () => s.listed, async messages() { return [{ id: '1', role: 'assistant', text: 'I was checking the export handler' }] }, async researchTurn(_panel: string, id: string, text: string) { received.push({ to: id, text }); return 'Continuing.' } }
  const delivery = createDelivery(s.store, terminals as never)
  const notifications = verificationNotifications(terminals as never, delivery)
  const handoff = createHandoff(s.store, terminals as never, (_id, text) => text, delivery, (record) => notifications.grant(record))
  try {
    const record = await s.plan()
    await s.decide(record, { executor: 'child' })
    s.child.stoppage = { kind: 'limit', reason: 'OpenCode reported a usage limit', at: '2026-11-23T10:00:00.000Z' }
    await assert.rejects(handoff.run(s.panel.id, s.child.id, s.child.id), /another running agent/)
    s.parent.stoppage = { kind: 'limit', reason: 'also limited', at: 'now' }
    await assert.rejects(handoff.run(s.panel.id, s.child.id, s.parent.id), /another running agent/)
    s.parent.stoppage = undefined

    const result = await handoff.run(s.panel.id, s.child.id, s.parent.id)
    assert.equal(result.tests, 1)
    for (let i = 0; i < 200 && received.length < 2; i++) await delay(10)
    assert.equal(received.length, 2); assert.ok(received.every((item) => item.to === s.parent.id))
    assert.match(received[0]!.text, /Child .*stopped working: OpenCode reported a usage limit/); assert.match(received[0]!.text, /I was checking the export handler/); assert.match(received[0]!.text, /untrusted/)
    assert.match(received[1]!.text, new RegExp(`verification docker ${record.id}`), 'the new holder gets its own grant')
    const moved = s.store.readTest(s.panel.id, record.id)
    assert.equal(moved.lease?.agentId, s.parent.id); assert.equal(moved.executor, 'parent')
    assert.ok((await s.ask(s.parent, 'docker', record.id)).argv.includes(image)); await assert.rejects(s.ask(s.child, 'report', record.id, JSON.stringify(observation)), /not for you/)
    await assert.rejects(handoff.run(s.panel.id, s.child.id, s.parent.id), /already sent/)
  } finally { await delivery.close(); await s.app.close() }
})

test('container failures carry their own exit code and output while Docker CLI errors stay out of the record', () => {
  const harness = verificationFailure(new ContainerFailure('harness_failed', 'The test command failed.', { exitCode: 3, output: 'PHP Warning: boom' }), 'running the test command')
  assert.equal(harness.code, 'harness_failed'); assert.equal(harness.exitCode, 3); assert.equal(harness.output, 'PHP Warning: boom'); assert.equal(harness.retryable, false)
  assert.match(harness.hint, /code 3/); assert.match(harness.hint, /repair the harness/)
  const invalid = verificationFailure(new ContainerFailure('output_invalid', 'The structured result is invalid: evidence must be a string of at most 4000 characters.', { output: '{"evidence":false}' }), 'reading the test’s structured result')
  assert.match(invalid.hint, /evidence must be a string/); assert.equal(invalid.retryable, false)
  assert.equal(verificationFailure(new ContainerFailure('test_timeout', 'late'), 'x').code, 'test_timeout')
  assert.equal(verificationFailure({ stderr: 'exec: "/nope": no such file or directory' }, 'x').code, 'harness_command_missing')
  const daemon = verificationFailure({ stderr: 'Error response from daemon: secret-token-should-not-appear', message: 'docker failed' }, 'creating the isolated container')
  assert.equal(daemon.code, 'docker_operation_failed'); assert.doesNotMatch(JSON.stringify(daemon), /secret-token/)
})

test('a restart during an agent’s grant interrupts it without blocking the next approval or inventing a container to clean up', async () => {
  const folder = await mkdtemp(join(await realpath(tmpdir()), 'kraflr-lease-restart-')), file = join(folder, 'state.sqlite')
  let store = openStore(file)
  const listed: AgentTerminalInfo[] = []
  const runner: VerificationRunner = { async available() { return { ready: true, detail: 'Synthetic engine', image: '' } }, async cleanup() { throw new Error('there is no container to clean up') }, async run() { throw new Error('unused') } }
  const start = () => buildApp(store, 4317, { verificationRunner: runner, terminals: { list: () => listed, async close() {}, async dashboardSessions() { return [] } } as unknown as AgentTerminals })
  let app = start()
  const call = async (path: string, method = 'GET', body?: unknown) => { const response = await app.inject({ url: path, method: method as 'GET' | 'POST', headers, payload: body as object }); return { status: response.statusCode, body: response.json() } }
  try {
    const panel = (await call('/api/verification/fixture', 'POST', {})).body
    const lead = store.listEvidence(panel.id, 0).leads[0]!
    listed.push({ id: randomUUID(), panelId: panel.id, parent: true, kind: 'claude', mode: 'terminal', label: 'Parent', state: 'running', scopeVersion: 1, chat: true, promptReady: true, startedAt: 'now', exitCode: null })
    const plan = async () => (await call(`/api/panels/${panel.id}/verification/project`, 'POST', { id: randomUUID(), leadId: lead.id, scopeVersion: 1,
      plan: { title: 'Restart plan', image, command: ['/usr/local/bin/php', '/app/verify.php'], action: 'Run it', expected: 'A result' } })).body as VerificationRecord
    const first = await plan()
    assert.equal((await call(`/api/panels/${panel.id}/verification/${first.id}/decision`, 'POST', { planHash: first.planHash, choice: 'approve', executor: 'parent', note: '' })).status, 202)
    await app.close()

    store = openStore(file); app = start()
    const restored = store.readTest(panel.id, first.id)
    assert.equal(restored.status, 'interrupted'); assert.match(restored.detail!, /Kraflr stopped before a result was recorded|shut down before the agent reported/); assert.notEqual(restored.cleanupPending, true); assert.equal(restored.executor, 'parent')
    assert.equal((await call('/api/verification/availability')).body.ready, true, 'an agent grant leaves nothing for Kraflr to clean up')
    const second = await plan()
    assert.equal((await call(`/api/panels/${panel.id}/verification/${second.id}/decision`, 'POST', { planHash: second.planHash, choice: 'approve', executor: 'parent', note: '' })).status, 202)
  } finally { await app.close(); await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

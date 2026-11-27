import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.ts'
import { openStore, StoreError } from '../server/db.ts'
import type { VerificationRunner } from '../server/verification-runner.ts'
import type { AgentTerminals } from '../server/agent-terminals.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import type { VerificationRecord } from '../shared/verification.ts'
import { agentVerification } from '../cli/agent-verification.ts'
import { labPreparationPrompt } from '../server/lab-preparation.ts'

const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
const image = 'sha256:' + 'e'.repeat(64)
const base = { outcome: 'reproduced', controlPassed: true, summary: 'The injected payload altered the query', evidence: 'HTTP 200 with extra rows' }
const full = { fidelity: 'full', real: ['WordPress 6.8 at the recorded commit', 'MariaDB 11 server', 'wp core install'], substituted: [] }

async function setup() {
  const store = openStore(':memory:')
  const runner: VerificationRunner = { async available() { return { ready: true, detail: 'Synthetic', image: '' } }, async run() { throw new Error('unused') } }
  const listed: AgentTerminalInfo[] = []
  const app = buildApp(store, 4317, { verificationRunner: runner, terminals: { list: () => listed, async close() {}, async dashboardSessions() { return [] } } as unknown as AgentTerminals })
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await app.inject({ url: path, method: method as 'GET' | 'POST', headers, payload: body as object })
    if (response.statusCode >= 400) throw new StoreError(response.statusCode, response.json().message)
    return response.json()
  }
  const panel = await api('/api/verification/fixture', 'POST', {})
  const lead = store.listEvidence(panel.id, 0).leads[0]!
  const parent: AgentTerminalInfo = { id: randomUUID(), panelId: panel.id, parent: true, kind: 'cline', mode: 'terminal', label: 'Parent', state: 'running', scopeVersion: 1, chat: true, promptReady: true, startedAt: 'now', exitCode: null }
  listed.push(parent)
  const plan = (limits?: object) => api(`/api/panels/${panel.id}/verification/project`, 'POST', { id: randomUUID(), leadId: lead.id, scopeVersion: 1,
    plan: { title: 'Synthetic SQL injection check', image, command: ['/usr/local/bin/php', '/app/verify.php'], action: 'Send the payload to the real route', expected: 'A control and an observation', ...(limits ? { limits } : {}) } }) as Promise<VerificationRecord>
  const approve = async (record: VerificationRecord) => api(`/api/panels/${panel.id}/verification/${record.id}/decision`, 'POST', { planHash: record.planHash, choice: 'approve', executor: 'parent', note: 'Reviewed.' }) as Promise<VerificationRecord>
  const report = async (record: VerificationRecord, observation: object) => agentVerification(store, api, parent, 'report', record.id, JSON.stringify(observation)) as Promise<{ record: VerificationRecord; message: string }>
  return { store, app, api, panel, lead, plan, approve, report, parent }
}

test('a shimmed or partial environment can neither create a Finding nor kill a lead', async () => {
  const cases: [string, object, RegExp][] = [
    ['reproduced on a stand-in', { ...base, environment: { fidelity: 'partial', real: ['PHP'], substituted: ['SQLite instead of MySQL', 'Stubbed WordPress REST API'] } }, /SQLite instead of MySQL/],
    ['reproduced with no statement about the environment', { ...base }, /did not state what the test ran against/],
    ['reproduced but the real components are not named', { ...base, environment: { fidelity: 'full', real: [], substituted: [] } }, /Not a full end-to-end/],
    ['full claimed while something was substituted', { ...base, environment: { fidelity: 'full', real: ['PHP'], substituted: ['a mocked database'] } }, /Not a full end-to-end/],
    ['not reproduced on a stand-in must not kill the lead', { ...base, outcome: 'not_reproduced', summary: 'The stand-in refused the payload', environment: { fidelity: 'partial', real: ['PHP'], substituted: ['SQLite'] } }, /neither confirm nor kill/],
  ]
  for (const [name, observation, detail] of cases) {
    const s = await setup()
    try {
      const record = await s.plan()
      await s.approve(record)
      const done = await s.report(record, observation)
      assert.equal(done.record.status, 'inconclusive', name); assert.match(done.record.detail!, detail, name)
      assert.equal(done.record.finding, undefined, name); assert.equal(done.record.killedLead, undefined, name)
      assert.equal(s.store.readEvidence(s.panel.id, s.lead.id).tag, 'lead', name + ': the lead stays open')
      assert.match(done.message, /full end-to-end/, name)
    } finally { await s.app.close() }
  }
})

test('a full end-to-end report still marks the lead, and a malformed environment is refused with a precise message', async () => {
  const s = await setup()
  try {
    const record = await s.plan()
    await s.approve(record)
    await assert.rejects(s.report(record, { ...base, environment: { fidelity: 'mostly', real: ['x'], substituted: [] } }), /environment must be/)
    await assert.rejects(s.report(record, { ...base, environment: 'full' }), /environment must be/)
    assert.equal(s.store.readTest(s.panel.id, record.id).status, 'running', 'a refused report leaves the grant open')
    const done = await s.report(record, { ...base, environment: full })
    assert.equal(done.record.status, 'reproduced'); assert.equal(done.record.finding?.acceptance, 'conditional')
    assert.deepEqual(done.record.observation && 'environment' in done.record.observation ? done.record.observation.environment : undefined, full)
    assert.equal(s.store.readEvidence(s.panel.id, s.lead.id).tag, 'finding')
  } finally { await s.app.close() }
})

test('a plan can ask for the resources a real application stack needs, within hard limits, and the approved command applies them', async () => {
  const s = await setup()
  try {
    const ordinary = await s.plan()
    assert.deepEqual(ordinary.plan.limits, { memoryMiB: 256, cpus: 1, processes: 64, seconds: 60, scratchMiB: 64 })
    const drop = (record: VerificationRecord) => s.api(`/api/panels/${s.panel.id}/verification/${record.id}/decision`, 'POST', { planHash: record.planHash, choice: 'cancel', note: '' })
    await drop(ordinary)

    const big = await s.plan({ memoryMiB: 2048, cpus: 2, processes: 256, seconds: 300, scratchMiB: 1024 })
    assert.deepEqual(big.plan.limits, { memoryMiB: 2048, cpus: 2, processes: 256, seconds: 300, scratchMiB: 1024 })
    await drop(big)
    const partial = await s.plan({ memoryMiB: 1024 })
    assert.deepEqual(partial.plan.limits, { memoryMiB: 1024, cpus: 1, processes: 64, seconds: 60, scratchMiB: 64 }, 'anything not asked for keeps its default')
    await drop(partial)

    for (const limits of [{ memoryMiB: 99999 }, { memoryMiB: 8 }, { cpus: 64 }, { seconds: 100000 }, { processes: 10 }, { memoryMiB: 512, scratchMiB: 1024 }, { memoryMiB: 300.5 }, { surprise: 1 }]) {
      await assert.rejects(s.plan(limits), (error: unknown) => error instanceof StoreError && error.status === 400, JSON.stringify(limits))
    }
  } finally { await s.app.close() }
  const approved = await setup()
  try {
    const record = await approved.plan({ memoryMiB: 2048, cpus: 2, processes: 256, seconds: 300, scratchMiB: 1024 })
    await approved.approve(record)
    const docker = await agentVerification(approved.store, approved.api, approved.parent, 'docker', record.id) as { argv: string[]; notes: string[] }
    const at = (flag: string) => docker.argv[docker.argv.indexOf(flag) + 1]
    assert.equal(at('--memory'), '2048m'); assert.equal(at('--memory-swap'), '2048m'); assert.equal(at('--cpus'), '2'); assert.equal(at('--pids-limit'), '256')
    assert.match(at('--tmpfs')!, /size=1024m/); assert.match(docker.notes.join(' '), /within 300 seconds/)
  } finally { await approved.app.close() }
})

test('the verify prompt demands the real stack and an honest environment statement before a lead may become a Finding', () => {
  const prompt = labPreparationPrompt({ id: 'lead-1', title: 'T', explanation: 'E', path: 'a.php', startLine: 1, endLine: 2 } as never, { repository: 'https://example.test/r' } as never, '/lab')
  assert.match(prompt, /FULL END-TO-END RULE/); assert.match(prompt, /real MySQL or MariaDB server \(not SQLite\)/); assert.match(prompt, /real core install/)
  assert.match(prompt, /Do not shim, stub, mock or reimplement/); assert.match(prompt, /partial test can neither confirm nor kill a lead/)
  assert.match(prompt, /environment\.substituted/); assert.match(prompt, /"limits" object/); assert.match(prompt, /memoryMiB 128–4096/)
})

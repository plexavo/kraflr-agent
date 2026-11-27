import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { openStore } from '../server/db.ts'
import { buildApp } from '../server/app.ts'
import { createResearchTeam } from '../server/research-team.ts'
import { createAgentTerminals } from '../server/agent-terminals.ts'
import { openClineWorker } from '../server/cline-worker.ts'
import { preparedLabPlan, validLabDirectory } from '../server/prepared-verification.ts'
import { decodeReport, plainReply } from '../shared/report-text.ts'
import { emptyScope } from '../shared/research.ts'
import type { ResearchRun } from '../shared/research-run.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'

const wrap = (data: object) => '```kraflr-result\n' + JSON.stringify(data) + '\n```'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function finished(store: ReturnType<typeof openStore>, panel: string, id: string) {
  for (let i = 0; i < 100 && store.readResearchRun(panel, id).status === 'running'; i++) await tick()
  return store.readResearchRun(panel, id)
}
function session(panelId: string, parent: boolean): AgentTerminalInfo {
  return { id: randomUUID(), panelId, kind: 'cline', mode: 'cline-worker', label: parent ? 'Parent' : 'Reviewer',
    parent, chat: true, state: 'running', scopeVersion: 1, startedAt: new Date().toISOString(), exitCode: null }
}
async function temporaryRoot(t: test.TestContext) {
  const base = await realpath(tmpdir())
  const path = await mkdtemp(join(base, 'kraflr-reliability-'))
  t.after(async () => {
    const resolved = await realpath(path)
    if (/^kraflr-reliability-[^\\/]+$/.test(relative(base, resolved))) await rm(resolved, { recursive: true, force: true })
  })
  return path
}

test('report variants decode without another model call and malformed reports never become the short reply', () => {
  const data = { summary: 'The lab is prepared. Execution still needs your approval.', leads: [], tasks: [], deadEnds: [], nextSteps: [] }
  for (const text of [wrap(data), '```kraclr-result\n' + JSON.stringify(data) + '\n```',
    '```\nkraflr-result\n' + JSON.stringify(data) + '\n```', '```json\n' + JSON.stringify(data) + '\n```',
    JSON.stringify(data), '~~~kraflr-result\n' + JSON.stringify(data) + '\n~~~']) {
    const decoded = decodeReport(text)
    assert.equal(decoded.structured, true, text)
    assert.equal(decoded.summary, data.summary)
    assert.equal(decoded.reply, data.summary)
    assert.doesNotMatch(decoded.reply, /kraflr-result|"leads"|```/)
  }
  assert.equal(decodeReport('```\nkraflr-result\n{"summary": broken\n```').structured, false)
  assert.doesNotMatch(plainReply('I saved the lab files.\n```kraflr-result\n{"summary": broken'), /summary|kraflr|```/)
  assert.doesNotMatch(plainReply('```\nkraflr-result\n{"summary": broken'), /"summary"|```/)
})

test('a permission wait beyond ten minutes stays active until explicit cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const nativeTimeout = AbortSignal.timeout
  AbortSignal.timeout = (milliseconds: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('Virtual timeout')), milliseconds)
    return controller.signal
  }
  t.after(() => { AbortSignal.timeout = nativeTimeout })
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Long approval', type: 'source' })
  store.saveScope(panel.id, 0, { ...emptyScope, repository: 'https://example.test/source', revision: 'v1' })
  const parent = session(panel.id, true)
  let signal: AbortSignal | undefined
  const team = createResearchTeam(store, { list: () => [parent], researchTurn(_panel, _agent, _prompt, _version, stop) {
    signal = stop
    return new Promise<string>((_resolve, reject) => stop.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }))
  } })
  try {
    const run = team.start(panel.id, 'Wait for the researcher’s tool decision.', randomUUID())
    assert.ok(signal)
    t.mock.timers.tick(11 * 60_000)
    await tick()
    assert.equal(signal.aborted, false)
    assert.equal(store.readResearchRun(panel.id, run.id).status, 'running')
    team.cancel(panel.id, run.id)
    assert.equal((await finished(store, panel.id, run.id)).status, 'interrupted')
  } finally { await team.close(); store.close() }
})

test('workers act only on tasks the parent assigns, and can exchange one bounded follow-up round with the parent', async () => {
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Required collaboration', type: 'source' })
  store.saveScope(panel.id, 0, { ...emptyScope, repository: 'https://example.test/source', revision: 'v1' })
  const parent = session(panel.id, true), worker = session(panel.id, false), away = session(randomUUID(), false)
  const calls: string[] = []
  let parentCalls = 0
  const team = createResearchTeam(store, { list: () => [parent, worker, away], async researchTurn(_panel, id, prompt) {
    calls.push(id)
    if (id === worker.id) return 'FULL_WORKER_TRANSCRIPT_ONLY_' + 'x'.repeat(20_000) + '\n' + wrap({ summary: 'The independent review checked the stated assumptions.', leads: [], tasks: [] })
    parentCalls++
    if (parentCalls === 1) return wrap({ summary: 'The source notes need independent review.', leads: [], tasks: [{ worker: 'Reviewer', objective: 'Independently review the notes.' }] })
    assert.match(prompt, /independent review checked/)
    assert.doesNotMatch(prompt, /FULL_WORKER_TRANSCRIPT_ONLY/)
    return wrap({ summary: 'Parent reviewed the returned worker results.', leads: [], tasks: [{ worker: 'Reviewer', objective: 'Check one remaining control assumption.' }] })
  } })
  try {
    const run = team.start(panel.id, 'Review the synthetic research notes together.', randomUUID())
    const done = await finished(store, panel.id, run.id)
    assert.equal(done.status, 'completed')
    assert.deepEqual(calls, [parent.id, worker.id, parent.id, worker.id, parent.id])
    assert.deepEqual(done.tasks.map(item => item.round), [1, 2])
    assert.equal(done.tasks[0]?.automatic, false)
    assert.match(done.tasks[0]?.fullReply ?? '', /FULL_WORKER_TRANSCRIPT_ONLY/)
    assert.match(done.nextSteps.join(' '), /two-round collaboration limit/)
  } finally { await team.close(); store.close() }
})

test('a built PHP lab recovers without a parent or code execution and retains its interruption history', async (t) => {
  const workspace = await temporaryRoot(t)
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Checkpoint recovery', type: 'source' })
  const scope = { ...emptyScope, repository: 'https://example.test/source', revision: 'v1', workspacePath: workspace }
  store.saveScope(panel.id, 0, scope)
  const source: ResearchRun = { id: randomUUID(), panelId: panel.id, parentId: randomUUID(), parentName: 'Fixture', scopeVersion: 1,
    objective: 'Synthetic security review', status: 'running', phase: 'Reviewing', startedAt: new Date().toISOString(), endedAt: null,
    summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [] }
  store.startResearchRun(source)
  store.saveResearchRun({ ...source, status: 'completed', leads: [{ kind: 'lead', title: 'Synthetic ownership concern', explanation: 'This is an unverified synthetic hypothesis.', path: 'fixture.txt', startLine: 1, endLine: 1,
    security: { hypothesis: 'A synthetic access check might omit ownership.', attackPath: 'A caller supplies another account’s synthetic record identifier.', impact: 'A caller might receive data belonging to another synthetic account.' } }] })
  const id = randomUUID(), leadId = `${source.id}:0`
  const directory = join(workspace, '.kraflr', panel.id, 'labs', `lab-${id}`)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'Dockerfile'), 'FROM php:8.2-cli@sha256:' + 'a'.repeat(64) + '\nCOPY verify.php /app/verify.php\nCMD ["/usr/local/bin/php","/app/verify.php"]\n')
  await writeFile(join(directory, 'verify.php'), 'RECOVERY MUST NOT READ OR EXECUTE THIS FILE')
  const plan = { title: 'Synthetic control', image: `sha256:${'b'.repeat(64)}`, command: ['/usr/local/bin/php', '/app/verify.php'], action: 'Compare synthetic owner and non-owner cases.', expected: 'Require a successful owner control before evaluating the claim.' }
  const preparation = { ...source, id, objective: 'Prepare an isolated synthetic lab.', purpose: 'verification' as const, leadId, labDirectory: directory }
  store.startResearchRun(preparation)
  const rawReply = '```\nkraclr-result\n' + JSON.stringify({ summary: 'The lab is built and awaits approval.', verification: plan }) + '\n```'
  store.saveResearchRun({ ...preparation, status: 'interrupted', phase: 'Original interruption', endedAt: new Date().toISOString(), fullReply: rawReply })
  const retryId = randomUUID()
  store.startResearchRun({ ...preparation, id: retryId })
  store.saveResearchRun({ ...preparation, id: retryId, status: 'interrupted', phase: 'Retry interrupted', endedAt: new Date().toISOString() })
  let inspections = 0, executions = 0
  const app = buildApp(store, 4317, { terminals: createAgentTerminals(workspace, store), verificationRunner: {
    async available(input) { inspections++; assert.equal(input?.image, plan.image); return { ready: true, detail: 'Fixture image inspector.', image: plan.image } },
    async run() { executions++; throw new Error('Recovery must never execute') },
  } })
  t.after(() => app.close())
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
  const route = `/api/panels/${panel.id}/lab-preparation`
  const page = (await app.inject({ url: `${route}?lead=${leadId}`, headers })).json()
  assert.equal(page.canStart, false)
  assert.equal(page.preparations[0].canRecover, true)
  assert.equal(page.preparations[0].harnessReady, true)
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.inject({ method: 'POST', url: `${route}/recover`, headers, payload: { runId: retryId } })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().status, 'pending')
  }
  assert.equal(store.listVerification(panel.id).records.length, 1)
  assert.equal(executions, 0)
  assert.equal(inspections, 2)
  const recovered = store.readResearchRun(panel.id, retryId)
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.phase, 'Retry interrupted')
  assert.equal(recovered.fullReply, undefined)
  assert.equal(store.readResearchRun(panel.id, id).fullReply, rawReply)
  assert.ok(recovered.verificationId)
  const checkpointOnly = { ...preparation, labPlan: undefined, fullReply: undefined }
  await writeFile(join(directory, 'kraflr-verification.json'), JSON.stringify(plan))
  assert.equal((await preparedLabPlan(checkpointOnly))?.image, plan.image)
  await writeFile(join(directory, 'kraflr-verification.json'), 'x'.repeat(16_001))
  assert.equal(await preparedLabPlan(checkpointOnly), undefined)
  assert.equal(await validLabDirectory(store.readSourceScope(panel.id, 1), randomUUID(), directory), false)
  store.saveScope(panel.id, 1, { ...scope, restrictions: 'Changed scope.' })
  assert.equal((await app.inject({ method: 'POST', url: `${route}/recover`, headers, payload: { runId: retryId } })).statusCode, 409)
})

test('Cline distinguishes the current free promotion from a similarly named catalog route and confirms native selection', async (t) => {
  const stdin = new PassThrough(), stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), { stdin, stdout, kill() { stdout.end(); stdin.end(); child.emit('close', 0); return true } })
  let current = 'nvidia/nemotron-3.5-super-vl:free'
  const selected: string[] = []
  let buffer = ''
  const send = (frame: object) => stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} } })
      else if (message.method === 'session/new') send({ id: message.id, result: { sessionId: 'fixture_promotion' } })
      else if (message.method === 'session/set_config_option') {
        if (message.params.configId === 'model') { current = message.params.value; selected.push(current) }
        send({ id: message.id, result: { configOptions: [
          { id: 'auto_approve', name: 'Approval', type: 'boolean', currentValue: false },
          { id: 'provider', name: 'Provider', type: 'select', currentValue: 'cline', options: [{ value: 'cline', name: 'Cline' }] },
          { id: 'model', name: 'Model', type: 'select', currentValue: current, options: [{ value: 'nvidia/nemotron-3.5-super-vl:free', name: 'Catalog route' }] },
        ] } })
      }
    }
  })
  const worker = await openClineWorker({ executable: 'fixture', cwd: process.cwd(), env: {}, signal: new AbortController().signal, onSaved() {},
    spawnProcess: (() => child) as unknown as typeof spawn,
    freeModels: async () => [{ id: 'cline-free/nemotron-3.5-super-vl', name: 'Current Cline free promotion' }],
  })
  t.after(() => worker.close())
  assert.equal(worker.modelSelectionRequired, true)
  assert.match(worker.models().notice ?? '', /free promotion/)
  await worker.selectModel('cline-free/nemotron-3.5-super-vl')
  assert.equal(worker.modelSelectionRequired, false)
  assert.equal(worker.models().current, 'cline-free/nemotron-3.5-super-vl')
  assert.deepEqual(selected, ['cline-free/nemotron-3.5-super-vl'])
})

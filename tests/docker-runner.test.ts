import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.ts'
import { openStore, StoreError } from '../server/db.ts'
import { dockerVerificationRunner, fixtureSource, fixtureVersion, readProjectObservation } from '../server/verification-runner.ts'
import type { AgentTerminals } from '../server/agent-terminals.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import type { ProjectVerificationPlan, VerificationRecord } from '../shared/verification.ts'
import { agentVerification, approvedDockerCommand } from '../cli/agent-verification.ts'

// These tests drive the real Docker engine. They skip, rather than fail, where Docker or the local base image is missing.
const base = 'node:26.13.1-alpine'
const repository = fixtureSource
const revision = fixtureVersion
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim()

async function prepare(): Promise<{ folder: string; id: string } | string> {
  try { if (!(await dockerVerificationRunner.available()).ready) return 'Docker is not ready' }
  catch { return 'Docker is not reachable' }
  try { docker('image', 'inspect', base) } catch { return `${base} is not a local image` }
  const folder = await mkdtemp(join(tmpdir(), 'kraflr-docker-runner-'))
  const result = (body: string) => `console.log('KRAFLR_VERIFICATION_RESULT ' + JSON.stringify(${body}))`
  await writeFile(join(folder, 'ok.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('/tmp/scratch', 'x'); writeFileSync(process.env.HOME + '/home-ok', 'x')\n${result("{ outcome: 'reproduced', controlPassed: true, summary: 'scratch space is writable', evidence: 'ok', environment: { fidelity: 'full', real: ['Node runtime in the container'], substituted: [] } }")}`)
  await writeFile(join(folder, 'crash.mjs'), `console.error('PHP-style fatal: boom'); process.exit(3)`)
  await writeFile(join(folder, 'badevidence.mjs'), result("{ outcome: 'reproduced', controlPassed: true, summary: 'bad evidence type', evidence: false }"))
  await writeFile(join(folder, 'noisy.mjs'), `console.log('x'.repeat(200000))\n${result("{ outcome: 'not_reproduced', controlPassed: true, summary: 'noisy but valid', evidence: 'tail' }")}`)
  await writeFile(join(folder, 'writeroot.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('/etc/kraflr', 'x')`)
  await writeFile(join(folder, 'hang.mjs'), 'setInterval(() => {}, 1000)')
  await writeFile(join(folder, 'Dockerfile'), `FROM ${base}\nWORKDIR /app\nCOPY *.mjs /app/\nUSER 1000:1000\n`)
  try {
    const id = docker('build', '-q', '--pull=false', '--label', `org.opencontainers.image.source=${repository}`, '--label', `org.opencontainers.image.revision=${revision}`, folder)
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('unexpected image id')
    return { folder, id }
  } catch (error) { await rm(folder, { recursive: true, force: true }); return `the test image could not be built: ${String((error as { stderr?: unknown }).stderr ?? error).slice(0, 300)}` }
}

const plan = (image: string, script: string, seconds = 20): ProjectVerificationPlan => ({
  kind: 'project', title: 'Docker runner test', image, command: ['/usr/local/bin/node', `/app/${script}`], action: 'Run a synthetic script', expected: 'A structured result',
  repository, targetVersion: revision,
  isolation: { network: 'none', user: '1000:1000', readOnly: true, dropCapabilities: 'ALL', noNewPrivileges: true },
  limits: { memoryMiB: 256, cpus: 1, processes: 64, seconds },
})
// The command an agent is handed is the whole verification path now, so these tests run exactly that command on the real engine.
const approved = (image: string, script: string) => ({ id: randomUUID(), plan: plan(image, script) }) as unknown as VerificationRecord
const runApproved = (record: VerificationRecord) => {
  const { argv } = approvedDockerCommand(record)
  return spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
}
const resultLine = (output: string) => JSON.parse(output.split(/\r?\n/).find((line) => line.startsWith('KRAFLR_VERIFICATION_RESULT '))!.slice('KRAFLR_VERIFICATION_RESULT '.length))

// One image is built lazily and shared by every test in this file, then removed once at the end.
let shared: ReturnType<typeof prepare> | undefined
const getLab = () => shared ??= prepare()
after(async () => {
  const built = await shared
  if (!built || typeof built === 'string') return
  try { docker('image', 'rm', '-f', built.id) } catch { /* Already removed. */ }
  await rm(built.folder, { recursive: true, force: true })
})

test('the approved docker command gives a harness scratch space, keeps the root read-only and leaves no container behind', async (t) => {
  const lab = await getLab()
  if (typeof lab === 'string') { t.skip(lab); return }

  const good = runApproved(approved(lab.id, 'ok.mjs'))
  assert.equal(good.status, 0, good.stderr)
  assert.deepEqual(resultLine(good.stdout), { outcome: 'reproduced', controlPassed: true, summary: 'scratch space is writable', evidence: 'ok', environment: { fidelity: 'full', real: ['Node runtime in the container'], substituted: [] } })
  const noisy = runApproved(approved(lab.id, 'noisy.mjs'))
  assert.equal(resultLine(noisy.stdout).outcome, 'not_reproduced', 'a harness may be noisy; only the result line matters')
  // The result line is exactly what the report route accepts, and a harness bug in its types is caught with a field-specific message.
  assert.deepEqual({ ...readProjectObservation(resultLine(good.stdout)) }, { kind: 'project', outcome: 'reproduced', controlPassed: true, summary: 'scratch space is writable', evidence: 'ok', environment: { fidelity: 'full', real: ['Node runtime in the container'], substituted: [] } })
  const bad = runApproved(approved(lab.id, 'badevidence.mjs'))
  assert.throws(() => readProjectObservation(resultLine(bad.stdout)), /evidence must be a string/)

  const crash = runApproved(approved(lab.id, 'crash.mjs'))
  assert.equal(crash.status, 3); assert.match(crash.stderr, /fatal: boom/)
  const readOnly = runApproved(approved(lab.id, 'writeroot.mjs'))
  assert.notEqual(readOnly.status, 0); assert.match(readOnly.stderr, /EROFS|read-only/i)

  assert.equal(docker('ps', '-a', '--filter', 'label=com.kraflr.agent-verification', '-q'), '', 'every run removes its container, including failed ones')
})

test('Kraflr’s own runner refuses a researched lead: only the approved agent runs it', async () => {
  await assert.rejects(dockerVerificationRunner.run(plan('sha256:' + 'a'.repeat(64), 'ok.mjs'), randomUUID(), new AbortController().signal, () => {}), (error: unknown) => {
    assert.ok(error instanceof StoreError); assert.match(error.message, /verified by an agent/); return true
  })
})

test('an agent runs the approved container on the real engine, reports it, and a crashing harness is reported as an error with its real exit code', async (t) => {
  const built = await getLab()
  if (typeof built === 'string') { t.skip(built); return }
  const store = openStore(':memory:'), listed: AgentTerminalInfo[] = []
  const terminals = { list: () => listed, async close() {}, async dashboardSessions() { return [] } } as unknown as AgentTerminals
  const app = buildApp(store, 4317, { terminals })
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await app.inject({ url: path, method: method as 'GET' | 'POST', headers, payload: body as object })
    if (response.statusCode >= 400) throw new StoreError(response.statusCode, response.json().message)
    return response.json()
  }
  try {
    const panel = await api('/api/verification/fixture', 'POST', {})
    const lead = store.listEvidence(panel.id, 0).leads[0]!
    const parent: AgentTerminalInfo = { id: randomUUID(), panelId: panel.id, parent: true, kind: 'claude', mode: 'terminal', label: 'Parent', state: 'running', scopeVersion: 1, chat: true, promptReady: true, startedAt: 'now', exitCode: null }
    listed.push(parent)
    const approve = async (script: string) => {
      const record = await api(`/api/panels/${panel.id}/verification/project`, 'POST', { id: randomUUID(), leadId: lead.id, scopeVersion: 1,
        plan: { title: script, image: built.id, command: ['/usr/local/bin/node', `/app/${script}`], action: 'Run a synthetic script', expected: 'A structured result' } }) as VerificationRecord
      return api(`/api/panels/${panel.id}/verification/${record.id}/decision`, 'POST', { planHash: record.planHash, choice: 'approve', executor: 'parent', note: 'Reviewed.' }) as Promise<VerificationRecord>
    }
    // What the agent does with the grant: ask for the exact command, run it in its own shell, and send what happened back.
    const execute = async (record: VerificationRecord) => {
      const command = await agentVerification(store, api, parent, 'docker', record.id) as { argv: string[] }
      return spawnSync(command.argv[0]!, command.argv.slice(1), { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
    }

    // A harness that crashes: the agent reports the real exit code and output, and the researcher sees Error faced.
    const crashing = await approve('crash.mjs')
    const crashed = await execute(crashing)
    assert.equal(crashed.status, 3)
    const failed = await agentVerification(store, api, parent, 'fail', crashing.id, JSON.stringify({ message: 'The harness exited with code 3.', output: crashed.stderr, exitCode: crashed.status })) as { record: VerificationRecord }
    assert.equal(failed.record.status, 'error'); assert.equal(failed.record.failure?.code, 'agent_reported'); assert.equal(failed.record.failure?.exitCode, 3); assert.match(failed.record.failure!.output!, /fatal: boom/)
    assert.equal(store.readEvidence(panel.id, lead.id).tag, 'lead'); assert.equal(store.readEvidence(panel.id, lead.id).verificationProgress?.label, 'Error faced')
    await api(`/api/panels/${panel.id}/verification/${crashing.id}/decision`, 'POST', { planHash: crashing.planHash, choice: 'cancel', note: '' })

    // A working harness: the same approval path ends with the agent's report marking a Finding.
    const working = await approve('ok.mjs')
    const ran = await execute(working)
    assert.equal(ran.status, 0, ran.stderr)
    const done = await agentVerification(store, api, parent, 'report', working.id, JSON.stringify({ image: built.id, ...resultLine(ran.stdout), exitCode: ran.status })) as { record: VerificationRecord }
    assert.equal(done.record.status, 'reproduced'); assert.equal(done.record.report?.via, 'agent-docker'); assert.equal(done.record.finding?.acceptance, 'conditional')
    assert.equal(store.readEvidence(panel.id, lead.id).tag, 'finding')
    assert.equal(docker('ps', '-a', '--filter', 'label=com.kraflr.agent-verification', '-q'), '', 'no container is left behind')
  } finally { await app.close() }
})

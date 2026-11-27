import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { openStore } from '../server/db.ts'
import { createResearchTeam } from '../server/research-team.ts'
import { labGuard } from '../server/lab-guard.ts'
import { approvedDockerCommand } from '../cli/agent-verification.ts'
import { confirmLead, recordLead } from '../cli/agent-lead.ts'
import { assignedWork } from '../cli/activity.ts'
import { NativePrompt } from '../cli/native-prompt.ts'
import { ApprovalInput } from '../cli/approval-input.ts'
import { buildReport } from '../server/report.ts'
import { emptyScope } from '../shared/research.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import type { VerificationRecord } from '../shared/verification.ts'

const image = 'sha256:' + 'ab12'.repeat(16)
function setup(workspace = '') {
  const store = openStore(':memory:'), panel = store.createPanel({ name: 'Flow', type: 'source' })
  store.saveScope(panel.id, 0, { ...emptyScope, targetName: 'Synthetic', repository: 'https://example.test/synthetic', revision: 'a'.repeat(40), accessMode: 'read_only', workspacePath: workspace })
  const parent: AgentTerminalInfo = { id: randomUUID(), panelId: panel.id, kind: 'claude', mode: 'terminal', label: 'Parent', state: 'running', chat: true, parent: true, promptReady: true, startedAt: 'now', scopeVersion: 1, exitCode: null }
  const child: AgentTerminalInfo = { ...parent, id: randomUUID(), kind: 'cline', label: 'Child', parent: false }
  const lead = (title = 'Unparameterised search query', lines = '10-12') => recordLead(store, parent, { title, path: 'app/db.py', lines, why: 'The query is built with an f-string.', hypothesis: 'The search term reaches SQL unescaped.', attack: 'Anyone who can call the search route.', impact: 'Rows of other users can be read.' })
  return { store, panel, parent, child, lead }
}

test('a lab preparation never assigns a Child a task the Parent did not ask for', async () => {
  const { store, panel, parent, child, lead } = setup()
  const id = lead().id!, calls: string[] = []
  const team = createResearchTeam(store, { list: () => [parent, child], async researchTurn(_panel, agent) { calls.push(agent); return '```kraflr-result\n' + JSON.stringify({ summary: 'Lab notes.', leads: [], deadEnds: [], nextSteps: [] }) + '\n```' } })
  try {
    const run = team.start(panel.id, 'Prepare the lab.', randomUUID(), id, { labDirectory: join(tmpdir(), 'lab-' + randomUUID()) })
    for (let i = 0; i < 100 && store.readResearchRun(panel.id, run.id).status === 'running'; i++) await new Promise((done) => setTimeout(done, 10))
    assert.deepEqual(calls, [parent.id])
    assert.equal(store.readResearchRun(panel.id, run.id).tasks.length, 0)
  } finally { await team.close(); store.close() }
})

test('a submitted lab starts only through the approved command of the agent holding the grant', async () => {
  const { store, panel, parent, child, lead } = setup()
  const leadId = lead().id!
  const record: VerificationRecord = { id: randomUUID(), panelId: panel.id, leadId, scopeVersion: 1, status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), planHash: 'c'.repeat(64),
    plan: { kind: 'project', title: 'Check', image, command: ['/usr/local/bin/python', '/app/run-test.py'], action: 'Run', expected: 'Result', repository: 'https://example.test/synthetic', targetVersion: 'a'.repeat(40), isolation: { network: 'none', user: '1000:1000', readOnly: true, dropCapabilities: 'ALL', noNewPrivileges: true }, limits: { memoryMiB: 256, cpus: 1, processes: 64, seconds: 60 } } }
  try {
    store.addVerification(record)
    const check = (agent: AgentTerminalInfo, command: string, tags: Record<string, string> = {}) => labGuard(store, agent, command, '', (item) => approvedDockerCommand(item).argv, async (name) => tags[name])
    // The failure seen in testing: the agent ran the submitted image with its own flags after a chat message.
    for (const command of [`docker run --rm --network none ${image}`, `cd /tmp && docker run --rm ${image.slice(7, 19)} python /app/run-test.py`, `podman create ${image}`, `docker -H unix:///run/docker.sock container run ${image}`]) {
      assert.match(await check(parent, command) ?? '', /Kraflr blocked this command/, command)
    }
    assert.match(await check(parent, 'docker run --rm my-lab:latest', { 'my-lab:latest': image }) ?? '', /blocked/, 'a tag does not hide the locked image')
    // Building, inspecting and running unrelated containers stay free.
    for (const command of ['docker build -t my-lab .', `docker image inspect ${image}`, 'docker ps -a', 'docker run --rm alpine:3 true', 'docker network create lab-net', 'ls -la']) assert.equal(await check(parent, command), undefined, command)
    // A Docker command that is only mentioned is not being run.
    for (const command of [`kraflr agent verification fail ${record.id} --message "docker run ${image} exited 1; retried docker run ${image}"`, `grep -n "docker run ${image}" notes.md`, `echo 'docker run --rm ${image}'`,
      `cat > result.json <<'EOF'\n{"command":"docker run --rm ${image}"}\ndocker run --rm ${image}\nEOF\nls`]) assert.equal(await check(parent, command), undefined, command)
    // Wrapped or handed to another shell, it still is.
    for (const command of [`sudo -E docker run --rm ${image}`, `timeout 60 docker run --rm ${image}`, `bash -lc "docker run --rm ${image}"`, `OUT=$(docker run --rm ${image})`, `cat <<EOF > a.txt\nnote\nEOF\ndocker run --rm ${image}`, `docker run \\\n  --rm ${image}`]) {
      assert.match(await check(parent, command) ?? '', /blocked/, command)
    }

    store.resolveVerification(panel.id, record.id, record.planHash, 'approve', 'Reviewed.', true, { executor: 'parent', lease: { agentId: parent.id, agentLabel: 'Parent', expiresAt: new Date(Date.now() + 60_000).toISOString() } })
    const approved = approvedDockerCommand(store.readTest(panel.id, record.id))
    assert.equal(await check(parent, approved.posix), undefined, 'the exact command runs')
    assert.equal(await check(parent, approved.powershell), undefined, 'in PowerShell form too')
    assert.equal(await check(parent, `MSYS_NO_PATHCONV=1 ${approved.posix} > result.txt 2>&1; echo $?`), undefined)
    assert.match(await check(child, approved.posix) ?? '', /blocked/, 'only the holder of the grant')
    assert.match(await check(parent, approved.posix.replace('--network', '--privileged --network')) ?? '', /blocked/, 'changed flags')
    assert.match(await check(parent, approved.posix + ' --extra') ?? '', /blocked/, 'added arguments')
    assert.match(await check(parent, `${approved.posix} && docker run --rm ${image}`) ?? '', /blocked/, 'a second start chained after it')
  } finally { store.close() }
})

test('the saved lab checkpoint locks the image, its folder mounts and its compose file before any test is queued', async (t) => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-guard-'))), { store, panel, parent, lead } = setup(workspace)
  t.after(async () => { store.close(); await rm(workspace, { recursive: true, force: true }) })
  const leadId = lead().id!, folder = 'lab-' + randomUUID(), directory = join(workspace, folder)
  await mkdir(directory)
  store.startResearchRun({ id: randomUUID(), panelId: panel.id, parentId: parent.id, parentName: 'Parent', scopeVersion: 1, purpose: 'verification', leadId, labDirectory: directory, objective: 'Prepare', status: 'running', phase: 'Preparing', startedAt: new Date().toISOString(), endedAt: null, summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [] })
  const check = (command: string, cwd = '') => labGuard(store, parent, command, cwd, () => [], async () => undefined)
  assert.equal(await check(`docker run --rm ${image}`), undefined, 'nothing is locked while the lab is still being built')
  await writeFile(join(directory, 'kraflr-verification.json'), JSON.stringify({ title: 'Check', image, command: ['/usr/local/bin/python', '/app/run-test.py'], action: 'Run', expected: 'Result' }))
  assert.match(await check(`docker run --rm ${image}`) ?? '', /blocked/)
  assert.match(await check(`docker run --rm -v /w/${folder}:/lab python:3 python /lab/run-test.py`) ?? '', /blocked/)
  assert.match(await check(`cd ${folder} && docker compose up`) ?? '', /blocked/)
  assert.match(await check('docker compose up -d', directory) ?? '', /blocked/)
})

test('an agent moves a lead to Findings only with proof and a control, and never over the researcher', () => {
  const { store, panel, parent, lead } = setup()
  const id = lead().id!
  const proof = 'GET /search?q=x%27+UNION+SELECT+password+FROM+users-- returned HTTP 200 with the other user’s password hash in the body.'
  const control = 'The same route with q=x returned HTTP 200 and an empty list.'
  try {
    assert.throws(() => confirmLead(store, parent, { id, proof: 'It looks vulnerable.', control }), /Reading code is not proof/)
    assert.throws(() => confirmLead(store, parent, { id, proof, control: '' }), /control/)
    assert.equal(store.readEvidence(panel.id, id).tag, 'lead')
    assert.equal(confirmLead(store, parent, { id, proof, control }).confirmed, true)
    const saved = store.readEvidence(panel.id, id)
    assert.equal(saved.tag, 'finding'); assert.equal(saved.verificationProgress?.label, 'Confirmed by agent'); assert.match(saved.reviews[0]!.note, /^Confirmed by Parent .*did not check it independently/)
    assert.match(buildReport(store, panel.id), /Agent-confirmed[\s\S]*not independently checked/)
    // The researcher moves it back; the agent cannot promote it again.
    store.saveLeadReview(panel.id, id, { expectedVersion: saved.reviews[0]!.version, status: 'open', tag: 'lead', note: 'The proof used test data only.', nextAction: '' })
    assert.throws(() => confirmLead(store, parent, { id, proof, control }), /Only the researcher/)
    const disputed = lead('Missing ownership check on export', '40-44').id!
    assert.notEqual(disputed, id)
    store.saveLeadReview(panel.id, disputed, { expectedVersion: 0, status: 'open', note: 'Challenge by Child: does not hold. The input is escaped.', nextAction: '' })
    assert.throws(() => confirmLead(store, parent, { id: disputed, proof, control }), /did not confirm/)
  } finally { store.close() }
})

test('a Docker verification in flight cannot be bypassed by confirming the lead', () => {
  const { store, panel, parent, lead } = setup()
  const id = lead().id!
  try {
    store.startResearchRun({ id: randomUUID(), panelId: panel.id, parentId: parent.id, parentName: 'Parent', scopeVersion: 1, purpose: 'verification', leadId: id, objective: 'Prepare', status: 'running', phase: 'Preparing', startedAt: new Date().toISOString(), endedAt: null, summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [] })
    assert.throws(() => confirmLead(store, parent, { id, proof: 'x'.repeat(100), control: 'y'.repeat(40) }), /verification of this lead is in progress/)
  } finally { store.close() }
})

test('a pane at rest stops reading as working even when no completion hook arrives', async () => {
  const write = (prompt: NativePrompt, text: string) => new Promise<void>((done) => prompt.output('\x1b[2J\x1b[H' + text, done))
  const cline = new NativePrompt(80, 24, 'cline'), idle = '› Ask anything...\r\n○ Plan ● Act (Tab)'
  await write(cline, 'Thinking... (esc to cancel)\r\n' + idle); cline.hook('UserPromptSubmit')
  assert.equal(cline.interrupted(Date.now() + 60_000), false, 'the spinner line means it is working, though its composer is empty')
  assert.equal(cline.status(false).reason, 'Working')
  await write(cline, idle)
  assert.equal(cline.interrupted(Date.now() + 5_000), false, 'a short pause is not rest')
  assert.equal(cline.interrupted(Date.now() + 20_000), true)
  cline.settle(); assert.deepEqual(cline.status(false), { ready: true, reason: '' })
  cline.dispose()
  // Waiting on a Child, or on a message not yet delivered, is not work.
  const task = { sessionId: 'child', status: 'assigned' }
  assert.equal(assignedWork('parent', [{ status: 'running', purpose: 'verification', parentId: 'parent', tasks: [task] }]), false)
  assert.equal(assignedWork('child', [{ status: 'running', purpose: 'verification', parentId: 'parent', tasks: [task] }]), true)
  assert.equal(assignedWork('child', [{ status: 'running', purpose: 'collaboration', parentId: 'child', tasks: [task] }]), false)
})

test('asking in chat to run the lab only opens the plan review', () => {
  for (const phrase of ['run the docker and confirm the vuln', 'please run the lab', 'execute the test']) { const input = new ApprovalInput(); input.input(phrase); assert.equal(input.input('\r'), true, phrase) }
  for (const phrase of ['did you run the docker?', 'why did you run the lab outside kraflr flow ?', 'do not run the docker']) { const input = new ApprovalInput(); input.input(phrase); assert.equal(input.input('\r'), false, phrase) }
})

test('both agent hooks refuse what the runtime refuses and stay silent otherwise', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-guard-hook-')))
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\kraflr-test-${randomUUID()}` : join(folder, 'runtime.sock')
  const asked: string[] = []
  const server = createServer((connection) => {
    connection.setEncoding('utf8')
    let buffer = ''
    connection.on('data', (chunk: string) => { buffer += chunk; for (let end; (end = buffer.indexOf('\n')) >= 0;) { const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); asked.push(message.params.command); connection.write(JSON.stringify({ id: message.id, result: message.params.command.includes('locked') ? { reason: 'Kraflr blocked this command.' } : {} }) + '\n') } })
    connection.on('error', () => {})
  })
  await new Promise<void>((done) => server.listen(socket, done))
  const run = (script: string, event: object) => new Promise<string>((done) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'cli', script)], { env: { ...process.env, KRAFLR_SOCKET: socket, KRAFLR_AGENT_ID: 'a', KRAFLR_AGENT_TOKEN: 't' }, stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk }); child.on('close', () => done(stdout.trim())); child.stdin.end(JSON.stringify(event))
  })
  try {
    const claude = (command: string) => run('claude-hook.ts', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
    assert.equal(JSON.parse(await claude('docker run locked')).hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(await claude('docker ps'), '{}'); assert.equal(await claude('ls'), '{}')
    const cline = (parameters: object) => run('hook.ts', { hookName: 'PreToolUse', preToolUse: { toolName: 'run_commands', parameters } })
    assert.equal(JSON.parse(await cline({ commands: JSON.stringify(['docker run locked']) })).cancel, true)
    assert.equal(await cline({ commands: ['docker ps'] }), '{}')
    assert.deepEqual(asked.filter((command) => command === 'ls'), [], 'only container commands are sent')
  } finally { server.close(); await rm(folder, { recursive: true, force: true }) }
})

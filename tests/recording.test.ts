import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { openStore } from '../server/db.ts'
import { confirmLead, killLead, recordLead } from '../cli/agent-lead.ts'
import { createRecordingReminders, holdAfter, isProbe, remindEvery } from '../cli/recording.ts'
import { claudeSettings } from '../cli/claude-settings.ts'
import { buildReport } from '../server/report.ts'
import { emptyScope } from '../shared/research.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'

function setup() {
  const store = openStore(':memory:'), panel = store.createPanel({ name: 'Recording', type: 'web' })
  store.saveScope(panel.id, 0, { ...emptyScope, targetName: 'Synthetic', webTargets: 'https://app.example.test', notes: 'Synthetic lab.', accessMode: 'read_only' })
  const agent: AgentTerminalInfo = { id: randomUUID(), panelId: panel.id, kind: 'claude', mode: 'terminal', label: 'Parent', state: 'running', chat: true, parent: true, promptReady: true, startedAt: 'now', scopeVersion: 1, exitCode: null }
  const lead = (title = 'Export ignores the owner', path = 'GET /api/export') => recordLead(store, agent, { title, path, why: 'The ID is taken from the query.', hypothesis: 'The export is not checked against the owner.', attack: 'Any signed-in user changes the ID.', impact: 'Other users’ exports can be read.' }).id!
  return { store, panel, agent, lead }
}
const tested = 'Requested /api/export?id=2 as user A and received HTTP 403 with an empty body.'
const reason = 'The server checks ownership before it reads the export.'

test('an agent kills a lead it tested, with its note labelled and the lead listed under Killed leads', () => {
  const { store, panel, agent, lead } = setup()
  try {
    const id = lead()
    assert.throws(() => killLead(store, agent, { id, tested: 'Did not work.', reason }), /what you actually tried/)
    assert.throws(() => killLead(store, agent, { id, tested, reason: 'no' }), /rules the flaw out/)
    assert.equal(store.readEvidence(panel.id, id).tag, 'lead')
    assert.equal(killLead(store, agent, { id, tested, reason }).killed, true)
    const saved = store.readEvidence(panel.id, id)
    assert.equal(saved.tag, 'killed_lead'); assert.equal(saved.status, 'closed')
    assert.match(saved.reviews[0]!.note, /^Killed by Parent .*did not check it independently[\s\S]*Tested: [\s\S]*Reason: /)
    assert.match(buildReport(store, panel.id), /Ruled out \(1\)[\s\S]*Killed by Parent/)
    assert.equal(killLead(store, agent, { id, tested, reason }).killed, true, 'killing it again changes nothing')
    assert.equal(store.readEvidence(panel.id, id).reviews.length, 1)
    assert.throws(() => confirmLead(store, agent, { id, proof: 'x'.repeat(100), control: 'y'.repeat(40) }), /Only an open lead/)
  } finally { store.close() }
})

test('a dead end that was never a lead is saved straight into Killed leads', () => {
  const { store, panel, agent } = setup()
  try {
    assert.throws(() => killLead(store, agent, { tested, reason }), /--title and --path/)
    const result = killLead(store, agent, { title: 'Debug route', path: 'GET /debug', tested, reason })
    assert.equal(store.readEvidence(panel.id, result.id!).tag, 'killed_lead')
    assert.equal(store.listEvidence(panel.id, 0, 'lead').counts.killed_lead, 1)
  } finally { store.close() }
})

test('an agent cannot kill a Finding, overrule the researcher or dismiss an upheld lead', () => {
  const { store, panel, agent, lead } = setup()
  try {
    const finding = lead()
    confirmLead(store, agent, { id: finding, proof: 'x'.repeat(100), control: 'y'.repeat(40) })
    assert.throws(() => killLead(store, agent, { id: finding, tested, reason }), /This is a Finding/)
    const reopened = lead('Reset token is reusable', 'POST /api/reset')
    killLead(store, agent, { id: reopened, tested, reason })
    store.saveLeadReview(panel.id, reopened, { expectedVersion: 1, status: 'open', tag: 'lead', note: 'Test it as a second user.', nextAction: '' })
    assert.throws(() => killLead(store, agent, { id: reopened, tested, reason }), /Only the researcher/)
    const upheld = lead('Share link has no expiry', 'GET /s/token')
    store.saveLeadReview(panel.id, upheld, { expectedVersion: 0, status: 'open', note: 'Verify by Child: confirmed. The link still works.', nextAction: '' })
    assert.throws(() => killLead(store, agent, { id: upheld, tested, reason }), /upheld/)
    const doubted = lead('Verbose errors', 'GET /api/error')
    store.saveLeadReview(panel.id, doubted, { expectedVersion: 0, status: 'open', note: 'Challenge by Child: does not hold. The message is static.', nextAction: '' })
    assert.equal(killLead(store, agent, { id: doubted, tested, reason }).killed, true)
  } finally { store.close() }
})

test('Kraflr’s own commands are not probes, and file reads count only for source review', () => {
  assert.equal(isProbe('web', 'Bash', 'curl -s https://app.example.test/'), true)
  assert.equal(isProbe('web', 'Bash', 'kraflr agent lead --title x'), false)
  assert.equal(isProbe('web', 'Bash', '"/usr/bin/node" "/opt/k/bin/kraflr.mjs" agent context'), false)
  assert.equal(isProbe('web', 'mcp__kraflr__burp_send_http1_request', 'app.example.test GET /'), true)
  assert.equal(isProbe('web', 'mcp__kraflr__burp_status', 'x'), false)
  assert.equal(isProbe('web', 'Read', '/tmp/a'), false); assert.equal(isProbe('source', 'Read', '/src/a.php'), true)
  const matcher = new RegExp((claudeSettings('node', 'hook.ts').hooks.PostToolUse as { matcher: string }[])[0]!.matcher)
  for (const tool of ['Bash', 'WebFetch', 'mcp__kraflr__burp_send_http2_request']) assert.match(tool, matcher)
  for (const tool of ['TodoWrite', 'BashOutput', 'mcp__other__send']) assert.doesNotMatch(tool, matcher)
})

test('reminders come with a prompt, after a run of unrecorded probes and once before such a turn ends', async () => {
  const { store, agent, lead } = setup()
  try {
    const id = lead(), reminders = createRecordingReminders(store, true), delivered: any[] = []
    const send = (params: { name: string; text?: string; continuing?: boolean }, assigned = false) => reminders.hook(agent, params, assigned, async (event) => { delivered.push(event); return {} }) as Promise<{ context?: string; hold?: string }>
    const probe = () => reminders.tool(agent, 'web', 'Bash', 'curl -s https://app.example.test/')

    const prompt = await send({ name: 'UserPromptSubmit' })
    assert.match(prompt.context!, /1 open lead\(s\)/); assert.ok(prompt.context!.includes(id)); assert.match(prompt.context!, /kraflr agent kill/)

    for (let i = 1; i < remindEvery; i++) assert.equal(probe(), undefined)
    assert.match(probe()!, new RegExp(`${remindEvery} tool calls`))
    reminders.recorded(agent.id)
    for (let i = 1; i < holdAfter; i++) probe()
    delivered.length = 0
    assert.deepEqual(await send({ name: 'TaskComplete', text: 'Short turn.' }), {}, 'a few probes do not hold a turn')

    probe()
    const held = await send({ name: 'TaskComplete', text: 'The export is protected.' })
    assert.match(held.hold!, /nothing recorded/); assert.equal(delivered.length, 1, 'a held turn is not reported to the runtime yet')
    await send({ name: 'TaskComplete', text: 'Saved one killed lead.', continuing: true })
    assert.equal(delivered.at(-1).text, 'The export is protected.\n\nSaved one killed lead.', 'the original answer is kept')

    for (let i = 0; i < holdAfter; i++) probe()
    assert.deepEqual(await send({ name: 'TaskComplete', text: 'Report.' }, true), {}, 'a report Kraflr is waiting for is never held')
    assert.deepEqual(await send({ name: 'TaskComplete', text: 'Again.', continuing: true }), {})
    reminders.recorded(agent.id)
    assert.deepEqual(await send({ name: 'TaskComplete', text: 'Done.' }), {})
  } finally { store.close() }
})

test('reminders stay silent when switched off and for agents other than Claude Code', async () => {
  const { store, agent } = setup()
  try {
    for (const [reminders, who] of [[createRecordingReminders(store, false), agent], [createRecordingReminders(store, true), { ...agent, kind: 'cline' as const }]] as const) {
      for (let i = 0; i < remindEvery * 2; i++) assert.equal(reminders.tool(who, 'web', 'Bash', 'curl x'), undefined)
      for (const name of ['UserPromptSubmit', 'TaskComplete']) assert.deepEqual(await reminders.hook(who, { name, text: 'ok' }, false, async () => ({})), {})
    }
  } finally { store.close() }
})

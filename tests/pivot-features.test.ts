import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, realpath, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../server/db.ts'
import { createSurfaceMap } from '../server/surface-map.ts'
import { buildReport } from '../server/report.ts'
import { exportReport } from '../server/research-team.ts'
import { recordLead } from '../cli/agent-lead.ts'
import { createLeadActions } from '../cli/lead-actions.ts'
import { createDelivery } from '../cli/delivery.ts'
import { emptyScope } from '../shared/research.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'

const agent = (panelId: string, parent: boolean, over: Partial<AgentTerminalInfo> = {}): AgentTerminalInfo => ({ id: randomUUID(), panelId, kind: 'claude', mode: 'terminal', label: parent ? 'Parent' : 'Child', parent, state: 'running', chat: true, promptReady: true, scopeVersion: 1, startedAt: 'now', exitCode: null, ...over })
const lead = { title: 'SSRF in the importer', path: 'POST /api/import', why: 'The url field is fetched server-side; the metadata page came back.', hypothesis: 'The importer fetches any URL the caller supplies.', attack: 'A logged-in user posts an internal URL to /api/import.', impact: 'Internal services and cloud metadata become reachable.' }

async function setup(workspace?: string) {
  const store = openStore(':memory:'), panel = store.createPanel({ name: 'Demo shop', type: 'web' })
  store.saveScope(panel.id, 0, { ...emptyScope, targetName: 'Demo', webTargets: '127.0.0.1:8080', notes: 'Local lab only.', repositoryMode: 'known', ...(workspace ? { workspacePath: workspace } : {}) })
  const parent = agent(panel.id, true), child = agent(panel.id, false)
  store.saveAgentSession({ id: parent.id, panelId: panel.id, kind: 'claude', mode: 'terminal', label: 'Parent', startedAt: 'now', scopeVersion: 1, nativeId: 'pty:', role: 'parent' })
  recordLead(store, parent, lead)
  const id = store.listEvidence(panel.id, 0, 'lead').leads[0]!.id
  return { store, panel, parent, child, id }
}

test('the attack-surface map is saved per panel, replaced or extended, bounded, and refuses a bad panel id', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-map-'))), panelId = '33333333-3333-4333-8333-333333333333'
  try {
    const map = createSurfaceMap(folder)
    assert.equal(map.get(panelId), undefined)
    assert.equal(map.set(panelId, 'Entry points: /login, /api/import').saved, true)
    assert.equal(map.get(panelId)?.text.trim(), 'Entry points: /login, /api/import'); assert.match(map.get(panelId)!.updatedAt, /^\d{4}-/)
    map.set(panelId, 'Auth: session cookie', true)
    assert.match(map.get(panelId)!.text, /Entry points[\s\S]*Auth: session cookie/)
    map.set(panelId, 'Replaced')
    assert.equal(map.get(panelId)?.text.trim(), 'Replaced')
    assert.throws(() => map.set(panelId, 'x'.repeat(41_000)), /limited to 40000/)
    assert.throws(() => map.get('../../etc/passwd'), /Invalid panel/)
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('a challenge defaults to a Child, can be asked of the Parent instead when no Child is running, and its verdict is attached without changing the lead\'s tag', async () => {
  const { store, panel, parent, child, id } = await setup()
  const sent: { to: string; text: string; onReply?: (reply: string) => void }[] = []
  const terminals = { list: () => [parent, child] }
  const actions = createLeadActions(store, terminals, (request) => { sent.push(request) })
  const result = actions.challenge(panel.id, id)
  assert.equal(result.agent, 'Child'); assert.equal(sent.length, 1); assert.equal(sent[0]!.to, child.id)
  assert.match(sent[0]!.text, /try to DISPROVE/); assert.match(sent[0]!.text, /about 5 minutes/); assert.match(sent[0]!.text, /VERDICT: holds/); assert.match(sent[0]!.text, /SSRF in the importer/); assert.match(sent[0]!.text, /Hypothesis: The importer fetches any URL/)
  sent[0]!.onReply!('I replayed it with a control URL.\nVERDICT: holds\nThe internal URL was fetched; an external one was too.')
  const after = store.readEvidence(panel.id, id)
  assert.equal(after.tag, 'lead'); assert.equal(after.status, 'open'); assert.equal(after.reviews.length, 1)
  assert.match(after.reviews[0]!.note, /^Challenge by Child: holds\./); assert.match(after.reviews[0]!.note, /control URL/)
  // Without a Child there is nobody to challenge with by default, but the Parent can be asked explicitly instead.
  assert.throws(() => createLeadActions(store, { list: () => [parent] }, () => {}).challenge(panel.id, id), /Start a Child session first/)
  assert.throws(() => createLeadActions(store, { list: () => [parent, { ...child, stoppage: { kind: 'limit', reason: 'limit', at: 'now' } }] }, () => {}).challenge(panel.id, id), /Start a Child session first/)
  const parentOnly = createLeadActions(store, { list: () => [parent] }, (request) => { sent.push(request) })
  const parentResult = parentOnly.challenge(panel.id, id, 'parent')
  assert.equal(parentResult.agent, 'Parent'); assert.equal(sent.length, 2); assert.equal(sent[1]!.to, parent.id)
  assert.throws(() => createLeadActions(store, { list: () => [child] }, () => {}).challenge(panel.id, id, 'parent'), /Parent is not running/)
  store.saveLeadReview(panel.id, id, { expectedVersion: 1, status: 'closed', note: 'Not exploitable', nextAction: '' })
  assert.throws(() => actions.challenge(panel.id, id), /already ruled out/)
  sent[0]!.onReply!('VERDICT: holds'); assert.equal(store.readEvidence(panel.id, id).reviews.length, 2, 'a verdict never reopens or edits a ruled-out lead')
  store.close()
})

test('verify is web-only, defaults to the Parent, is recorded distinctly from a challenge, and never touches the lead\'s tag', async () => {
  const { store, panel, parent, child, id } = await setup()
  const sent: { to: string; text: string; onReply?: (reply: string) => void }[] = []
  const actions = createLeadActions(store, { list: () => [parent, child] }, (request) => { sent.push(request) })
  const result = actions.verify(panel.id, id)
  assert.equal(result.agent, 'Parent'); assert.equal(sent.length, 1); assert.equal(sent[0]!.to, parent.id)
  assert.match(sent[0]!.text, /VERIFY this lead/); assert.match(sent[0]!.text, /Be neutral/); assert.match(sent[0]!.text, /VERDICT: confirmed/); assert.match(sent[0]!.text, /SSRF in the importer/)
  sent[0]!.onReply!('I sent the import request with the internal URL and it fetched it.\nVERDICT: confirmed\nResponse body included the metadata contents.')
  const after = store.readEvidence(panel.id, id)
  assert.equal(after.tag, 'lead'); assert.equal(after.status, 'open'); assert.equal(after.reviews.length, 1)
  assert.match(after.reviews[0]!.note, /^Verify by Parent: confirmed\./); assert.match(after.reviews[0]!.note, /metadata contents/)
  // Asking a Child instead is still available, and verify is refused outright on a source-review panel, which already has Docker verification.
  const childResult = createLeadActions(store, { list: () => [parent, child] }, (request) => { sent.push(request) }).verify(panel.id, id, 'child')
  assert.equal(childResult.agent, 'Child'); assert.equal(sent[1]!.to, child.id)
  const code = store.createPanel({ name: 'Code', type: 'source' })
  store.saveScope(code.id, 0, { ...emptyScope, repository: 'https://github.com/example/export-tools', revision: 'HEAD', workspacePath: '/tmp/ws', accessMode: 'read_only' })
  const codeLeadId = (recordLead(store, agent(code.id, true), lead), store.listEvidence(code.id, 0, 'lead').leads[0]!.id)
  assert.throws(() => createLeadActions(store, { list: () => [agent(code.id, true)] }, () => {}).verify(code.id, codeLeadId), /Use Verify in Docker/)
  store.close()
})

test('variants are hunted only from an accepted Finding, by a Child or the Parent as chosen', async () => {
  const { store, panel, parent, child, id } = await setup()
  const sent: { to: string; text: string }[] = []
  const actions = createLeadActions(store, { list: () => [parent, child] }, (request) => { sent.push(request) })
  assert.throws(() => actions.variants(panel.id, id, 'child'), /accepted Finding/)
  store.saveLeadReview(panel.id, id, { expectedVersion: 0, status: 'open', tag: 'finding', note: 'Reproduced: the response contained the metadata page.', nextAction: '' })
  assert.equal(actions.variants(panel.id, id, 'child').agent, 'Child'); assert.equal(sent[0]!.to, child.id)
  assert.match(sent[0]!.text, /Hunt the same flaw pattern/); assert.match(sent[0]!.text, /kraflr agent lead/); assert.match(sent[0]!.text, /Reproduced: the response contained the metadata page/)
  assert.equal(actions.variants(panel.id, id, 'parent').agent, 'Parent'); assert.equal(sent[1]!.to, parent.id)
  store.close()
})

test('a PoC is written only for an accepted Finding, defaults to the Parent, and is attached to the lead as a fenced block without touching its tag', async () => {
  const { store, panel, parent, child, id } = await setup()
  const sent: { to: string; text: string; onReply?: (reply: string) => void }[] = []
  const actions = createLeadActions(store, { list: () => [parent, child] }, (request) => { sent.push(request) })
  assert.throws(() => actions.generatePoc(panel.id, id), /accepted Finding/)
  store.saveLeadReview(panel.id, id, { expectedVersion: 0, status: 'open', tag: 'finding', note: 'Reproduced: the response contained the metadata page.', nextAction: '' })
  const result = actions.generatePoc(panel.id, id)
  assert.equal(result.agent, 'Parent'); assert.equal(sent[0]!.to, parent.id)
  assert.match(sent[0]!.text, /self-contained proof of concept/); assert.match(sent[0]!.text, /single fenced code block/); assert.match(sent[0]!.text, /SSRF in the importer/)
  sent[0]!.onReply!('Here it is:\n```bash\ncurl -s -X POST http://127.0.0.1:8080/api/import -d \'url=http://169.254.169.254/latest/meta-data\'\n```\nThat fetches the metadata endpoint.')
  const after = store.readEvidence(panel.id, id)
  assert.equal(after.tag, 'finding'); assert.equal(after.reviews.length, 2)
  assert.match(after.reviews[0]!.note, /^PoC by Parent:\ncurl -s -X POST http:\/\/127\.0\.0\.1:8080\/api\/import/)
  assert.doesNotMatch(after.reviews[0]!.note, /```/, 'the fences themselves are stripped, leaving just the copy-pasteable command')
  // A Child can be asked explicitly, and a PoC never reopens or edits a ruled-out lead.
  assert.equal(actions.generatePoc(panel.id, id, 'child').agent, 'Child'); assert.equal(sent[1]!.to, child.id)
  store.saveLeadReview(panel.id, id, { expectedVersion: 2, status: 'closed', note: 'Withdrawn', nextAction: '' })
  sent[1]!.onReply!('```\ncurl again\n```')
  assert.equal(store.readEvidence(panel.id, id).reviews.length, 3, 'a PoC reply after the Finding was closed is not attached')
  store.close()
})

test('a delivery to a Child does not wait for the Parent’s own run, so a challenge runs in parallel', async () => {
  const { store, panel, parent, child } = await setup()
  const calls: string[] = []
  const delivery = createDelivery(store, { list: () => [parent, child], async researchTurn(_panel, id) { calls.push(id); return 'VERDICT: unclear' } })
  const run = { id: randomUUID(), panelId: panel.id, parentId: parent.id, parentName: 'Parent', scopeVersion: 1, objective: 'Investigate', status: 'running' as const, phase: 'Parent is investigating', startedAt: new Date().toISOString(), endedAt: null, summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [] }
  store.startResearchRun(run)
  const base = { panelId: panel.id, scopeVersion: 1, from: 'Researcher', objective: 'o', task: 't', waiting: 'w', done: 'd', failed: 'f', doneResult: 'r', text: 'hello' }
  delivery.send({ ...base, to: child.id, key: 'to-child' })
  for (let i = 0; i < 40 && !calls.length; i++) await new Promise((done) => setTimeout(done, 25))
  assert.deepEqual(calls, [child.id], 'the Child was reached while the Parent’s run was still active')
  delivery.send({ ...base, to: parent.id, key: 'to-parent' })
  await new Promise((done) => setTimeout(done, 400))
  assert.deepEqual(calls, [child.id], 'the Parent, busy in its own run, is still waited for')
  await delivery.close(); store.close()
})

test('the report lists scope, accepted Findings with the researcher’s note, what was ruled out and what is open, and is written to the workspace', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-report-'))), workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const { store, panel, parent, id } = await setup(workspace)
    recordLead(store, parent, { ...lead, title: 'Verbose error leaks a path', path: 'GET /debug', why: 'The stack trace names a server path.' })
    recordLead(store, parent, { ...lead, title: 'Open redirect on logout', path: 'GET /logout', why: 'The next parameter is not checked.' })
    const leads = store.listEvidence(panel.id, 0, 'lead').leads, byTitle = (title: string) => leads.find((item) => item.title === title)!.id
    store.saveLeadReview(panel.id, id, { expectedVersion: 0, status: 'open', tag: 'finding', note: 'Fetched http://127.0.0.1:8080/latest/meta-data through the importer.', nextAction: '' })
    store.saveLeadReview(panel.id, byTitle('Verbose error leaks a path'), { expectedVersion: 0, status: 'closed', note: 'Only in debug builds', nextAction: '' })
    const text = buildReport(store, panel.id, ['- 12:00:00 GET 200 http://127.0.0.1:8080/api/import (Parent)'])
    assert.match(text, /# Security research report: Demo shop/); assert.match(text, /Authorized targets: 127\.0\.0\.1:8080/); assert.match(text, /Findings \(1\)/)
    assert.match(text, /### 1\. SSRF in the importer/); assert.match(text, /\*\*Impact\.\*\* Internal services and cloud metadata/); assert.match(text, /Researcher's evidence[^\n]*\n\nFetched http:\/\/127\.0\.0\.1:8080\/latest\/meta-data/)
    assert.match(text, /Ruled out \(1\)[\s\S]*Verbose error leaks a path[\s\S]*Only in debug builds/); assert.match(text, /Still open \(1\)[\s\S]*Open redirect on logout/)
    assert.match(text, /## Recorded activity[\s\S]*GET 200 http:\/\/127\.0\.0\.1:8080\/api\/import/)
    const saved = await exportReport(store, panel.id, [])
    assert.match(saved.name, /^kraflr-report-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}\.md$/); assert.equal(saved.path.startsWith(workspace) || saved.path.startsWith(await realpath(workspace)), true)
    assert.match(await readFile(saved.path, 'utf8'), /SSRF in the importer/)
    store.close()
  } finally { await rm(base, { recursive: true, force: true }) }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../server/db.ts'
import { buildApp } from '../server/app.ts'
import { createResearchTeam } from '../server/research-team.ts'
import { createAgentTerminals } from '../server/agent-terminals.ts'
import { publicRepository } from '../server/repository-checkout.ts'
import { readPinnedSource } from '../server/pinned-source.ts'
import { managedAgentPolicy } from '../server/agent-policy.ts'
import { emptyScope } from '../shared/research.ts'
import type { ResearchRun, ResearchLead } from '../shared/research-run.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import type { VerificationRecord } from '../shared/verification.ts'

const exec = promisify(execFile)
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }
const hypothesis: ResearchLead = { kind: 'lead', title: 'Export ownership may be missing', explanation: 'The synthetic route returns an export without comparing its owner.',
  path: 'service.mjs', startLine: 1, endLine: 1, security: { hypothesis: 'The export route appears to omit an ownership check.',
    attackPath: 'A signed-in account can choose an export ID belonging to another account.', impact: 'The caller may retrieve another account’s private export.' } }
const wrap = (value: object) => '```kraflr-result\n' + JSON.stringify(value) + '\n```'
async function directory(t: test.TestContext) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'kraflr-product-'))
  t.after(async () => {
    const resolved = await realpath(root)
    if (/^kraflr-product-[^\\/]+$/.test(relative(base, resolved))) await rm(resolved, { recursive: true, force: true })
  })
  return root
}
function record(store: ReturnType<typeof openStore>, panelId: string, leads: ResearchLead[], endedAt = new Date().toISOString()) {
  const run: ResearchRun = { id: randomUUID(), panelId, parentId: randomUUID(), parentName: 'Synthetic parent', scopeVersion: 1,
    objective: 'Inspect synthetic source.', status: 'running', phase: 'Reviewing', startedAt: endedAt, endedAt: null,
    summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [] }
  store.startResearchRun(run)
  const completed = { ...run, status: 'completed' as const, endedAt, summary: 'Synthetic evidence recorded.', leads }
  store.saveResearchRun(completed)
  return completed
}
function parent(panelId: string): AgentTerminalInfo {
  return { id: randomUUID(), panelId, kind: 'cline', mode: 'cline-worker', label: 'Synthetic parent', scopeVersion: 1,
    startedAt: new Date().toISOString(), state: 'running', exitCode: null, chat: true, parent: true }
}
async function git(cwd: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)))
  const result = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env: { ...env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }, windowsHide: true })
  return result.stdout.trim()
}
async function source(root: string) {
  const repo = join(root, 'repo'); const workspace = join(root, 'workspace')
  await mkdir(repo); await mkdir(workspace)
  await writeFile(join(repo, 'service.mjs'), 'export const exportData = (records, id) => records[id];\n')
  await git(repo, ['init'])
  await git(repo, ['add', 'service.mjs'])
  await git(repo, ['-c', 'user.name=Kraflr QA', '-c', 'user.email=qa@example.test', 'commit', '-m', 'Synthetic source fixture'])
  return { repo, workspace, commit: await git(repo, ['rev-parse', 'HEAD']) }
}
async function settled(store: ReturnType<typeof openStore>, panelId: string, runId: string) {
  for (let attempt = 0; attempt < 100 && store.readResearchRun(panelId, runId).status === 'running'; attempt++) await delay(10)
  return store.readResearchRun(panelId, runId)
}

test('duplicate reports backfill into one stable lead, preserve aliases and decisions, and update in place', async (t) => {
  const root = await directory(t)
  const file = join(root, 'workspace.sqlite')
  let store = openStore(file)
  const panel = store.createPanel({ name: 'Deduplication fixture', type: 'source' })
  const other = store.createPanel({ name: 'Unrelated', type: 'source' })
  for (const id of [panel.id, other.id]) store.saveScope(id, 0, { ...emptyScope, repository: 'https://example.test/source', revision: 'v1' })
  const first = record(store, panel.id, [hypothesis], '2026-11-18T00:00:00Z')
  const second = record(store, panel.id, [{ ...hypothesis, explanation: 'An updated explanation of the same flaw.' }], '2026-11-18T00:01:00Z')
  assert.equal(store.listEvidence(panel.id, 0, 'lead').leads.length, 1)
  assert.equal(store.readEvidence(panel.id, `${second.id}:0`).id, `${first.id}:0`)
  assert.equal(store.readEvidence(panel.id, `${first.id}:0`).explanation, 'An updated explanation of the same flaw.')
  record(store, other.id, [{ ...hypothesis, id: `${first.id}:0`, explanation: 'Must remain in the other panel.' }])
  assert.equal(store.listEvidence(other.id, 0, 'lead').leads.length, 1)
  assert.notEqual(store.listEvidence(other.id, 0, 'lead').leads[0]!.id, `${first.id}:0`)
  const renamed = record(store, panel.id, [{ ...hypothesis, id: `${first.id}:0`, title: 'Refined export authorization hypothesis' }], '2026-11-18T00:02:00Z')
  assert.equal(store.listEvidence(panel.id, 0, 'lead').leads.length, 1)
  assert.equal(store.readEvidence(panel.id, `${renamed.id}:0`).title, 'Refined export authorization hypothesis')
  store.saveLeadReview(panel.id, `${second.id}:0`, { expectedVersion: 0, status: 'closed', tag: 'killed_lead', note: 'Caller authorization rules this out.', nextAction: '' })
  record(store, panel.id, [{ ...hypothesis, id: `${first.id}:0`, title: 'An agent must not rewrite the closed lead' }])
  assert.equal(store.readEvidence(panel.id, `${first.id}:0`).tag, 'killed_lead')
  assert.equal(store.readEvidence(panel.id, `${first.id}:0`).title, 'Refined export authorization hypothesis')
  store.close()
  const legacy = new DatabaseSync(file)
  const version = Number(legacy.prepare('PRAGMA user_version').get()!.user_version)
  // Rewinds past the evidence, checkout and agent-record migrations plus the two that follow them (per-panel running index, Claude kind).
  legacy.exec(`DROP TABLE agent_records; ALTER TABLE scope_revisions DROP COLUMN roeReference; ALTER TABLE agent_sessions DROP COLUMN role; DROP TABLE repository_checkouts; DROP TABLE evidence_links; DROP TABLE evidence_items; PRAGMA user_version = ${version - 6}`)
  legacy.close()
  store = openStore(file)
  assert.equal(store.listEvidence(panel.id, 0).counts.killed_lead, 1)
  assert.equal(store.readEvidence(panel.id, `${second.id}:0`).reviews[0]?.note, 'Caller authorization rules this out.')
  assert.equal(store.readResearchRun(panel.id, second.id).leads[0]!.explanation, 'An updated explanation of the same flaw.')
  store.close()
})

test('a free research run accepts a plain answer without a repair turn and keeps the full text', async () => {
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Report repair', type: 'source' })
  store.saveScope(panel.id, 0, { ...emptyScope, repository: 'https://example.test/source', revision: 'v1' })
  const agent = parent(panel.id)
  let calls = 0
  const team = createResearchTeam(store, { list: () => [agent], async researchTurn(_panelId, _id, prompt) {
    calls++
    assert.doesNotMatch(prompt, /Do not do more research or use tools/)
    return 'I inspected service.mjs line 1 and found a possible export ownership issue. This full explanation must be retained.'
  } })
  const run = team.start(panel.id, 'Inspect the synthetic source.', randomUUID())
  const completed = await settled(store, panel.id, run.id)
  assert.equal(calls, 1, 'no repair turn is spent on a free run')
  assert.equal(completed.status, 'completed')
  assert.match(completed.fullReply ?? '', /full explanation must be retained/)
  assert.doesNotMatch(completed.fullReply ?? '', /Structured report repair/)
  assert.equal(completed.reportWarning, undefined)
  await team.close(); store.close()
})

test('an interrupted report retains partial parent text without fabricating evidence', async () => {
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Partial report', type: 'source' })
  store.saveScope(panel.id, 0, { ...emptyScope, repository: 'https://example.test/source', revision: 'v1' })
  const agent = parent(panel.id)
  const team = createResearchTeam(store, { list: () => [agent], async researchTurn() {
    throw Object.assign(new Error('Synthetic provider failure'), { partialReply: 'I prepared the Dockerfile, but have not completed or verified the test.' })
  } })
  const run = team.start(panel.id, 'Prepare an owned synthetic test.', randomUUID())
  const failed = await settled(store, panel.id, run.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.fullReply ?? '', /have not completed or verified the test/)
  assert.equal(store.listEvidence(panel.id, 0).leads.length, 0)
  await team.close(); store.close()
})

test('source preparation records the Git revision automatically and refuses a changed checkout', async (t) => {
  const root = await directory(t)
  const { repo, workspace, commit } = await source(root)
  const store = openStore(':memory:')
  const app = buildApp(store, 4317)
  t.after(() => app.close())
  const panel = store.createPanel({ name: 'Automatic source', type: 'source' })
  const { revision: _revision, ...scope } = { ...emptyScope, targetName: 'Synthetic source', repository: repo, workspacePath: workspace }
  const saved = await app.inject({ method: 'PUT', url: `/api/panels/${panel.id}/scope`, headers, payload: { expectedVersion: 0, scope } })
  assert.equal(saved.statusCode, 200, saved.body)
  const prepared = await app.inject({ method: 'POST', url: `/api/panels/${panel.id}/checkout`, headers, payload: {} })
  assert.equal(prepared.statusCode, 200, prepared.body)
  assert.equal(store.readPanel(panel.id).checkout?.commit, commit)
  const effective = store.readSourceScope(panel.id, 1)
  const excerpt = await readPinnedSource(effective, { scopeVersion: 1, path: 'service.mjs', startLine: 1, endLine: 1, model: '', objective: '' })
  assert.equal(excerpt.commit, commit)
  assert.match(managedAgentPolicy(effective, workspace).policies.map((item) => item.resource).join(' '), /edit:/)
  await writeFile(join(repo, 'service.mjs'), 'changed source\n')
  assert.equal((await app.inject({ method: 'POST', url: `/api/panels/${panel.id}/checkout`, headers, payload: {} })).statusCode, 409)
  await git(repo, ['add', 'service.mjs'])
  await git(repo, ['-c', 'user.name=Kraflr QA', '-c', 'user.email=qa@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Changed synthetic revision'])
  const earlier = store.createPanel({ name: 'Earlier pinned revision', type: 'source' })
  store.saveScope(earlier.id, 0, { ...emptyScope, repository: repo, revision: commit, workspacePath: workspace })
  const wrongHead = await app.inject({ method: 'POST', url: `/api/panels/${earlier.id}/checkout`, headers, payload: {} })
  assert.equal(wrongHead.statusCode, 409)
  assert.match(wrongHead.json().message, /checked-out commit differs/)
  assert.equal(store.readPanel(earlier.id).checkout, undefined)
  for (const bad of ['file:///C:/private', 'https://user:secret@github.com/a/b', 'https://127.0.0.1/a/b', 'https://github.com/a/b?token=secret']) assert.equal(publicRepository(bad), undefined)
  assert.equal(publicRepository('https://github.com/octocat/Hello-World.git'), 'https://github.com/octocat/Hello-World.git')
})

test('parent lab preparation captures files and image metadata, queues once, and requires approval before testing', async (t) => {
  const root = await directory(t)
  const { repo, workspace, commit } = await source(root)
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Prepared lab fixture', type: 'source' })
  store.saveScope(panel.id, 0, { ...emptyScope, repository: repo, revision: 'HEAD', workspacePath: workspace })
  const original = record(store, panel.id, [hypothesis])
  const leadId = `${original.id}:0`
  const agent = parent(panel.id)
  let builds = 0; let tests = 0; let labDirectory = ''; let imageReady = true; let includePlan = true
  const terminals = { ...createAgentTerminals(root, store), list: () => [agent], async bindRepository() {},
    async researchTurn(_panelId: string, _id: string, prompt: string) {
      builds++
      assert.match(prompt, /Never search unrelated host directories/i)
      assert.match(prompt, /Do not run the test/)
      assert.ok(prompt.includes(commit))
      labDirectory = /^Lab folder: ([^\n]+)$/m.exec(prompt)![1]!
      await writeFile(join(labDirectory, 'Dockerfile'), 'FROM scratch\n')
      await writeFile(join(labDirectory, 'run-test.mjs'), '// synthetic test-double harness\n')
      return wrap({ reply: 'The lab is prepared. Review the isolated test plan before running it.', summary: 'Prepared a synthetic lab.',
        leads: [], deadEnds: [], nextSteps: [], verification: includePlan ? { title: 'Synthetic export control', image: `sha256:${'a'.repeat(64)}`,
          command: ['/fixture/run-test'], action: 'Compare owned and foreign synthetic export access.', expected: 'Owned control succeeds and the foreign record is returned.' } : undefined })
    } }
  const app = buildApp(store, 4317, { terminals, verificationRunner: {
    async available(plan) { if (plan && 'kind' in plan) { assert.equal(plan.repository, repo); assert.equal(plan.targetVersion, commit) }
      return { ready: imageReady, detail: imageReady ? 'Synthetic image metadata accepted by the test double.' : 'Synthetic image is unavailable.', image: plan?.image ?? '' } },
    async run(_plan, _id, signal, beforeStart) { signal.throwIfAborted(); beforeStart(); tests++
      return { kind: 'project', outcome: 'reproduced', controlPassed: true, summary: 'Synthetic observation.', evidence: 'Test-double control and foreign access observed.' } },
  } })
  t.after(() => app.close())
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload })
  const route = `/api/panels/${panel.id}/lab-preparation`
  const id = randomUUID()
  const requested = await post(route, { id, leadId })
  assert.equal(requested.statusCode, 202, requested.body)
  assert.equal((await post(route, { id, leadId })).statusCode, 200)
  const run = await settled(store, panel.id, id)
  assert.equal(run.status, 'completed', run.phase)
  assert.equal(builds, 1)
  assert.equal(tests, 0)
  assert.equal(await readFile(join(labDirectory, 'Dockerfile'), 'utf8'), 'FROM scratch\n')
  const progress = (await app.inject({ url: `${route}?lead=${leadId}`, headers })).json()
  assert.equal(progress.preparations[0].dockerfileReady, true)
  assert.equal(progress.preparations[0].harnessReady, true)
  const plan = store.readTest(panel.id, run.verificationId!)
  assert.equal(plan.status, 'pending')
  const decision = `/api/panels/${panel.id}/verification/${plan.id}/decision`
  assert.equal((await post(decision, { choice: 'approve', note: 'Approve this synthetic test.', planHash: plan.planHash })).statusCode, 400, 'a researched lead needs a named verifier')
  assert.equal((await post(decision, { choice: 'approve', executor: 'parent', note: 'Approve this synthetic test.', planHash: plan.planHash })).statusCode, 202)
  // The Parent runs the container itself and reports; Kraflr's own runner never executes a researched lead.
  assert.equal((await post(`/api/panels/${panel.id}/verification/${plan.id}/report`, { image: plan.plan.image, observation: { outcome: 'reproduced', controlPassed: true, summary: 'Synthetic observation.', evidence: 'Test-double control and foreign access observed.', environment: { fidelity: 'full', real: ['Synthetic application at the recorded commit', 'Synthetic database server'], substituted: [] } } })).statusCode, 200)
  const result: VerificationRecord = store.readTest(panel.id, plan.id)
  assert.equal(tests, 0)
  assert.equal(result.status, 'reproduced')
  assert.equal(result.finding?.acceptance, 'conditional', 'approving authorizes the verifier to mark the lead')
  assert.equal(store.readEvidence(panel.id, leadId).tag, 'finding')
  assert.equal(store.listEvidence(panel.id, 0, 'finding').leads.length, 1)
  record(store, panel.id, [{ ...hypothesis, id: leadId, title: 'An agent cannot rewrite an accepted finding' }])
  assert.equal(store.readEvidence(panel.id, leadId).title, hypothesis.title)
  assert.equal(store.readEvidence(panel.id, leadId).tag, 'finding')
  assert.equal((await post(decision, { choice: 'approve', executor: 'parent', note: '', planHash: plan.planHash })).statusCode, 409)
  assert.equal((await post(route,{id:randomUUID(),leadId})).statusCode,409,'A verified lead cannot start another lab implicitly')
  store.saveLeadReview(panel.id,leadId,{expectedVersion:store.readEvidence(panel.id,leadId).reviews[0]?.version??0,status:'open',tag:'lead',note:'Explicitly reopen for the test of failed preparation recovery.',nextAction:''})
  imageReady = false
  const missingImage = randomUUID()
  assert.equal((await post(route, { id: missingImage, leadId })).statusCode, 202)
  assert.equal((await settled(store, panel.id, missingImage)).status, 'failed')
  assert.equal(store.listVerification(panel.id, leadId).records.length, 1)
  imageReady = true; includePlan = false
  const missingPlan = randomUUID()
  assert.equal((await post(route, { id: missingPlan, leadId })).statusCode, 202)
  assert.match((await settled(store, panel.id, missingPlan)).phase, /did not return a built Docker image/)
  assert.equal(store.readResearchRun(panel.id, missingPlan).labDirectory, store.readResearchRun(panel.id, missingImage).labDirectory)
  assert.equal(store.listVerification(panel.id, leadId).records.length, 1)
  assert.equal((await post(`/api/panels/${panel.id}/verification/${plan.id}/finding`, { note: 'Already saved by the verifier.' })).statusCode, 409)
})

test('a scope change during Docker inspection cannot queue a prepared test', async () => {
  const store = openStore(':memory:')
  const panel = store.createPanel({ name: 'Preparation scope race', type: 'source' })
  const scope = { ...emptyScope, repository: 'https://example.test/source', revision: 'v1' }
  store.saveScope(panel.id, 0, scope)
  const original = record(store, panel.id, [hypothesis])
  const leadId = `${original.id}:0`
  const agent = parent(panel.id)
  let inspected = false; let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const team = createResearchTeam(store, { list: () => [agent], async researchTurn() {
    return wrap({ summary: 'Prepared synthetic files.', leads: [], verification: { title: 'Synthetic control', image: `sha256:${'b'.repeat(64)}`,
      command: ['/fixture/run-test'], action: 'Inspect the synthetic export route.', expected: 'Compare owned and foreign records.' } })
  } }, async (plan) => { inspected = true; await gate; return { ready: true, detail: 'Synthetic inspector.', image: plan?.image ?? '' } })
  try {
    const run = team.start(panel.id, 'Prepare the synthetic lab.', randomUUID(), leadId, { labDirectory: 'synthetic-only' })
    for (let attempt = 0; attempt < 50 && !inspected; attempt++) await delay(5)
    assert.ok(inspected)
    store.saveScope(panel.id, 1, { ...scope, restrictions: 'Changed during image inspection.' })
    release()
    assert.equal((await settled(store, panel.id, run.id)).status, 'interrupted')
    assert.equal(store.listVerification(panel.id, leadId).records.length, 0)
  } finally { release(); await team.close(); store.close() }
})

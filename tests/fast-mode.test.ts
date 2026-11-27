import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { openStore } from '../server/db.ts'
import { emptyScope } from '../shared/research.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import { recordLead } from '../cli/agent-lead.ts'
import { claudeSettings, autonomyFromEnvironment } from '../cli/claude-settings.ts'
import { terminalTeamInstructions } from '../shared/terminal-team.ts'

function setup(type: 'source' | 'web' = 'web') {
  const store = openStore(':memory:'), panel = store.createPanel({ name: 'Fast mode', type })
  store.saveScope(panel.id, 0, type === 'web' ? { ...emptyScope, targetName: 'Demo', webTargets: 'http://127.0.0.1:8080', notes: 'Local lab only.', repositoryMode: 'known' } : { ...emptyScope, targetName: 'Demo', repository: 'https://example.test/demo.git', revision: 'v1' })
  const agent: AgentTerminalInfo = { id: randomUUID(), panelId: panel.id, kind: 'claude', mode: 'terminal', label: 'Parent', parent: true, state: 'running', chat: true, scopeVersion: 1, startedAt: 'now', exitCode: null }
  return { store, panel, agent }
}
const full = { title: 'SSRF in the importer', path: 'POST /api/import', why: 'The url field is fetched server-side. Reproduced live: the response contained the metadata page.', hypothesis: 'The importer fetches any URL the caller supplies.', attack: 'Any logged-in user posts an internal URL to /api/import.', impact: 'Internal services and cloud metadata become reachable.' }

test('an agent records a lead with one command while it keeps working, and the lead lands in the Leads tab as a lead, not a Finding', () => {
  const { store, panel, agent } = setup()
  const first = recordLead(store, agent, full)
  assert.equal(first.recorded, true)
  const leads = store.listEvidence(panel.id, 0, 'lead').leads
  assert.equal(leads.length, 1); assert.equal(leads[0]!.title, 'SSRF in the importer'); assert.equal(leads[0]!.path, 'POST /api/import'); assert.equal(leads[0]!.startLine, 1)
  assert.equal(store.listEvidence(panel.id, 0, 'finding').leads.length, 0)
  // The same endpoint can be recorded again as a second lead, and a second lead needs no finished turn.
  recordLead(store, agent, { ...full, title: 'Blind SSRF through the webhook field', path: 'POST /api/webhook' })
  assert.equal(store.listEvidence(panel.id, 0, 'lead').leads.length, 2)
  store.close()
})

test('a lead names exactly what is missing or too thin, and bad line ranges are refused', () => {
  const { store, agent } = setup('source')
  assert.throws(() => recordLead(store, agent, { title: 'x' }), /needs --path, --why, --hypothesis, --attack, --impact/)
  assert.throws(() => recordLead(store, agent, { ...full, attack: 'too short' }), /--attack must be at least 12 characters/)
  assert.throws(() => recordLead(store, agent, { ...full, lines: 'ten' }), /--lines must look like/)
  assert.throws(() => recordLead(store, agent, { ...full, lines: '1-900' }), /not valid/)
  const ok = recordLead(store, agent, { ...full, path: 'src/import.php', lines: '10-20' })
  assert.equal(ok.recorded, true); assert.equal(store.listEvidence(agent.panelId, 0, 'lead').leads[0]!.startLine, 10)
  store.close()
})

test('a lead is redacted before it is saved', () => {
  const { store, agent } = setup()
  recordLead(store, agent, { ...full, why: full.why + ' token=SECRET123' }, (text) => text.replaceAll('SECRET123', '[redacted]'))
  assert.doesNotMatch(JSON.stringify(store.readEvidence(agent.panelId, store.listEvidence(agent.panelId, 0, 'lead').leads[0]!.id)), /SECRET123/)
  store.close()
})

test('a Claude session is free by default, asks only when KRAFLR_PERMISSIONS=ask, and never enables bypass mode', () => {
  const free = claudeSettings('node', 'hook.ts'), ask = claudeSettings('node', 'hook.ts', 'ask')
  assert.ok(free.permissions.allow?.includes('Bash')); assert.ok(free.permissions.allow?.includes('WebFetch')); assert.equal(ask.permissions.allow, undefined)
  assert.equal(free.permissions.disableBypassPermissionsMode, 'disable')
  assert.equal(autonomyFromEnvironment(undefined), 'free'); assert.equal(autonomyFromEnvironment('ask'), 'ask'); assert.equal(autonomyFromEnvironment('anything'), 'free')
})

test('the team instructions make a Child optional and give the one-line lead command', () => {
  assert.match(terminalTeamInstructions, /a Child is optional and never required/); assert.match(terminalTeamInstructions, /kraflr agent lead/)
  assert.doesNotMatch(terminalTeamInstructions, /must involve them|Start with a short plan/)
})

test('a Claude session records what its tools did through a PostToolUse hook that never carries a permission decision', () => {
  const hooks = claudeSettings('node', 'hook.ts').hooks as Record<string, { matcher?: string }[]>
  assert.match(hooks.PostToolUse![0]!.matcher!, /Bash/); assert.match(hooks.PostToolUse![0]!.matcher!, /WebFetch/)
  assert.doesNotMatch(JSON.stringify(hooks.PostToolUse), /permission/i)
})

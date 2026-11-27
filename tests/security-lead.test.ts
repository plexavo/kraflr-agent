import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyAgentEvidence } from '../shared/security-lead.ts'
import { openStore } from '../server/db.ts'
import { emptyScope } from '../shared/research.ts'
import type { ResearchRun } from '../shared/research-run.ts'
import { randomUUID } from 'node:crypto'

test('agent entries need an explicit security rationale; missing or invalid fields stay General', () => {
  const security = {
    hypothesis: 'The export handler appears to omit the ownership check.',
    attackPath: 'An authenticated account supplies another account’s export ID.',
    impact: 'The caller could read another account’s private export data.',
  }
  for (const entry of [null, [], {}, { kind: 'lead' }, { kind: 'lead', security: [] },
    { kind: 'lead', security: { ...security, impact: ' ' } },
    { kind: 'lead', security: { ...security, attackPath: 'a'.repeat(1201) } },
    { kind: 'lead', security: { ...security, hypothesis: 123 } },
    { kind: 'finding', security }, { kind: 'general', security }, { security }]) {
    assert.deepEqual(classifyAgentEvidence(entry), { kind: 'general' })
  }
  assert.deepEqual(classifyAgentEvidence({ kind: 'lead', security: { ...security, impact: ` ${security.impact} ` } }),
    { kind: 'lead', security })
})

test('legacy repository notes become General without changing source records or explicit researcher tags', () => {
  const store = openStore(':memory:')
  try {
    const panel = store.createPanel({ name: 'Legacy repository discovery', type: 'source' })
    store.saveScope(panel.id, 0, { ...emptyScope, targetName: 'Calendar', repository: 'https://example.test/calendar', revision: 'v1' })
    const run: ResearchRun = { id: randomUUID(), panelId: panel.id, parentId: randomUUID(), parentName: 'Earlier agent',
      scopeVersion: 1, objective: 'Find the official repository.', status: 'running', phase: 'Discovering',
      startedAt: new Date().toISOString(), endedAt: null, summary: '', tasks: [], leads: [], deadEnds: [], nextSteps: [] }
    store.startResearchRun(run)
    const entry = { title: 'Official-repository self-declaration in README', path: 'README.md', startLine: 1, endLine: 5,
      explanation: 'Hypothesis: this is the official upstream, linked by the plugin page.' }
    const saved = { ...run, status: 'completed' as const, leads: [entry, { ...entry, kind: 'lead' as const }] }
    store.saveResearchRun(saved)
    assert.deepEqual(store.listEvidence(panel.id, 0).counts, { general: 1, lead: 0, killed_lead: 0, finding: 0 })
    assert.deepEqual(store.readResearchRun(panel.id, run.id), saved)
    const id = `${run.id}:0`
    store.saveLeadReview(panel.id, id, { expectedVersion: 0, status: 'open', tag: 'lead',
      note: 'Researcher wants to track an additional security hypothesis here.', nextAction: '' })
    assert.equal(store.readEvidence(panel.id, id).tag, 'lead')
    assert.equal(store.listEvidence(panel.id, 0, 'general').leads.length, 0)
    assert.equal(store.readEvidence(panel.id, `${run.id}:1`).id, id)
  } finally { store.close() }
})

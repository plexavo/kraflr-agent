import { accessLabels, researchLabels } from '../shared/research.ts'
import { confirmationNote, evidenceTagLabels } from '../shared/evidence.ts'
import type { ResearchStore } from './db.ts'

const fence = (text: string) => '```\n' + text.replace(/```/g, "'''").trimEnd() + '\n```'
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Every lead with a tag, newest first, across pages. */
function allWithTag(store: ResearchStore, panelId: string, tag: 'finding' | 'killed_lead' | 'lead') {
  const ids: string[] = []
  for (let offset = 0; offset < 500; offset += 25) {
    const page = store.listEvidence(panelId, offset, tag)
    ids.push(...page.leads.map((lead) => lead.id))
    if (!page.more) break
  }
  return ids.map((id) => store.readEvidence(panelId, id))
}

/**
 * The write-up of a panel as it stands: what was in scope, each Finding with the note that made it one (the researcher's, or an agent's own
 * confirmation, labelled apart) and everything the agents attached, the leads that were ruled out and why, and how many are still open. `appendix` is extra evidence the caller holds (the
 * requests an agent made, for a web test).
 */
export function buildReport(store: ResearchStore, panelId: string, appendix: string[] = []) {
  const panel = store.readPanel(panelId), scope = panel.scopeHistory[0]
  const findings = allWithTag(store, panelId, 'finding'), killed = allWithTag(store, panelId, 'killed_lead'), open = allWithTag(store, panelId, 'lead')
  const lines: string[] = [`# Security research report: ${panel.name}`, '', `Generated ${new Date().toISOString()} by Kraflr. Scope revision ${panel.scopeVersion}.`, '', '## Scope', '',
    `- Type: ${researchLabels[panel.type]}`, `- Target: ${scope?.targetName || panel.name}`]
  if (scope) {
    if (panel.type === 'web') lines.push(`- Authorized targets: ${scope.webTargets.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean).join(', ') || 'none saved'}`, `- Rules of engagement: ${scope.roeReference ? scope.roeReference + ' · ' : ''}${oneLine(scope.notes).slice(0, 600) || 'see the reference'}`)
    else lines.push(`- Source: ${scope.repository || 'not set'}${scope.revision ? ' @ ' + scope.revision : ''}`, ...(scope.resolvedCommit ? [`- Commit tested: ${scope.resolvedCommit}`] : []))
    lines.push(`- Access: ${accessLabels[scope.accessMode]}`, ...(scope.restrictions.trim() ? [`- Restrictions: ${oneLine(scope.restrictions).slice(0, 400)}`] : []))
  }
  lines.push('', `## Findings (${findings.length})`, '')
  if (!findings.length) lines.push('No lead has been accepted as a Finding.', '')
  findings.forEach((lead, index) => {
    // An agent's own confirmation is labelled as such, never as the researcher's evidence.
    const confirmed = confirmationNote(lead.reviews), note = confirmed ?? lead.reviews.find((review) => review.tag === 'finding') ?? lead.reviews[0]
    lines.push(`### ${index + 1}. ${lead.title}`, '', `- Location: ${lead.path}${panel.type === 'web' ? '' : `:${lead.startLine}–${lead.endLine}`}`, `- Scope revision: ${lead.scopeVersion}${lead.commit ? ` · commit ${lead.commit}` : ''}`, `- Found by: ${lead.agent}`)
    if (lead.security) lines.push('', `**Hypothesis.** ${lead.security.hypothesis}`, '', `**Attack path.** ${lead.security.attackPath}`, '', `**Impact.** ${lead.security.impact}`)
    if (lead.explanation) lines.push('', '**What the agent observed.**', '', lead.explanation)
    if (note?.note) lines.push('', confirmed ? `**Agent-confirmed (${note.savedAt}), not independently checked.**` : `**Researcher's evidence (accepted ${note.savedAt}).**`, '', note.note)
    const extra = lead.reviews.filter((review) => review !== note && review.note)
    if (extra.length) lines.push('', '**Review history.**', '', ...extra.map((review) => `- ${review.savedAt}: ${oneLine(review.note).slice(0, 1200)}`))
    if (lead.verificationResults.length) lines.push('', '**Docker verification.**', '', ...lead.verificationResults.slice(0, 3).map((record) => `- ${record.status}${record.detail ? ' · ' + oneLine(record.detail).slice(0, 400) : ''}`))
    if (lead.evidence?.length) lines.push('', '**Cited source.**', '', fence(lead.evidence.map((line, i) => `${lead.startLine + i}  ${line}`).join('\n')))
    lines.push('')
  })
  lines.push(`## Ruled out (${killed.length})`, '')
  for (const lead of killed.slice(0, 40)) lines.push(`- ${lead.title} (${lead.path}) — ${oneLine(lead.reviews[0]?.note ?? '').slice(0, 300) || 'no reason recorded'}`)
  if (!killed.length) lines.push('Nothing was ruled out.')
  lines.push('', `## Still open (${open.length})`, '', ...open.slice(0, 40).map((lead) => `- ${lead.title} (${lead.path}) · ${evidenceTagLabels[lead.tag]}`))
  if (!open.length) lines.push('No open leads.')
  if (appendix.length) lines.push('', '## Recorded activity', '', ...appendix)
  lines.push('')
  return lines.join('\n')
}

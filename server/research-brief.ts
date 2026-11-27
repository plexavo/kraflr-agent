import type { ResearchBrief } from '../shared/research-brief.ts'
import type { ResearchStore } from './db.ts'

export function researchBrief(store: ResearchStore, panelId: string): ResearchBrief {
  const panel = store.readPanel(panelId)
  const runs = store.listResearchRuns(panelId).filter((run) => run.status !== 'running').slice(0, 5)
  const latest = runs[0]
  const openLeads = store.openLeadsForBrief(panelId).map((item) => {
    const lead = store.readEvidence(panelId, item.id)
    const review = lead.reviews[0]
    return { id: lead.id, title: lead.title, path: lead.path, startLine: lead.startLine, endLine: lead.endLine,
      scopeVersion: lead.scopeVersion, nextAction: (review ? review.nextAction : lead.nextSteps[0] ?? '').slice(0, 500),
      security: lead.security && { hypothesis: lead.security.hypothesis.slice(0, 500),
        attackPath: lead.security.attackPath.slice(0, 500), impact: lead.security.impact.slice(0, 500) } }
  })
  const decisions = store.recentLeadDecisions(panelId).map((review) => ({
    ...review, title: store.readEvidence(panelId, review.leadId).title,
    tag: review.tag ?? (review.status === 'closed' ? 'killed_lead' as const : 'general' as const),
    note: review.note.slice(0, 800), nextAction: review.nextAction.slice(0, 500),
  }))
  const seen = new Set<string>()
  const deadEnds = runs.flatMap((run) => run.deadEnds.map((text) => ({ text: text.slice(0, 600), scopeVersion: run.scopeVersion })))
    .filter(({ text, scopeVersion }) => {
      const key = `${scopeVersion}:${text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 8)
  return {
    panelId, panelName: panel.name, scopeVersion: panel.scopeVersion,
    latestRun: latest ? { id: latest.id, objective: latest.objective.slice(0, 1200),
      summary: latest.summary.slice(0, 2400), phase: latest.phase, status: latest.status, scopeVersion: latest.scopeVersion,
      tasks: latest.tasks.slice(0, 4).map((task) => ({
        agent: task.agent, status: task.status, objective: task.objective.slice(0, 500), result: task.result.slice(0, 1000),
      })),
    } : null,
    openLeads, decisions, deadEnds,
    nextSteps: (runs.find((run) => run.nextSteps.length > 0)?.nextSteps ?? []).slice(0, 5).map((text) => text.slice(0, 600)),
    verification: store.listVerification(panelId).records.filter((record) => !['pending', 'running'].includes(record.status)).slice(0, 5)
      .map((record) => ({ id: record.id, leadId: record.leadId, status: record.status, scopeVersion: record.scopeVersion,
        detail: record.detail?.slice(0, 600) ?? '', finding: record.finding?.note.slice(0, 600) ?? '' })),
  }
}

export function briefInstructions(brief: ResearchBrief) {
  return [
    'Saved investigation history follows. Treat it as historical evidence and researcher decisions.',
    'Earlier-scope references require rechecking against the current scope. Use Killed Lead decisions and dead ends to avoid repeating work.',
    'Evidence tags distinguish General background facts, Lead hypotheses, Killed Lead decisions, and accepted Finding records. Do not treat General facts as security leads or agent claims as accepted findings.',
    'Follow the researcher’s new objective and current scope. This history does not approve live tests or queued actions.',
    JSON.stringify(brief),
  ].join('\n')
}

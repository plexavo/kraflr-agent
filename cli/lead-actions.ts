import { StoreError, type ResearchStore } from '../server/db.ts'
import type { AgentTerminals } from '../server/agent-terminals.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import { agentConfirmed, type EvidenceLead } from '../shared/evidence.ts'
import type { Delivery } from './delivery.ts'

const clip = (text: string, limit: number) => text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text

/** The lead as a teammate needs to see it: what it claims, where, and what the researcher already wrote about it. */
function describe(lead: EvidenceLead) {
  const note = lead.reviews.find((review) => review.note)?.note
  return [`Lead: ${lead.title}`, `Location: ${lead.path}${lead.startLine > 1 || lead.endLine > 1 ? `:${lead.startLine}–${lead.endLine}` : ''}`,
    ...(lead.security ? [`Hypothesis: ${lead.security.hypothesis}`, `Attack path: ${lead.security.attackPath}`, `Impact: ${lead.security.impact}`] : []),
    ...(lead.explanation ? [`What was observed: ${clip(lead.explanation, 1500)}`] : []),
    ...(note ? [`${note.startsWith(agentConfirmed) ? 'Confirmation' : "Researcher's note"}: ${clip(note, 1500)}`] : [])].join('\n')
}

export const challengeMinutes = 5

/**
 * Two things a researcher can ask of the team about a lead. Neither runs on its own and neither blocks the Parent, which keeps working in its own pane:
 * a **challenge** asks a Child to try to disprove a lead and attaches its verdict to that lead, and **variants** asks an agent to look for the same flaw elsewhere.
 */
export function createLeadActions(store: ResearchStore, terminals: Pick<AgentTerminals, 'list'>, send: (request: Delivery) => void) {
  const live = (panelId: string, scopeVersion: number) => terminals.list().filter((agent) => agent.panelId === panelId && agent.chat && agent.state === 'running'
    && agent.scopeVersion === scopeVersion && !agent.modelSelectionRequired && !agent.stoppage)
  function pick(panelId: string, scopeVersion: number, who: 'child' | 'parent', agentId?: string): AgentTerminalInfo {
    const team = live(panelId, scopeVersion)
    const chosen = who === 'parent' ? team.find((agent) => agent.parent) : agentId ? team.find((agent) => agent.id === agentId && !agent.parent) : team.find((agent) => !agent.parent)
    if (!chosen) throw new StoreError(409, who === 'parent' ? 'The Parent is not running for the current scope.' : 'Start a Child session first. A challenge needs a second agent, ideally on a different model.')
    return chosen
  }
  /** Records an agent's verdict on the lead itself, without changing its status or tag. Shared by Challenge and the live web Verify, which differ only in label and verdict wording. */
  function attachVerdict(panelId: string, leadId: string, label: string, verdictWords: string, who: string, reply: string) {
    try {
      const lead = store.readEvidence(panelId, leadId), latest = lead.reviews[0]
      if (latest?.status === 'closed') return
      const verdict = new RegExp(`VERDICT:\\s*(${verdictWords})`, 'i').exec(reply)?.[1]?.toLowerCase() ?? 'no clear verdict'
      const body = clip(reply.replace(/\s+/g, ' ').trim(), 1800)
      store.saveLeadReview(panelId, leadId, { expectedVersion: latest?.version ?? 0, status: latest?.status ?? 'open', note: `${label} by ${who}: ${verdict}. ${body}`, nextAction: latest?.nextAction ?? '' })
    } catch { /* The lead changed or the scope moved on; the full reply is still in the research record. */ }
  }
  const attach = (panelId: string, leadId: string, who: string, reply: string) => attachVerdict(panelId, leadId, 'Challenge', 'holds|does not hold|unclear', who, reply)
  /** Records the PoC on the Finding itself, the same way a challenge verdict is recorded: as a note, without changing status or tag. */
  function attachPoc(panelId: string, leadId: string, who: string, reply: string) {
    try {
      const lead = store.readEvidence(panelId, leadId), latest = lead.reviews[0]
      if (latest?.status === 'closed') return
      const block = /```[^\n]*\n([\s\S]*?)```/.exec(reply)?.[1]?.trim()
      const poc = clip((block || reply).trim(), 6000)
      store.saveLeadReview(panelId, leadId, { expectedVersion: latest?.version ?? 0, status: latest?.status ?? 'open', note: `PoC by ${who}:\n${poc}`, nextAction: latest?.nextAction ?? '' })
    } catch { /* The lead changed or the scope moved on; the full reply is still in the research record. */ }
  }
  return {
    challenge(panelId: string, leadId: string, who: 'child' | 'parent' = 'child', agentId?: string) {
      const lead = store.readEvidence(panelId, leadId), panel = store.readPanel(panelId)
      if (lead.status === 'closed') throw new StoreError(409, 'This lead was already ruled out.')
      const agent = pick(panelId, panel.scopeVersion, who, agentId)
      send({ panelId, scopeVersion: panel.scopeVersion, to: agent.id, key: `challenge:${leadId}:${Date.now()}`, from: 'Researcher', objective: `Challenge: ${lead.title}`, task: `Try to disprove: ${lead.title}`,
        waiting: `Waiting for ${agent.label} to challenge the lead`, done: 'Challenge verdict saved on the lead', failed: 'The challenge did not finish', doneResult: 'Verdict saved',
        text: [`The researcher asks you to try to DISPROVE this lead. Be a sceptical second pair of eyes, not a cheerleader. Work inside the saved scope, and use any tool you need.`,
          `Time box: about ${challengeMinutes} minutes. Look for the reason it is wrong (a check you missed, an input that never reaches the sink, a control case that behaves the same, a mitigation). If you cannot break it, say what you tried.`,
          'End with one line: VERDICT: holds, VERDICT: does not hold, or VERDICT: unclear, followed by a short paragraph of the evidence. Do not record new leads for this task.', '', describe(lead)].join('\n'),
        onReply: (reply) => attach(panelId, leadId, agent.label, reply) })
      return { agent: agent.label, minutes: challengeMinutes }
    },
    /** The web equivalent of "Verify in Docker": there is no lab to build against a live target, so verification means
     * an agent actually reproducing the claim with a real request and response, neutrally — confirm or refute, not
     * argue either side. */
    verify(panelId: string, leadId: string, who: 'child' | 'parent' = 'parent', agentId?: string) {
      const lead = store.readEvidence(panelId, leadId), panel = store.readPanel(panelId)
      if (panel.type !== 'web') throw new StoreError(409, 'Use Verify in Docker for a source-review lead.')
      if (lead.status === 'closed') throw new StoreError(409, 'This lead was already ruled out.')
      const agent = pick(panelId, panel.scopeVersion, who, agentId)
      send({ panelId, scopeVersion: panel.scopeVersion, to: agent.id, key: `verify:${leadId}:${Date.now()}`, from: 'Researcher', objective: `Verify: ${lead.title}`, task: `Reproduce against the live target: ${lead.title}`,
        waiting: `Waiting for ${agent.label} to verify the lead`, done: 'Verification saved on the lead', failed: 'The verification did not finish', doneResult: 'Verdict saved',
        text: [`The researcher asks you to VERIFY this lead against the live target. Be neutral: your job is to find out whether it is real, not to defend or attack it.`,
          'Send the actual request(s) this lead describes and show the real response(s). Add a control case if one makes the result clearer (an unmodified request, a different account, or similar).',
          `If it is proven beyond doubt (you reproduced it and a control behaved differently), move it to Findings first: kraflr agent confirm ${lead.id} --proof "…" --control "…". Otherwise do not.`,
          'End with one line: VERDICT: confirmed, VERDICT: not confirmed, or VERDICT: inconclusive, followed by the real request/response evidence. Do not record new leads for this task.', '', describe(lead)].join('\n'),
        onReply: (reply) => attachVerdict(panelId, leadId, 'Verify', 'confirmed|not confirmed|inconclusive', agent.label, reply) })
      return { agent: agent.label }
    },
    variants(panelId: string, leadId: string, who: 'child' | 'parent' = 'child', agentId?: string) {
      const lead = store.readEvidence(panelId, leadId), panel = store.readPanel(panelId)
      if (lead.tag !== 'finding') throw new StoreError(409, 'Variants are hunted from an accepted Finding.')
      const agent = pick(panelId, panel.scopeVersion, who, agentId)
      send({ panelId, scopeVersion: panel.scopeVersion, to: agent.id, key: `variants:${leadId}:${Date.now()}`, from: 'Researcher', objective: `Variants of: ${lead.title}`, task: `Hunt the same pattern elsewhere: ${lead.title}`,
        waiting: `Waiting for ${agent.label} to hunt variants`, done: 'Variant hunt finished', failed: 'The variant hunt did not finish', doneResult: 'Variant hunt finished',
        text: ['The researcher accepted this Finding. Hunt the same flaw pattern elsewhere in the saved scope: the same missing check, the same kind of sink, the same unsafe helper, sibling endpoints or sibling handlers.',
          'Record each real hit as its own lead with `kraflr agent lead` (do not record the Finding itself again). Time box: about 10 minutes. End with a plain summary of where you looked and what you found.', '', describe(lead)].join('\n') })
      return { agent: agent.label }
    },
    generatePoc(panelId: string, leadId: string, who: 'child' | 'parent' = 'parent', agentId?: string) {
      const lead = store.readEvidence(panelId, leadId), panel = store.readPanel(panelId)
      if (lead.tag !== 'finding') throw new StoreError(409, 'A PoC is written for an accepted Finding.')
      const agent = pick(panelId, panel.scopeVersion, who, agentId)
      send({ panelId, scopeVersion: panel.scopeVersion, to: agent.id, key: `poc:${leadId}:${Date.now()}`, from: 'Researcher', objective: `PoC for: ${lead.title}`, task: `Write a copy-pasteable proof of concept for: ${lead.title}`,
        waiting: `Waiting for ${agent.label} to write a proof of concept`, done: 'Proof of concept saved on the Finding', failed: 'The proof of concept did not finish', doneResult: 'PoC saved',
        text: ["Write a complete, self-contained proof of concept that reproduces this Finding exactly as recorded. Use the real target, path and values from the scope and the evidence below, not placeholders — the researcher must be able to run it with nothing left to fill in.",
          'Use whatever form actually reproduces it: one or more curl commands, a short script, or exact numbered steps against the recorded target.',
          'Reply with ONLY a single fenced code block containing the PoC. No preamble, no explanation outside the block, no commentary after it.', '', describe(lead)].join('\n'),
        onReply: (reply) => attachPoc(panelId, leadId, agent.label, reply) })
      return { agent: agent.label }
    },
    /** Hands a cross-account replay result to the Parent to confirm and, if it holds up, record as a lead — replay itself never writes a lead. */
    reportReplay(panelId: string, summary: string) {
      const panel = store.readPanel(panelId)
      const agent = pick(panelId, panel.scopeVersion, 'parent')
      send({ panelId, scopeVersion: panel.scopeVersion, to: agent.id, key: `replay:${Date.now()}`, from: 'Researcher', objective: 'Review a cross-account replay', task: 'Review a replay result and record a lead if it holds up',
        waiting: `Waiting for ${agent.label} to review the replay`, done: 'Replay reviewed', failed: 'The review did not finish', doneResult: 'Reviewed',
        text: ["The researcher replayed a request Kraflr captured, swapping in a different account's credentials, and got this result:", '', summary, '',
          'If this looks like real broken access control (an IDOR, a missing authorization check), confirm it yourself — reproduce it, check what a legitimate control case does — and record it with `kraflr agent lead`. If it does not hold up, reply explaining why.'].join('\n') })
      return { agent: agent.label }
    },
  }
}
export type LeadActions = ReturnType<typeof createLeadActions>

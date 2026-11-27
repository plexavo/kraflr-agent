import { randomUUID } from 'node:crypto'
import { StoreError, type ResearchStore } from '../server/db.ts'
import type { AgentTerminalInfo } from '../shared/agent-terminal.ts'
import { report } from '../server/research-team.ts'
import { recordId } from './agent-records.ts'
import { agentConfirmed, isOpenLead } from '../shared/evidence.ts'

const secureFields = [['--hypothesis', 'hypothesis'], ['--attack', 'attack'], ['--impact', 'impact']] as const

/**
 * `kraflr agent lead`: one lead, saved the moment the agent has it. It needs no finished turn, no report block and no idle panel, so an agent
 * records what it finds while it keeps working. A recorded lead becomes a Finding through `kraflr agent confirm`, an approved test or the researcher.
 */
export function recordLead(store: ResearchStore, agent: AgentTerminalInfo, params: Record<string, unknown>, redact: (text: string) => string = (text) => text) {
  const field = (name: string, max: number) => typeof params[name] === 'string' ? redact(params[name] as string).trim().slice(0, max) : ''
  const title = field('title', 160), path = field('path', 500), why = field('why', 2400), id = field('id', 80)
  const security = { hypothesis: field('hypothesis', 1200), attackPath: field('attack', 1200), impact: field('impact', 1200) }
  const missing = [['--title', title], ['--path', path], ['--why', why], ['--hypothesis', security.hypothesis], ['--attack', security.attackPath], ['--impact', security.impact]]
    .filter(([, value]) => !value).map(([name]) => name)
  if (missing.length) throw new StoreError(400, 'A lead needs ' + missing.join(', ') + '.')
  const short = secureFields.filter(([, name]) => field(name, 1200).length < 12).map(([flag]) => flag)
  if (short.length) throw new StoreError(400, short.join(', ') + ' must be at least 12 characters of real explanation.')
  const given = field('lines', 20), lines = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(given)
  if (given && !lines) throw new StoreError(400, '--lines must look like 10 or 10-20.')
  const startLine = lines ? Number(lines[1]) : 1, endLine = lines ? Number(lines[2] ?? lines[1]) : 1
  const parsed = report('```kraflr-result\n' + JSON.stringify({ summary: title, leads: [{ kind: 'lead', title, explanation: why, path, startLine, endLine, ...(id ? { id } : {}), security }] }) + '\n```')
  if (parsed.leads.length !== 1 || parsed.leads[0]!.kind !== 'lead') throw new StoreError(400, 'The lead was not valid. Keep --lines within 120 lines and --path a short file path or endpoint.')
  const now = new Date().toISOString(), run = recordId(agent.id + ':lead:' + randomUUID())
  store.saveAgentRecord({ id: run, panelId: agent.panelId, parentId: agent.id, parentName: agent.label, scopeVersion: agent.scopeVersion!,
    purpose: 'conversation', objective: 'Lead recorded by ' + agent.label, status: 'completed', phase: 'Lead recorded', startedAt: now, endedAt: now,
    reply: title, summary: title, fullReply: why, leads: parsed.leads, tasks: [], deadEnds: [], nextSteps: [] })
  // The saved ID (an update or a repeat resolves to the original lead) is what confirm and verification commands take.
  let saved = ''
  try { saved = store.readEvidence(agent.panelId, id || run + ':0').id } catch { /* The lead is saved; its ID is in `kraflr agent context`. */ }
  return { recorded: true, title, ...(saved ? { id: saved } : {}), hint: 'Keep working. Once you have proven this beyond doubt, run kraflr agent confirm' + (saved ? ' ' + saved : ' <lead-id>') + ' --proof "..." --control "..."; otherwise leave it as a lead.' }
}

/**
 * `kraflr agent confirm`: the agent moves a lead it has proven to Findings. It must show what it observed and a control case that behaved
 * differently. Kraflr does not check the proof itself, so the Finding is labelled as the agent's and the researcher can move it back. An agent
 * cannot overrule the researcher, a Docker test still in flight, or a second agent that failed to confirm the lead.
 */
export function confirmLead(store: ResearchStore, agent: AgentTerminalInfo, params: Record<string, unknown>, redact: (text: string) => string = (text) => text) {
  const field = (name: string, max: number) => typeof params[name] === 'string' ? redact(params[name] as string).trim().slice(0, max) : ''
  const id = field('id', 80), proof = field('proof', 1500), control = field('control', 600)
  if (!id) throw new StoreError(400, 'Name the lead: kraflr agent confirm <lead-id> --proof "..." --control "...". Lead IDs are in kraflr agent context.')
  if (proof.length < 80) throw new StoreError(400, '--proof must show what you actually did and observed (the real request and response, or the command and its output), at least 80 characters. Reading code is not proof.')
  if (control.length < 30) throw new StoreError(400, '--control must describe the control case and how its result differed, at least 30 characters.')
  const lead = store.readEvidence(agent.panelId, id)
  if (lead.tag === 'finding') return { confirmed: true, id: lead.id, hint: 'This lead is already a Finding.' }
  if (!isOpenLead(lead)) throw new StoreError(409, 'Only an open lead can be confirmed.')
  if (lead.scopeVersion !== agent.scopeVersion) throw new StoreError(409, 'This lead was recorded under an earlier scope. Check it again, record it with kraflr agent lead, then confirm the new lead.')
  if (lead.verificationProgress?.active) throw new StoreError(409, 'A Docker verification of this lead is in progress; its approved run marks the lead. Do not confirm it another way.')
  if (lead.reviews.some((review) => review.tag === 'finding' || review.status === 'closed')) throw new StoreError(409, 'The researcher already changed this lead’s status. Only the researcher can accept it now.')
  const disputed = lead.reviews.find((review) => /^(?:Challenge|Verify) by /.test(review.note))
  if (disputed && /^(?:Challenge|Verify) by .{1,80}?: (?:does not hold|not confirmed)\./.test(disputed.note)) throw new StoreError(409, 'A second check did not confirm this lead. Report your evidence to the researcher, who decides.')
  const note = `${agentConfirmed}${agent.label} (reported by the agent; Kraflr did not check it independently).\nProof: ${proof}\nControl: ${control}`
  store.saveLeadReview(agent.panelId, lead.id, { expectedVersion: lead.reviews[0]?.version ?? 0, status: 'open', tag: 'finding', note, nextAction: lead.reviews[0]?.nextAction ?? '' })
  return { confirmed: true, id: lead.id, title: lead.title, hint: 'Saved in Findings, labelled as your confirmation. Tell the researcher in plain English what you proved.' }
}

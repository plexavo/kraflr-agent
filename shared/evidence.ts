import type { ResearchLead } from './research-run.ts'
import type { VerificationRecord } from './verification.ts'

export const evidenceIdPattern = '^[a-f0-9-]{36}:(?:[0-9]{1,2}|source)$'
export const leadStatuses = ['open', 'closed'] as const
export type LeadStatus = typeof leadStatuses[number]
export const evidenceTags = ['general', 'lead', 'killed_lead', 'finding'] as const
export type EvidenceTag = typeof evidenceTags[number]
export const evidenceTagLabels: Record<EvidenceTag, string> = {
  general: 'General', lead: 'Lead', killed_lead: 'Killed Lead', finding: 'Finding',
}
export interface EvidencePage {
  leads: EvidenceSummary[]
  more: boolean
  counts: Record<EvidenceTag, number>
}

export interface EvidenceSummary {
  verificationProgress?: import('./lead-verification.ts').LeadVerificationProgress
  id: string
  title: string
  path: string
  startLine: number
  endLine: number
  scopeVersion: number
  status: LeadStatus
  tag: EvidenceTag
  createdAt: string
}

export function isOpenLead(item: Pick<EvidenceSummary, 'status' | 'tag'>) {
  return item.status === 'open' && item.tag === 'lead'
}

export interface LeadReview {
  version: number
  status: LeadStatus
  note: string
  nextAction: string
  savedAt: string
  tag?: EvidenceTag | null
}

/** How the note of a Finding an agent confirmed itself begins, so it is never shown as the researcher's own acceptance. */
export const agentConfirmed = 'Confirmed by '

/** The agent's confirmation that made this lead a Finding, if that is how it got there (not the researcher, not an approved test). Reviews are newest first. */
export function confirmationNote(reviews: LeadReview[]) {
  let promoted: LeadReview | undefined
  for (const review of reviews) { if (review.tag !== 'finding') break; promoted = review }
  return promoted?.note.startsWith(agentConfirmed) ? promoted : undefined
}

export type SaveLeadReview = Omit<LeadReview, 'version' | 'savedAt'> & { expectedVersion: number }

export interface EvidenceLead extends EvidenceSummary, Omit<ResearchLead, 'id'> {
  runId: string
  origin: 'research' | 'source'
  agent: string
  objective: string
  summary: string
  deadEnds: string[]
  nextSteps: string[]
  reviews: LeadReview[]
  verificationResults: VerificationRecord[]
  hasAcceptedFinding: boolean
}

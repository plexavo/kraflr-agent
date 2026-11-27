import type { ResearchRunStatus } from './research-run.ts'
import type { EvidenceTag, LeadStatus } from './evidence.ts'
import type { VerificationStatus } from './verification.ts'
import type { SecurityHypothesis } from './security-lead.ts'

export interface ResearchBrief {
  panelId: string
  panelName: string
  scopeVersion: number
  latestRun: {
    id: string; objective: string; summary: string; phase: string; status: ResearchRunStatus; scopeVersion: number
    tasks: { agent: string; status: string; objective: string; result: string }[]
  } | null
  openLeads: { id: string; title: string; path: string; startLine: number; endLine: number; scopeVersion: number; nextAction: string; security?: SecurityHypothesis }[]
  decisions: { leadId: string; title: string; status: LeadStatus; tag?: EvidenceTag | null; note: string; nextAction: string; savedAt: string }[]
  deadEnds: { text: string; scopeVersion: number }[]
  nextSteps: string[]
  verification: { id: string; leadId: string; status: VerificationStatus; scopeVersion: number; detail: string; finding: string }[]
}

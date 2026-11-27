import type { SecurityHypothesis } from './security-lead.ts'

export type ResearchRunStatus = 'running' | 'completed' | 'failed' | 'interrupted'

export interface RepositorySuggestion {
  url: string
  targetName: string
  revision: string
  sourceUrl: string
  reason: string
}

export interface SavedRepositorySuggestion extends RepositorySuggestion {
  runId: string
  scopeVersion: number
  parentName: string
}

export interface ResearchLead {
  id?: string
  title: string
  explanation: string
  path: string
  startLine: number
  endLine: number
  commit?: string
  evidence?: string[]
  verification?: ProjectVerificationInput
  kind?: 'lead' | 'general'
  security?: SecurityHypothesis
}

export interface ResearchTask {
  round?: number
  automatic?: boolean
  fullReply?: string
  sessionId: string
  agent: string
  objective: string
  status: 'assigned' | 'completed' | 'failed' | 'interrupted'
  result: string
}

export interface ResearchRun {
  team?: { rounds: number; workerIds: string[]; automaticReviews: number; detail?: string }
  purpose?: 'verification'|'collaboration'|'conversation'
  labDirectory?: string
  /** The failed test this preparation is repairing, so the lead reads "Analysing verification error" while the agent works. */
  repairOf?: string
  labPlan?: ProjectVerificationInput
  verificationId?: string
  reply?: string
  fullReply?: string
  reportWarning?: string
  reportRecovered?: boolean
  parentReplies?: string[]
  id: string
  panelId: string
  parentId: string
  parentName: string
  scopeVersion: number
  objective: string
  status: ResearchRunStatus
  phase: string
  startedAt: string
  endedAt: string | null
  summary: string
  tasks: ResearchTask[]
  leads: ResearchLead[]
  deadEnds: string[]
  nextSteps: string[]
  leadId?: string
  leadReviewVersion?: number
  repositorySuggestion?: RepositorySuggestion
}
import type { ProjectVerificationInput } from './verification.ts'


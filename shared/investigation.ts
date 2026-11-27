import type { AgentTerminalInfo } from './agent-terminal.ts'

export interface LeadCounts {
  panelId: string
  total: number
  closed: number
  findings: number
}

export interface ActiveResearch {
  panelId: string
  parentId: string
  objective: string
  phase: string
  assignments: { sessionId: string; objective: string; status: string }[]
}

export interface InvestigationSnapshot {
  counts: LeadCounts[]
  sessions: AgentTerminalInfo[]
  research: ActiveResearch[]
}

import type { SecurityHypothesis } from './security-lead.ts'

export const fullCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
export const sourceLineLimit = 120
export const modelRef = /^[a-zA-Z0-9_.-]{1,80}\/[a-zA-Z0-9_./:-]{1,180}$/

export interface SourceSelection {
  scopeVersion: number
  path: string
  startLine: number
  endLine?: number
  objective: string
  model: string
}

export interface SourceExcerpt {
  commit: string
  path: string
  startLine: number
  lines: string[]
}

export interface SourcePreview extends SourceSelection {
  id: string
  excerpt: SourceExcerpt
}

export interface SourceLead {
  title: string
  explanation: string
  startLine: number
  endLine: number
  kind?: 'lead' | 'general'
  security?: SecurityHypothesis
}

export interface SourceReviewResult {
  summary: string
  lead: SourceLead | null
}

export interface SourceReviewRun extends SourcePreview {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string
  finishedAt: string | null
  detail: string
  result: SourceReviewResult | null
}

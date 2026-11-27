import type { ResearchRun } from './research-run.ts'
export interface LabPreparation {
  run: Pick<ResearchRun, 'id' | 'status' | 'phase' | 'summary' | 'reply' | 'reportWarning' | 'scopeVersion' | 'verificationId'>
  directory: string
  directoryReady: boolean
  dockerfileReady: boolean
  harnessReady: boolean
  canRecover: boolean
  planChanged?: boolean
  preparedImage?: string
  recoveryReason: string
}
export interface LabPreparationPage {
  prompt: string
  canStart: boolean
  reason: string
  preparations: LabPreparation[]
}

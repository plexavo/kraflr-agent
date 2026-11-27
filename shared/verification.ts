export const verificationVariants = ['vulnerable', 'patched'] as const
export type VerificationVariant = typeof verificationVariants[number]

export type VerificationStatus = 'pending' | 'running' | 'denied' | 'expired' | 'stale'
  | 'cancelled' | 'reproduced' | 'not_reproduced' | 'inconclusive' | 'error' | 'interrupted'

/** What a container may use. `scratchMiB` is the writable `/tmp`, held in memory, so it can never exceed `memoryMiB`. */
export interface VerificationLimits { memoryMiB: number; cpus: number; processes: number; seconds: number; scratchMiB?: number }

/** The range a plan may request. The defaults suit a small harness; a faithful application stack (a database server, a CMS install) needs more,
 * and the researcher sees and approves the exact numbers. */
export const limitRanges = {
  memoryMiB: { min: 128, max: 4096, fallback: 256 },
  cpus: { min: 0.5, max: 4, fallback: 1 },
  processes: { min: 32, max: 512, fallback: 64 },
  seconds: { min: 10, max: 900, fallback: 60 },
  scratchMiB: { min: 16, max: 4096, fallback: 64 },
} as const

interface VerificationPlanBase {
  image: string
  action: string
  expected: string
  isolation: { network: 'none'; user: string; readOnly: true; dropCapabilities: 'ALL'; noNewPrivileges: true }
  limits: VerificationLimits
}

export interface FixtureVerificationPlan extends VerificationPlanBase {
  variant: VerificationVariant
  fixtureVersion: string
  harnessHash: string
}

export interface ProjectVerificationInput {
  title: string
  image: string
  command: string[]
  action: string
  expected: string
  /** Resources the test asks for; anything left out uses the default. */
  limits?: Partial<VerificationLimits>
}

export interface ProjectVerificationPlan extends VerificationPlanBase, Omit<ProjectVerificationInput, 'limits'> {
  kind: 'project'
  repository: string
  targetVersion: string
}

export type VerificationPlan = FixtureVerificationPlan | ProjectVerificationPlan

export function isProjectPlan(plan: VerificationPlan): plan is ProjectVerificationPlan {
  return 'kind' in plan && plan.kind === 'project'
}

/** Plans an agent runs and reports itself; only the bundled self-test fixture is run by Kraflr. */
export function isAgentPlan(plan: VerificationPlan): plan is ProjectVerificationPlan {
  return isProjectPlan(plan)
}

export interface FixtureObservation {
  ownerStatus: number
  ownerRecordReturned: boolean
  foreignStatus: number
  foreignRecordReturned: boolean
}

/** What the test actually ran against. A Finding or a killed lead needs `full`: the real application, its real database and its real install flow. */
export interface VerificationEnvironment {
  fidelity: 'full' | 'partial'
  real: string[]
  substituted: string[]
}

export interface ProjectObservation {
  kind: 'project'
  outcome: 'reproduced' | 'not_reproduced' | 'inconclusive'
  controlPassed: boolean
  summary: string
  evidence: string
  environment?: VerificationEnvironment
}

/** True only when the agent states it ran the real stack and names what was real. Self-reported, and shown to the researcher as such. */
export const isFullEnvironment = (environment?: VerificationEnvironment) =>
  environment?.fidelity === 'full' && environment.real.length > 0 && environment.substituted.length === 0

/** Why a saved test failed. `output` is bounded, sanitized container output and is untrusted data. */
export interface VerificationFailureDetail {
  stage: string
  code: string
  retryable: boolean
  hint: string
  exitCode?: number
  output?: string
}

/** Who runs an approved test. `parent` and `child` are live agents that run the container themselves and mark the result.
 * `kraflr` exists only for the bundled self-test fixture, which is never offered for a researched lead. */
export type VerificationExecutor = 'kraflr' | 'parent' | 'child'
export const isAgentExecutor = (executor?: VerificationExecutor) => executor === 'parent' || executor === 'child'

export interface VerificationLease {
  agentId: string
  agentLabel: string
  expiresAt: string
}

/** What an agent says it ran. Kraflr cannot verify this, so it is stored as a claim next to the observation. */
export interface VerificationReport {
  reportedAt: string
  via: 'agent-docker'
  command?: string
  exitCode?: number
}

export interface VerificationRecord {
  failure?: VerificationFailureDetail
  executor?: VerificationExecutor
  lease?: VerificationLease
  report?: VerificationReport
  id: string
  panelId: string
  leadId: string
  scopeVersion: number
  plan: VerificationPlan
  planHash: string
  status: VerificationStatus
  createdAt: string
  expiresAt: string
  decision?: { choice: 'approve' | 'deny'; at: string; note: string; saveFindingOnSuccess?: boolean }
  leadReviewVersion?: number
  finishedAt?: string
  detail?: string
  observation?: FixtureObservation | ProjectObservation
  finding?: { note: string; acceptedAt: string; acceptance?: 'conditional' }
  /** Set when the agent's report showed the hypothesis does not hold (control passed, not reproduced) and the lead was closed. */
  killedLead?: { note: string; killedAt: string }
  cleanupPending?: boolean
}

export interface VerificationPageData {
  leadId: string | null
  canRequest: boolean
  records: VerificationRecord[]
}

export interface VerificationQueueData {
  records: VerificationRecord[]
  more: boolean
}

export interface VerificationAvailability {
  ready: boolean
  detail: string
  image: string
}

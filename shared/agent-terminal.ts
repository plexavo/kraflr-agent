export const agentKinds = ['opencode', 'cline', 'claude'] as const
export type AgentKind = typeof agentKinds[number]
/** Kinds that run as the provider's own terminal UI in a Kraflr pane, reporting lifecycle through hooks. OpenCode is driven through its local API instead. */
export const nativeAgentKinds = ['cline', 'claude'] as const
export type NativeAgentKind = typeof nativeAgentKinds[number]
export const isNativeKind = (kind: AgentKind): kind is NativeAgentKind => (nativeAgentKinds as readonly string[]).includes(kind)
export type AgentMode = 'terminal' | 'cline-worker'
export const maxActiveAgents = 4

export const agentDetails = {
  opencode: { name: 'OpenCode', installUrl: 'https://opencode.ai/docs' },
  cline: { name: 'Cline', installUrl: 'https://cline.bot/cli' },
  claude: { name: 'Claude Code', installUrl: 'https://code.claude.com/docs/en/overview' },
} satisfies Record<AgentKind, { name: string; installUrl: string }>

export interface AgentInstallation {
  kind: AgentKind
  installed: boolean
}

export interface AgentTelemetry {
  model?: string
  usage?: { tokens: number; kind: 'session' | 'context' }
}

export interface AgentTerminalInfo extends AgentTelemetry {
  id: string
  panelId: string
  kind: AgentKind
  mode: AgentMode
  label: string
  state: 'running' | 'stopping' | 'exited' | 'offline'
  startedAt: string
  exitCode: number | null
  scopeVersion: number | null
  chat: boolean
  parent: boolean
  modelSelectionRequired?: boolean
  promptReady?: boolean
  readinessReason?: string
  activity?: 'starting'|'idle'|'working'
  /** A prompt has been submitted to this session since it started, by the researcher or by Kraflr. */
  prompted?: boolean
  detail?: string
  /** Why this agent can no longer continue. Cleared when it completes a turn again. */
  stoppage?: AgentStoppage
}

export interface AgentStoppage {
  kind: 'limit' | 'error' | 'exited'
  reason: string
  at: string
}

/** Provider messages that mean the account or model has run out of allowance, as opposed to an ordinary failure. */
export const limitPattern = /usage limit|rate.?limit|limit reached|hit your .{0,24}limit|quota (?:exceeded|exhausted)|out of (?:usage|credits)|credit balance is too low|insufficient (?:credits|quota|balance)|too many requests|\b429\b/i
export const stoppageKind = (text: string): 'limit' | 'error' => limitPattern.test(text) ? 'limit' : 'error'

export interface SavedAgentSession {
  role?: 'parent'|'child'|null
  id: string
  panelId: string
  kind: AgentKind
  mode: AgentMode
  label: string
  startedAt: string
  scopeVersion: number | null
  nativeId: string | null
  model?: string | null
}

export interface WorkerModels {
  current: string | null
  choices: { id: string; name: string }[]
  notice?: string
}

export function isActiveAgent(session: AgentTerminalInfo) {
  return session.state === 'running' || session.state === 'stopping'
}

export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant' | 'activity'
  text: string
}

export interface AgentPermission {
  id: string
  fingerprint: string
  action: string
  resources: string[]
  description?: string
  canApprove: boolean
}

export type AgentPermissionDecision = 'once' | 'reject'

export interface AgentAttention {
  panelId: string
  terminalId: string
  permissions: AgentPermission[]
  question: boolean
  unavailable?: boolean
}

export interface TerminalSize {
  cols: number
  rows: number
}

export interface LaunchTerminalInput extends TerminalSize {
  role?: 'parent'|'child'
  prepareRepository?: boolean
  kind: AgentKind
  mode?: AgentMode
  label?: string
}

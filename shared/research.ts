export const researchTypes = ['source', 'web'] as const
export type ResearchType = (typeof researchTypes)[number]

export const researchLabels: Record<ResearchType, string> = {
  source: 'Open-source code review',
  web: 'Web application testing',
}

export const scopeFields = {
  targetName: 150,
  repository: 500,
  revision: 200,
  webTargets: 2000,
  labTargets: 2000,
  labPath: 1000,
  workspacePath: 1000,
  repositoryDiscovery: 4000,
  allowedActions: 4000,
  restrictions: 4000,
  // Rules of engagement can run to several pages, and agents are given them whole.
  notes: 20000,
  /** A link to the rules of engagement, or the file they were loaded from. */
  roeReference: 1000,
} as const

export const repositoryModes = ['known', 'discover'] as const
export const accessModes = ['read_only', 'read_write', 'unspecified'] as const
export type AccessMode = (typeof accessModes)[number]
export const accessLabels: Record<AccessMode, string> = {
  read_only: 'Read only',
  read_write: 'Read and write',
  unspecified: 'Access mode unspecified',
}

export type ScopeTextField = keyof typeof scopeFields
export type ScopeInput = Record<ScopeTextField, string> & {
  repositoryMode: (typeof repositoryModes)[number]
  accessMode: AccessMode
}

export const emptyScope: ScopeInput = {
  targetName: '',
  repository: '',
  revision: '',
  webTargets: '',
  labTargets: '',
  labPath: '',
  workspacePath: '',
  repositoryDiscovery: '',
  repositoryMode: 'known',
  accessMode: 'read_only',
  allowedActions: '',
  restrictions: '',
  notes: '',
  roeReference: '',
}

export interface ScopeRevision extends ScopeInput {
  checkoutPath?: string
  resolvedCommit?: string
  version: number
  savedAt: string
}

export interface Panel {
  id: string
  name: string
  type: ResearchType
  createdAt: string
  updatedAt: string
  scopeVersion: number
  repositoryMode: ScopeInput['repositoryMode'] | null
}

export interface PanelDetail extends Panel {
  checkout?: RepositoryCheckout
  scopeHistory: ScopeRevision[]
}

export interface RepositoryCheckout {
  panelId: string
  scopeVersion: number
  repository: string
  path: string
  commit: string
  preparedAt: string
}

export interface CreatePanelInput {
  name: string
  type: ResearchType
}

export interface SaveScopeInput {
  expectedVersion: number
  scope: ScopeInput
}

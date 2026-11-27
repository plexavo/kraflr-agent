import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import type { ScopeRevision } from '../shared/research.ts'
import { StoreError } from './db.ts'
import type { GatewayServerConfig } from './mcp-gateway-config.ts'

export function managedAgentPolicy(scope: ScopeRevision, cwd?: string, gateway?: GatewayServerConfig) {
  const permissions = [
    { action: '*', resource: '*', effect: 'ask' },
    ...['read', 'glob', 'grep', 'webfetch', 'websearch'].map((action) => ({ action, resource: '*', effect: 'allow' })),
    { action: 'external_directory', resource: '*', effect: 'ask' },
    { action: 'read', resource: '*.env', effect: 'ask' },
    { action: 'read', resource: '*.env.*', effect: 'ask' },
    { action: 'read', resource: '*.env.example', effect: 'allow' },
    { action: 'subagent', resource: '*', effect: 'deny' },
    { action: 'execute', resource: '*', effect: 'deny' },
  ]
  const policies = [
    { action: 'tool.use', resource: 'execute:*', effect: 'deny' },
    { action: 'tool.use', resource: 'subagent:*', effect: 'deny' },
  ]
  const repository = scope.checkoutPath ?? scope.repository
  if (scope.repositoryMode === 'known' && isAbsolute(repository)) {
    let root = ''
    try {
      if (statSync(repository).isDirectory()) root = realpathSync(repository).replaceAll('\\', '/').replace(/\/$/, '')
    } catch { /* Missing clones require explicit attention. */ }
    if (root) {
      permissions.push({ action: 'external_directory', resource: `${root}/*`, effect: 'allow' })
      if (scope.accessMode === 'read_only') {
        policies.push({ action: 'tool.use', resource: `edit:${root}/*`, effect: 'deny' })
        // Installed OpenCode also checks Location-relative edit paths outside its cwd.
        if (cwd) {
          const local = relative(realpathSync(cwd), root).replaceAll('\\', '/')
          policies.push({ action: 'tool.use', resource: `edit:${local ? `${local}/` : ''}*`, effect: 'deny' })
        }
      }
    }
  }
  return {
    permissions, policies,
    // One server exposes Semgrep plus whatever Burp Suite's own MCP server reports, instead of one entry per third-party tool.
    // OpenCode nests server entries under mcp.servers, not directly under mcp, and has no "enabled" field (only
    // "disabled", defaulting to false) — a server is on unless explicitly turned off.
    ...(gateway ? { mcp: { servers: { kraflr: { type: 'local', command: [gateway.command, ...gateway.args], environment: gateway.env } } } } : {}),
  }
}

export function prepareAgentPolicy(cwd: string, scope: ScopeRevision, gateway?: GatewayServerConfig) {
  const directory = join(cwd, '.opencode')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink()) throw new StoreError(409, 'The scratch configuration is linked elsewhere. Start a fresh agent session.')
  const target = join(directory, 'opencode.json')
  let previous: Record<string, unknown> = {}
  try {
    if (lstatSync(target).isSymbolicLink()) throw new StoreError(409, 'The scratch configuration is linked elsewhere. Start a fresh agent session.')
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid configuration.')
    previous = parsed as typeof previous
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof StoreError) throw error
      throw new StoreError(409, 'The scratch configuration could not be verified. Start a fresh agent session.')
    }
  }
  const temporary = join(directory, `kraflr-policy-${randomUUID()}.tmp`)
  writeFileSync(temporary, JSON.stringify({ ...previous, ...managedAgentPolicy(scope, cwd, gateway) }, null, 2), { flag: 'wx', mode: 0o600 })
  try { renameSync(temporary, target) }
  finally { try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
}

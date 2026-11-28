import type { GatewayServerConfig } from '../server/mcp-gateway-config.ts'

/** Session-only Claude Code settings (passed with --settings). They carry Kraflr's lifecycle hooks and nothing from the researcher's own configuration. */
const portable = (path: string) => path.replaceAll('\\', '/')

/** How freely a session may act. "free" is the default: the agent works like a plain Claude Code session without asking before each action. */
export type Autonomy = 'free' | 'ask'

/** KRAFLR_PERMISSIONS=ask brings back Claude Code's own approval prompts for every session this runtime starts. */
export const autonomyFromEnvironment = (value = process.env.KRAFLR_PERMISSIONS): Autonomy => value === 'ask' ? 'ask' : 'free'

/** Tools a free session may use without asking. A bare tool name allows every use of it; the hooks below still apply. */
const freeTools = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent']

export function claudeHookCommand(node: string, script: string, event: string) {
  // Claude Code runs hook commands through a POSIX shell (Git Bash on Windows). Forward slashes and double quotes keep paths with spaces intact.
  return '"' + portable(node) + '" "' + portable(script) + '" ' + event
}

export function claudeSettings(node: string, script: string, autonomy: Autonomy = 'free', hasGateway = false) {
  const hook = (event: string) => ({ hooks: [{ type: 'command', command: claudeHookCommand(node, script, event), timeout: 10 }] })
  return {
    hooks: {
      SessionStart: [hook('SessionStart')], UserPromptSubmit: [hook('UserPromptSubmit')], Stop: [hook('Stop')], StopFailure: [hook('StopFailure')],
      PreToolUse: [{ matcher: 'Bash|Agent|Task|TeamCreate|TeamDelete|SendMessage|Edit|Write|MultiEdit|NotebookEdit', ...hook('PreToolUse') }],
      // Shell commands, file reads, fetches and gateway calls are recorded for the researcher after they run. The hook never changes a decision.
      PostToolUse: [{ matcher: '^(?:Bash|Read|Write|Edit|MultiEdit|WebFetch|WebSearch|mcp__kraflr__.*)$', ...hook('PostToolUse') }],
    },
    // Bypass mode stays disabled: a free session is pre-allowed tool by tool, so Claude Code never shows its bypass warning and the hooks still run.
    permissions: { disableBypassPermissionsMode: 'disable', ...(autonomy === 'free' ? { allow: hasGateway ? [...freeTools, 'mcp__kraflr'] : freeTools } : {}) },
  }
}

/**
 * A separate --mcp-config file, not part of --settings: Claude Code only loads mcpServers from --mcp-config (or a
 * project .mcp.json), never from --settings — a plain settings.json "mcpServers" key is silently ignored.
 */
export function claudeMcpConfig(gateway: GatewayServerConfig) {
  return { mcpServers: { kraflr: { type: 'stdio', command: gateway.command, args: gateway.args, env: gateway.env } } }
}

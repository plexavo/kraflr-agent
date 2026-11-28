import { join } from 'node:path'

export interface GatewayServerConfig { command: string; args: string[]; env: Record<string, string> }

/**
 * The one MCP server every agent session is given: Kraflr's own gateway (`server/mcp-gateway.ts`), which exposes
 * Semgrep directly and proxies whatever Burp Suite's own MCP server reports. Each agent CLI wires this single
 * descriptor into its own config instead of a separate entry per third-party tool.
 *
 * The gateway is handed the data folder, not the Burp URL: it reads the saved URL when it needs it, so a URL set
 * or changed after a session started still reaches that session. KRAFLR_BURP_MCP_URL, when set, is passed through as an override.
 */
export function gatewayServerConfig(node: string, root: string, dataDir?: string, override = process.env.KRAFLR_BURP_MCP_URL, responseDir?: string): GatewayServerConfig {
  const env: Record<string, string> = {}
  if (dataDir) env.KRAFLR_SETTINGS_DIR = dataDir
  // Where this session's long web responses are saved whole when the gateway shortens them.
  if (responseDir) env.KRAFLR_RESPONSE_DIR = responseDir
  if (override?.trim()) env.KRAFLR_BURP_MCP_URL = override.trim()
  return { command: node, args: [join(root, 'server', 'mcp-gateway.ts')], env }
}

/**
 * Cline reads MCP servers from a single settings file (CLINE_MCP_SETTINGS_PATH, otherwise its global one), never from the project folder. A
 * Kraflr session is pointed at its own file, which keeps the researcher's servers and adds the gateway.
 */
export function clineMcpSettings(existing: string, gateway: GatewayServerConfig) {
  let servers: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(existing) as { mcpServers?: unknown }
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) servers = parsed.mcpServers as Record<string, unknown>
  } catch { /* No settings file yet, or one Cline itself could not read. */ }
  return { mcpServers: { ...servers, kraflr: { transport: { type: 'stdio', command: gateway.command, args: gateway.args, env: gateway.env } } } }
}

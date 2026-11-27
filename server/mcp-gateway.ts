import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { runSemgrepProcess, summarize, type SemgrepSpawn } from './semgrep-scan.ts'
import { resolveBurpUrl } from './kraflr-settings.ts'
import { burpFailure, burpHint } from '../shared/burp.ts'

const semgrepTool: Tool = {
  name: 'semgrep_scan',
  description: 'Run a Semgrep static-analysis pass over a path in the current session workspace and list what it finds, highest severity first. Each hit is a reachability question to answer yourself, not a confirmed finding — most are noise.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path, or relative to the current workspace. Defaults to the whole workspace.' },
      config: { type: 'string', description: 'A semgrep --config value (ruleset name, registry id, or local path). Defaults to "auto".' },
    },
  },
}

const burpStatusTool: Tool = {
  name: 'burp_status',
  description: 'Report whether this gateway is connected to a Burp Suite MCP server, and which Burp tools (if any) it is proxying.',
  inputSchema: { type: 'object', properties: {} },
}

const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], ...(isError ? { isError } : {}) })

type BurpConnect = (url: string) => Promise<Client>

const defaultBurpConnect: BurpConnect = async (url) => {
  const client = new Client({ name: 'kraflr-gateway', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

/**
 * One MCP server for every Kraflr agent session, instead of wiring Burp's MCP server and Semgrep's into each agent CLI
 * separately. It exposes `semgrep_scan` itself, and — once the researcher has set their running Burp Suite's MCP
 * endpoint — proxies whatever tools Burp currently reports, prefixed `burp_`, forwarding each call through unchanged.
 * An agent configures one server ("kraflr") and sees both; Kraflr never bundles or starts Burp itself.
 */
export function createGateway(options: { burpUrl?: string | (() => string | undefined); runSemgrep?: SemgrepSpawn; connectBurp?: BurpConnect } = {}) {
  // Asked every time, so a URL saved or changed after this session started is picked up without restarting it.
  const currentUrl = () => (typeof options.burpUrl === 'function' ? options.burpUrl() : options.burpUrl)?.trim() || undefined
  const connect = options.connectBurp ?? defaultBurpConnect
  type BurpLink = { url: string; client: Client; tools: Tool[] }
  let link: BurpLink | undefined
  let lastError: string | undefined
  let connecting: { url: string; done: Promise<BurpLink | undefined> } | undefined
  // The endpoint whose tools the agent was last given ('' for none), so it can be told when its list is out of date.
  let listed: string | undefined

  function drop() { const old = link; link = undefined; void old?.client.close().catch(() => {}) }

  // Retried on the next request rather than remembered forever, since Burp may start after the agent session does.
  function connectBurp(): Promise<BurpLink | undefined> {
    const url = currentUrl()
    if (link && link.url !== url) drop()
    if (link) return Promise.resolve(link)
    if (!url) return Promise.resolve(undefined)
    if (connecting?.url === url) return connecting.done
    const done = (async () => {
      try {
        const client = await connect(url)
        const { tools } = await client.listTools()
        lastError = undefined
        return link = { url, client, tools }
      } catch (error) {
        lastError = burpFailure(error)
        return undefined
      } finally { if (connecting?.url === url) connecting = undefined }
    })()
    connecting = { url, done }
    return done
  }

  /** The link after proving it still answers: a restarted Burp ends the old session, which then needs a new one. */
  async function checkedBurp() {
    const existing = link
    const result = await connectBurp()
    if (!result || result !== existing) return result
    try { result.tools = (await result.client.listTools()).tools; return result }
    catch { drop(); return connectBurp() }
  }

  async function callSemgrepScan(args: Record<string, unknown>) {
    const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : process.cwd()
    const config = typeof args.config === 'string' && args.config.trim() ? args.config.trim() : undefined
    const run = await runSemgrepProcess(path, config, options.runSemgrep)
    if (!run.ok) return text('semgrep did not run: ' + run.reason + '. Install it (pip install semgrep, or see semgrep.dev) and try again, or just read the code yourself.', true)
    if (!run.results.length) return text('semgrep ran clean: no hits in ' + path + '.')
    return text(`${run.results.length} hit(s), highest severity first:\n${summarize(run.results, 20_000)}`)
  }

  async function callBurpStatus() {
    const url = currentUrl()
    if (!url) return text('Burp is not configured: no Burp MCP URL is saved. Ask the researcher to set it in Kraflr under Agent controls → Research tools → Set Burp MCP URL, then call burp_status again; no restart is needed.')
    const result = await checkedBurp()
    announce(result)
    const hint = burpHint(url, lastError)
    if (!result) return text('Burp MCP is configured at ' + url + ' but not reachable: ' + (lastError ?? 'unknown error') + '. Make sure Burp Suite is running with its MCP server enabled.' + (hint ? ' ' + hint : ''), true)
    return text(`Connected to Burp MCP at ${url}. Proxying ${result.tools.length} tool(s): ${result.tools.map((tool) => 'burp_' + tool.name).join(', ') || '(none reported)'}. If these are not in your tool list yet, this CLI has not refreshed it: the researcher can reopen this agent session.`)
  }

  const server = new Server({ name: 'kraflr', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
  /** Tell the agent to fetch the tool list again when Burp has appeared, gone or moved since it last did. */
  function announce(result: BurpLink | undefined) {
    if (listed === undefined || listed === (result?.url ?? '')) return
    void server.sendToolListChanged().catch(() => {})
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await connectBurp()
    listed = result?.url ?? ''
    const burpTools: Tool[] = (result?.tools ?? []).map((tool) => ({ ...tool, name: 'burp_' + tool.name }))
    return { tools: [semgrepTool, burpStatusTool, ...burpTools] }
  })
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    if (name === 'semgrep_scan') return callSemgrepScan(args ?? {})
    if (name === 'burp_status') return callBurpStatus()
    if (name.startsWith('burp_')) {
      const result = await connectBurp()
      announce(result)
      if (!result) return text('Burp MCP is not connected. Call burp_status for details.', true)
      const original = name.slice('burp_'.length)
      if (!result.tools.some((tool) => tool.name === original)) return text('Burp does not report a tool named ' + original + '.', true)
      // A failed call is not repeated, since it may already have sent a request; the next one reconnects.
      try { return await result.client.callTool({ name: original, arguments: args }) }
      catch (error) { drop(); throw error }
    }
    return text('Unknown tool: ' + name, true)
  })
  return server
}

if (import.meta.main) {
  const settings = process.env.KRAFLR_SETTINGS_DIR
  // Without a settings folder only the environment counts; a settings file in the working folder is never trusted.
  await createGateway({ burpUrl: () => settings ? resolveBurpUrl(settings) : process.env.KRAFLR_BURP_MCP_URL }).connect(new StdioServerTransport())
}

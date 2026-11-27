import { spawn, type ChildProcess } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { burpFailure } from '../shared/burp.ts'

export interface GatewayStatus {
  semgrep: { available: boolean; version?: string; reason?: string }
  burp: { configured: boolean; url?: string; connected?: boolean; tools?: number; reason?: string }
}

/** `semgrep --version` prints an upgrade notice above the version line on an outdated install, so the version is whichever line matches X.Y.Z, not necessarily the last one. */
function parseSemgrepVersion(output: string): string | undefined {
  return output.split('\n').map((line) => line.trim()).find((line) => /^\d+\.\d+\.\d+$/.test(line))
}

function checkSemgrep(runSemgrep: (args: string[]) => ChildProcess = (args) => spawn('semgrep', args, { stdio: ['ignore', 'pipe', 'ignore'], signal: AbortSignal.timeout(5000) })): Promise<GatewayStatus['semgrep']> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try { child = runSemgrep(['--version']) } catch (error) { resolve({ available: false, reason: error instanceof Error ? error.message : 'semgrep could not be started' }); return }
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => { if (out.length < 10_000) out += chunk })
    child.on('error', (error) => resolve({ available: false, reason: error.name === 'AbortError' ? 'semgrep did not respond in time' : 'semgrep could not be started: ' + error.message }))
    child.on('close', (code) => {
      if (code !== 0) { resolve({ available: false, reason: 'semgrep exited with code ' + code }); return }
      resolve({ available: true, version: parseSemgrepVersion(out) })
    })
  })
}

async function checkBurp(url: string | undefined, connect: (url: string) => Promise<Client> = defaultConnect): Promise<GatewayStatus['burp']> {
  if (!url?.trim()) return { configured: false }
  try {
    const client = await connect(url.trim())
    const { tools } = await client.listTools(undefined, { timeout: 5000 })
    await client.close()
    return { configured: true, url, connected: true, tools: tools.length }
  } catch (error) {
    return { configured: true, url, connected: false, reason: burpFailure(error) }
  }
}

async function defaultConnect(url: string): Promise<Client> {
  const client = new Client({ name: 'kraflr-status', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: 5000 })
  return client
}

/**
 * An on-demand, live check of the same two things the per-session gateway (server/mcp-gateway.ts) relies on, run from
 * Kraflr's own core process so the researcher can see tool-gateway health without needing a running agent at all.
 */
export function checkGatewayStatus(burpUrl: string | undefined, overrides: { runSemgrep?: Parameters<typeof checkSemgrep>[0]; connectBurp?: Parameters<typeof checkBurp>[1] } = {}): Promise<GatewayStatus> {
  return Promise.all([
    checkSemgrep(overrides.runSemgrep),
    checkBurp(burpUrl, overrides.connectBurp),
  ]).then(([semgrep, burp]) => ({ semgrep, burp }))
}

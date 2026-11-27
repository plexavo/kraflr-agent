import { RpcClient } from './ipc.ts'
import { mentionsContainerTool } from '../shared/containers.ts'

/**
 * Asks the runtime whether a shell command would start a submitted verification lab outside its approved run. Only commands that name a container
 * tool are sent. An unreachable runtime refuses nothing: a detached session keeps working as the researcher's own tool.
 */
export async function labRefusal(command: string, cwd: string): Promise<string | undefined> {
  if (!mentionsContainerTool(command) || command.length > 20_000) return
  if (!process.env.KRAFLR_SOCKET) return
  let client: RpcClient | undefined
  try {
    client = new RpcClient({ socket: process.env.KRAFLR_SOCKET, token: process.env.KRAFLR_AGENT_TOKEN ?? '', agent: process.env.KRAFLR_AGENT_ID })
    const result = await client.call('guard', { command, cwd }, 8000) as { reason?: unknown } | undefined
    return typeof result?.reason === 'string' ? result.reason : undefined
  } catch { return undefined }
  finally { client?.close() }
}

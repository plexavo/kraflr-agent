import { RpcClient } from './ipc.ts'
import { labRefusal } from './guard-client.ts'
let raw = ''
for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) break }
/** Every string a shell tool was given. Its input may arrive as an object, a list of commands or JSON text. */
function words(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') {
    if (depth < 4 && /^\s*[[{]/.test(value)) { try { return words(JSON.parse(value), depth + 1) } catch { /* Plain text that only looks like JSON. */ } }
    return [value]
  }
  return depth < 4 && value && typeof value === 'object' ? Object.values(value).flatMap((item) => words(item, depth + 1)) : []
}
try {
  const event = JSON.parse(raw || '{}')
  const client = new RpcClient({ socket: process.env.KRAFLR_SOCKET ?? '', token: process.env.KRAFLR_AGENT_TOKEN ?? '', agent: process.env.KRAFLR_AGENT_ID })
  const names: Record<string,string> = { agent_start:'TaskStart', prompt_submit:'UserPromptSubmit', agent_end:'TaskComplete', agent_error:'TaskError', agent_abort:'TaskCancel' }
  const name = event.hookName ?? event.hookEventName ?? process.argv[2]
  if(name==='tool_call'||name==='PreToolUse'){
    client.close()
    const tool=event.tool_call?.name??event.preToolUse?.toolName
    const refuse=(errorMessage:string)=>{process.stdout.write(JSON.stringify({cancel:true,errorMessage})+'\n');process.exit(0)}
    if(typeof tool==='string'&&/^(team_|spawn_agent$|delegate$|delegate_task$|task$|send_message$)/.test(tool)){
      refuse('Use existing Kraflr teammates through kraflr agent context / ask. Untracked agent creation and native team handoffs are disabled.')
    }
    if(typeof tool==='string'&&/command|bash|shell|terminal|exec/i.test(tool)){
      const command=words(event.tool_call?.input??event.tool_call?.arguments??event.preToolUse?.parameters??event.preToolUse?.input).join('\n')
      const reason=await labRefusal(command,typeof event.workspaceRoots?.[0]==='string'?event.workspaceRoots[0]:'')
      if(reason)refuse(reason)
    }
    process.stdout.write('{}\n');process.exit(0)
  }
  try { await client.call('hook', { name: names[name] ?? name,
    sessionId: event.sessionContext?.rootSessionId ?? event.sessionId ?? event.taskId, text: event.turn?.outputText ?? event.result?.text ?? event.outputText ?? '',
    prompt:event.userPromptSubmit?.prompt,timestamp:event.timestamp,
    status: event.result?.status ?? event.turn?.status }, 3000) } finally { client.close() }
} catch { /* A detached/unavailable client must not change a native tool decision. */ }
process.stdout.write('{}\n')

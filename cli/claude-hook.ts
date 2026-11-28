import { open, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { RpcClient } from './ipc.ts'
import { labRefusal } from './guard-client.ts'

/** Claude Code lifecycle hook for Kraflr sessions. Reads one event on stdin, relays it to the runtime, and never changes a permission decision
 * except to deny three things Kraflr must track itself: untracked sub-agents, edits to a read-only source checkout, and starting a submitted
 * verification lab outside its approved run. It also passes back the runtime's reminders to record research (see recording.ts). */

let raw = ''
for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 2 * 1024 * 1024) break }
const reply = (value: object = {}) => process.stdout.write(JSON.stringify(value) + '\n')

const untracked = /^(?:Agent|Task|TeamCreate|TeamDelete|SendMessage)$/
const writers = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

function inside(root: string, target: string) {
  const offset = relative(resolve(root), resolve(target))
  return samePath(offset, '') || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep))
}

function denial(event: { tool_name?: unknown; tool_input?: Record<string, unknown> }) {
  const tool = typeof event.tool_name === 'string' ? event.tool_name : ''
  // A free session may use Claude Code's own sub-agents like any plain session; only an "ask" session routes teamwork through Kraflr.
  if (process.env.KRAFLR_AUTONOMY === 'ask' && untracked.test(tool)) return 'Use existing Kraflr teammates through kraflr agent context / ask. Untracked agent creation and native team handoffs are disabled.'
  const root = process.env.KRAFLR_READONLY_ROOT
  const file = event.tool_input?.file_path ?? event.tool_input?.notebook_path
  if (root && writers.test(tool) && typeof file === 'string' && inside(root, file)) {
    return 'This research panel has read-only access to the source checkout. Write notes, harnesses and lab files in your session or lab folder instead.'
  }
}

/** What a gateway tool was pointed at: for a Burp request only the host and request line, never its headers or cookies. */
function gatewayCall(input: Record<string, unknown>) {
  const pseudo = (input.pseudoHeaders ?? {}) as Record<string, unknown>
  const line = typeof input.content === 'string' ? input.content.split(/\r?\n|\\r|\\n/)[0]
    : [pseudo[':method'] ?? pseudo.method, pseudo[':path'] ?? pseudo.path].filter(Boolean).join(' ')
  return [input.targetHostname, line, input.path, input.regex].filter((part) => typeof part === 'string' && part).join(' ')
}

// Claude Code can write the final message to its transcript slightly after Stop fires, so this is only a fallback for last_assistant_message.
async function transcriptText(path: unknown) {
  if (typeof path !== 'string' || !isAbsolute(path)) return ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const file = await open(path, 'r')
      try {
        const size = (await stat(path)).size, length = Math.min(size, 256 * 1024), buffer = Buffer.alloc(length)
        await file.read(buffer, 0, length, size - length)
        for (const line of buffer.toString('utf8').split('\n').reverse()) {
          try {
            const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } }
            if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue
            const text = (entry.message.content as { type?: string; text?: string }[]).filter((block) => block.type === 'text' && block.text).map((block) => block.text).join('\n').trim()
            if (text) return text
          } catch { /* A partially written line is skipped. */ }
        }
      } finally { await file.close() }
    } catch { /* The transcript may not exist yet. */ }
    await new Promise((done) => setTimeout(done, 200))
  }
  return ''
}

try {
  const event = JSON.parse(raw || '{}') as Record<string, any>
  const name = String(event.hook_event_name ?? process.argv[2] ?? '')
  if (name === 'PreToolUse') {
    const command = event.tool_name === 'Bash' ? event.tool_input?.command : undefined
    const reason = denial(event) ?? (typeof command === 'string' ? await labRefusal(command, typeof event.cwd === 'string' ? event.cwd : '') : undefined)
    reply(reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {})
    process.exit(0)
  }
  if (name === 'PostToolUse') {
    // A record of what the agent did, including tools that never touch the scope proxy. Bounded and best effort: it must not slow or change the tool.
    const tool = String(event.tool_name ?? ''), input = (event.tool_input ?? {}) as Record<string, unknown>
    const summary = String(tool === 'Bash' ? input.command ?? '' : tool === 'WebFetch' ? input.url ?? '' : tool === 'WebSearch' ? input.query ?? ''
      : tool.startsWith('mcp__') ? gatewayCall(input) : input.file_path ?? input.notebook_path ?? '').slice(0, 600)
    let context: unknown
    if (/^[A-Za-z0-9_]{2,80}$/.test(tool) && summary) {
      const client = new RpcClient({ socket: process.env.KRAFLR_SOCKET ?? '', token: process.env.KRAFLR_AGENT_TOKEN ?? '', agent: process.env.KRAFLR_AGENT_ID })
      try { context = ((await client.call('activity', { tool, summary }, 1500)) as { context?: unknown } | undefined)?.context } catch { /* Recording is optional. */ } finally { client.close() }
    }
    reply(typeof context === 'string' ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } } : {}); process.exit(0)
  }
  const kinds: Record<string, string> = { SessionStart: 'SessionStart', UserPromptSubmit: 'UserPromptSubmit', Stop: 'TaskComplete', StopFailure: 'TaskError' }
  const mapped = kinds[name]
  if (mapped) {
    const text = mapped === 'TaskComplete' || mapped === 'TaskError'
      ? String(event.last_assistant_message ?? '') || await transcriptText(event.transcript_path) || String(event.error_details ?? '')
      : ''
    const payload = {
      name: mapped, sessionId: typeof event.session_id === 'string' ? event.session_id : undefined, text,
      prompt: mapped === 'UserPromptSubmit' && typeof event.prompt === 'string' ? event.prompt : undefined,
      // StopFailure names why the turn ended (rate_limit, authentication_failed, billing_error...); Kraflr uses it to tell a limit from an ordinary failure.
      error: mapped === 'TaskError' && typeof event.error === 'string' ? event.error : undefined,
      timestamp: typeof event.prompt_id === 'string' ? event.prompt_id : new Date().toISOString(),
      // True when this turn was already continued by a Stop hook, so it is never held twice.
      continuing: mapped === 'TaskComplete' && event.stop_hook_active === true ? true : undefined,
    }
    // A completed turn is reported exactly once, so a busy runtime gets a few chances before the event is given up. Repeats are harmless:
    // the runtime resolves a waiting assignment once and saves a direct reply under its stable turn id.
    for (let attempt = 0; attempt < (mapped === 'SessionStart' ? 1 : 3); attempt++) {
      const client = new RpcClient({ socket: process.env.KRAFLR_SOCKET ?? '', token: process.env.KRAFLR_AGENT_TOKEN ?? '', agent: process.env.KRAFLR_AGENT_ID })
      try {
        // The runtime may answer with a reminder to record research: context beside a prompt, or one held turn. Neither is a permission decision.
        const answer = (await client.call('hook', payload, 3000)) as { context?: unknown; hold?: unknown } | undefined
        if (name === 'UserPromptSubmit' && typeof answer?.context === 'string') { reply({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: answer.context } }); process.exit(0) }
        if (name === 'Stop' && typeof answer?.hold === 'string') { reply({ decision: 'block', reason: answer.hold }); process.exit(0) }
        break
      }
      catch { await new Promise((done) => setTimeout(done, 400)) }
      finally { client.close() }
    }
  }
} catch { /* A detached or unavailable runtime must never change a native tool decision. */ }
reply()

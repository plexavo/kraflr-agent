import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NativePrompt } from '../cli/native-prompt.ts'
import { visibleAttention } from '../cli/activity.ts'
import { agentDetails, agentKinds, isNativeKind } from '../shared/agent-terminal.ts'
import { agentEnvironment, resolveAgent } from '../server/agent-terminals.ts'
import { teamInstructions } from '../cli/team-context.ts'

const rule = '─'.repeat(60)
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`
// Screens below reproduce what Claude Code 2.1 drew in a real pty capture: a composer framed by two rules, a dimmed example prompt, a footer.
const composer = (text: string) => `${rule}\r\n❯ ${text}\r\n${rule}\r\n  ? for shortcuts`
async function screen(text: string) {
  const prompt = new NativePrompt(100, 30, 'claude')
  await new Promise<void>((done) => prompt.output('\x1b[2J\x1b[H' + text, done))
  return prompt
}

test('Claude Code is a native agent kind with its own name and discovery override', () => {
  assert.ok(agentKinds.includes('claude')); assert.ok(isNativeKind('claude')); assert.ok(isNativeKind('cline')); assert.ok(!isNativeKind('opencode'))
  assert.equal(agentDetails.claude.name, 'Claude Code')
  assert.ok(agentEnvironment('claude').TERM); assert.equal('ANTHROPIC_API_KEY' in agentEnvironment('cline'), false, 'other agents never receive Claude credentials')
  const keys = ['ANTHROPIC_API_KEY', 'KRAFLR_CLAUDE_ENV'].map((name) => [name, process.env[name]] as const)
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key'; delete process.env.KRAFLR_CLAUDE_ENV
    assert.equal('ANTHROPIC_API_KEY' in agentEnvironment('claude'), false, 'an ambient API key must not silently replace the subscription login')
    process.env.KRAFLR_CLAUDE_ENV = 'ANTHROPIC_API_KEY, KRAFLR_AGENT_TOKEN, lowercase'
    const chosen = agentEnvironment('claude') as Record<string, string>
    assert.equal(chosen.ANTHROPIC_API_KEY, 'sk-test-not-a-real-key', 'the researcher can opt in by name'); assert.equal('KRAFLR_AGENT_TOKEN' in chosen, false, 'runtime credentials can never be forwarded')
  } finally { for (const [name, value] of keys) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  const original = process.env.KRAFLR_CLAUDE_EXE
  try { process.env.KRAFLR_CLAUDE_EXE = resolve('definitely-not-installed.exe'); assert.ok(resolveAgent('claude') !== resolve('definitely-not-installed.exe')) }
  finally { if (original === undefined) delete process.env.KRAFLR_CLAUDE_EXE; else process.env.KRAFLR_CLAUDE_EXE = original }
})

test('Claude Code prompt readiness distinguishes an empty composer from drafts, dialogs and setup screens', async () => {
  const idle = await screen(composer(dim('Try "how does <filepath> work?"')))
  assert.deepEqual(idle.status(false), { ready: true, reason: '' }, 'a dimmed example prompt is not a draft')
  assert.equal((await screen(composer(dim('Try "create a util logging.py that…"')))).status(false).ready, true, 'the example text changes between launches')
  assert.equal((await screen(composer(''))).status(false).ready, true)

  const draft = await screen(composer('Try "my own text that merely starts the same"'))
  assert.equal(draft.status(false).ready, false, 'the same words typed by a person are a draft because they are not dimmed')
  assert.equal((await screen(composer('/model'))).status(false).reason, 'Native prompt has a draft or menu')

  // After a turn, Claude Code also shows a dimmed "ghost text" guess at the researcher's next prompt, in free-form
  // wording that does not start with "Try \"" — still not real input, so it must not block readiness either.
  const suggestion = await screen(composer(dim('record findings')))
  assert.deepEqual(suggestion.status(false), { ready: true, reason: '' }, 'a dimmed next-prompt suggestion is ghost text, not a draft, whatever it says')

  const dialog = await screen(['Bash command', '  docker run --rm image', '', 'Do you want to proceed?', '❯ 1. Yes', "  2. Yes, and don't ask again", '  3. No, and tell Claude what to do differently (esc)'].join('\r\n'))
  assert.equal(dialog.status(false).reason, 'Needs your response')
  const trust = await screen(['Quick safety check: Is this a project you created or one you trust?', '', '❯ 1. Yes, I trust this folder', '  2. No, exit', 'Enter to confirm · Esc to cancel'].join('\r\n'))
  assert.match(trust.status(false).reason, /setup or trust choice|Needs your response/)
  assert.equal((await screen('Claude Code is starting…')).status(false).ready, false, 'an unrecognised screen is never ready')
})

test('a turn stays working until Claude Code reports it or its pane proves it ended', async () => {
  const prompt = await screen(composer(dim('Try "x"')))
  assert.equal(prompt.status(false).ready, true)
  prompt.hook('UserPromptSubmit')
  assert.deepEqual(prompt.status(false), { ready: false, reason: 'Working' })
  assert.equal(prompt.interrupted(), false, 'a turn that just started is not interrupted')
  assert.equal(prompt.interrupted(Date.now() + 10_000), true, 'an empty composer with no spinner for seconds means Esc ended the turn')
  const spinning = await screen(`✻ Thinking… (12s · esc to interrupt)\r\n${composer('')}`)
  spinning.hook('UserPromptSubmit')
  assert.equal(spinning.interrupted(Date.now() + 10_000), false, 'a visible spinner means the turn is still running')
  prompt.hook('TaskComplete')
  assert.equal(prompt.status(false).ready, true)
  const cline = new NativePrompt(100, 30, 'cline')
  cline.hook('UserPromptSubmit')
  assert.equal(cline.interrupted(Date.now() + 60_000), false, 'with no screen evidence of rest, a Cline turn is still running')
})

test('only recognised Claude Code dialogs are reported as approvals or questions', () => {
  const lines = (...text: string[]) => text
  assert.equal(visibleAttention(lines('Do you want to proceed?', '❯ 1. Yes', '  2. No'), 'claude'), 'approval')
  assert.equal(visibleAttention(lines('Do you trust the files in this folder?'), 'claude'), 'question')
  assert.equal(visibleAttention(lines('Enter to select · ↑/↓ to navigate · Esc to cancel'), 'claude'), 'question')
  assert.equal(visibleAttention(lines('Do you want to hear a joke?'), 'claude'), undefined, 'a question with no numbered Yes option is not an approval')
  assert.equal(visibleAttention(lines('Cline needs permission', '[y] Approve   [n] Deny'), 'claude'), undefined, 'another agent’s markers do not apply')
  assert.equal(visibleAttention(lines('Cline needs permission', '[y] Approve   [n] Deny'), 'cline'), 'approval')
})

test('Claude Code is told to use bash syntax for the bridge, never PowerShell', () => {
  const windows = teamInstructions('C:\\scratch', 'C:\\node.exe', 'C:\\kraflr.mjs', true), claude = teamInstructions('C:\\scratch', 'C:\\node.exe', 'C:\\kraflr.mjs', false)
  assert.match(windows, /PowerShell/); assert.doesNotMatch(claude, /PowerShell/); assert.match(claude, /verification docker/)
})

// --- the hook script, driven over a real local socket exactly as Claude Code drives it ---
const hook = resolve(import.meta.dirname, '..', 'cli', 'claude-hook.ts')
async function relay(answer: (message: any) => object = () => ({})) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-claude-hook-')))
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\kraflr-test-${randomUUID()}` : join(folder, 'runtime.sock')
  const received: any[] = []
  const server = createServer((connection) => {
    connection.setEncoding('utf8')
    let buffer = ''
    connection.on('data', (chunk: string) => {
      buffer += chunk
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
        received.push(message); connection.write(JSON.stringify({ id: message.id, result: answer(message) }) + '\n')
      }
    })
  })
  await new Promise<void>((done) => server.listen(socket, done))
  const run = (event: object, extra: Record<string, string> = {}, name = '') => new Promise<{ stdout: string; code: number | null }>((done) => {
    const child = spawn(process.execPath, [hook, name], { env: { ...process.env, KRAFLR_SOCKET: socket, KRAFLR_AGENT_ID: 'agent-1', KRAFLR_AGENT_TOKEN: 'token-1', ...extra }, stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('close', (code) => done({ stdout, code }))
    child.stdin.end(JSON.stringify(event))
  })
  return { folder, received, run, close: async () => { server.close(); await rm(folder, { recursive: true, force: true }) } }
}

test('the Claude hook relays lifecycle events, takes the final message from Stop and falls back to the transcript', async () => {
  const r = await relay()
  try {
    assert.equal((await r.run({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt: 'Review the handler', prompt_id: 'p1' })).stdout.trim(), '{}')
    assert.equal((await r.run({ hook_event_name: 'Stop', session_id: 'sess-1', last_assistant_message: 'The final answer', prompt_id: 'p1' })).code, 0)
    const transcript = join(r.folder, 'transcript.jsonl')
    await writeFile(transcript, [
      { type: 'user', message: { role: 'user', content: 'q' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier text' }, { type: 'tool_use', name: 'Read' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Transcript final answer' }] } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    await r.run({ hook_event_name: 'Stop', session_id: 'sess-1', transcript_path: transcript, prompt_id: 'p2' })
    await r.run({ hook_event_name: 'StopFailure', session_id: 'sess-1', error: 'rate_limit', last_assistant_message: 'API rate limit reached', prompt_id: 'p3' })
    await r.run({ hook_event_name: 'SessionStart', session_id: 'sess-1', source: 'startup' })
    await r.run({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    const calls = r.received.map((message) => ({ agent: message.agent, token: message.token, method: message.method, ...message.params }))
    assert.deepEqual(calls.map((call) => call.name), ['UserPromptSubmit', 'TaskComplete', 'TaskComplete', 'TaskError', 'SessionStart'], 'unrelated notifications are not forwarded')
    assert.ok(calls.every((call) => call.method === 'hook' && call.agent === 'agent-1' && call.token === 'token-1'))
    assert.equal(calls[0].prompt, 'Review the handler'); assert.equal(calls[0].sessionId, 'sess-1')
    assert.equal(calls[1].text, 'The final answer'); assert.equal(calls[1].timestamp, 'p1')
    assert.equal(calls[2].text, 'Transcript final answer')
    assert.equal(calls[3].text, 'API rate limit reached')
  } finally { await r.close() }
})

test('the Claude hook denies untracked sub-agents only in an ask session, always denies edits to a read-only checkout, and allows everything else', async () => {
  const r = await relay()
  try {
    const verdict = async (event: object, env: Record<string, string> = {}) => {
      const out = JSON.parse((await r.run({ hook_event_name: 'PreToolUse', ...event }, env)).stdout)
      return out.hookSpecificOutput?.permissionDecision as string | undefined
    }
    for (const tool of ['Agent', 'Task', 'TeamCreate', 'SendMessage']) {
      assert.equal(await verdict({ tool_name: tool, tool_input: {} }, { KRAFLR_AUTONOMY: 'ask' }), 'deny', tool)
      assert.equal(await verdict({ tool_name: tool, tool_input: {} }, { KRAFLR_AUTONOMY: 'free' }), undefined, tool + ' is allowed in a free session')
    }
    const checkout = join(r.folder, 'checkout')
    const readOnly = { KRAFLR_READONLY_ROOT: checkout }
    assert.equal(await verdict({ tool_name: 'Edit', tool_input: { file_path: join(checkout, 'src', 'a.php') } }, readOnly), 'deny')
    assert.equal(await verdict({ tool_name: 'Write', tool_input: { file_path: join(checkout, '..', 'checkout', 'b.php') } }, readOnly), 'deny', 'dot-dot paths are resolved first')
    assert.equal(await verdict({ tool_name: 'Write', tool_input: { file_path: join(r.folder, 'checkout-notes.md') } }, readOnly), undefined, 'a sibling folder with the same prefix is not the checkout')
    assert.equal(await verdict({ tool_name: 'Edit', tool_input: { file_path: join(checkout, 'src', 'a.php') } }), undefined, 'no read-only root, no restriction')
    assert.equal(await verdict({ tool_name: 'Read', tool_input: { file_path: join(checkout, 'src', 'a.php') } }, readOnly), undefined, 'reading stays allowed')
    assert.equal(await verdict({ tool_name: 'Bash', tool_input: { command: 'ls' } }, readOnly), undefined)
    assert.equal(r.received.length, 0, 'tool checks never need the runtime')
  } finally { await r.close() }
})

test('the Claude hook hands the runtime’s recording reminders back to Claude Code', async () => {
  const r = await relay((message) => message.method === 'activity' ? { context: 'Record it.' }
    : message.params.name === 'UserPromptSubmit' ? { context: '2 open leads.' } : message.params.continuing ? {} : { hold: 'Record before you finish.' })
  try {
    const out = async (event: object) => JSON.parse((await r.run(event)).stdout)
    assert.deepEqual(await out({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '2 open leads.' } })
    assert.deepEqual(await out({ hook_event_name: 'PostToolUse', tool_name: 'mcp__kraflr__burp_send_http1_request', tool_input: { targetHostname: 'app.example.test', content: 'GET /a HTTP/1.1\r\nCookie: secret=1\r\n\r\n' } }),
      { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Record it.' } })
    assert.equal(r.received.at(-1).params.summary, 'app.example.test GET /a HTTP/1.1', 'headers and cookies are never reported')
    assert.deepEqual(await out({ hook_event_name: 'Stop', last_assistant_message: 'Done', stop_hook_active: false }), { decision: 'block', reason: 'Record before you finish.' })
    assert.deepEqual(await out({ hook_event_name: 'Stop', last_assistant_message: 'Saved', stop_hook_active: true }), {})
  } finally { await r.close() }
})

test('with Kraflr unreachable the hook still exits cleanly and decides nothing', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'kraflr-claude-hook-down-')))
  try {
    const child = spawn(process.execPath, [hook, 'Stop'], { env: { ...process.env, KRAFLR_SOCKET: process.platform === 'win32' ? '\\\\.\\pipe\\kraflr-missing-' + randomUUID() : join(folder, 'none.sock'), KRAFLR_AGENT_ID: 'x', KRAFLR_AGENT_TOKEN: 'y' }, stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk })
    const code = await new Promise<number | null>((done) => { child.on('close', done); child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'text' })) })
    assert.equal(code, 0); assert.equal(stdout.trim(), '{}')
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('the Claude hook reports what a tool did to the runtime, bounded and without ever deciding anything', async () => {
  const r = await relay()
  try {
    const out = async (event: object) => (await r.run({ hook_event_name: 'PostToolUse', ...event })).stdout.trim()
    assert.equal(await out({ tool_name: 'Bash', tool_input: { command: 'curl -s http://127.0.0.1:8080/api/items?id=1' } }), '{}')
    assert.equal(await out({ tool_name: 'Read', tool_input: { file_path: '/work/app/src/export.php' } }), '{}')
    assert.equal(await out({ tool_name: 'WebFetch', tool_input: { url: 'https://example.test/docs' } }), '{}')
    assert.equal(await out({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(5000) } }), '{}')
    assert.equal(await out({ tool_name: 'Bash', tool_input: {} }), '{}', 'nothing to report, nothing sent')
    assert.equal(await out({ tool_name: 'Grep', tool_input: { pattern: 'x' } }), '{}')
    const activity = r.received.filter((call) => call.method === 'activity')
    assert.deepEqual(activity.map((call) => [call.params.tool, call.params.summary.slice(0, 40)]), [['Bash', 'curl -s http://127.0.0.1:8080/api/items?'], ['Read', '/work/app/src/export.php'], ['WebFetch', 'https://example.test/docs'], ['Bash', 'x'.repeat(40)]])
    assert.equal(activity[3].params.summary.length, 600)
    assert.ok(activity.every((call) => call.agent === 'agent-1' && call.token === 'token-1'))
  } finally { await r.close() }
})

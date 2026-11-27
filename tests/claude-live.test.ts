import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { address, RpcClient } from '../cli/ipc.ts'
import { resolveAgent } from '../server/agent-terminals.ts'
import { emptyScope } from '../shared/research.ts'

// Launches the real, signed-in Claude Code CLI inside a real Kraflr runtime. It submits no prompt (so it spends no model quota) and never
// accepts Claude Code's trust dialog (so it does not touch ~/.claude.json). Opt in with KRAFLR_LIVE_CLAUDE=1.
const enabled = process.env.KRAFLR_LIVE_CLAUDE === '1' && resolveAgent('claude')

test('a real Claude Code pane starts inside Kraflr with its hooks installed, waits at the trust dialog and stops cleanly', { skip: enabled ? false : 'set KRAFLR_LIVE_CLAUDE=1 with Claude Code installed' }, async () => {
  const base = await realpath(tmpdir()), folder = await mkdtemp(join(base, 'kraflr-live-claude-')), workspace = await mkdtemp(join(base, 'kraflr-live-workspace-'))
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'kraflr.mjs'), '--core', '--data-dir', folder], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let startupError = ''; child.stderr?.on('data', (text) => { startupError = (startupError + text).slice(-8000) })
  let rpc: RpcClient | undefined
  try {
    for (const deadline = Date.now() + 30_000; Date.now() < deadline && child.exitCode === null;) {
      try { rpc = new RpcClient(await address(folder)); await rpc.call('ping', {}, 500); break } catch { rpc?.close(); rpc = undefined; await delay(50) }
    }
    assert.ok(rpc, 'Runtime must start: ' + startupError)
    const api = (path: string, method = 'GET', body?: unknown) => rpc!.call('api', { path, method, body })
    const panel = await api('/api/panels', 'POST', { name: 'Live Claude', type: 'source' })
    await api(`/api/panels/${panel.id}/scope`, 'PUT', { expectedVersion: 0, scope: { ...emptyScope, targetName: 'Live check', repositoryMode: 'discover', repositoryDiscovery: 'Adapter test only', workspacePath: workspace, accessMode: 'read_only' } })
    const launched = await api(`/api/panels/${panel.id}/terminal`, 'POST', { kind: 'claude', mode: 'terminal', label: 'Live Claude', role: 'parent', cols: 110, rows: 32 })
    assert.equal(launched.kind, 'claude'); assert.equal(launched.state, 'running')

    // Per-session files the adapter promises: instructions, session-only hook settings, and the bridge shims for both shells.
    const scratch = join(folder, 'agent-terminals', launched.id)
    const settings = JSON.parse(await readFile(join(scratch, '.claude', 'kraflr-settings.json'), 'utf8'))
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PreToolUse']) assert.match(settings.hooks[event][0].hooks[0].command, /claude-hook\.ts/, event)
    assert.match(await readFile(join(scratch, 'AGENTS.md'), 'utf8'), /Current role: parent/)
    await access(join(folder, 'agent-terminals', 'bin', process.platform === 'win32' ? 'kraflr.cmd' : 'kraflr'))
    if (process.platform === 'win32') await access(join(folder, 'agent-terminals', 'bin', 'kraflr'))
    await access(join(folder, 'agent-terminals', 'claude-' + panel.id))

    // A folder Claude Code has never seen opens its trust dialog. Kraflr must report that as a blocked prompt, never as ready.
    let state: any
    for (let attempt = 0; attempt < 150; attempt++) {
      state = (await api('/api/agents/sessions')).find((item: any) => item.id === launched.id)
      if (/setup or trust choice|Needs your response/.test(state?.readinessReason ?? '')) break
      await delay(200)
    }
    assert.equal(state.state, 'running'); assert.equal(state.promptReady, false)
    assert.match(state.readinessReason, /setup or trust choice|Needs your response/)

    await api(`/api/panels/${panel.id}/terminal/${launched.id}/stop`, 'POST', {})
    for (let attempt = 0; attempt < 50; attempt++) {
      state = (await api('/api/agents/sessions')).find((item: any) => item.id === launched.id)
      if (state?.state !== 'running' && state?.state !== 'stopping') break
      await delay(100)
    }
    assert.ok(['exited', 'offline'].includes(state.state), 'Stopping the pane ends the Claude Code process: ' + state.state)
  } finally {
    try { await rpc?.call('stop') } catch { /* The runtime may already have stopped. */ }
    rpc?.close()
    // The runtime holds the database and agent folders until it exits, so wait for it before deleting them.
    if (child.exitCode === null) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve() }, 15_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    for (const path of [folder, workspace]) await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})

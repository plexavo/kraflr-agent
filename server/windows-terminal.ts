import { fork } from 'node:child_process'
import type { IPty, IWindowsPtyForkOptions } from 'node-pty'

export type ManagedTerminal = Pick<IPty, 'pid' | 'onData' | 'onExit' | 'write' | 'resize' | 'kill'>

// A per-terminal host contains ConPTY workers and handles. Its lifetime ends with
// this terminal, so upstream handle leaks cannot retain the Kraflr server.
export function spawnWindowsTerminal(file: string, args: string[], options: IWindowsPtyForkOptions): ManagedTerminal {
  const child = fork(new URL('./windows-terminal-host.ts', import.meta.url), [], {
    env: options.env, windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number }) => void>()
  let code = 1
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return
    const item = message as { type?: string; text?: unknown; code?: unknown }
    if (item.type === 'data' && typeof item.text === 'string') {
      for (const listener of dataListeners) listener(item.text)
    } else if (item.type === 'exit' && typeof item.code === 'number') code = item.code
  })
  child.once('error', () => { code = 1 })
  child.once('close', (exitCode) => {
    for (const listener of exitListeners) listener({ exitCode: exitCode === 0 ? code : exitCode ?? code })
    dataListeners.clear()
    exitListeners.clear()
  })
  if (!child.pid) throw new Error('Windows terminal host could not start.')
  const send = (message: object) => {
    if (!child.connected) throw new Error('Windows terminal host has stopped.')
    child.send(message, (error) => { if (error && child.connected) child.disconnect() })
  }
  send({ type: 'start', file, args, options })
  return {
    pid: child.pid,
    onData(listener) { dataListeners.add(listener); return { dispose() { dataListeners.delete(listener) } } },
    onExit(listener) { exitListeners.add(listener); return { dispose() { exitListeners.delete(listener) } } },
    write(text) { send({ type: 'input', text }) },
    resize(cols, rows) { send({ type: 'resize', cols, rows }) },
    kill() { child.kill() },
  }
}

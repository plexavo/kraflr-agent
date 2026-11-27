import { spawn } from 'node-pty'
import type { IPty, IWindowsPtyForkOptions } from 'node-pty'

let terminal: IPty | undefined
let ending = false

function finish(code: number) {
  if (ending) return
  ending = true
  // This host owns one terminal only. Exit also releases its ConPTY worker
  // threads after the terminal's final IPC message has been delivered.
  if (process.connected) process.send?.({ type: 'exit', code }, () => process.exit(0))
  else process.exit(0)
}

process.on('disconnect', () => process.exit(0))
process.on('message', (message: unknown) => {
  if (ending || !message || typeof message !== 'object') return
  const item = message as { type?: string; file?: string; args?: string[]; options?: IWindowsPtyForkOptions;
    text?: string; cols?: number; rows?: number }
  try {
    if (item.type === 'start' && !terminal && item.file && item.args && item.options) {
      terminal = spawn(item.file, item.args, item.options)
      terminal.onData((text) => {
        if (!process.connected || ending) return
        const accepted = process.send?.({ type: 'data', text }, () => { if (!ending) terminal?.resume() })
        if (accepted === false) terminal?.pause()
      })
      terminal.onExit(({ exitCode }) => finish(exitCode))
    } else if (item.type === 'input' && typeof item.text === 'string') terminal?.write(item.text)
    else if (item.type === 'resize' && item.cols && item.rows) terminal?.resize(item.cols, item.rows)
  } catch {
    finish(1)
  }
})

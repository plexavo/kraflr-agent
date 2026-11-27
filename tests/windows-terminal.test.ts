import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { agentEnvironment } from '../server/agent-terminals.ts'
import { spawnWindowsTerminal } from '../server/windows-terminal.ts'
import { stopWindowsProcessTree } from '../server/process-tree.ts'

for (const natural of [true, false]) test(`Windows terminal host relays input and output and exits ${natural ? 'naturally' : 'with its owned process tree'}`,
  { skip: process.platform !== 'win32', timeout: 12_000 }, async () => {
    const program = [
      "process.stdout.write('HOST_READY\\r\\n')",
      'process.stdin.setRawMode(true)',
      'process.stdin.resume()',
      "process.stdin.on('data', bytes => { const value=bytes.toString(); if(value==='Q') process.exit(0); else process.stdout.write('HOST_ECHO:'+value+'\\r\\n') })",
    ].join(';')
    const terminal = spawnWindowsTerminal(process.execPath, ['-e', program], {
      cwd: process.cwd(), env: agentEnvironment('opencode'), cols: 100, rows: 26,
    })
    let output = ''
    let exits = 0
    let exited = false
    const finished = new Promise<number>((resolve) => {
      terminal.onExit(({ exitCode }) => { exited = true; exits++; resolve(exitCode) })
    })
    terminal.onData((text) => { output += text })
    const waitFor = async (text: string) => {
      for (let attempt = 0; attempt < 100 && !output.includes(text) && !exited; attempt++) await delay(30)
      assert.ok(output.includes(text), `Expected ${text}; got ${output}`)
    }
    try {
      await waitFor('HOST_READY')
      terminal.resize(80, 24)
      terminal.write('X')
      await waitFor('HOST_ECHO:X')
      if (natural) terminal.write('Q')
      else await stopWindowsProcessTree(terminal.pid)
      const timeout = new AbortController()
      try {
        const code = await Promise.race([finished, delay(3000, null, { signal: timeout.signal })])
        assert.notEqual(code, null, 'The terminal host did not exit.')
        if (natural) assert.equal(code, 0)
        assert.equal(exits, 1)
      } finally { timeout.abort() }
    } finally {
      if (!exited) await stopWindowsProcessTree(terminal.pid).catch(() => {})
    }
  })

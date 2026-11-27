import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node-pty'
import { spawnWindowsTerminal } from '../server/windows-terminal.ts'
import { PaneScreen } from '../cli/screen.ts'

test('terminal: a workspace folder that is not absolute is rejected with a message that says so, and the Access choice resets when the type changes', async () => {
  const base = await realpath(tmpdir()), folder = await mkdtemp(join(base, 'kraflr-form-errors-')), script = join(folder, 'fixture.ts'), root = resolve(import.meta.dirname, '..'), cols = 180, rows = 54
  await writeFile(script, `
 import{runTui}from${JSON.stringify(pathToFileURL(join(root, 'cli', 'tui.ts')).href)}
 const events=new Set()
 const rpc={events,close(){},async call(method,params){
  if(method==='mkdir')throw Error('The form must stop before creating anything')
  if(method!=='api')throw Error('Unexpected action '+method)
  const p=params.path
  if(p==='/api/panels')return[]
  if(p==='/api/agents/sessions')return[]
  if(p==='/api/agents/attention')return[]
  if(p==='/api/investigation')return{counts:[]}
  throw Error('Unexpected request '+p)
 }}
 await runTui(rpc)
 `)
  const terminal = process.platform === 'win32' ? spawnWindowsTerminal(process.execPath, [script], { cwd: root, cols, rows, env: process.env, name: 'xterm-256color' }) : spawn(process.execPath, [script], { cwd: root, cols, rows, env: process.env, name: 'xterm-256color' })
  const screen = new PaneScreen(cols, rows, (text) => terminal.write(text))
  terminal.onData((text) => screen.write(text, () => {}))
  const current = () => { const b = screen.terminal.buffer.active; return Array.from({ length: rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '').join('\n') }
  const until = async (text: string) => { for (let i = 0; i < 130; i++) { if (current().includes(text)) return; await delay(80) } throw Error('Missing ' + text + '\n' + current()) }
  const click = async (label: string) => { await until(label); const lines = current().split('\n'), y = lines.findIndex((line) => line.includes(label)), x = lines[y]!.indexOf(label) + 2; terminal.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`); await delay(150) }
  const type = async (text: string) => { terminal.write(text); await delay(120) }
  const enter = async () => { terminal.write('\r'); await delay(120) }
  try {
    await click('New panel'); await until('Type of security research')
    terminal.write('\x1b[C'); await delay(200); await until('Authorized targets')
    // Switching from code review to web testing must not leave the code-review value in the Access field.
    await until('Read-only testing (no state changes)'); assert.doesNotMatch(current(), /‹ Read only ›/)
    // Panel name, target name, authorized targets, rules source (kept), rules text, then a workspace that is not absolute.
    await enter(); await type('Shop QA'); await enter(); await type('Shop'); await enter(); await type('http://192.0.2.10:8080'); await enter(); await enter()
    await type('Test only inside business hours.'); await enter(); await type('webapptest'); await enter(); await enter(); await enter(); await enter()
    await until('must be an absolute path such as'); await until('“webapptest” is not.')
    assert.doesNotMatch(current(), /Provide a panel name, target and absolute workspace folder/)
  } finally { terminal.kill(); screen.dispose(); assert.match(relative(base, folder), /^kraflr-form-errors-[^\\/]+$/); await rm(folder, { recursive: true, force: true }) }
})

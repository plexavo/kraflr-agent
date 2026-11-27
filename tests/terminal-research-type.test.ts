import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm, realpath, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node-pty'
import { spawnWindowsTerminal } from '../server/windows-terminal.ts'
import { PaneScreen } from '../cli/screen.ts'

test('terminal: choosing web application testing asks for targets and rules of engagement, and the Kickoff prompt button offers a prompt built from them', async () => {
  const base = await realpath(tmpdir()), folder = await mkdtemp(join(base, 'kraflr-research-type-')), log = join(folder, 'calls.jsonl'), script = join(folder, 'fixture.ts'), root = resolve(import.meta.dirname, '..'), cols = 180, rows = 54
  const workspace = join(folder, 'workspace'), rules = join(folder, 'rules.txt'), ruleText = 'Test only between 09:00 and 17:00 UTC. No load testing and no social engineering.'
  await mkdir(workspace); await writeFile(rules, ruleText)
  await writeFile(script, `
 import{appendFileSync}from'node:fs'
 import{runTui}from${JSON.stringify(pathToFileURL(join(root, 'cli', 'tui.ts')).href)}
 const log=${JSON.stringify(log)},events=new Set()
 let panels=[],detail,sessions=[]
 const agent={id:'parent',panelId:'p1',kind:'opencode',mode:'terminal',label:'Parent',parent:true,state:'running',chat:true,scopeVersion:1,startedAt:'now',exitCode:null}
 const rpc={events,close(){},async call(method,params){
  if(method==='mkdir'){appendFileSync(log,JSON.stringify({mkdir:params.path})+'\\n');return{path:params.path}}
  if(method==='watch'){queueMicrotask(()=>{for(const listener of events)listener({event:'pty',id:'parent',packet:'event: snapshot\\ndata: '+JSON.stringify('Parent pane')+'\\n\\n'})});return{}}
  if(method==='terminal-attach')return agent
  if(method==='resize'||method==='input')return{}
  if(method!=='api')throw Error('Unexpected action '+method)
  const p=params.path,m=params.method??'GET'
  if(m==='POST'||m==='PUT')appendFileSync(log,JSON.stringify({method:m,path:p,body:params.body})+'\\n')
  if(m==='POST'&&p==='/api/panels'){const panel={id:'p1',name:params.body.name,type:params.body.type,scopeVersion:0,scopeHistory:[],repositoryMode:null,createdAt:'now',updatedAt:'now'};panels=[panel];detail=panel;return panel}
  if(m==='PUT'&&p==='/api/panels/p1/scope'){detail={...detail,scopeVersion:1,scopeHistory:[{...params.body.scope,version:1,savedAt:'now'}]};panels=[{...detail}];return detail}
  if(m==='POST'&&p==='/api/panels/p1/terminal'){sessions=[agent];return agent}
  if(m==='POST'&&p==='/api/panels/p1/research-runs')return{id:params.body.id,status:'running'}
  if(p==='/api/panels')return panels
  if(p==='/api/agents/sessions')return sessions
  if(p==='/api/agents/attention')return[]
  if(p==='/api/investigation')return{counts:[]}
  if(p==='/api/panels/p1')return detail
  if(p.endsWith('/research-runs'))return[]
  if(p.includes('/evidence'))return{leads:[],counts:{},more:false}
  throw Error('Unexpected request '+m+' '+p)
 }}
 await runTui(rpc)
 `)
  const terminal = process.platform === 'win32' ? spawnWindowsTerminal(process.execPath, [script], { cwd: root, cols, rows, env: { ...process.env, HOME: folder, USERPROFILE: folder }, name: 'xterm-256color' }) : spawn(process.execPath, [script], { cwd: root, cols, rows, env: { ...process.env, HOME: folder, USERPROFILE: folder }, name: 'xterm-256color' })
  const screen = new PaneScreen(cols, rows, (text) => terminal.write(text)); let ended = false
  terminal.onData((text) => screen.write(text, () => {})); terminal.onExit(() => { ended = true })
  const current = () => { const b = screen.terminal.buffer.active; return Array.from({ length: rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '').join('\n') }
  const until = async (text: string) => { for (let i = 0; i < 130; i++) { if (current().includes(text)) return; await delay(80) } throw Error('Missing ' + text + '\n' + current()) }
  const click = async (label: string) => { await until(label); const lines = current().split('\n'), y = lines.findIndex((line) => line.includes(label)), x = lines[y]!.indexOf(label) + 2; terminal.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`); await delay(150) }
  const type = async (text: string) => { terminal.write(text); await delay(120) }
  const enter = async () => { terminal.write('\r'); await delay(120) }
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  try {
    await click('New panel')
    await until('Type of security research'); await until('Open-source code review'); await until('Official repository URL or local Git clone')
    // Choosing web application testing swaps the repository questions for targets and rules of engagement.
    terminal.write('\x1b[C'); await delay(200)
    await until('Web application testing'); await until('Authorized targets (domains or URLs, separated by commas)'); await until('Rules of engagement source')
    assert.doesNotMatch(current(), /Official repository URL/)
    await enter(); await type('Shop QA'); await enter(); await type('Shop'); await enter(); await type('shop.example.com, *.api.example.com'); await enter()
    terminal.write('\x1b[C'); await delay(150); await until('Link to them'); await until('Rules of engagement link (https://…)')
    terminal.write('\x1b[C'); await delay(150); await until('Choose a file'); await until('Rules of engagement file (absolute path to a text file)')
    await enter(); await type(rules); await enter(); await type('~/workspace'); await enter(); await until('Read-only testing (no state changes)'); await enter(); await type('No load testing'); await enter()
    assert.doesNotMatch(current(), /\[ [A-Za-z]/, 'no bracketed controls remain')
    await enter()
    await until('Scope saved. Agents are told the authorized targets')
    const created = await calls()
    const panelCall = created.find((call) => call.path === '/api/panels' && call.method === 'POST'), scopeCall = created.find((call) => call.method === 'PUT')
    assert.deepEqual(panelCall.body, { name: 'Shop QA', type: 'web' })
    const scope = scopeCall.body.scope
    assert.equal(scope.webTargets, 'shop.example.com\n*.api.example.com'); assert.equal(scope.notes, ruleText); assert.equal(scope.roeReference, rules)
    assert.equal(scope.repository, ''); assert.equal(scope.repositoryMode, 'known'); assert.equal(scope.accessMode, 'read_only'); assert.equal(scope.restrictions, 'No load testing'); assert.equal(scope.workspacePath, workspace)
    assert.equal(scope.targetName, 'Shop')

    // The Scope tab states what the researcher authorized.
    const side = () => current().split('\n').findIndex((line) => line.slice(0, 23).includes('Scope'))
    terminal.write(`\x1b[<0;3;${side() + 1}M\x1b[<0;3;${side() + 1}m`); await delay(200)
    await until('Type of security research: Web application testing'); await until('Authorized targets: shop.example.com, *.api.example.com'); await until('(file, its text is saved)'); await until('Read-only testing (no state changes)')
    assert.doesNotMatch(current(), /Review repository|Prepared source/)

    // Starting the first Parent offers the prepared prompt; no repository is prepared for a web test.
    terminal.write(`\x1b[<0;3;${current().split('\n').findIndex((line) => line.slice(0, 23).includes('Agents')) + 1}M\x1b[<0;3;${current().split('\n').findIndex((line) => line.slice(0, 23).includes('Agents')) + 1}m`); await delay(200)
    await click('New session'); await until('Start a native agent')
    await enter(); await enter(); await enter(); await enter()
    // No pop-up covers the new pane; the prepared prompt waits behind the Kickoff prompt button.
    await until('Parent started. Select Kickoff prompt'); assert.doesNotMatch(current(), /Hunt depth|Send prompt/)
    await click('Kickoff prompt'); await until('Hunt depth'); await click('Standard')
    await until('Start the research'); await until('Send to Parent'); await until('Add an instruction, then send'); await until('Authorized targets: shop.example.com, *.api.example.com')
    const launch = (await calls()).find((call) => call.path === '/api/panels/p1/terminal')
    assert.equal(launch.body.prepareRepository, false); assert.equal(launch.body.role, 'parent'); assert.equal(launch.body.kind, 'opencode')
    await click('Send to Parent')
    await until('Research started.')
    const run = (await calls()).find((call) => call.path === '/api/panels/p1/research-runs')
    assert.equal(run.body.prepareRepository, false)
    assert.match(run.body.objective, /test Shop \(Web application testing, scope revision 1\)/); assert.match(run.body.objective, /shop\.example\.com, \*\.api\.example\.com/)
    assert.match(run.body.objective, /Test only between 09:00 and 17:00 UTC/); assert.match(run.body.objective, /Use a Child only if it clearly saves time/)
    await click('Detach'); for (let i = 0; i < 70 && !ended; i++) await delay(60); assert.equal(ended, true)
  } finally { if (!ended) terminal.kill(); screen.dispose(); assert.match(relative(base, folder), /^kraflr-research-type-[^\\/]+$/); await rm(folder, { recursive: true, force: true }) }
})

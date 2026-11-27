import assert from'node:assert/strict'
import test from'node:test'
import{mkdtemp,readFile,writeFile,rm,realpath}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join,relative,resolve}from'node:path'
import{pathToFileURL}from'node:url'
import{setTimeout as delay}from'node:timers/promises'
import{spawn}from'node-pty'
import{spawnWindowsTerminal}from'../server/windows-terminal.ts'
import{PaneScreen,terminalBackground}from'../cli/screen.ts'

test('on-demand in-app terminal panes route native input, keep approvals visible and never open external windows',async()=>{
 const folder=await mkdtemp(join(await realpath(tmpdir()),'kraflr-tui-qa-')),log=join(folder,'input.jsonl'),script=join(folder,'fixture.ts'),root=resolve(import.meta.dirname,'..');let cols=180,rows=54
 const module=pathToFileURL(join(root,'cli','tui.ts')).href
 await writeFile(script,`
 import{appendFileSync}from'node:fs'
 import{runTui}from${JSON.stringify(module)}
 const log=${JSON.stringify(log)},events=new Set(),agents=Array.from({length:4},(_,i)=>({id:'agent-'+i,panelId:'panel',kind:i%2?'cline':'opencode',mode:'terminal',label:['Parent console','Permission worker','Active worker','Ready worker'][i],parent:i===0,state:'running',activity:i===2?'working':'idle',scopeVersion:1,startedAt:'now',exitCode:null}))
 const write=process.stdout.write.bind(process.stdout)
 process.stdout.write=function(chunk,...args){const text=String(chunk);if(text.includes('\\x1b]11;?'))queueMicrotask(()=>process.stdin.emit('data','\\x1b]11;rgb:0c0c/0c0c/0c0c\\x1b\\\\'));if(text.includes('\\x1b]11;')||text.includes('\\x1b]111'))appendFileSync(log+'.appearance',JSON.stringify(text)+'\\n');return write(chunk,...args)}
 const panel={id:'panel',name:'Interface QA',type:'source',scopeVersion:1,scopeHistory:[]}
 const rpc={events,close(){},async call(method,params){
  if(method==='watch'){const i=agents.findIndex(a=>a.id===params.id),text=i===1?'Cline needs permission\\r\\nRead a synthetic note\\r\\n[y] Approve   [n] Deny':'Native CLI '+i+' / synthetic display only';queueMicrotask(()=>{for(const listener of events)listener({event:'pty',id:params.id,packet:'event: snapshot\\ndata: '+JSON.stringify(text)+'\\n\\n'})});return{}}
  if(method==='open-terminal')throw Error('External terminal windows must not open')
  if(method==='terminal-attach')return agents.find(a=>a.id===params.id)
  if(method==='input'){appendFileSync(log,JSON.stringify(params)+'\\n');return{}}
  if(method==='resize')return{}
  if(method==='api'){if(params.path==='/api/panels')return[panel];if(params.path==='/api/agents/sessions')return agents;if(params.path==='/api/agents/attention')return[];if(params.path==='/api/investigation')return{counts:[]};if(params.path.endsWith('/research-runs'))return[];if(params.path.includes('/evidence'))return{leads:[]};if(params.path==='/api/panels/panel')return panel}
  throw Error('Unexpected fixture request '+method)
 }}
 await runTui(rpc)
 `)
 const terminal=process.platform==='win32'?spawnWindowsTerminal(process.execPath,[script],{cwd:root,cols,rows,env:process.env,name:'xterm-256color'}):spawn(process.execPath,[script],{cwd:root,cols,rows,env:process.env,name:'xterm-256color'})
 const screen=new PaneScreen(cols,rows,text=>terminal.write(text));let ended=false,output=''
 terminal.onData(text=>{output=(output+text).slice(-2_000_000);screen.write(text,()=>{})});terminal.onExit(()=>{ended=true})
 const current=()=>{const b=screen.terminal.buffer.active;return Array.from({length:rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true,0,cols)??'').join('\n')}
 const until=async(text:string)=>{for(let i=0;i<100;i++){if(current().includes(text))return;await delay(60)}throw Error('Missing '+text+'\n'+current())}
 const click=async(label:string)=>{await until(label);const lines=current().split('\n'),y=lines.findIndex(line=>line.includes(label)),x=lines[y]!.indexOf(label)+2;terminal.write(`\x1b[<0;${x+1};${y+1}M\x1b[<0;${x+1};${y+1}m`);await delay(200)}
 // Sidebar tabs share their words with headers, so they are found in the sidebar columns only.
 const tab=async(label:string)=>{await until(label);const side=cols>=110?23:20,y=current().split('\n').findIndex(line=>line.slice(0,side).includes(label));assert.ok(y>=0,'Missing tab '+label);terminal.write(`\x1b[<0;3;${y+1}M\x1b[<0;3;${y+1}m`);await delay(200)}
 try{
  await until('FOLLOW THE EVIDENCE');await until('Review approval');assert.match(current(),/4\/4 Agents active/)
  assert.equal(await readFile(log,'utf8').catch(()=>''),'')
  terminal.write('nqa12345\x02\x10');await delay(200);assert.match(current(),/FOLLOW THE EVIDENCE/);assert.equal(ended,false)
  await click('Interface QA');await until('Native CLI 3');assert.match(current(),/Parent console \/ Parent/);assert.match(current(),/Ready worker \/ Child/);assert.match(current(),/Cline needs permission/)
  const layout=()=>{const lines=current().split('\n'),title=lines[1]!,side=cols>=110?23:20;assert.equal(title.slice(side).trim(),'INTERFACE QA','Centered title is in the workspace header');assert.ok(Math.abs(title.indexOf('INTERFACE QA')-(side+(cols-side-'INTERFACE QA'.length)/2))<1);assert.ok(lines[2]!.includes('4/4 Agents active'));assert.equal(lines.findIndex(line=>line.slice(0,side).includes('Leads')),rows-6);assert.ok(lines[5]!.endsWith('┐'),'Agent panes reach the right edge');assert.ok(lines[rows-2]!.endsWith('┘'),'Agent panes reach the last workspace row');assert.ok(lines[6]!.includes('Native CLI 0'),'Panes start directly below the toolbar')}
  layout();assert.ok(output.includes(terminalBackground.enter))
  assert.doesNotMatch(current(),/Open terminal|Add agent|Send Esc to CLI|Research prompt/)
  await click('Native CLI 0');terminal.write('input for parent');await delay(120);terminal.write('\x1b');await delay(100);terminal.write('\x03');await delay(120)
  let received=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  assert.ok(received.some(item=>item.id==='agent-0'&&item.text==='input for parent'))
  assert.ok(received.some(item=>item.text==='\x1b'));assert.ok(received.some(item=>item.text==='\x03'))
  await click('Native CLI 2');terminal.write('input for worker');await delay(120)
  received=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.ok(received.some(item=>item.id==='agent-2'&&item.text==='input for worker'))
  await tab('Leads');terminal.write('must not reach agents');await delay(120);assert.doesNotMatch(await readFile(log,'utf8'),/must not reach/)
  await tab('Agents');await click('Agent controls');await until('Agent controls');assert.doesNotMatch(current(),/Make focused agent parent/);terminal.write('\x1b');await delay(200)
  await click('Approvals');await until('Agent attention');assert.match(current(),/Permission worker/)
  terminal.write('\x1b');await delay(200);for(const [w,h]of[[120,34],[75,25]]){cols=w!;rows=h!;screen.resize(cols,rows);terminal.resize(cols,rows);await delay(500);await until('Native CLI 3');try{layout()}catch(error){throw Error(`Layout at ${cols}x${rows}: ${error}\n${current()}`)}await tab('Leads');assert.match(current(),/No items in this category/);await tab('Agents');await until('Native CLI 3')}
  terminal.write('\x1b');await delay(250);await click('New session');await until('Four agents are active.');assert.doesNotMatch(current(),/Start a native agent/)
  await click('Detach');for(let i=0;i<80&&!ended;i++)await delay(60);assert.equal(ended,true);assert.ok((await readFile(log+'.appearance','utf8')).trim().split('\n').map(line=>JSON.parse(line)).some(text=>text.includes(terminalBackground.restore('rgb:0c0c/0c0c/0c0c'))),'Restore the captured host background on detach')
 }finally{if(!ended)terminal.kill();screen.dispose();const target=resolve(folder),offset=relative(await realpath(tmpdir()),target);assert.ok(offset.startsWith('kraflr-tui-qa-')&&!offset.includes('..'));await rm(target,{recursive:true,force:true})}
})

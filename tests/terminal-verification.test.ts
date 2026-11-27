import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp,readFile,writeFile,rm,realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,relative,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node-pty'
import { spawnWindowsTerminal } from '../server/windows-terminal.ts'
import { PaneScreen } from '../cli/screen.ts'

test('terminal Verify: an approval pop-up, a red error with Inform agent, a second approved run, and the result in Findings, with no Docker prompt typed',async()=>{
 const base=await realpath(tmpdir()),folder=await mkdtemp(join(base,'kraflr-verification-ui-')),log=join(folder,'mutations.jsonl'),script=join(folder,'fixture.ts'),root=resolve(import.meta.dirname,'..'),cols=180,rows=54
 await writeFile(script,`
 import{appendFileSync}from'node:fs'
 import{runTui}from${JSON.stringify(pathToFileURL(join(root,'cli','tui.ts')).href)}
 const log=${JSON.stringify(log)},events=new Set(),panel={id:'panel',name:'Verification UI QA',scopeVersion:1,scopeHistory:[],type:'source'}
 const agent={id:'parent',panelId:'panel',kind:'opencode',mode:'terminal',label:'Parent',parent:true,state:'running',chat:true,scopeVersion:1,startedAt:'now',exitCode:null}
 let phase='unverified',record,history=[],preparation,prepares=0,approvals=0
 const labels={unverified:'Unverified',preparing:'Verifying · preparing lab',analysing:'Analysing verification error',awaiting_approval:'Test approval needed',running:'Verifying · Parent is running the test',failed:'Error faced',verified:'Verified'}
 const lead=()=>({id:'lead',title:'Synthetic saved hypothesis',path:'synthetic.txt',startLine:1,endLine:1,scopeVersion:1,status:'open',tag:phase==='verified'?'finding':'lead',explanation:'Harmless test metadata only',reviews:[],verificationResults:history,verificationProgress:{state:phase,label:labels[phase],active:['preparing','analysing','running','awaiting_approval'].includes(phase),canVerify:phase==='unverified'||phase==='failed',recordId:record?.id},hasAcceptedFinding:phase==='verified'})
 const pending=(id,hash,image)=>({id,status:'pending',scopeVersion:1,planHash:hash,plan:{title:'Harmless no-op check',action:'Print a harmless observation',expected:'A passing synthetic control',image,targetVersion:'synthetic-v1',command:['/usr/local/bin/node','/app/noop.mjs'],limits:{seconds:60}}})
 const rpc={events,close(){},async call(method,params){
  if(method==='input'){appendFileSync(log+'.input',JSON.stringify(params)+'\\n');return{}}
  if(method==='terminal-attach')return agent
  if(method==='watch'){queueMicrotask(()=>{for(const listener of events)listener({event:'pty',id:'parent',packet:'event: snapshot\\ndata: '+JSON.stringify('Native Parent pane; no test commands typed')+'\\n\\n'})});return{}}
  if(method==='resize')return{}
  if(method!=='api')throw Error('Unexpected action '+method)
  const p=params.path
  if(params.method==='POST'){
   appendFileSync(log,JSON.stringify(params)+'\\n')
   if(p.endsWith('/lab-preparation')){
    prepares++
    if(prepares===1&&params.body.repairOf)throw Error('The first lab is not a repair')
    if(prepares===2&&params.body.repairOf!=='test')throw Error('The second lab must repair the failed test')
    phase=prepares===1?'preparing':'analysing';preparation={run:{id:'prep'+prepares,status:'running',phase:prepares===1?'Preparing harmless lab':'Analysing the verification error and repairing the lab'},directory:'synthetic-lab',directoryReady:true,dockerfileReady:false,harnessReady:false,canRecover:false}
    setTimeout(()=>{preparation.run.status='completed';preparation.run.phase='Lab ready; review test';preparation.dockerfileReady=true;preparation.harnessReady=true;record=prepares===1?pending('test','a'.repeat(64),'sha256:'+'b'.repeat(64)):pending('second-test','c'.repeat(64),'sha256:'+'d'.repeat(64));history=[record,...history];phase='awaiting_approval'},prepares===1?4000:1500)
    return{id:'prep'+prepares}
   }
   if(p.endsWith('/test/decision')||p.endsWith('/second-test/decision')){
    const body=params.body
    if(phase!=='awaiting_approval'||body.choice!=='approve'||body.executor!=='parent'||body.saveFindingOnSuccess!==true||body.planHash!==record.planHash)throw Error('Wrong approval '+JSON.stringify(body))
    phase='running';record.status='running';record.lease={agentId:'parent',agentLabel:'Parent'}
    if(++approvals===1)setTimeout(()=>{phase='failed';record.status='error';record.detail='Parent could not complete the test: config.php is missing';record.failure={stage:'running the test',code:'agent_reported',retryable:false,hint:'Parent reported a problem. Inform the agent so it analyses and repairs the lab, or cancel this verification.',output:'COPY failed: config.php not found'}},300)
    else setTimeout(()=>{phase='verified';record.status='reproduced';record.finding={note:'Approved by the researcher',acceptance:'conditional'};record.observation={outcome:'reproduced',controlPassed:true,summary:'Synthetic test result'}},1200)
    return record
   }
   throw Error('Unexpected mutation '+p)
  }
  if(p==='/api/panels')return[panel]
  if(p==='/api/agents/sessions')return[agent]
  if(p==='/api/agents/attention')return[]
  if(p==='/api/investigation')return{counts:[]}
  if(p==='/api/panels/panel')return panel
  if(p.endsWith('/research-runs'))return[]
  if(p.endsWith('/evidence/lead'))return lead()
  if(p.includes('/evidence?')){const finding=p.includes('tag=finding');return{leads:(phase==='verified')===finding?[lead()]:[],counts:{},more:false}}
  if(p.includes('/lab-preparation?'))return{canStart:phase==='unverified'||phase==='failed',preparations:preparation?[{...preparation,canRecover:false,planChanged:false}]:[],reason:''}
  if(p.includes('/verification?'))return{records:history}
  throw Error('Unexpected read '+p)
 }}
 await runTui(rpc)
 `)
 const terminal=process.platform==='win32'?spawnWindowsTerminal(process.execPath,[script],{cwd:root,cols,rows,env:process.env,name:'xterm-256color'}):spawn(process.execPath,[script],{cwd:root,cols,rows,env:process.env,name:'xterm-256color'})
 const screen=new PaneScreen(cols,rows,text=>terminal.write(text));let ended=false
 terminal.onData(text=>screen.write(text,()=>{}));terminal.onExit(()=>{ended=true})
 const current=()=>{const b=screen.terminal.buffer.active;return Array.from({length:rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)??'').join('\n')}
 const until=async(text:string)=>{for(let i=0;i<130;i++){if(current().includes(text))return;await delay(80)}throw Error('Missing '+text+'\n'+current())}
 const click=async(label:string)=>{await until(label);const lines=current().split('\n'),y=lines.findIndex(line=>line.includes(label)),x=lines[y]!.indexOf(label)+2;terminal.write(`\x1b[<0;${x+1};${y+1}M\x1b[<0;${x+1};${y+1}m`);await delay(120)}
 // Sidebar tabs share their words with headers, so they are found in the sidebar columns only.
 const tab=async(label:string)=>{await until(label);const y=current().split('\n').findIndex(line=>line.slice(0,23).includes(label));assert.ok(y>=0,'Missing tab '+label);terminal.write(`\x1b[<0;3;${y+1}M\x1b[<0;3;${y+1}m`);await delay(120)}
 const mutations=async()=>(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 try{
  await click('Verification UI QA');await tab('Leads');await click('Synthetic saved hypothesis');await click('Verify')
  await until('Verifying');await tab('Leads');await until('Verifying · preparing lab');await click('Synthetic saved hypothesis')
  await click('View verification progress')
  // The lab is ready: the exact test appears as a pop-up with one choice per verifier and no bracketed buttons.
  await until('Approval needed · verification test');await until('Harmless no-op check');await until('Parent verification · mark Finding or killed lead')
  assert.doesNotMatch(current(),/Kraflr runs it|Child verification/);assert.equal((await mutations()).length,1,'No test execution before approval')
  terminal.write('\x1b');await delay(150);await tab('Agents');await click('Native Parent pane; no test commands typed');terminal.write('I approve\r');await until('Approval needed · verification test')
  assert.equal((await mutations()).length,1,'Saying I approve opens exact-plan review without granting execution')
  await click('Parent verification · mark Finding or killed lead');await until('Verifying · Parent is running the test')

  // The agent reports it cannot finish: the progress turns red and the pop-up offers Inform agent or Cancel.
  await until('Error faced');await until('Inform agent · analyse the error, fix it and ask for approval again');await until('Cancel verification · the agent must ask for approval again')
  await until('config.php is missing');await until('COPY failed: config.php not found')
  assert.doesNotMatch(current(),/\[ [A-Za-z]/,'no bracketed controls remain')
  const red=screen.terminal.buffer.active,bannerRow=current().split('\n').findIndex(line=>line.includes('Error faced')),cell=red.getLine(red.baseY+bannerRow)!.getCell(current().split('\n')[bannerRow]!.indexOf('Error faced'))!
  assert.equal(cell.getFgColor(),(240<<16)|(118<<8)|118,'an error is drawn in red')

  // Inform agent: the Parent analyses the error and the lead says so while it works.
  await click('Inform agent · analyse the error, fix it and ask for approval again');await until('Analysing verification error')
  assert.equal((await mutations())[2].body.repairOf,'test')
  // The repaired plan comes back as a second run and its approval opens by itself, even though no menu was open.
  await until('Approval needed · second run after the repair');await until('sha256:'+'d'.repeat(64));await until('Repair of the earlier error')
  assert.equal((await mutations()).length,3,'The repair submits a new plan without executing it')
  await click('Parent verification · mark Finding or killed lead');await until('Verified · saved in Findings')
  await click('Open Findings');await until('✓ Verified');await click('Synthetic saved hypothesis');await until('View verified result');assert.doesNotMatch(current(),/Retry verification/)
  const sent=await mutations();assert.equal(sent.length,4);assert.equal(sent[1].body.executor,'parent');assert.equal(sent[1].body.saveFindingOnSuccess,true);assert.equal(sent[3].body.planHash,'c'.repeat(64));assert.equal(sent[3].body.executor,'parent')
  assert.equal((await readFile(log+'.input','utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(item=>!item.generated).map(item=>item.text).join(''),'I approve\r','No manual Docker command or extra execution prompt was typed')
  terminal.write('\x1b');await delay(200);await click('Detach');for(let i=0;i<70&&!ended;i++)await delay(60);assert.equal(ended,true)
 }finally{if(!ended)terminal.kill();screen.dispose();assert.match(relative(base,folder),/^kraflr-verification-ui-[^\\/]+$/);await rm(folder,{recursive:true,force:true})}
})

test('terminal: an agent that hit its usage limit is announced once, and its saved context can be handed to a running teammate',async()=>{
 const base=await realpath(tmpdir()),folder=await mkdtemp(join(base,'kraflr-stop-ui-')),log=join(folder,'calls.jsonl'),script=join(folder,'fixture.ts'),root=resolve(import.meta.dirname,'..'),cols=180,rows=54
 await writeFile(script,`
 import{appendFileSync}from'node:fs'
 import{runTui}from${JSON.stringify(pathToFileURL(join(root,'cli','tui.ts')).href)}
 const log=${JSON.stringify(log)},events=new Set(),panel={id:'panel',name:'Limit QA',scopeVersion:1,scopeHistory:[],type:'source'}
 const parent={id:'parent',panelId:'panel',kind:'cline',mode:'terminal',label:'Parent',parent:true,state:'running',chat:true,scopeVersion:1,startedAt:'now',exitCode:null}
 const worker={id:'worker',panelId:'panel',kind:'opencode',mode:'terminal',label:'Worker',parent:false,state:'running',chat:true,scopeVersion:1,startedAt:'now',exitCode:null}
 let handedOff=false
 const rpc={events,close(){},async call(method,params){
  if(method==='terminal-attach')return parent
  if(method==='watch'){queueMicrotask(()=>{for(const listener of events)listener({event:'pty',id:params.id,packet:'event: snapshot\\ndata: '+JSON.stringify(params.id==='parent'?'Parent pane':'Worker pane')+'\\n\\n'})});return{}}
  if(method==='resize'||method==='input')return{}
  if(method==='handoff'){appendFileSync(log,JSON.stringify(params)+'\\n');handedOff=true;return{to:'Worker',tests:0}}
  if(method!=='api')throw Error('Unexpected action '+method)
  const p=params.path
  if(p==='/api/panels')return[panel]
  if(p==='/api/agents/sessions')return[{...parent,stoppage:{kind:'limit',reason:'Cline hit a usage or rate limit: 5-hour limit reached, resets 3pm',at:'t1'}},worker]
  if(p==='/api/agents/attention')return[]
  if(p==='/api/investigation')return{counts:[]}
  if(p==='/api/panels/panel')return panel
  if(p.endsWith('/research-runs'))return[]
  if(p.includes('/evidence'))return{leads:[],counts:{},more:false}
  throw Error('Unexpected read '+p)
 }}
 await runTui(rpc)
 `)
 const terminal=process.platform==='win32'?spawnWindowsTerminal(process.execPath,[script],{cwd:root,cols,rows,env:process.env,name:'xterm-256color'}):spawn(process.execPath,[script],{cwd:root,cols,rows,env:process.env,name:'xterm-256color'})
 const screen=new PaneScreen(cols,rows,text=>terminal.write(text));let ended=false
 terminal.onData(text=>screen.write(text,()=>{}));terminal.onExit(()=>{ended=true})
 const current=()=>{const b=screen.terminal.buffer.active;return Array.from({length:rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)??'').join('\n')}
 const until=async(text:string)=>{for(let i=0;i<130;i++){if(current().includes(text))return;await delay(80)}throw Error('Missing '+text+'\n'+current())}
 const click=async(label:string)=>{await until(label);const lines=current().split('\n'),y=lines.findIndex(line=>line.includes(label)),x=lines[y]!.indexOf(label)+2;terminal.write(`\x1b[<0;${x+1};${y+1}M\x1b[<0;${x+1};${y+1}m`);await delay(120)}
 try{
  // The pop-up names the agent and the reason and offers the remaining agent; it appears by itself, once.
  await until('Agent stopped');await until('Parent hit its usage limit');await until('5-hour limit reached, resets 3pm');await until('Hand saved context to Worker')
  assert.doesNotMatch(current(),/\[ [A-Za-z]/)
  await click('Hand saved context to Worker');await until('Saved context from Parent is going to Worker')
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(calls,[{panel:'panel',from:'parent',to:'worker'}])
  await delay(1800);assert.doesNotMatch(current(),/Agent stopped/,'the same stoppage is not announced twice')
  await click('Detach');for(let i=0;i<70&&!ended;i++)await delay(60);assert.equal(ended,true)
 }finally{if(!ended)terminal.kill();screen.dispose();assert.match(relative(base,folder),/^kraflr-stop-ui-[^\\/]+$/);await rm(folder,{recursive:true,force:true})}
})

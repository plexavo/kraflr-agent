import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { InputDecoder } from '../cli/input.ts'
import { Frame,PaneScreen,paneGrid } from '../cli/screen.ts'
import { shellQuote,launcher } from '../cli/commands.ts'
import { address,RpcClient } from '../cli/ipc.ts'
import nativePolicy from '../cli/cline-team-policy.ts'
import{runSummary,recordSlice}from'../cli/records.ts'
import type{ResearchRun}from'../shared/research-run.ts'

test('large research histories remain readable through bounded IPC record parts without losing worker text',()=>{
  const full='large parent reply\n'.repeat(50_000),worker='large worker reply\n'.repeat(30_000)
  const run:ResearchRun={id:'run',panelId:'panel',parentId:'parent',parentName:'Parent',scopeVersion:1,objective:'Long research',status:'completed',phase:'Saved',startedAt:'now',endedAt:'now',summary:'Short summary',reply:'Short reply',fullReply:full,parentReplies:[full],leads:[],deadEnds:[],nextSteps:[],tasks:[{sessionId:'worker',agent:'Worker',objective:'Review',status:'completed',result:'Worker result',fullReply:worker}]}
  assert.ok(Buffer.byteLength(JSON.stringify(Array(20).fill(runSummary(run))))<2*1024*1024)
  assert.equal(run.fullReply,full);assert.equal(run.tasks[0]!.fullReply,worker)
  const parts:string[]=[];let offset=0
  do{const part=recordSlice(run,offset);assert.ok(Buffer.byteLength(JSON.stringify(part))<512_000);parts.push(part.text);offset+=part.text.length;if(!part.more)break}while(offset<10_000_000)
  const text=parts.join('');assert.ok(text.includes(full));assert.ok(text.includes(worker));assert.match(text,/Scope 1/)
})

test('Cline native policy exposes tracked research tools and removes untracked engine team tools',()=>{
  const tools=[{name:'read_files'},{name:'run_commands'},{name:'submit'},{name:'team_send_message'},{name:'spawn_agent'},{name:'team_mission_log'}]
  assert.deepEqual(nativePolicy.hooks.beforeModel({request:{tools}}).tools.map(tool=>tool.name),['read_files','run_commands','submit'])
  assert.equal(nativePolicy.hooks.beforeTool({toolCall:{toolName:'team_send_message'}})?.skip,true)
  assert.equal(nativePolicy.hooks.beforeTool({toolCall:{toolName:'run_commands'}}),undefined)
})

test('terminal navigation buffers fragmented controls and paste does not execute shortcuts',()=>{
  const input=new InputDecoder()
  assert.deepEqual(input.feed('\x1b'),[])
  assert.deepEqual(input.feed('[A'),[{name:'up'}])
  assert.deepEqual(input.feed('\x1b[200~q\x02\r\x1b[20'),[])
  assert.deepEqual(input.feed('1~'),[{name:'text',text:'q\x02\r'}])
  assert.deepEqual(input.feed('\x1b[<0;9;7M'),[{name:'mouse',x:8,y:6}])
  input.feed('\x1b');assert.deepEqual(input.flushEscape(),[{name:'escape'}])
  input.feed('x'.repeat(128_001));assert.equal(input.buffer,'')
})

test('native VT rendering contains control sequences, preserves wide cells and replies to cursor queries',async()=>{
  const replies:string[]=[],pane=new PaneScreen(20,5,text=>replies.push(text)),frame=new Frame(24,7)
  try{
    await new Promise<void>(resolve=>pane.write('\x1b[31mhello 界\x1b[0m\x1b]52;c;U0VDUkVU\x07\x1b]0;spoofed title\x07\x1b[6n',resolve))
    pane.draw(frame,{x:1,y:1,w:20,h:5})
    const output=frame.ansi()
    assert.match(output,/hello 界/);assert.doesNotMatch(output,/\x1b\]|U0VDUkVU|spoofed title/)
    assert.ok(replies.some(text=>/^\x1b\[\d+;\d+R$/.test(text)))
    assert.equal(frame.cells[1]![8],'')
    const label=new Frame(30,2);label.text(0,0,'lead\x1b]52;c;secret\x07')
    assert.doesNotMatch(label.ansi(),/\x1b\]/)
  }finally{pane.dispose()}
})

test('four-pane grid partitions odd terminal sizes without overlaps or lost cells',()=>{
  const region={x:25,y:5,w:121,h:43},rects=paneGrid(region),cells=new Set<string>()
  assert.equal(rects.length,4)
  for(const r of rects)for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++){const key=x+','+y;assert.ok(!cells.has(key));cells.add(key);assert.ok(x>=region.x&&x<region.x+region.w&&y>=region.y&&y<region.y+region.h)}
  assert.equal(cells.size,region.w*region.h)
})

test('command launchers quote paths literally on Linux and Windows',()=>{
  assert.equal(shellQuote("/a b/'$(echo secret)`x`"),"'/a b/'\\''$(echo secret)`x`'")
  assert.match(launcher('/a b/node','/x/$HOME/app.mjs',false),/exec '\/a b\/node' '\/x\/\$HOME\/app.mjs' "\$@"/)
  assert.match(launcher('C:\\100%\\node.exe','C:\\a b\\app.mjs',true),/100%%/)
})

test('terminal runtime uses authenticated local IPC, isolates owner controls and persists across client detach',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'kraflr-terminal-test-'))
  const child=spawn(process.execPath,[join(import.meta.dirname,'..','bin','kraflr.mjs'),'--core','--data-dir',folder],{stdio:['ignore','ignore','pipe'],windowsHide:true})
  let startupError='';child.stderr?.on('data',text=>{startupError=(startupError+text).slice(-8000)})
  let owner:RpcClient|undefined
  try{
    const deadline=Date.now()+30_000
    while(Date.now()<deadline&&child.exitCode===null){try{owner=new RpcClient(await address(folder));await owner.call('ping',{},500);break}catch{owner?.close();owner=undefined;await delay(50)}}
    assert.ok(owner,'Runtime must start: '+startupError);const endpoint=await address(folder)
    const stranger=new RpcClient({...endpoint,token:'0'.repeat(64)})
    await assert.rejects(stranger.call('api',{path:'/api/panels'}),/capability/);stranger.close()
    const forged=new RpcClient({...endpoint,agent:'unknown-agent'})
    await assert.rejects(forged.call('mkdir',{path:join(folder,'unauthorized')}),/capability/);forged.close()
    const panel=await owner.call('api',{method:'POST',path:'/api/panels',body:{name:'IPC persistence',type:'source'}})
    const pid=(await owner.call('ping')).pid;owner.close();owner=new RpcClient(endpoint)
    assert.equal((await owner.call('ping')).pid,pid)
    assert.equal((await owner.call('api',{path:'/api/panels'}))[0].id,panel.id)
    await assert.rejects(owner.call('api',{path:'https://example.test/',method:'GET'}),/Unsupported/)
    await owner.call('stop');owner.close();owner=undefined
    await new Promise<void>((resolve,reject)=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>reject(new Error('Runtime did not stop')),10_000);child.once('exit',()=>{clearTimeout(timer);resolve()})})
  }finally{owner?.close();if(child.exitCode===null)child.kill();assert.ok(folder.startsWith(join(tmpdir(),'kraflr-terminal-test-')));await rm(folder,{recursive:true,force:true})}
})

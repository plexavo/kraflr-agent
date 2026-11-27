import assert from'node:assert/strict'
import test from'node:test'
import{mkdtemp,writeFile,readFile,rm,realpath}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join,resolve,relative}from'node:path'
import{pathToFileURL}from'node:url'
import{setTimeout as delay}from'node:timers/promises'
import{spawn}from'node-pty'
import{spawnWindowsTerminal}from'../server/windows-terminal.ts'
import{PaneScreen}from'../cli/screen.ts'

test('dedicated terminal relays Escape and Ctrl+C unchanged, streams output without repainting, and releases the client',async()=>{
 const base=await realpath(tmpdir()),folder=await mkdtemp(join(base,'kraflr-attach-qa-')),root=resolve(import.meta.dirname,'..'),file=join(folder,'native.ts'),log=join(folder,'input.jsonl')
 await writeFile(file,`
 import{EventEmitter}from'node:events'
 import{appendFileSync}from'node:fs'
 import{attachTerminal}from${JSON.stringify(pathToFileURL(join(root,'cli','attach.ts')).href)}
 const events=new Set(),socket=new EventEmitter(),emit=(name,value)=>{for(const listener of events)listener({event:'pty',id:'agent',packet:'event: '+name+'\\ndata: '+JSON.stringify(value)+'\\n\\n'})}
 const rpc={events,socket,close(){appendFileSync(${JSON.stringify(log)},JSON.stringify({closed:true})+'\\n')},async call(method,params){
  if(method==='terminal-attach')return{id:'agent',panelId:'panel',state:'running'}
  if(method==='watch'){queueMicrotask(()=>emit('snapshot','\\x1b[2J\\x1b[HNative terminal ready\\r\\n\\x1b]52;c;hidden\\x07'));return{}}
  if(method==='resize')return{}
  if(method==='input'){appendFileSync(${JSON.stringify(log)},JSON.stringify(params)+'\\n');emit('output','ECHO:'+params.text.replaceAll('\\x1b','ESC').replaceAll('\\x03','CTRLC')+'\\r\\n');if(params.text.includes('FINISH_TEST'))emit('state',{state:'exited'});return{}}
  throw Error('Unexpected request '+method)
 }}
 await attachTerminal(rpc,'agent')
 `)
 const terminal=process.platform==='win32'?spawnWindowsTerminal(process.execPath,[file],{cwd:root,cols:120,rows:35,env:process.env,name:'xterm-256color'}):spawn(process.execPath,[file],{cwd:root,cols:120,rows:35,env:process.env,name:'xterm-256color'})
 let output='',ended=false;const screen=new PaneScreen(120,35,text=>terminal.write(text));terminal.onData(text=>{output+=text;screen.write(text,()=>{})});terminal.onExit(()=>{ended=true})
 try{
  for(let i=0;i<100&&!output.includes('Native terminal ready');i++)await delay(50)
  assert.match(output,/Native terminal ready/);assert.doesNotMatch(output,/hidden|\x1b\]52/)
  const size=output.length;await delay(450);assert.equal(output.length,size,'No timer-driven full-screen refresh in the direct terminal')
  terminal.write('\x1b');await delay(150);terminal.write('\x03');await delay(150);terminal.write('plain input');await delay(150)
  let received=''
  for(let i=0;i<100;i++){
    const recorded=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
    received=recorded.filter(item=>typeof item.text==='string'&&!item.generated).map(item=>item.text).join('')
    if(received==='\x1b\x03plain input')break
    await delay(30)
  }
  assert.equal(received,'\x1b\x03plain input','Native input is an ordered byte stream; PTY chunk boundaries and delivery timing may vary')
  terminal.resize(150,40);await delay(100);terminal.write('FINISH_TEST')
  for(let i=0;i<100&&!ended;i++)await delay(50);assert.equal(ended,true)
  assert.match(await readFile(log,'utf8'),/"closed":true/)
 }finally{if(!ended)terminal.kill();screen.dispose();assert.ok(relative(base,resolve(folder)).startsWith('kraflr-attach-qa-'));await rm(folder,{recursive:true,force:true})}
})

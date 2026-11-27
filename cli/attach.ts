import type{RpcClient}from'./ipc.ts'

/** Streaming VT passthrough: native drawing stays native; host side effects are contained. */
export class TerminalOutput{
  private mode:'text'|'escape'|'csi'|'string'|'end'='text'
  private sequence=''
  write(text:string){let output='';for(const ch of text){
    if(this.mode==='string'){if(ch==='\x07'||ch==='\x9c')this.mode='text';else if(ch==='\x1b')this.mode='end';continue}
    if(this.mode==='end'){this.mode=ch==='\\'?'text':ch==='\x1b'?'end':'string';continue}
    if(this.mode==='escape'){
      if(ch==='['){this.mode='csi';this.sequence='\x1b['}
      else if(']PX^_'.includes(ch)){this.mode='string'}
      else{if(ch!=='c')output+='\x1b'+ch;this.mode='text'}continue
    }
    if(this.mode==='csi'){
      this.sequence+=ch
      if(ch>='@'&&ch<='~'){if(ch!=='t')output+=this.sequence;this.mode='text';this.sequence=''}
      else if(this.sequence.length>128){this.mode='text';this.sequence=''}
      continue
    }
    if(ch==='\x1b')this.mode='escape'
    else if('\x90\x98\x9d\x9e\x9f'.includes(ch))this.mode='string'
    else if(ch==='\x9b'){this.mode='csi';this.sequence='\x1b['}
    else if(ch<'\x80'||ch>'\x9f')output+=ch
  }return output}
}

export async function attachTerminal(rpc:RpcClient,id:string){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Open the agent in an interactive terminal.')
  const filter=new TerminalOutput();let ended=false,resolveDone:()=>void=()=>{},failed:Error|undefined,pending='',sending=false
  const done=new Promise<void>(resolve=>{resolveDone=resolve})
  const finish=()=>{if(ended)return;ended=true;resolveDone()}
  async function send(){if(sending||ended||!pending)return;sending=true
    try{while(pending&&!ended){const text=pending.slice(0,60_000);pending=pending.slice(text.length);await rpc.call('input',{panel:session.panelId,id,text,generated:/^\x1b\[[?>\d;]*[cRn]$/.test(text)})}}
    catch(error){failed=error instanceof Error?error:new Error('Agent input disconnected.');finish()}finally{sending=false}
  }
  const input=(text:string)=>{if(Buffer.byteLength(pending+text)>128_000){failed=new Error('Input is backed up. Reopen this terminal before retrying.');finish();return}pending+=text;void send()}
  const size=()=>({cols:process.stdout.columns||100,rows:process.stdout.rows||30})
  const session=await rpc.call('terminal-attach',{id,...size()})
  const resize=()=>void rpc.call('resize',{panel:session.panelId,id,...size()}).catch(()=>finish())
  const onEvent=(event:any)=>{if(event.id!==id)return;if(event.event==='terminal-end'){if(!ended)failed=new Error('Terminal stream disconnected. Reopen the agent terminal to reconnect.');finish();return}if(event.event!=='pty')return;for(const part of String(event.packet).split('\n\n')){
    const name=/^event: (.+)$/m.exec(part)?.[1],json=/^data: (.*)$/m.exec(part)?.[1];if(!json)continue
    try{const value=JSON.parse(json);if(name==='output'||name==='snapshot'){
      const text=filter.write(String(value));if(process.stdout.writableLength>2*1024*1024){failed=new Error('Terminal output is backed up. Reopen this terminal to reconnect.');finish();return}process.stdout.write(text)
    }else if(name==='state'&&value.state!=='running'&&value.state!=='stopping')finish()}catch{failed=new Error('The terminal stream was interrupted.');finish()}
  }}
  rpc.events.add(onEvent);rpc.socket.once('close',finish)
  process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();process.stdin.on('data',input)
  process.stdout.on('resize',resize);process.once('SIGTERM',finish);process.once('SIGHUP',finish)
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H')
  try{await rpc.call('watch',{id});await done}
  finally{
    ended=true;rpc.events.delete(onEvent);rpc.socket.off('close',finish);process.stdin.off('data',input);process.stdin.setRawMode(false);process.stdin.pause()
    process.stdout.off('resize',resize);process.off('SIGTERM',finish);process.off('SIGHUP',finish)
    process.stdout.write('\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l');rpc.close()
  }
  if(failed)throw failed
}

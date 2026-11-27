export type TerminalInputEvent={type:'data';text:string}|{type:'escape'}|{type:'background';color:string}|{type:'mouse';button:number;x:number;y:number;pressed:boolean}
/** Frame terminal input before routing it, including fragmented mouse reports and paste. */
export class TerminalInput {
  buffer=''
  feed(text:string):TerminalInputEvent[]{
    this.buffer+=text
    if(this.buffer.length>128_000){this.buffer='';return[]}
    const events:TerminalInputEvent[]=[]
    while(this.buffer){
      if(this.buffer.startsWith('\x1b[200~')){
        const end=this.buffer.indexOf('\x1b[201~',6);if(end<0)break
        events.push({type:'data',text:this.buffer.slice(0,end+6)});this.buffer=this.buffer.slice(end+6);continue
      }
      if(this.buffer.startsWith('\x1b]')){
        const end=/\x07|\x1b\\/.exec(this.buffer)
        if(!end){if(this.buffer.length>1024)this.buffer='';break}
        const reply=/^\x1b\]11;(rgb:[a-f0-9]{1,4}\/[a-f0-9]{1,4}\/[a-f0-9]{1,4})$/i.exec(this.buffer.slice(0,end.index))
        if(reply)events.push({type:'background',color:reply[1]!})
        this.buffer=this.buffer.slice(end.index+end[0].length);continue
      }
      const mouse=/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.buffer)
      if(mouse){events.push({type:'mouse',button:Number(mouse[1]),x:Number(mouse[2])-1,y:Number(mouse[3])-1,pressed:mouse[4]==='M'});this.buffer=this.buffer.slice(mouse[0].length);continue}
      if(this.buffer[0]==='\x1b'){
        if(this.buffer.length===1||/^\x1b\[[0-9;<]*$/.test(this.buffer))break
        const csi=/^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.buffer)
        if(csi){events.push({type:'data',text:csi[0]});this.buffer=this.buffer.slice(csi[0].length);continue}
        this.buffer=this.buffer.slice(1);events.push({type:'escape'});continue
      }
      const end=this.buffer.indexOf('\x1b'),size=end<0?this.buffer.length:end
      events.push({type:'data',text:this.buffer.slice(0,size)});this.buffer=this.buffer.slice(size)
    }
    return events
  }
  flushEscape():TerminalInputEvent[]{if(this.buffer==='\x1b'){this.buffer='';return[{type:'escape'}]}return[]}
}

export type Key = { name: string; text?: string; x?: number; y?: number }
/** Bounded ANSI input decoder. Native-pane data bypasses this decoder unchanged. */
export class InputDecoder {
  buffer = ''
  paste = false
  feed(text: string): Key[] {
    this.buffer += text
    if (this.buffer.length > 128_000) { this.buffer = ''; return [] }
    const keys: Key[] = []
    const escape: Record<string, string> = { '\x1b[A':'up','\x1b[B':'down','\x1b[C':'right','\x1b[D':'left','\x1b[H':'home','\x1b[F':'end','\x1b[3~':'delete','\x1b[5~':'pageup','\x1b[6~':'pagedown','\x1b[Z':'backtab' }
    while (this.buffer) {
      if (this.paste) {
        const end = this.buffer.indexOf('\x1b[201~')
        if (end < 0) break
        keys.push({name:'text',text:this.buffer.slice(0,end)});this.buffer=this.buffer.slice(end+6);this.paste=false;continue
      }
      if (this.buffer.startsWith('\x1b[200~')) {this.paste=true;this.buffer=this.buffer.slice(6);continue}
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.buffer)
      if (mouse) { if(mouse[4]==='M')keys.push({name:Number(mouse[1])>=64 ? (Number(mouse[1])===64?'up':'down'):'mouse',x:Number(mouse[2])-1,y:Number(mouse[3])-1});this.buffer=this.buffer.slice(mouse[0].length);continue }
      const match=Object.keys(escape).find(key=>this.buffer.startsWith(key))
      if(match){keys.push({name:escape[match]!});this.buffer=this.buffer.slice(match.length);continue}
      if(this.buffer[0]==='\x1b') {
        if(this.buffer.length===1)break
        if(/^\x1b\[[0-9;<]*$/.test(this.buffer))break
        const csi=/^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.buffer)
        if(csi){this.buffer=this.buffer.slice(csi[0].length);continue}
        this.buffer=this.buffer.slice(1);keys.push({name:'escape'});continue
      }
      const char=String.fromCodePoint(this.buffer.codePointAt(0)!);this.buffer=this.buffer.slice(char.length)
      const controls:Record<string,string>={'\r':'enter','\n':'enter','\t':'tab','\x7f':'backspace','\b':'backspace','\x02':'prefix','\x03':'ctrlc','\x10':'prompt','\x0e':'new','\x0c':'refresh'}
      if(controls[char])keys.push({name:controls[char]!});else if(char>=' ')keys.push({name:'text',text:char})
    }
    return keys
  }
  flushEscape():Key[]{if(this.buffer==='\x1b'){this.buffer='';return[{name:'escape'}]}return[]}
}


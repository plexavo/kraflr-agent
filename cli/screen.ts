import { createRequire } from 'node:module'
import type { Terminal as HeadlessTerminal, IBufferCell } from '@xterm/headless'
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless')
export const clean = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g,' ')
// gold = in progress, green = passed, red = error, accent = what you have selected. Plain text is ink; secondary text is muted.
export const colors = { gold:'\x1b[38;2;236;201;110m', muted:'\x1b[38;2;139;143;152m', ink:'\x1b[38;2;224;226;231m', green:'\x1b[38;2;143;197;163m', red:'\x1b[38;2;240;118;118m', border:'\x1b[38;2;61;63;70m', accent:'\x1b[38;2;125;169;240m', chip:'\x1b[48;2;38;41;52m', bold:'\x1b[1m', reset:'\x1b[0m' }
export type Tone = 'error' | 'progress' | 'pass' | 'info'
export const toneColor: Record<Tone, string> = { error: colors.red, progress: colors.gold, pass: colors.green, info: colors.ink }
/** How a lead's verification state reads at a glance: red when it needs attention, yellow while it moves, green when it passed. */
export function stateTone(state: string | undefined): Tone {
  if (['failed', 'interrupted', 'stale', 'expired'].includes(state ?? '')) return 'error'
  if (['preparing', 'analysing', 'awaiting_approval', 'running'].includes(state ?? '')) return 'progress'
  return state === 'verified' ? 'pass' : 'info'
}
// Match host padding to the canvas; restore its reported background or request the profile default.
export const terminalBackground={query:'\x1b]11;?\x1b\\',enter:'\x1b]11;rgb:12/13/17\x1b\\',restore:(color?:string)=>color?`\x1b]11;${color}\x1b\\`:'\x1b]111\x1b\\'}
export interface Rect { x:number;y:number;w:number;h:number }
export interface Hit extends Rect { action:()=>void }
export class Frame {
  cells:string[][]
  styles:string[][]
  constructor(readonlyWidth:number,readonlyHeight:number){this.width=readonlyWidth;this.height=readonlyHeight;this.cells=Array.from({length:this.height},()=>Array(this.width).fill(' '));this.styles=Array.from({length:this.height},()=>Array(this.width).fill(colors.ink))}
  width:number;height:number
  text(x:number,y:number,text:unknown,width=this.width-x,color=colors.ink){if(y<0||y>=this.height)return;let col=x;for(const ch of Array.from(clean(text)).slice(0,Math.max(0,width))){if(col>=0&&col<this.width){this.cells[y]![col]=ch;this.styles[y]![col]=color}col++}}
  box(r:Rect,title='',active=false,tone=colors.accent){if(r.w<3||r.h<3)return;const c=active?tone:colors.border;this.text(r.x,r.y,'┌'+'─'.repeat(r.w-2)+'┐',r.w,c);this.text(r.x,r.y+r.h-1,'└'+'─'.repeat(r.w-2)+'┘',r.w,c);for(let y=r.y+1;y<r.y+r.h-1;y++){this.text(r.x,y,'│',1,c);this.text(r.x+r.w-1,y,'│',1,c)}if(title)this.text(r.x+2,r.y,' '+title+' ',r.w-4,active?colors.bold+tone:colors.ink)}
  ansi(previous?:Frame){let output='';const same=previous?.width===this.width&&previous.height===this.height
    for(let y=0;y<this.height;y++){
      let start=0,end=this.width-1
      if(same){const equal=(x:number)=>this.cells[y]![x]===previous.cells[y]![x]&&this.styles[y]![x]===previous.styles[y]![x];while(start<=end&&equal(start))start++;if(start>end)continue;while(end>start&&equal(end))end--;if(start>0&&(this.cells[y]![start]===''||previous.cells[y]![start]===''))start--}
      output+=`\x1b[${y+1};${start+1}H`;let style=''
      for(let x=start;x<=end;x++){const next=this.styles[y]![x]!;if(next!==style){output+='\x1b[0m\x1b[48;2;18;19;23m'+next.replaceAll('\x1b[0m','\x1b[0m\x1b[48;2;18;19;23m');style=next}output+=this.cells[y]![x]??' '}
      output+='\x1b[0m'
    }return output?'\x1b[?2026h\x1b[?25l'+output+'\x1b[?2026l':''
  }
}
function style(cell:IBufferCell){let s='\x1b[0m';if(cell.isBold())s+='\x1b[1m';if(cell.isDim())s+='\x1b[2m';if(cell.isItalic())s+='\x1b[3m';if(cell.isUnderline())s+='\x1b[4m';if(cell.isInverse())s+='\x1b[7m';for(const [prefix,mode,value]of[[38,cell.getFgColorMode(),cell.getFgColor()],[48,cell.getBgColorMode(),cell.getBgColor()]]as const){if(mode===0x1000000||mode===0x2000000)s+=`\x1b[${prefix};5;${value}m`;else if(mode===0x3000000)s+=`\x1b[${prefix};2;${(value>>16)&255};${(value>>8)&255};${value&255}m`}return s}
export class PaneScreen {
  terminal:HeadlessTerminal
  cursorVisible=true
  private revision=0
  private cache?:{revision:number;offset:number;frame:Frame}
  constructor(cols:number,rows:number,onReply:(text:string)=>void){this.terminal=new Terminal({cols,rows,allowProposedApi:true,scrollback:1000,logLevel:'off'});this.terminal.onData(onReply);for(const final of ['h','l'])this.terminal.parser.registerCsiHandler({prefix:'?',final},params=>{if(params.includes(25))this.cursorVisible=final==='h';return false})}
  write(text:string,done:()=>void){this.terminal.write(text,()=>{this.revision++;done()})}
  resize(cols:number,rows:number){if(this.terminal.cols!==cols||this.terminal.rows!==rows){this.terminal.resize(cols,rows);this.revision++}}
  draw(frame:Frame,r:Rect,offset=0){
    if(!this.cache||this.cache.revision!==this.revision||this.cache.offset!==offset||this.cache.frame.width!==r.w||this.cache.frame.height!==r.h){
      const local=new Frame(r.w,r.h),buffer=this.terminal.buffer.active,reusable=buffer.getNullCell()
      for(let row=0;row<r.h;row++){const line=buffer.getLine(Math.max(0,buffer.baseY-offset)+row);if(!line)continue;for(let col=0;col<r.w;col++){const cell=line.getCell(col,reusable);if(!cell)continue;local.cells[row]![col]=cell.getWidth()===0?'':cell.getChars()||' ';local.styles[row]![col]=style(cell)}}
      this.cache={revision:this.revision,offset,frame:local}
    }
    for(let y=0;y<r.h;y++)for(let x=0;x<r.w;x++){frame.cells[r.y+y]![r.x+x]=this.cache.frame.cells[y]![x]!;frame.styles[r.y+y]![r.x+x]=this.cache.frame.styles[y]![x]!}
  }
  dispose(){this.terminal.dispose()}
}
export function paneGrid(r:Rect):Rect[]{const w=Math.floor(r.w/2),h=Math.floor(r.h/2);return[{x:r.x,y:r.y,w,h},{x:r.x+w,y:r.y,w:r.w-w,h},{x:r.x,y:r.y+h,w,h:r.h-h},{x:r.x+w,y:r.y+h,w:r.w-w,h:r.h-h}]}
export function paneLayout(r:Rect,count:number):Rect[]{
  if(count<=0)return[]
  if(count===1)return[{...r}]
  const left=Math.floor(r.w/2),top=Math.floor(r.h/2)
  if(count===2)return[{...r,w:left},{...r,x:r.x+left,w:r.w-left}]
  if(count===3)return[{...r,w:left},{x:r.x+left,y:r.y,w:r.w-left,h:top},{x:r.x+left,y:r.y+top,w:r.w-left,h:r.h-top}]
  return paneGrid(r)
}

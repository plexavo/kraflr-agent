import{PaneScreen}from'./screen.ts'
import type{IBuffer}from'@xterm/headless'
import type{NativeAgentKind}from'../shared/agent-terminal.ts'
/** Observe the native composer without ever typing into it or granting permission. */
export class NativePrompt{
  readonly screen:PaneScreen
  private active=false
  private activeSince=0
  private draft=''
  private typed=''
  private paste=''
  private submitted=false
  private clear=false
  private blocked='Starting'
  private changed=0
  // Screen evidence that a turn is no longer running, for turns that end without a lifecycle hook (Esc, a menu choice, a lost hook).
  private idleSince=0
  private outputAt=0
  readonly kind:NativeAgentKind
  constructor(cols:number,rows:number,kind:NativeAgentKind='cline'){this.kind=kind;this.screen=new PaneScreen(cols,rows,()=>{})}
  output(text:string,done:()=>void){this.screen.write(text,()=>{this.outputAt=Date.now();this.observe();done()})}
  resize(cols:number,rows:number){this.screen.resize(cols,rows);this.observe()}
  private observe(){
    const terminal=this.screen.terminal,buffer=terminal.buffer.active,lines=Array.from({length:terminal.rows},(_,row)=>buffer.getLine(buffer.baseY+row)?.translateToString(true).trim()??'')
    if(this.kind==='claude'){this.observeClaude(lines,buffer);return}
    const composer=lines.findLastIndex(line=>/^[›❯>]/.test(line)),bottom=lines.slice(Math.max(0,composer)),text=bottom.join('\n')
    this.clear=composer>=0&&/^[›❯>]\s*(?:What can I do for you\?|Ask anything(?:\.\.\.|…)?|Ask Cline(?:\.\.\.|…)?|Type a message(?:\.\.\.|…)?)\s*$/i.test(lines[composer]!)&&/Plan.*Act|Auto-approve/.test(bottom.join('\n'))
    this.blocked=lines.some(line=>/^Cline needs permission$|^Cline is asking a question$/.test(line))?'Needs your response':lines.some(line=>/^Select (?:a )?(?:model|provider)|^Choose (?:a )?(?:model|provider)|^Search models/i.test(line))||/enter.{0,8}(?:select|confirm)|esc.{0,8}cancel/i.test(text)?'Native menu open':this.clear?'':'Native prompt has a draft or menu'
    if(this.clear&&!this.blocked)this.draft=''
    // Cline shows its empty composer while it works too, so the "esc to cancel" spinner line is what tells a running turn apart.
    if(this.clear&&!this.blocked&&!lines.some(line=>/esc to (?:cancel|interrupt)/i.test(line)))this.idleSince||=Date.now();else this.idleSince=0
  }
  /**
   * Claude Code frames its composer between two rules and shows dimmed ghost text until something is typed: either its
   * own startup example ("Try \"...\"") or, after a turn, an AI-guessed next prompt in the researcher's own words.
   * Both are accepted with Tab, not submitted, and both render dim — unlike real typed text, which never does — so
   * dimness alone is what tells ghost text apart from a genuine draft, not the specific wording.
   */
  private observeClaude(lines:string[],buffer:IBuffer){
    const rule=/^[─━]{8,}/,composer=lines.findLastIndex(line=>/^❯/.test(line))
    const framed=composer>0&&rule.test(lines[composer-1]??'')&&rule.test(lines[composer+1]??'')
    const rendered=composer>=0?buffer.getLine(buffer.baseY+composer):undefined
    const typed=composer>=0?lines[composer]!.replace(/^❯\s*/,''):''
    const raw=rendered?.translateToString(true)??'',column=raw.indexOf('❯')+2
    const placeholder=typed===''||Boolean(rendered?.getCell(column)?.isDim())
    const working=lines.some(line=>/esc to interrupt/i.test(line))
    const dialog=lines.some(line=>/^Do you want to /.test(line))&&lines.some(line=>/^(?:❯\s*)?1\.\s*Yes/.test(line))||lines.some(line=>/Enter to (?:select|confirm).*Esc to cancel/i.test(line))
    const setup=lines.some(line=>/Do you trust the files|trust this folder|Quick safety check|Choose the text style|Select login method/i.test(line))
    this.clear=framed&&placeholder&&!dialog&&!setup
    this.blocked=dialog?'Needs your response':setup?'Claude Code is waiting for a setup or trust choice':this.clear?'':framed&&!placeholder?'Native prompt has a draft or menu':'Check native prompt'
    if(this.clear&&!this.blocked)this.draft=''
    // A clear composer with no spinner means any turn that was in flight has ended, even if Claude Code sent no Stop hook (for example after Esc).
    if(this.clear&&!working&&!dialog)this.idleSince||=Date.now();else this.idleSince=0
  }
  /**
   * Claude Code's folder questions, when one is showing: "Is this a folder you trust?" (the working folder) and "Adding a new directory" (a folder passed
   * with --add-dir). Returns the folder it names (rejoined if a narrow pane wrapped it) and the key presses that answer Yes from where the cursor is.
   * Both default to "No, exit", which would end the session.
   */
  trustDialog():{folder:string;keys:string}|undefined{
    if(this.kind!=='claude')return
    const terminal=this.screen.terminal,buffer=terminal.buffer.active,lines=Array.from({length:terminal.rows},(_,row)=>buffer.getLine(buffer.baseY+row)?.translateToString(true).trim()??'')
    const no=lines.findIndex(line=>/^(?:❯\s*)?No, exit/.test(line))
    const read=(start:RegExp,end:RegExp,answer:RegExp)=>{
      const from=lines.findIndex(line=>start.test(line)),to=lines.findIndex((line,index)=>index>from&&end.test(line)),yes=lines.findIndex(line=>answer.test(line))
      if(from<0||to<=from||yes<0||no<0)return
      const folder=lines.slice(from+1,to).join('').replace(/\s+/g,'')
      return folder?{folder,keys:/^❯/.test(lines[yes]!)?'\r':'\x1b[B'}:undefined
    }
    return read(/^Accessing workspace:?$/,/^Quick safety check/,/^(?:❯\s*)?Yes, I trust this folder/)
      ??read(/^Adding a new directory:?$/,/^This session hasn.t worked here before/,/^(?:❯\s*)?Yes, add it/)
  }
  input(text:string):string|undefined{
    if(/^\x1b\[<(?:\d+);\d+;\d+[Mm]$/.test(text)||/^\x1b\[[?>\d;]*[cRn]$/.test(text))return
    if(this.paste){text=this.paste+text;this.paste=''}
    if(text.startsWith('\x1b[200~')){
      const end=text.indexOf('\x1b[201~',6)
      if(end<0){this.paste=text.slice(0,128_000);this.draft='Pasting';return}
      const body=text.slice(6,end).replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');this.typed=(this.typed+body).slice(0,12000);this.draft=this.typed;this.changed=Date.now()
      return text.length>end+6?this.input(text.slice(end+6)):undefined
    }
    const clean=text.replace(/\x1b\[20[01]~/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
    let submission:string|undefined
    for(const ch of clean){if(ch==='\r'||ch==='\n'){if(this.typed.trim()&&!this.typed.trim().startsWith('/')){this.submitted=true;this.activeSince=Date.now();this.idleSince=0;submission=this.typed.trim()}this.draft='';this.typed=''}else if(ch==='\x7f'||ch==='\b'){this.typed=Array.from(this.typed).slice(0,-1).join('');this.draft=this.typed}else if(ch==='\x15'||ch==='\x03'){this.draft='';this.typed=''}else if(ch>=' '){this.typed=(this.typed+ch).slice(0,12000);this.draft=this.typed}}
    if(clean.replace(/\x1b/g,'').length)this.changed=Date.now()
    return submission
  }
  hook(name:string){if(/^(TaskStart|UserPromptSubmit)$/.test(name)){this.active=true;this.activeSince=Date.now();this.submitted=true;this.draft='';this.typed=''}else if(/^(TaskComplete|TaskError|TaskCancel)$/.test(name)){this.active=false;this.submitted=false;this.draft='';this.typed=''}}
  /**
   * True once the pane has sat on an empty composer, spinner gone, long enough that a turn Kraflr still counts as running must have ended without
   * saying so. A working CLI keeps drawing, so quiet output confirms it; a pane that stays idle but keeps redrawing is believed after longer.
   * Claude Code needs seconds. Cline gets longer.
   */
  interrupted(now=Date.now()){
    if(!(this.active||this.submitted)||this.idleSince<=0)return false
    const idle=now-this.idleSince,since=now-this.activeSince,quiet=now-this.outputAt
    if(this.kind==='claude')return idle>2500&&since>4000&&(quiet>2000||idle>20_000)
    return idle>15_000&&since>15_000&&(quiet>8000||idle>90_000)
  }
  /** Forget a turn that interrupted() proved is over. */
  settle(){this.active=false;this.submitted=false}
  // Reading the status never ends a turn: the runtime does that, so it can also release an assignment still waiting on it.
  status(quiet=true){
    const working=(this.active||this.submitted)&&!this.interrupted()
    const reason=working?'Working':this.draft?'Unsent draft':this.blocked||(!this.clear?'Check native prompt':quiet&&Date.now()-this.changed<180?'Updating native prompt':'');return{ready:!reason,reason}
  }
  confirm(){return this.status(false)}
  dispose(){this.screen.dispose()}
}

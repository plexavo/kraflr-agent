import{limitPattern,type AgentAttention,type AgentKind,type AgentTerminalInfo}from'../shared/agent-terminal.ts'
export type Activity='starting'|'ready'|'active'|'approval'|'question'|'limit'|'stopped'
export function visibleAttention(lines:string[],kind:AgentKind='cline'):'approval'|'question'|undefined{
  const viewport=lines.map(line=>line.trim())
  // Only known dialogs count: an unrecognised screen is never reported as an approval, so a status marker cannot invite a blind confirmation.
  if(kind==='claude'){
    if(viewport.some(line=>/^Do you want to /.test(line))&&viewport.some(line=>/^(?:❯\s*)?1\.\s*Yes/.test(line)))return'approval'
    if(viewport.some(line=>/Do you trust the files|trust this folder|Quick safety check/i.test(line))||viewport.some(line=>/Enter to (?:select|confirm).*Esc to cancel/i.test(line)))return'question'
    return
  }
  if(viewport.includes('Cline needs permission')&&viewport.some(line=>/\[y\]\s*Approve.*\[n\]\s*Deny/.test(line)))return'approval'
  if(viewport.includes('Cline is asking a question')&&viewport.some(line=>/How should Cline|Select|Type a response|Try a different approach/.test(line)))return'question'
}
/** A provider limit message that a native pane prints without any hook reporting it. It must read like a notice (short, with a reset or retry hint) so code or prose about rate limits never matches. */
export function visibleLimit(lines:string[]):string|undefined{
  for(const raw of lines.slice().reverse()){const line=raw.trim();if(line&&line.length<200&&limitPattern.test(line)&&/\breset|try again|upgrade|credits?\b|renews?\b/i.test(line)&&!/[{};=<>]/.test(line))return line}
}
export function activity(agent:AgentTerminalInfo,request:AgentAttention|undefined,observed:ReturnType<typeof visibleAttention>,assigned:boolean,recentOutput:boolean):Activity{
  if(agent.state!=='running')return'stopped'
  // A provider limit or a crash leaves the pane looking idle; say so instead of showing a healthy "Ready".
  if(agent.stoppage)return agent.stoppage.kind==='limit'?'limit':'stopped'
  if(request?.permissions.length||observed==='approval')return'approval'
  if(request?.question||observed==='question')return'question'
  if(agent.activity==='starting')return'starting'
  if(assigned||agent.activity==='working'||recentOutput)return'active'
  return'ready'
}
export const activityLabels:Record<Activity,string>={starting:'Starting',ready:'Ready',active:'Active',approval:'Review approval',question:'Needs an answer',limit:'Limit reached',stopped:'Stopped'}
/**
 * Whether the work Kraflr records for an agent should show it as busy. Only OpenCode needs this: the Claude Code and Cline panes say so
 * themselves, and a run that is merely waiting (a Parent on its Child, a message not yet delivered) leaves an agent at rest.
 */
export function assignedWork(agentId:string,runs:{status:string;purpose?:string;parentId:string;tasks?:{sessionId:string;status:string}[]}[]){
  return runs.some(run=>{
    if(run.status!=='running'||run.purpose==='conversation')return false
    const waiting=run.tasks?.filter(task=>task.status==='assigned')??[]
    return waiting.some(task=>task.sessionId===agentId)&&run.purpose!=='collaboration'||run.purpose!=='collaboration'&&run.parentId===agentId&&!waiting.length
  })
}
/** Green when healthy and idle, yellow while it works or waits for you, red when it cannot continue. */
export const activityTone:Record<Activity,'error'|'progress'|'pass'|'info'>={starting:'progress',ready:'pass',active:'progress',approval:'progress',question:'progress',limit:'error',stopped:'error'}
export function activityGlyph(state:Activity,now=Date.now()){
  const frames:Record<Activity,string[]>={starting:['◴','◷','◶','◵'],ready:['●'],active:['▁','▂','▄','▆','▄','▂'],approval:['◇','◆','◇',' '],question:['?','?','·','·'],limit:['!'],stopped:['○']}
  const set=frames[state];return set[Math.floor(now/(state==='approval'?240:170))%set.length]!
}
export const orbit=(now=Date.now())=>['◴','◷','◶','◵'][Math.floor(now/180)%4]!
export const kraflrAscii=[
  '█   █  █████   █████  █████  █      █████ ',
  '█  █   █   █   █   █  █      █      █   █ ',
  '███    █████   █████  ████   █      █████ ',
  '█  █   █  █    █   █  █      █      █  █  ',
  '█   █  █   █   █   █  █      █████  █   █ ',
]

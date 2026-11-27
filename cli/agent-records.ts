import{createHash,randomUUID}from'node:crypto'
import{StoreError,type ResearchStore}from'../server/db.ts'
import type{AgentTerminalInfo}from'../shared/agent-terminal.ts'
import type{ResearchRun}from'../shared/research-run.ts'
import{report}from'../server/research-team.ts'
export function recordId(key:string){const hex=createHash('sha256').update(key).digest('hex').slice(0,32);return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`}
export function saveConversation(store:ResearchStore,agent:AgentTerminalInfo,key:string,prompt:string,text:string,status:'completed'|'failed'='completed'){
 const id=recordId(agent.id+':'+key);if(store.hasAgentRecord(agent.panelId,id))return
 try{store.readResearchRun(agent.panelId,recordId(`terminal-team:${agent.id}:${key}`));return}catch(error){if(!(error instanceof StoreError&&error.status===404))throw error}
 if(store.listResearchRuns(agent.panelId).some(run=>run.purpose!=='conversation'&&((run.parentId===agent.id&&run.fullReply?.includes(text))||run.tasks.some(task=>task.sessionId===agent.id&&task.fullReply===text))))return
 const parsed=report(text),now=new Date().toISOString()
 store.saveAgentRecord({id,panelId:agent.panelId,parentId:agent.id,parentName:agent.label,scopeVersion:agent.scopeVersion!,purpose:'conversation',objective:prompt.trim().slice(0,8000)||'Direct native conversation',status,phase:status==='completed'?'Native conversation saved':'Native conversation failed',startedAt:now,endedAt:now,reply:parsed.reply,summary:parsed.summary,fullReply:text,leads:parsed.leads,tasks:[],deadEnds:parsed.deadEnds,nextSteps:parsed.nextSteps,repositorySuggestion:parsed.repositorySuggestion})
}
export function exchangeRecord(sender:AgentTerminalInfo,peer:AgentTerminalInfo,text:string):ResearchRun{
 return{id:randomUUID(),panelId:sender.panelId,parentId:sender.id,parentName:sender.label,scopeVersion:sender.scopeVersion!,purpose:'collaboration',objective:`${sender.label} → ${peer.label}: ${text}`.slice(0,8000),status:'running',phase:'Waiting for teammate',startedAt:new Date().toISOString(),endedAt:null,summary:'',tasks:[{sessionId:peer.id,agent:peer.label,objective:text,status:'assigned',result:''}],leads:[],deadEnds:[],nextSteps:[]}
}

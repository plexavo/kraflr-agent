import type{ResearchRun}from'../shared/research-run.ts'
/** Keep list refreshes small; complete replies stay in SQLite and are read on demand. */
export function runSummary(run:ResearchRun){
  const{fullReply:_reply,parentReplies:_parents,...rest}=run
  return{...rest,leads:[],summary:run.summary.slice(0,2400),reply:run.reply?.slice(0,2400),
    tasks:run.tasks.map(({fullReply:_full,...task})=>({...task,result:task.result.slice(0,1200)})),
    deadEnds:run.deadEnds.slice(0,15),nextSteps:run.nextSteps.slice(0,15)}
}
export function recordSlice(run:ResearchRun,offset=0){
  const text=[`Research: ${run.objective}`,`Scope ${run.scopeVersion} · ${run.status} · ${run.startedAt}`,run.summary,'',
    run.purpose==='collaboration'?'TEAMMATE REPLY':run.purpose==='conversation'?'AGENT REPLY':'PARENT REPLY',run.fullReply||run.parentReplies?.join('\n\n--- Parent turn ---\n\n')||run.reply||'',
    ...run.tasks.flatMap(task=>['',`${run.purpose==='collaboration'?'TEAMMATE':'WORKER'}: ${task.agent} · round ${task.round??1} · ${task.status}`,'Assigned by: '+(run.purpose==='collaboration'?'Peer message':task.automatic?'Kraflr independent-review fallback':'Parent task plan'),task.objective,task.fullReply||task.result]),
    '', 'RECORDED EVIDENCE',JSON.stringify(run.leads,null,2),'','DEAD ENDS',...run.deadEnds,'','NEXT STEPS',...run.nextSteps,
  ].join('\n')
  const start=Math.min(text.length,Math.max(0,Math.trunc(offset))),size=64_000
  return{id:run.id,purpose:run.purpose,phase:run.phase,status:run.status,offset:start,total:text.length,text:text.slice(start,start+size),more:start+size<text.length}
}

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { RpcClient } from './ipc.ts'
import { InputDecoder, type Key } from './input.ts'
import { Frame, PaneScreen, paneLayout, terminalBackground, colors as c, clean, stateTone, toneColor, type Hit, type Rect, type Tone } from './screen.ts'
import { emptyScope, accessLabels, researchLabels, scopeFields, type Panel, type PanelDetail, type ScopeInput } from '../shared/research.ts'
import { parseWebTargets } from '../shared/web-scope.ts'
import { burpHint } from '../shared/burp.ts'
import { kickoffPrompt, huntDepths, type HuntDepth } from '../shared/kickoff-prompt.ts'
import { agentDetails, type AgentTerminalInfo } from '../shared/agent-terminal.ts'
import { confirmationNote, type EvidenceLead, type EvidenceTag } from '../shared/evidence.ts'
import { activity, activityGlyph, activityLabels, activityTone, assignedWork, visibleAttention, visibleLimit, orbit, kraflrAscii } from './activity.ts'
import { TerminalInput, type TerminalInputEvent } from './terminal-input.ts'
import { ApprovalInput } from './approval-input.ts'
import type { AgentAttention } from '../shared/agent-terminal.ts'

type Choice={label:string;run:()=>void|Promise<void>;tone?:Tone}
type Menu={title:string;lines:string[];choices:Choice[];selected:number;scroll:number;verificationKey?:string;stamp?:string;banner?:{text:string;tone:Tone}}
type Field={label:string;value:string;options?:string[];cursor?:number;onChange?:()=>void}
type Form={title:string;fields:Field[];selected:number;submit:(values:string[])=>Promise<void>}
type Pane={screen:PaneScreen;panel:string;cols:number;rows:number;scroll:number;lastOutput:number;owned:boolean;attaching:boolean;error:string;queue:{text:string;generated:boolean}[];sending:boolean}
const tabs=['Agents','Leads','Killed leads','Findings','Scope'] as const
const scopeInput=(scope?:Partial<ScopeInput>)=>Object.fromEntries(Object.entries(emptyScope).map(([key,value])=>[key,scope?.[key as keyof ScopeInput]??value])) as ScopeInput
type View=typeof tabs[number]|'Investigation'
const wrap=(text:string,width:number)=>{const result:string[]=[];for(const line of text.split('\n')){let rest=clean(line);while(rest.length>width){let cut=rest.lastIndexOf(' ',width);if(cut<width/2)cut=width;result.push(rest.slice(0,cut));rest=rest.slice(cut).trimStart()}result.push(rest)}return result}

export async function runTui(rpc:RpcClient) {
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Open Kraflr in an interactive terminal, or use `kraflr status`.')
  let panels:Panel[]=[],panel:PanelDetail|undefined,sessions:AgentTerminalInfo[]=[],runs:any[]=[],evidence:any,investigation:any
  let selectedPanel='',view:View='Investigation',listIndex=0,paneIndex=0,busy=0,notice='',noticeTone:Tone='info',noticeUntil=0,menu:Menu|undefined,form:Form|undefined
  let hits:Hit[]=[],ended=false,dirty=true,drawing=false,refreshing=false,evidenceOffset=0
  let focus=-1,requests:AgentAttention[]=[],formError='',previousFrame:Frame|undefined
  let nativeInput=false,nativePointer='',regions:{agent:AgentTerminalInfo;rect:Rect;index:number}[]=[]
  let paintTimer:ReturnType<typeof setTimeout>|undefined
  const screens=new Map<string,Pane>()
  const approvalInputs=new Map<string,ApprovalInput>()
  const verificationWatches=new Map<string,{lead:EvidenceLead;state:string;autoRecover:boolean}>(),recoveredLabs=new Set<string>()
  // Stoppages the researcher has already been told about, so a limit pop-up appears once per stoppage instead of on every refresh.
  const toldAboutStop=new Set<string>()
  // The selected panel's totals per category, for the sidebar and to announce a new Finding.
  let counts:Record<EvidenceTag,number>|undefined
  // OpenCode sends no prompt hook, so a line the researcher submitted in its pane is remembered here.
  const typedPrompt=new Set<string>(),typedLine=new Map<string,string>()
  const decoder=new InputDecoder()
  let hostBackground:string|undefined,waitingForBackground=true,backgroundReceived=()=>{}
  const backgroundReady=new Promise<void>(resolve=>{backgroundReceived=resolve})
  const help=()=>show('Using Kraflr',[
    'Click buttons and tabs, or move between controls with Tab and select with Enter.',
    'New panel asks what type of security research this is. Open-source code review asks for the repository. Web application testing asks for the authorized targets and the rules of engagement (written here, a link, or a text file). Kickoff prompt sends the Parent a research prompt built from the scope, as it is or with your additions. The button leaves once the Parent has started working.',
    'Create sessions to add independent terminal panes inside this workspace. No empty slots are reserved.',
    'Click inside a pane to type. Escape, Ctrl+C and Tab go to that CLI. Click the sidebar, a tab or Workspace controls to return to navigation.',
    'Type work requests in the Parent terminal. A Child works only on what the Parent or you send it.',
    'Click a lead for Verify, Accept, Challenge, Rule out or Explain. An agent can move a lead to Findings itself when it has reproduced it with a control case; the Finding says so, and you can move it back. Research record retains full replies and General evidence.',
    'Verification: agents build the lab on their own. When it is ready a pop-up shows the exact test. Approve it with Parent verification or Child verification; that agent runs the test and marks the lead as a Finding or a killed lead. A chat message is not an approval. If the lab fails, the agent repairs it and asks again; Inform agent prompts it if it has stopped.',
    'Colors: red is an error or a stopped agent, yellow is work in progress, green is a pass or a healthy agent. If an agent hits its usage limit a pop-up offers to hand its saved context to another agent.',
    'A pulsing diamond means review an approval. A question mark means the agent needs an answer. Click the agent to review; indicators never approve a request.',
    'Detach leaves your agents running. kraflr stop explicitly stops the runtime.',
  ])
  let escapeTimer:ReturnType<typeof setTimeout>|undefined
  const api=<T=any>(path:string,method='GET',body?:unknown)=>rpc.call('api',{path,method,body}) as Promise<T>
  const mark=()=>{dirty=true;if(!paintTimer&&!ended)paintTimer=setTimeout(()=>{paintTimer=undefined;render()},12)}
  const alert=(text:string,tone:Tone='info')=>{notice=clean(text);noticeTone=tone;noticeUntil=Date.now()+16_000;mark()}
  async function action(fn:()=>Promise<void>,onError?:(message:string)=>void){busy++;mark();try{await fn()}catch(error){const message=error instanceof Error?error.message:'Action failed.';alert(message,'error');if(onError)onError(message);else if(form)formError=message;else show('Action needs attention',[message],selectedPanel?[{label:'Edit scope',run:()=>scopeForm(true)}]:[])}finally{busy--;mark()}}
  const visible=()=>sessions.filter(item=>item.panelId===selectedPanel&&item.state==='running').slice(0,4)
  const chosen=()=>visible()[paneIndex]
  const parent=()=>sessions.find(item=>item.panelId===selectedPanel&&item.parent&&item.state==='running')
  function show(title:string,lines:string[],choices:Choice[]=[],banner?:Menu['banner']){nativeInput=false;menu={title,lines,choices:selectedChoices(choices),selected:0,scroll:0,banner};form=undefined;mark()}
  function selectedChoices(choices:Choice[]){return [...choices,{label:'Back',run:()=>{menu=undefined;mark()}}]}
  function fields(title:string,items:Field[],submit:(values:string[])=>Promise<void>){nativeInput=false;menu=undefined;formError='';form={title,fields:items.map(item=>({...item,cursor:item.value.length})),selected:0,submit};mark()}
  function select(id:string){nativeInput=false;selectedPanel=id;panel=undefined;counts=undefined;view='Agents';listIndex=0;evidenceOffset=0;evidence=undefined;paneIndex=0;void refresh();mark()}
  async function refresh(){if(refreshing||ended)return;refreshing=true;try{
    const loaded=await Promise.allSettled([api<Panel[]>('/api/panels'),api<AgentTerminalInfo[]>('/api/agents/sessions'),api('/api/investigation'),api<AgentAttention[]>('/api/agents/attention')])
    if(loaded[0].status==='fulfilled')panels=loaded[0].value
    if(loaded[1].status==='fulfilled'){sessions=loaded[1].value;noteScreenLimits()}
    if(loaded[2].status==='fulfilled')investigation=loaded[2].value
    if(loaded[3].status==='fulfilled')requests=loaded[3].value
    for(const[id,pane]of screens)if(!sessions.some(item=>item.id===id&&item.state==='running')){pane.screen.dispose();screens.delete(id);approvalInputs.delete(id)}
    if(selectedPanel){const id=selectedPanel;const category:EvidenceTag=view==='Killed leads'?'killed_lead':view==='Findings'?'finding':'lead'
      const details=await Promise.allSettled([api<PanelDetail>(`/api/panels/${id}`),api<any[]>(`/api/panels/${id}/research-runs`),api(`/api/panels/${id}/evidence?tag=${category}&offset=${evidenceOffset}`)])
      if(id===selectedPanel){if(details[0].status==='fulfilled')panel=details[0].value;if(details[1].status==='fulfilled')runs=details[1].value
        if(details[2].status==='fulfilled'){const latest=(details[2].value as {counts?:Record<EvidenceTag,number>}).counts
          if(latest){if(counts&&latest.finding>counts.finding)alert('A new Finding was saved. Open Findings to review it.','pass');counts=latest}
          if(category===(view==='Killed leads'?'killed_lead':view==='Findings'?'finding':'lead'))evidence=details[2].value}}
    }
    for(const session of sessions.filter(item=>item.state==='running'))if(!screens.has(session.id)){
      const screen=new PaneScreen(80,24,text=>{if(screens.get(session.id)?.owned)sendNative(session,text,true)})
      screens.set(session.id,{screen,panel:session.panelId,cols:80,rows:24,scroll:0,lastOutput:0,owned:false,attaching:false,error:'',queue:[],sending:false})
      const size=await rpc.call('watch',{id:session.id}).catch(error=>{screens.get(session.id)!.error=error.message;return undefined})
      if(size?.cols&&size?.rows){const pane=screens.get(session.id)!;pane.cols=size.cols;pane.rows=size.rows;pane.screen.resize(size.cols,size.rows)}
    }
    if(selectedPanel&&!verificationWatches.has(selectedPanel)){
      const candidate=evidence?.leads?.find((item:any)=>item.verificationProgress?.active)
      if(candidate){const lead=await api<EvidenceLead>(`/api/panels/${selectedPanel}/evidence/${encodeURIComponent(candidate.id)}`);verificationWatches.set(selectedPanel,{lead,state:'restored',autoRecover:false})}
    }
    const watched=verificationWatches.get(selectedPanel)
    if(watched&&!busy){
      const lead=await api<EvidenceLead>(`/api/panels/${selectedPanel}/evidence/${encodeURIComponent(watched.lead.id)}`)
      watched.lead=lead
      // A new test on the same lead (the repaired second run) changes the record id, so it counts as a change even when the state repeats.
      const state=lead.verificationProgress?.state??'unverified',stamp=state+':'+(lead.verificationProgress?.recordId??''),changed=stamp!==watched.state;watched.state=stamp
      const key=selectedPanel+':'+lead.id
      if(menu?.verificationKey===key&&!form)await verification(lead,true)
      else if(changed&&['awaiting_approval','verified','failed','interrupted','not_reproduced','inconclusive'].includes(state)){
        const tone=stateTone(state)
        alert(state==='verified'?(lead.tag==='finding'?'Verified — saved in Findings.':'Verified — review the result to accept the Finding.'):lead.verificationProgress!.label,tone)
        // The approval and the error are decisions only the researcher can take, so they open over a pane being typed into; any other menu is left alone.
        if(!form&&(!menu||menu.verificationKey?.startsWith(selectedPanel+':'))&&(!nativeInput||['awaiting_approval','failed','interrupted'].includes(state)))await verification(lead)
      }
    }
    checkStoppage()
    mark()
  }catch(error){alert(error instanceof Error?error.message:'Runtime unavailable.')}finally{refreshing=false}}
  rpc.events.add(event=>{if(event.event==='terminal-end'){const pane=screens.get(event.id);if(pane&&sessions.some(item=>item.id===event.id&&item.state==='running')){pane.owned=false;pane.error='Pane stream disconnected. Select Retry pane to reconnect.';mark()}return}if(event.event==='terminal-size'){const pane=screens.get(event.id);if(pane){pane.cols=event.cols;pane.rows=event.rows;pane.screen.resize(event.cols,event.rows)}return}if(event.event!=='pty')return;const pane=screens.get(event.id);if(!pane)return;for(const part of String(event.packet).split('\n\n')){
    const name=/^event: (.+)$/m.exec(part)?.[1],json=/^data: (.*)$/m.exec(part)?.[1];if(!json)continue
    try{const value=JSON.parse(json);if(name==='output'||name==='snapshot'){pane.lastOutput=Date.now();pane.screen.write(value,mark)}else if(name==='state'){sessions=sessions.map(item=>item.id===event.id?value:item);mark()}}catch{alert('A terminal stream was interrupted; reconnect the client.')}
  }})
  function panelChooser(){show('Research panels',['Each panel owns its scope, agent sessions and evidence. Create up to four agents across your workspace.'],panels.map(item=>{const active=sessions.filter(agent=>agent.panelId===item.id&&agent.chat&&agent.state==='running').length
    return{label:`${active?'●':'○'} ${item.name} · ${active?`${active} agent${active===1?'':'s'} active`:'Idle'}`,tone:(active?'progress':'info') as Tone,run:()=>{menu=undefined;select(item.id)}}}))}
  const typeLabel='Type of security research',roeSourceLabel='Rules of engagement source',roeSources=['Write them here','Link to them','Choose a file']
  const roeValueLabel:Record<string,string>={'Write them here':'Rules of engagement (up to 8000 characters; use a file for longer)','Link to them':'Rules of engagement link (https://…)','Choose a file':'Rules of engagement file (absolute path to a text file)'}
  const webAccess=['Read-only testing (no state changes)','State-changing tests allowed']
  /** The fields for one type of research. Switching the type or how the rules are given rebuilds them and keeps what was already typed. */
  function scopeFormFields(edit:boolean,type:'source'|'web',roe:string,old:Map<string,string>,scope?:PanelDetail['scopeHistory'][number]):Field[]{
    const v=(label:string,fallback:string)=>old.get(label)??fallback
    // A choice typed for the other type of research is only kept if this type offers it; otherwise it falls back to its default.
    const choice=(label:string,options:string[],fallback:string)=>{const kept=old.get(label);return kept!==undefined&&options.includes(kept)?kept:fallback}
    const reshape=()=>reshapeScopeForm(edit,scope)
    const head:Field[]=[...(edit?[]:[{label:typeLabel,value:researchLabels[type],options:[researchLabels.source,researchLabels.web],onChange:reshape},{label:'Research panel name',value:v('Research panel name','')}]),{label:'Target name',value:v('Target name',scope?.targetName??'')}]
    const workspace:Field={label:'Workspace folder (absolute path; created if needed)',value:v('Workspace folder (absolute path; created if needed)',scope?.workspacePath??'')}
    const restrictions:Field={label:'Restrictions',value:v('Restrictions',scope?.restrictions??'')}
    if(type==='source')return[...head,{label:'Official repository URL or local Git clone',value:v('Official repository URL or local Git clone',scope?.repository??'')},workspace,{label:'Repository discovery note (when URL is unknown)',value:v('Repository discovery note (when URL is unknown)',scope?.repositoryDiscovery??'')},
      {label:'Access',value:choice('Access',['Read only','Read and write'],scope?.accessMode==='read_write'?'Read and write':'Read only'),options:['Read only','Read and write']},restrictions]
    return[...head,{label:'Authorized targets (domains or URLs, separated by commas)',value:v('Authorized targets (domains or URLs, separated by commas)',(scope?.webTargets??'').split(/[\n,;]+/).map(item=>item.trim()).filter(Boolean).join(', '))},
      {label:roeSourceLabel,value:choice(roeSourceLabel,roeSources,roe),options:roeSources,onChange:reshape},
      {label:roeValueLabel[roe]!,value:v(roeValueLabel[roe]!,roe==='Link to them'||roe==='Choose a file'?scope?.roeReference??'':scope?.notes??'')},
      workspace,{label:'Access',value:choice('Access',webAccess,scope?.accessMode==='read_write'?webAccess[1]!:webAccess[0]!),options:webAccess},restrictions]
  }
  function reshapeScopeForm(edit:boolean,scope?:PanelDetail['scopeHistory'][number]){
    if(!form)return
    const old=new Map(form.fields.map(item=>[item.label,item.value] as [string,string]))
    const type=edit?panel!.type:old.get(typeLabel)===researchLabels.web?'web':'source',selected=form.fields[form.selected]?.label
    form.fields=scopeFormFields(edit,type,old.get(roeSourceLabel)??roeSources[0]!,old,scope).map(item=>({...item,cursor:item.value.length}))
    form.selected=Math.max(0,form.fields.findIndex(item=>item.label===selected));mark()
  }
  /** A leading ~ is the researcher's home folder, as in a shell. */
  const expandHome=(path:string)=>path==='~'?homedir():/^~[\\/]/.test(path)?join(homedir(),path.slice(2)):path
  function scopeForm(edit=false){const scope=edit?panel?.scopeHistory[0]:undefined,type=edit?panel!.type:'source'
    const reference=scope?.roeReference.trim()??'',roe=!reference?roeSources[0]!:/^https?:\/\//i.test(reference)?roeSources[1]!:roeSources[2]!
    fields(edit?'Edit research scope':'New research panel',scopeFormFields(edit,type,roe,new Map(),scope),async values=>{
      const by=new Map(form!.fields.map((item,index)=>[item.label,values[index]!] as [string,string])),get=(label:string)=>(by.get(label)??'').trim()
      const kind:'source'|'web'=edit?panel!.type:get(typeLabel)===researchLabels.web?'web':'source'
      const name=edit?panel!.name:get('Research panel name'),target=get('Target name'),typed=get('Workspace folder (absolute path; created if needed)'),workspace=expandHome(typed)
      if(!name)throw new Error('Enter a name for the research panel.')
      if(!target)throw new Error('Enter the target name.')
      if(!typed)throw new Error('Enter the workspace folder where agents keep their files.')
      if(!isAbsolute(workspace))throw new Error(`The workspace folder must be an absolute path such as ${join(homedir(),'research')}; “${typed}” is not.`)
      let payload:Partial<ScopeInput>
      if(kind==='source'){
        const repo=get('Official repository URL or local Git clone'),discovery=get('Repository discovery note (when URL is unknown)')
        if(!repo&&!discovery)throw new Error('Provide a repository or a discovery note.')
        payload={repository:repo,repositoryMode:repo?'known':'discover',repositoryDiscovery:discovery,revision:repo?(repo===scope?.repository?scope.revision:'HEAD'):'',accessMode:get('Access')==='Read and write'?'read_write':'read_only'}
      }else{
        const {targets,invalid}=parseWebTargets(by.get('Authorized targets (domains or URLs, separated by commas)')??'')
        if(!targets.length)throw new Error('Enter at least one authorized target: a domain such as app.example.com, a wildcard such as *.example.com, or a URL.')
        if(invalid.length)throw new Error('These are not valid hosts or URLs: '+invalid.slice(0,3).join(', ')+'.')
        const how=get(roeSourceLabel),given=get(roeValueLabel[how]!)
        if(!given)throw new Error(how==='Write them here'?'Write the rules of engagement, or link to them, or choose a file.':how==='Link to them'?'Enter the link to the rules of engagement.':'Enter the path of the rules of engagement file.')
        let notes='',roeReference=''
        if(how==='Write them here')notes=given
        else if(how==='Link to them'){if(!/^https?:\/\/\S+$/i.test(given))throw new Error('The rules of engagement link must start with http:// or https://.');roeReference=given}
        else{
          const path=expandHome(given)
          if(!isAbsolute(path))throw new Error('Enter the absolute path of the rules of engagement file.')
          // The file is read now and saved with the scope, so every agent gets the same text the researcher chose.
          const bytes=await readFile(path).catch(()=>{throw new Error('That rules of engagement file could not be read.')})
          if(bytes.length>200_000||bytes.includes(0))throw new Error('Choose a plain text file of at most 200 KB for the rules of engagement.')
          notes=bytes.toString('utf8').trim();roeReference=path
          if(!notes)throw new Error('That file is empty.')
          if(notes.length>scopeFields.notes)throw new Error(`That file is longer than ${scopeFields.notes} characters. Link to it instead, or shorten it.`)
        }
        payload={repository:'',repositoryMode:'known',repositoryDiscovery:'',revision:'',webTargets:targets.map(item=>item.text).join('\n'),notes,roeReference,accessMode:get('Access')===webAccess[1]?'read_write':'read_only'}
      }
      await rpc.call('mkdir',{path:workspace})
      const item=edit?panel!:await api<Panel>('/api/panels','POST',{name,type:kind})
      await api(`/api/panels/${item.id}/scope`,'PUT',{expectedVersion:item.scopeVersion,scope:{...scopeInput(scope),targetName:target,workspacePath:workspace,restrictions:get('Restrictions'),...payload}})
      form=undefined;select(item.id);alert(kind==='web'?'Scope saved. Agents are told the authorized targets and the rules of engagement before they test anything.':'Scope saved. Exact source version is recorded automatically before research.')
    })
  }
  function addAgent(){if(!panel?.scopeVersion){alert('Create and save a research scope first.');return}if(sessions.filter(item=>item.state==='running'||item.state==='stopping').length>=4){alert('Four agents are active. Stop one before adding another.');return}
    fields('Start a native agent',[{label:'Agent',value:'OpenCode',options:['OpenCode','Cline','Claude Code']},{label:'Session name',value:''},{label:'Role (one parent per research panel)',value:parent()?'Child':'Parent',options:['Parent','Child']}],async values=>{
      const launched=await api<AgentTerminalInfo>(`/api/panels/${selectedPanel}/terminal`,'POST',{kind:values[0]==='Cline'?'cline':values[0]==='Claude Code'?'claude':'opencode',mode:'terminal',label:values[1],role:values[2]==='Parent'?'parent':'child',cols:80,rows:24,prepareRepository:panel?.type==='source'})
      form=undefined;view='Agents';await refresh();paneIndex=Math.max(0,visible().findIndex(item=>item.id===launched.id));await openAgent(launched)
      // Nothing opens over the new pane; the prompt built from the scope waits behind the Kickoff prompt button.
      if(values[2]==='Parent'&&!researchStarted())alert('Parent started. Select Kickoff prompt when you are ready, or type your own request in its pane.')
      mark()
    })
  }
  /** True once the Parent has been given work, by the researcher's own prompt or the kickoff; the Kickoff prompt button is no longer offered then. */
  function researchStarted(){const lead=parent();return Boolean(lead&&(lead.prompted||lead.activity==='working'||typedPrompt.has(lead.id)||runs.some(run=>run.parentId===lead.id&&run.scopeVersion===panel?.scopeVersion&&run.status!=='failed')))}
  /** Sends the prepared prompt to the Parent as the research objective, the same way a typed objective is delivered. */
  const sendKickoff=(text:string)=>confirmModel(()=>void action(async()=>{
    await api(`/api/panels/${selectedPanel}/research-runs`,'POST',{id:randomUUID(),objective:text,prepareRepository:panel?.type==='source'})
    menu=undefined;form=undefined;view='Agents';const agent=parent();if(agent)await openAgent(agent)
    alert('Research started. The Parent works on its own and records leads as it finds them.','progress')
  }))
  function offerKickoff(depth:HuntDepth='standard'){
    if(!panel?.scopeVersion)return
    const prompt=kickoffPrompt(panel,depth),depthLabel=huntDepths.find(item=>item.value===depth)!.label
    show(`Start the research · ${depthLabel} hunt`,['Kraflr built this prompt from your saved scope at this hunt depth. It goes to the Parent as the research objective.','',prompt],[
      {label:'Send to Parent',run:()=>sendKickoff(prompt)},
      {label:'Add an instruction, then send',run:()=>fields('Add to the prompt',[{label:'Extra instruction (optional)',value:''}],async values=>{form=undefined;const extra=values[0]!.trim();await sendKickoff(extra?prompt+'\n\nAdditional instruction from the researcher: '+extra:prompt)})},
      {label:'Change hunt depth',run:()=>chooseHuntDepth()},
    ])
  }
  /** Strix-style presets: how thoroughly the Parent hunts and how freely it delegates to a Child. Only the prompt changes; nothing is enforced beyond what it asks the agent to do. */
  function chooseHuntDepth(){
    show('Hunt depth',['How thoroughly to hunt, and how freely to delegate to a Child. This only shapes the research prompt; Kraflr does not enforce it.'],huntDepths.map(item=>({label:`${item.label} — ${item.description}`,run:()=>offerKickoff(item.value)})))
  }
  function savedSessions(){show('Saved agents',['Restarted native processes resume their supported conversation IDs; the original process is not revived.'],sessions.filter(item=>item.panelId===selectedPanel&&item.state!=='running').map(item=>({label:`${item.label} · ${item.kind}`,run:()=>action(async()=>{
    const resumed=await api<AgentTerminalInfo>(`/api/panels/${selectedPanel}/terminal/${item.id}/resume`,'POST',{cols:100,rows:30});menu=undefined;await refresh();await openAgent(resumed)
  })})))}
  /** A starting agent is not ready for a message yet. Give it a short while on its own before asking the researcher to look at the pane. */
  async function waitForParent(){for(let i=0;i<40;i++){const p=parent();if(!p||p.kind==='opencode'||p.promptReady!==false)return;if(i===0)alert('Waiting for '+agentDetails[p.kind].name+' to be ready for the prompt…','progress');await new Promise(done=>setTimeout(done,700));sessions=await api<AgentTerminalInfo[]>('/api/agents/sessions')}}
  async function confirmModel(next:()=>void){sessions=await api<AgentTerminalInfo[]>('/api/agents/sessions');if(!parent())throw new Error('Start or reopen a parent agent in this panel first.');await waitForParent();const p=parent();if(!p)throw new Error('Start or reopen a parent agent in this panel first.')
    if(p.kind!=='opencode'&&p.promptReady===false){const name=agentDetails[p.kind].name;show('Check the parent’s native prompt',['Finish any active turn or permission request, close local menus and clear any unsent draft in this '+name+' pane. '+name+' has not reported an idle turn since its last keyboard interaction.'+(p.readinessReason?' Current state: '+p.readinessReason+'.':'')],[{label:'I checked: prompt is clear; continue',run:()=>action(async()=>{await rpc.call('ready',{id:p.id});menu=undefined;next()})}]);return}
    if(!p.modelSelectionRequired){next();return}
    await modelPicker(p,next)
  }
  async function modelPicker(agent:AgentTerminalInfo,next:()=>void=()=>{}){
    if(agent.kind!=='opencode'){const name=agentDetails[agent.kind].name;show('Native '+name+' model',['Open the agent terminal and use /model. '+name+' applies the selection directly to its own session.']);return}
    const catalog=await api(`/api/panels/${agent.panelId}/terminal/${agent.id}/models`)
    show(`Choose model · ${agent.label}`,['Select and confirm this session’s actual model. Provider billing and quotas belong to the CLI account.'],catalog.choices.map((choice:any)=>({label:choice.name,run:()=>action(async()=>{await api(`/api/panels/${agent.panelId}/terminal/${agent.id}/models`,'PUT',{id:choice.id});menu=undefined;await refresh();next()})})))
  }
  async function explain(lead:EvidenceLead){await confirmModel(()=>void action(async()=>{
    const id=randomUUID();await api(`/api/panels/${selectedPanel}/research-runs`,'POST',{id,leadId:lead.id,objective:'Explain this saved lead in two to four plain-English sentences: what might be wrong, who could be affected, what evidence is missing, and the next useful check. Do not inspect additional source or execute anything. Do not claim it is confirmed.',prepareRepository:false});menu=undefined;view='Agents';const agent=parent();if(agent)await openAgent(agent);alert('The explanation appears in the Parent terminal and is saved in Record.')
  }))}
  async function startVerification(lead:EvidenceLead){
    if(panel?.type==='web'){alert('Verification is built for source review and is not available for web application panels yet. Record your own evidence; no test will be started.','error');return}
    await confirmModel(()=>void action(async()=>{
    const id=selectedPanel,current=await api<EvidenceLead>(`/api/panels/${id}/evidence/${encodeURIComponent(lead.id)}`)
    if(current.verificationProgress&&!current.verificationProgress.canVerify){await verification(current);return}
    const preparation=await api(`/api/panels/${id}/lab-preparation`,'POST',{id:randomUUID(),leadId:current.id})
    verificationWatches.set(id,{lead:{...current,verificationProgress:{state:'preparing',label:'Verifying · preparing lab',active:true,canVerify:false,preparationId:preparation.id,scopeVersion:panel?.scopeVersion}},state:'preparing',autoRecover:true});menu=undefined;view='Agents';nativeInput=false
    alert('Verifying: preparing the lab. The exact test opens in a pop-up for your approval; you then choose who verifies it.','progress');await refresh()
  }))}
  /** "Inform agent": the Parent analyses the failed test, repairs the lab and queues a repaired plan, which comes back as a second approval. */
  const informAgent=(lead:EvidenceLead,failed:any)=>confirmModel(()=>void action(async()=>{
    const id=selectedPanel,preparation=await api(`/api/panels/${id}/lab-preparation`,'POST',{id:randomUUID(),leadId:lead.id,repairOf:failed.id})
    verificationWatches.set(id,{lead:{...lead,verificationProgress:{state:'analysing',label:'Analysing verification error',active:true,canVerify:false,preparationId:preparation.id,scopeVersion:panel?.scopeVersion}},state:'analysing:',autoRecover:true})
    menu=undefined;view='Agents';nativeInput=false
    alert('The agent is analysing the error. You will be asked to approve the repaired test as a second run.','progress');await refresh()
  }))
  /** Cancelling closes the failed test. Nothing runs again until the agent asks for a fresh approval. */
  const cancelVerification=(lead:EvidenceLead,record:any,note='')=>action(async()=>{
    await api(`/api/panels/${selectedPanel}/verification/${record.id}/decision`,'POST',{choice:'cancel',note,planHash:record.planHash})
    const current=await api<EvidenceLead>(`/api/panels/${selectedPanel}/evidence/${encodeURIComponent(lead.id)}`);await verification(current)
    alert('Verification cancelled. The agent must ask for approval again before running another test.','info')
  })
  async function verification(lead:EvidenceLead,refreshOnly=false){const id=selectedPanel,key=id+':'+lead.id
    const [prep,history]=await Promise.all([api(`/api/panels/${id}/lab-preparation?lead=${encodeURIComponent(lead.id)}`),api(`/api/panels/${id}/verification?lead=${encodeURIComponent(lead.id)}`)])
    if(id!==selectedPanel)return
    if(!verificationWatches.has(id))verificationWatches.set(id,{lead,state:lead.verificationProgress?.state??'unverified',autoRecover:false})
    const progress=lead.verificationProgress,latest=prep.preparations[0],record=history.records.find((item:any)=>item.id===progress?.recordId)??history.records.find((item:any)=>item.scopeVersion===panel?.scopeVersion)??history.records[0]
    if(latest?.canRecover&&!record&&verificationWatches.get(id)?.autoRecover&&!recoveredLabs.has(latest.run.id)){
      recoveredLabs.add(latest.run.id)
      await api(`/api/panels/${id}/lab-preparation/recover`,'POST',{runId:latest.run.id})
      const current=await api<EvidenceLead>(`/api/panels/${id}/evidence/${encodeURIComponent(lead.id)}`);await verification(current);return
    }
    const usable=(item:AgentTerminalInfo)=>item.panelId===id&&item.state==='running'&&item.chat&&!item.stoppage&&!item.modelSelectionRequired
    const parentAgent=sessions.find(item=>usable(item)&&item.parent),children=sessions.filter(item=>usable(item)&&!item.parent)
    const stamp=JSON.stringify({latest,record,reason:prep.reason,progress,parent:parentAgent?.id,children:children.map(item=>item.id)})
    if(refreshOnly&&menu?.verificationKey===key&&menu.stamp===stamp)return
    const previous=menu?.verificationKey===key?menu:undefined,selectedLabel=previous?.choices[previous.selected]?.label
    const repaired=prep.preparations.find((item:any)=>item.planChanged&&item.canRecover),recoverable=repaired??prep.preparations.find((item:any)=>item.canRecover)
    const recover=()=>action(async()=>{await api(`/api/panels/${id}/lab-preparation/recover`,'POST',{runId:recoverable.run.id});const current=await api<EvidenceLead>(`/api/panels/${id}/evidence/${encodeURIComponent(lead.id)}`);await verification(current)})
    const holder=sessions.find(item=>item.id===record?.lease?.agentId),who:string=record?.lease?.agentLabel??'The agent'
    const openTerminal=(agent:AgentTerminalInfo|undefined,label:string):Choice[]=>agent?[{label,run:()=>{void openAgent(agent)}}]:[]
    const checks=latest?`${latest.directoryReady?'✓':'○'} Lab folder   ${latest.dockerfileReady?'✓':'○'} Dockerfile   ${latest.harnessReady?'✓':'○'} Harness`:''
    const result=record?.observation?JSON.stringify(record.observation,null,2):''
    // What the agent says the test ran against. Only a full, named environment can confirm a lead or kill it, so it is always shown next to the result.
    const env=record?.observation&&'environment' in record.observation?record.observation.environment:undefined
    const environmentLine=env?`Environment (reported by the agent): ${env.fidelity}${env.real.length?' · real: '+env.real.join(', '):''}${env.substituted.length?' · substituted: '+env.substituted.join(', '):''}`:record?.observation&&'kind' in record.observation?'Environment: the report did not say what the test ran against.':''
    const lines:string[]=[lead.title,''],choices:Choice[]=[]
    let banner:Menu['banner'],title='Verification'
    const status=record?.status,state=progress?.state
    if(repaired){
      title='Repaired test ready';banner={text:'Repaired lab found · review it and approve a new run',tone:'progress'}
      lines.push('The lab was rebuilt after the error. Its new image or command needs its own approval; the earlier approval does not transfer.','Prepared image: '+repaired.preparedImage)
      choices.push({label:'Review repaired plan',run:()=>recover()})
    }else if(status==='pending'){
      const attempt=history.records.filter((item:any)=>item.status!=='pending').length+1,plan=record.plan
      title='Approve verification test';banner={text:attempt>1?'Approval needed · second run after the repair':'Approval needed · verification test',tone:'progress'}
      const earlier=history.records.find((item:any)=>item.id!==record.id&&item.failure)
      lines.push(plan.title,plan.action,'Expected: '+plan.expected,'','Image: '+plan.image,'Source version: '+plan.targetVersion,'Command: '+JSON.stringify(plan.command),`Isolation: network none; read-only root with a ${plan.limits.scratchMiB??64} MiB scratch /tmp; non-root; no host mounts; dropped capabilities.`,`Limits: ${plan.limits.memoryMiB} MiB memory · ${plan.limits.cpus} CPU · ${plan.limits.processes} processes · ${plan.limits.seconds} seconds · ${plan.limits.scratchMiB??64} MiB scratch`+(plan.limits.memoryMiB>256||plan.limits.seconds>60||plan.limits.cpus>1?'  (more than the default; check it is what a faithful environment needs)':''),
        ...(earlier?['',`Repair of the earlier error: ${earlier.failure.hint}`]:[]),'',
        'Approving lets the agent you choose run exactly this test in its own shell and then mark the lead: a Finding if it reproduces with a passing control, a killed lead if it does not. The result is labeled agent-reported.')
      const approve=(executor:'parent'|'child',agent:AgentTerminalInfo)=>action(async()=>{
        await api(`/api/panels/${id}/verification/${record.id}/decision`,'POST',{choice:'approve',executor,...(executor==='child'?{agentId:agent.id}:{}),note:`Reviewed the exact plan; ${agent.label} verifies it and marks the lead.`,saveFindingOnSuccess:true,planHash:record.planHash})
        await refresh();const current=await api<EvidenceLead>(`/api/panels/${id}/evidence/${encodeURIComponent(lead.id)}`);await verification(current)
        alert(`Approved. ${agent.label} is running the test and will mark the lead.`,'progress')
      })
      if(parentAgent)choices.push({label:'Parent verification · mark Finding or killed lead',run:()=>approve('parent',parentAgent)})
      for(const child of children)choices.push({label:children.length>1?`Child verification (${child.label}) · mark Finding or killed lead`:'Child verification · mark Finding or killed lead',run:()=>approve('child',child)})
      if(!parentAgent&&!children.length)lines.push('','No agent can verify right now. Start or reopen a Parent or Child agent, then review this test again.')
      choices.push({label:'Deny plan',tone:'error',run:()=>fields('Deny this plan',[{label:'Reason',value:''}],async values=>{await api(`/api/panels/${id}/verification/${record.id}/decision`,'POST',{choice:'deny',note:values[0],planHash:record.planHash});form=undefined;const current=await api<EvidenceLead>(`/api/panels/${id}/evidence/${encodeURIComponent(lead.id)}`);await verification(current);alert('Denial saved; nothing executed.')})})
    }else if(status==='running'){
      title='Verification running';banner={text:`Verifying · ${who} is running the test`,tone:'progress'}
      lines.push(record.plan.title,`Approved for ${who}. It has until ${record.lease?.expiresAt??'its lease limit'} to report.`,'When it reports, Kraflr marks the lead: a Finding if the test reproduced with a passing control, a killed lead if it did not.')
      choices.push(...openTerminal(holder,`Open ${who} terminal`),{label:'Cancel verification',tone:'error',run:()=>action(async()=>{await api(`/api/panels/${id}/verification/${record.id}/decision`,'POST',{choice:'cancel',note:'Stopped by the researcher in the terminal.',planHash:record.planHash});await verification(lead)})})
    }else if(state==='analysing'||state==='preparing'){
      title=state==='analysing'?'Analysing verification error':'Preparing verification lab'
      banner={text:state==='analysing'?'Analysing verification error':'Verifying · preparing the lab',tone:'progress'}
      lines.push(state==='analysing'?'The agent is analysing the error, repairing the lab and will ask for approval again as a second run.':'The Parent is building the lab and the exact test it will ask you to approve.',latest?.run.phase??'',checks)
      if(latest?.run.status==='running')choices.push(...openTerminal(parentAgent,'Open Parent terminal'),{label:'Stop this work',tone:'error',run:()=>action(async()=>{await api(`/api/panels/${id}/research-runs/cancel`,'POST',{id:latest.run.id});await verification(lead)})})
    }else if(status==='error'||status==='interrupted'){
      title='Verification error';banner={text:'Error faced'+(record.failure?.stage?' · '+record.failure.stage:''),tone:'error'}
      lines.push(record.detail??'The test did not finish.',...(record.failure?.hint?['',record.failure.hint]:[]),...(record.failure?.exitCode!==undefined?['','Exit code: '+record.failure.exitCode]:[]),...(record.failure?.output?['','Output from the test:',record.failure.output]:[]),
        '','The Parent may already be repairing the lab on its own; a repaired plan appears here for your approval.','Inform agent: use this if it has stopped. It analyses the error, repairs the lab and asks you to approve a second run.','Cancel verification: nothing more runs, and the agent must ask for approval again next time.')
      choices.push({label:'Inform agent · analyse the error, fix it and ask for approval again',run:()=>informAgent(lead,record)},{label:'Cancel verification · the agent must ask for approval again',tone:'error',run:()=>cancelVerification(lead,record)})
    }else if(status==='inconclusive'){
      title='Verification inconclusive';banner={text:'Inconclusive · the test could not decide',tone:'progress'}
      lines.push(record.detail??'',environmentLine,result,'','Inform agent: it refines the test and asks you to approve a second run.','Cancel verification: the lead stays open and the agent must ask for approval again.')
      choices.push({label:'Inform agent · refine the test and ask for approval again',run:()=>informAgent(lead,record)},{label:'Cancel verification',tone:'error',run:()=>cancelVerification(lead,record)})
    }else if(status==='reproduced'){
      title=record.finding?'Verified':'Reproduced';banner=record.finding?{text:'Verified · saved in Findings',tone:'pass'}:{text:'Reproduced · accept it to save the Finding',tone:'progress'}
      lines.push(record.detail??'',environmentLine,result,'','Reproduction applies only to this test and its control. The result is labeled agent-reported.')
      if(record.finding)choices.push({label:'Open Findings',run:()=>{menu=undefined;view='Findings';evidenceOffset=0;listIndex=0;void refresh();mark()}})
      else choices.push({label:'Review observation and accept finding',run:()=>show('Researcher acceptance',[record.detail,'',result,'','Reproduction applies only to this test and its control.'],[{label:'Accept with a review note',run:()=>fields('Accept verified finding',[{label:'Review note',value:''}],async values=>{await api(`/api/panels/${id}/verification/${record.id}/finding`,'POST',{note:values[0]});form=undefined;alert('Finding accepted and saved.','pass');await refresh()})}])})
    }else if(status==='not_reproduced'){
      title='Not reproduced';banner=record.killedLead?{text:'Not reproduced · lead killed',tone:'pass'}:{text:'Not reproduced',tone:'info'}
      lines.push(record.detail??'',environmentLine,result,...(record.killedLead?['','The control passed and the hypothesis did not reproduce, so the lead moved to Killed leads with this result as its reason.']:[]))
      if(record.killedLead)choices.push({label:'Open Killed leads',run:()=>{menu=undefined;view='Killed leads';evidenceOffset=0;listIndex=0;void refresh();mark()}})
    }else if(record){
      title='Verification';banner={text:progress?.label??'Verification closed',tone:stateTone(state)}
      lines.push(record.detail??'','Nothing is running. The agent must ask for approval before it runs another test.')
      if(progress?.canVerify&&prep.canStart)choices.push({label:'Verify again',run:()=>startVerification(lead)})
    }else{
      title='Verification';banner={text:progress?.label??'Unverified',tone:stateTone(state)}
      lines.push(latest?latest.run.phase:'No lab prepared yet.',checks,latest?.directory??'',prep.reason??'')
      if(recoverable)choices.push({label:'Recover built lab and queue approval',run:()=>recover()})
      if(prep.canStart)choices.push({label:latest?'Repair existing lab with parent':'Prepare Docker lab with parent',run:()=>startVerification(lead)})
    }
    show(title,lines.filter(line=>line!==undefined),choices,banner)
    menu!.verificationKey=key;menu!.stamp=stamp
    if(previous){menu!.scroll=previous.scroll;menu!.selected=Math.max(0,menu!.choices.findIndex(choice=>choice.label===selectedLabel))}
  }
  function leadActions(){const item=evidence?.leads?.[listIndex];if(!item)return;void action(async()=>showLeadDetail(await api<EvidenceLead>(`/api/panels/${selectedPanel}/evidence/${encodeURIComponent(item.id)}`)))}
  /** Returns the most recent PoC a Generate PoC request has attached to this Finding, if any — later notes (a fresh PoC, a challenge verdict) do not erase an older one. */
  function pocNote(lead:EvidenceLead){return lead.reviews.find(review=>review.note?.startsWith('PoC by '))?.note}
  function showLeadDetail(lead:EvidenceLead){
    const confirmed=lead.tag==='finding'&&Boolean(confirmationNote(lead.reviews)),progress=lead.verificationProgress,tested=lead.verificationResults.length>0
    const review=(tag:'lead'|'killed_lead',title:string,label:string,done:string)=>fields(title,[{label,value:''}],async values=>{
      if(!values[0]!.trim())throw new Error('Record the reason.')
      await api(`/api/panels/${selectedPanel}/evidence/${encodeURIComponent(lead.id)}`,'PUT',{expectedVersion:lead.reviews[0]?.version??0,status:tag==='lead'?'open':'closed',tag,note:values[0]!.trim(),nextAction:''});form=undefined;await refresh();alert(done)
    })
    const hint=lead.tag==='finding'?(confirmed?'An agent confirmed this itself. Check its proof below; if it does not hold up, move it back to Leads.':''):lead.tag==='lead'?'An agent moves this to Findings once it has proven it. You can also accept it with your own evidence, challenge it, or rule it out.':''
    // The verification entry comes first because it is what changes; then the decision, then the ways to learn more.
    const progressChoice:Choice[]=progress&&progress.state!=='unverified'&&!(confirmed&&!tested)?[{label:progress.state==='verified'?'View verified result':['failed','interrupted'].includes(progress.state)?'View error · inform agent or cancel':'View verification progress',tone:stateTone(progress.state),run:()=>action(()=>verification(lead))}]:[]
    show(lead.title,[`${lead.tag==='finding'?'Finding':lead.tag==='killed_lead'?'Killed lead':'Lead'} · ${progress?.label??'Unverified'}`,`Source: ${lead.path}:${lead.startLine}–${lead.endLine}`,'',lead.explanation,...(lead.reviews[0]?.note?['','Latest note: '+lead.reviews[0].note]:[]),...(hint?['',hint]:[])],[
      ...progressChoice,
      ...(lead.tag==='lead'&&panel?.type!=='web'&&(progress?.canVerify??true)&&!['failed','interrupted'].includes(progress?.state??'')?[{label:progress?.state==='unverified'?'Verify in Docker (optional)':'Verify again',run:()=>startVerification(lead)}]:[]),
      ...(lead.tag==='lead'?[...(panel?.type==='web'?[{label:'Verify this lead',run:()=>offerVerify(lead)}]:[]),{label:'Accept as a Finding',run:()=>fields('Accept this Finding',[{label:'Evidence, and how it was confirmed',value:''}],async values=>{
        if(!values[0]!.trim())throw new Error('Record the evidence and how it was confirmed.')
        await api(`/api/panels/${selectedPanel}/evidence/${encodeURIComponent(lead.id)}`,'PUT',{expectedVersion:lead.reviews[0]?.version??0,status:'open',tag:'finding',note:values[0]!.trim(),nextAction:''})
        form=undefined;await refresh();alert('Saved as a Finding with your evidence note.','pass');offerVariants(lead)
      })},{label:'Challenge this lead (about 5 min)',run:()=>offerChallenge(lead)},{label:'Rule out this lead',run:()=>review('killed_lead','Kill this lead','Why is this ruled out?','Lead closed with its reason; history retained.')}]:[]),
      ...(lead.tag==='finding'?[{label:'Hunt variants of this Finding',run:()=>offerVariants(lead)},
        {label:'Generate PoC',run:()=>action(async()=>{const result=await rpc.call('poc',{panel:selectedPanel,leadId:lead.id});menu=undefined;alert(result.agent+' is writing a proof of concept. Open this Finding again and choose "View PoC" once it is done.','progress')})},
        ...(pocNote(lead)?[{label:'View PoC',run:()=>action(()=>pocView(lead))}]:[]),
        {label:'Not valid · move back to Leads',run:()=>review('lead','Move back to Leads','Why is this not a Finding?','Moved back to Leads with your reason; only you can accept it again.')}]:[]),
      {label:'Explain in plain English',run:()=>action(()=>explain(lead))},
    ])
  }
  /** A full-screen, scrollable, copy-pasteable view of the latest PoC an agent wrote for this Finding. */
  async function pocView(lead:EvidenceLead){const note=pocNote(lead)??'No PoC has been generated yet.'
    show('Proof of concept',note.split('\n'),[{label:'Back to the Finding',run:()=>action(async()=>showLeadDetail(await api<EvidenceLead>(`/api/panels/${selectedPanel}/evidence/${encodeURIComponent(lead.id)}`)))}])}
  /** After a Finding is accepted: ask an agent to hunt the same flaw pattern elsewhere in the scope. Nothing starts unless the researcher chooses. */
  function offerVariants(lead:EvidenceLead){
    const hasChild=sessions.some(agent=>agent.panelId===selectedPanel&&!agent.parent&&agent.state==='running')
    const hunt=(who:'child'|'parent')=>action(async()=>{const result=await rpc.call('variants',{panel:selectedPanel,leadId:lead.id,who});menu=undefined;alert(result.agent+' is hunting the same pattern. New hits appear in the Leads tab.','progress')})
    show('Hunt the same pattern elsewhere?',['Variant hunting asks an agent to look for the same flaw (the same missing check, sink or unsafe helper) in the rest of the scope, and to record each real hit as a new lead.','The Parent keeps working in its own pane while a Child hunts.'],[
      ...(hasChild?[{label:'Ask a Child agent',run:()=>hunt('child')}]:[]),
      {label:'Ask the Parent',run:()=>hunt('parent')},
      {label:'Not now',run:()=>{menu=undefined;mark()}},
    ])
  }
  /** The web equivalent of "Verify in Docker (optional)": there is no lab to build against a live target, so this asks
   * an agent to reproduce the claim with a real request and response and report a neutral verdict, defaulting to the
   * Parent since confirming a lead does not need a second, adversarial pair of eyes the way Challenge does. */
  function offerVerify(lead:EvidenceLead){
    const hasChild=sessions.some(agent=>agent.panelId===selectedPanel&&!agent.parent&&agent.state==='running')
    const ask=(who:'child'|'parent')=>action(async()=>{const result=await rpc.call('verify-lead',{panel:selectedPanel,leadId:lead.id,who});menu=undefined;alert(result.agent+' is verifying this lead against the live target. Its verdict is added to the lead when it finishes.','progress')})
    show('Verify this lead?',['Verification asks an agent to reproduce the claim against the live target with a real request and response, and report confirmed, not confirmed, or inconclusive. Its verdict is added to the lead either way — accepting or killing it is still your call.'],[
      {label:'Ask the Parent',run:()=>ask('parent')},
      ...(hasChild?[{label:'Ask a Child agent',run:()=>ask('child')}]:[]),
      {label:'Not now',run:()=>{menu=undefined;mark()}},
    ])
  }
  /** Challenging a lead needs a second pair of eyes, but a Child is not always running (or even installed, on some setups): offer the Parent too, the same choice already given for variant hunting. */
  function offerChallenge(lead:EvidenceLead){
    const hasChild=sessions.some(agent=>agent.panelId===selectedPanel&&!agent.parent&&agent.state==='running')
    const ask=(who:'child'|'parent')=>action(async()=>{const result=await rpc.call('challenge',{panel:selectedPanel,leadId:lead.id,who});menu=undefined;alert(result.agent+' is trying to disprove this lead. Its verdict is added to the lead when it finishes; your Parent keeps working.','progress')})
    show('Challenge this lead?',['A challenge asks an agent to try to DISPROVE the lead — a sceptical second pass, ideally on a different model. Its verdict is added to the lead either way.'],[
      ...(hasChild?[{label:'Ask a Child agent',run:()=>ask('child')}]:[]),
      {label:'Ask the Parent',run:()=>ask('parent')},
      {label:'Not now',run:()=>{menu=undefined;mark()}},
    ])
  }
  async function exportFindingsReport(){const saved=await rpc.call('export-report',{panel:selectedPanel});show('Report saved',[saved.path,'','It lists the scope, each accepted Finding with your evidence note and everything the agents attached, what was ruled out and why, and what is still open.'+(panel?.type==='web'?' It also lists the recorded requests.':'')])}
  async function mapView(){const saved=await rpc.call('map',{panel:selectedPanel});show('Attack-surface map',[saved.text?'Saved '+saved.updatedAt:'No map has been saved yet. The first agent to look at the target writes one; every later session reads it first.','',saved.text||''])}
  /** A live, on-demand check of the same two things a session's `kraflr` MCP gateway relies on — not a running agent's own connection, but whether the tools it would get are actually there right now. */
  async function gatewayStatusView(){
    const status=await rpc.call('gateway-status',{})
    const semgrep=status.semgrep.available?`Semgrep: available${status.semgrep.version?' (v'+status.semgrep.version+')':''}.`:`Semgrep: not found${status.semgrep.reason?' — '+status.semgrep.reason:''}. Install it (pip install semgrep) for the background first pass and the semgrep_scan tool.`
    const burp=!status.burp.configured?'Burp: not configured. Use "Set Burp MCP URL" in Agent controls to save your running Burp instance\'s MCP endpoint.'
      :status.burp.connected?`Burp: connected at ${status.burp.url} — proxying ${status.burp.tools} tool(s).`
      :`Burp: configured at ${status.burp.url} but not reachable — ${status.burp.reason}.`
    const hint=status.burp.configured&&!status.burp.connected?burpHint(status.burp.url,status.burp.reason):''
    show('Tool gateway status',['Checked just now, independent of any running agent. Each agent session gets its own gateway process, but it relies on the same two things.','',semgrep,burp,...(hint?['',hint]:[])])
  }
  /** The saved Burp MCP URL survives restarts and needs no shell setup — KRAFLR_BURP_MCP_URL (if set) still overrides it for a one-off session. */
  async function setBurpUrl(){
    const current=await rpc.call('burp-url',{})
    fields(current.fromEnv?'Set Burp MCP URL (KRAFLR_BURP_MCP_URL is overriding this)':'Set Burp MCP URL',[{label:'Burp MCP endpoint (blank to clear)',value:current.fromEnv?'':current.url}],async values=>{
      const saved=await rpc.call('set-burp-url',{url:values[0]!.trim()})
      form=undefined
      alert(saved.url?'Saved. Agents use '+saved.url+' from their next burp_status call.':'Cleared. Agents no longer have Burp configured.','pass')
    })
  }
  function killLead(){const item=evidence?.leads?.[listIndex];if(!item||view!=='Leads')return;fields('Kill this lead',[{label:'Why is this ruled out?',value:''}],async values=>{
    const lead=await api<EvidenceLead>(`/api/panels/${selectedPanel}/evidence/${encodeURIComponent(item.id)}`)
    await api(`/api/panels/${selectedPanel}/evidence/${encodeURIComponent(item.id)}`,'PUT',{expectedVersion:lead.reviews[0]?.version??0,status:'closed',tag:'killed_lead',note:values[0],nextAction:''});form=undefined;await refresh();alert('Lead closed with its reason; history retained.')
  })}
  /** What the agents did: every request through the scope proxy (blocked ones in red) and each command they ran. Newest first. */
  const trafficLine=(entry:any)=>{const time=String(entry.at).slice(11,19)
    if(entry.kind==='command')return time+' '+entry.agent+' ran '+entry.text
    if(entry.blocked)return time+' BLOCKED '+entry.method+' '+entry.url
    if(entry.outOfScope)return time+' OUT OF SCOPE (HTTPS, not blocked) '+entry.url
    return time+' '+entry.method+' '+(entry.status||'—')+' '+entry.url+(entry.ms!==undefined?' · '+entry.ms+' ms':'')}
  async function trafficMenu(offset=0){const panelId=selectedPanel,page=await rpc.call('traffic',{panel:panelId,offset}),choices:Choice[]=page.entries.map((entry:any)=>({label:trafficLine(entry).slice(0,160),...(entry.blocked||entry.outOfScope?{tone:'error' as const}:{}),run:()=>action(()=>trafficDetail(entry.id,offset))}))
    if(offset>0)choices.push({label:'Newer',run:()=>action(()=>trafficMenu(Math.max(0,offset-25)))})
    if(page.more)choices.push({label:'Older',run:()=>action(()=>trafficMenu(offset+25))})
    show('Traffic and activity',['Requests the agents sent through Kraflr (plain HTTP to your authorized targets), requests it blocked, and the commands the agents ran. Newest first.','A tool that ignores proxy settings is not recorded or blocked here; its command still appears when the agent reports it.',...(page.entries.length?[]:['','Nothing has been recorded yet.'])],choices)
  }
  async function trafficDetail(id:string,offset:number){const entry:any=await rpc.call('traffic',{panel:selectedPanel,id}),side=(label:string,part:any)=>part?['',label,...Object.entries(part.headers).map(([name,value])=>name+': '+value),...(part.body?['',part.body]:[])]:[]
    show(entry.kind==='command'?'Command':entry.blocked?'Blocked request':'Request',[trafficLine(entry),'Agent: '+entry.agent,...(entry.reason?['',entry.reason]:[]),...side('Request',entry.request),...side('Response',entry.response)],[
      ...(entry.kind==='http'&&!entry.blocked?[{label:'Replay as a different account',run:()=>replayForm(entry,offset)}]:[]),
      {label:'Back to the list',run:()=>action(()=>trafficMenu(offset))},
    ],entry.blocked?{text:'Blocked · outside the authorized targets',tone:'error'}:undefined)
  }
  /** The Autorize pattern: resend a captured request with one header swapped for a different account's value and diff the live response against the original. */
  function replayForm(entry:any,offset:number){
    fields('Replay as a different account',[{label:'Header to swap (Cookie, Authorization, …)',value:'Cookie'},{label:"The other account's value for that header",value:''}],async values=>{
      const header=values[0]!.trim(),value=values[1]!.trim()
      if(!header)throw new Error('Name the header to swap.')
      if(!value)throw new Error("Give the other account's value for that header.")
      const result=await rpc.call('replay-cross-account',{panel:selectedPanel,entryId:entry.id,header,value})
      form=undefined
      const summary=`${entry.method} ${entry.url}\nOriginal status: ${result.originalStatus} · Replay status (as a different ${header}): ${result.replayStatus}\n${result.verdict}`
      show('Replay result',[entry.method+' '+entry.url,`Original status: ${result.originalStatus}  ·  Replay status: ${result.replayStatus}`,'',result.verdict,'','Replay response body (first part):',result.body||'(empty)'],[
        {label:'Ask the Parent to confirm and record',run:()=>action(async()=>{const sent=await rpc.call('replay-record',{panel:selectedPanel,summary});menu=undefined;alert(sent.agent+' is reviewing the replay and will record a lead if it holds up.','progress')})},
        {label:'Back to the request',run:()=>action(()=>trafficDetail(entry.id,offset))},
      ],result.similarity>=0.6&&result.originalStatus===result.replayStatus?{text:'Looks the same for a different identity',tone:'error'}:{text:'Looks different',tone:'pass'})
    })
  }
  function recordMenu(){show('Research record',['Full captured replies remain saved with their scope revision.'],[
    ...runs.map(run=>({label:`${run.status} · ${run.objective}`,run:()=>action(()=>showRecord(run.id))})),
    {label:'Export saved research brief to workspace',run:()=>action(async()=>{const result=await api(`/api/panels/${selectedPanel}/research-brief/export`,'POST',{});show('Research brief exported',[result.path??JSON.stringify(result)])})},
    {label:'General evidence',run:()=>action(async()=>{const general=await api(`/api/panels/${selectedPanel}/evidence?tag=general`);show('General evidence',general.leads.map((item:any)=>`${item.title}\n${item.path}:${item.startLine}–${item.endLine}`))})},
  ])}
  async function showRecord(id:string,offset=0){const panelId=selectedPanel,record=await rpc.call('research-record',{panel:panelId,id,offset}),choices:Choice[]=[]
    if(record.offset>0)choices.push({label:'Previous part',run:()=>action(()=>showRecord(id,Math.max(0,record.offset-64_000)))})
    if(record.more)choices.push({label:'Next part of full reply',run:()=>action(()=>showRecord(id,record.offset+64_000))})
    if(record.status==='running')choices.push({label:record.purpose==='collaboration'?'Cancel this exchange':'Stop this research',run:()=>action(async()=>{if(record.purpose==='collaboration')await rpc.call('cancel-communication',{panel:panelId,id});else await api(`/api/panels/${panelId}/research-runs/cancel`,'POST',{id});menu=undefined;await refresh()})})
    show(record.phase,[`Characters ${record.offset+1}–${Math.min(record.offset+64_000,record.total)} of ${record.total}. PageUp / PageDown scroll this part.`,'',record.text],choices)
  }
  async function repositorySuggestion(){const suggestion=await api(`/api/panels/${selectedPanel}/repository-suggestion`)
    if(!suggestion){const agent=parent();if(agent)await openAgent(agent);alert('Ask the parent directly in its terminal to find the official repository.');return}
    show('Review suggested repository',[suggestion.targetName,suggestion.url,'Supporting source: '+suggestion.sourceUrl,suggestion.reason,'Saving changes this scope and stops its earlier-scope agents.'],[{label:'Use this repository in a new scope revision',run:()=>action(async()=>{await api(`/api/panels/${selectedPanel}/scope`,'PUT',{expectedVersion:panel!.scopeVersion,scope:{...scopeInput(panel!.scopeHistory[0]),targetName:suggestion.targetName,repositoryMode:'known',repository:suggestion.url,revision:'HEAD'}});menu=undefined;await refresh()})}])
  }
  function agentMenu(){const selected=chosen();show('Agent controls',['Native /model and tool permissions work inside the selected agent terminal pane.'],[
    ...sessions.filter(item=>item.panelId===selectedPanel&&item.stoppage&&(item.state==='running'||item.state==='exited')).map(item=>({label:`${item.label} stopped · hand its saved context to another agent`,tone:'error' as Tone,run:()=>stoppedAgent(item)})),
    ...(selected?[{label:`This agent · ${selected.label} ›`,run:()=>focusedAgentMenu(selected)}]:[]),
    {label:'Start another agent',run:()=>addAgent()},{label:'Reopen a saved session',run:()=>savedSessions()},
    {label:'Research tools › prompt, map, Semgrep and Burp',run:()=>toolsMenu()},
  ])}
  function focusedAgentMenu(selected:AgentTerminalInfo){show(`${selected.label} · ${agentDetails[selected.kind].name} · ${selected.parent?'Parent':'Child'}`,['Controls for the focused agent only.'],[
    {label:'Open its terminal',run:()=>action(async()=>{menu=undefined;await openAgent(selected)})},
    {label:'Choose / confirm its model',run:()=>action(()=>modelPicker(selected))},
    {label:'Mark native prompt ready (only after checking it)',run:()=>action(async()=>{await rpc.call('ready',{id:selected.id});menu=undefined;alert('Marked ready. Queued work may now enter this native prompt.')})},
    {label:'Stop this agent',tone:'error',run:()=>show('Stop this agent?',[selected.label,'Its process stops; saved scope, evidence and supported conversation remain.'],[{label:'Stop agent',tone:'error',run:()=>action(async()=>{await api(`/api/panels/${selectedPanel}/terminal/${selected.id}/stop`,'POST',{});menu=undefined;await refresh()})}])},
  ])}
  function toolsMenu(){show('Research tools',['Shared by every agent in this panel.'],[
    ...(parent()?[{label:'Kickoff prompt for this scope',run:()=>chooseHuntDepth()}]:[]),
    {label:'Attack-surface map',run:()=>action(mapView)},{label:'Tool gateway status (Semgrep, Burp)',run:()=>action(gatewayStatusView)},{label:'Set Burp MCP URL',run:()=>action(setBurpUrl)},
  ])}
  /** Live panes that print a provider limit without any hook reporting it are treated as stopped too, so the pop-up and the red marker do not depend on the CLI's own signalling. */
  function noteScreenLimits(){for(const agent of sessions){if(agent.state!=='running'||agent.stoppage||agent.kind==='opencode')continue;const line=visibleLimit(screenLines(agent));if(line)agent.stoppage={kind:'limit',reason:`${agentDetails[agent.kind].name} shows: ${line}`,at:'screen:'+line}}}
  function checkStoppage(){
    if(menu||form)return
    const agent=sessions.find(item=>item.stoppage&&(item.state==='running'||item.state==='exited')&&!toldAboutStop.has(item.id+':'+item.stoppage.at))
    if(!agent)return
    toldAboutStop.add(agent.id+':'+agent.stoppage!.at);stoppedAgent(agent)
  }
  /** Say which agent stopped and why, and offer its saved context to the agents that are still running. */
  function stoppedAgent(agent:AgentTerminalInfo){
    const stop=agent.stoppage;if(!stop)return
    const name=agentDetails[agent.kind].name,panelName=panels.find(item=>item.id===agent.panelId)?.name??'this panel'
    const others=sessions.filter(item=>item.panelId===agent.panelId&&item.id!==agent.id&&item.state==='running'&&item.chat&&!item.stoppage&&!item.modelSelectionRequired)
    const headline=stop.kind==='limit'?`${agent.label} hit its usage limit`:stop.kind==='exited'?`${agent.label} stopped unexpectedly`:`${agent.label} stopped`
    show('Agent stopped',[`${agent.label} · ${name} · ${agent.parent?'Parent':'Child'} · ${panelName}`,'',stop.reason,'',
      others.length?'Kraflr saved what it was working on: its assignments, its latest replies and any verification test it was approved to run. Hand that context to a running agent so the work continues.':'No other agent is running in this panel. Start one, then hand the saved context over from Agent controls.'],
      [...others.map(other=>({label:`Hand saved context to ${other.label} · ${agentDetails[other.kind].name} · ${other.parent?'Parent':'Child'}`,run:()=>handoffTo(agent,other)})),...(others.length?[]:[{label:'Start another agent',run:()=>addAgent()}])],{text:headline,tone:'error'})
    alert(headline,'error')
  }
  const handoffTo=(from:AgentTerminalInfo,to:AgentTerminalInfo)=>action(async()=>{
    const result=await rpc.call('handoff',{panel:from.panelId,from:from.id,to:to.id})
    menu=undefined;alert(`Saved context from ${from.label} is going to ${to.label}${result?.tests?` together with ${result.tests} approved verification test(s)`:''}.`,'progress');await refresh()
  })
  async function attention(){const requests=await api<AgentAttention[]>('/api/agents/attention');for(const agent of sessions.filter(item=>item.kind!=='opencode'&&item.state==='running'))if(['approval','question'].includes(agentState(agent)))requests.push({panelId:agent.panelId,terminalId:agent.id,permissions:[],question:true});show('Agent attention',['Use native terminal panes for their questions and approvals. This view also exposes exact managed OpenCode requests.'],requests.filter(item=>item.permissions.length||item.question).map(item=>({label:sessions.find(agent=>agent.id===item.terminalId)?.label??item.terminalId,run:()=>{
    const permission=item.permissions[0];if(!permission){const agent=sessions.find(agent=>agent.id===item.terminalId);if(agent)focusAgent(agent);return}
    show(permission.action,[permission.description??'',...permission.resources],[
      ...(permission.canApprove?[{label:'Allow this exact request once',run:()=>action(async()=>{await api(`/api/panels/${item.panelId}/terminal/${item.terminalId}/decision`,'POST',{id:permission.id,decision:'once',fingerprint:permission.fingerprint});menu=undefined})}]:[]),
      {label:'Deny',run:()=>action(async()=>{await api(`/api/panels/${item.panelId}/terminal/${item.terminalId}/decision`,'POST',{id:permission.id,decision:'reject',fingerprint:permission.fingerprint});menu=undefined})},
    ])
  }})))}

  async function openAgent(agent:AgentTerminalInfo){selectedPanel=agent.panelId;view='Agents';paneIndex=Math.max(0,visible().findIndex(item=>item.id===agent.id));nativeInput=true;menu=undefined;form=undefined;mark()}
  function ensurePane(agent:AgentTerminalInfo,pane:Pane,cols:number,rows:number){
    if(pane.attaching||pane.error||pane.owned&&pane.cols===cols&&pane.rows===rows)return
    pane.attaching=true
    void rpc.call('terminal-attach',{id:agent.id,cols,rows}).then(()=>{
      if(screens.get(agent.id)!==pane)return
      pane.owned=true;pane.cols=cols;pane.rows=rows;pane.screen.resize(cols,rows);mark()
    }).catch(error=>{pane.owned=false;pane.error=error.message;mark()}).finally(()=>{pane.attaching=false})
  }
  async function retryPane(agent:AgentTerminalInfo,pane:Pane){try{await rpc.call('watch',{id:agent.id});pane.error='';mark()}catch(error){pane.error=error instanceof Error?error.message:'Could not reconnect this pane.';mark()}}
  function sendNative(agent:AgentTerminalInfo,text:string,generated=false){
    const pane=screens.get(agent.id);if(!pane?.owned){if(!generated)alert('This pane is still connecting.');return}
    if(!generated&&agent.kind==='opencode'&&!/^\x1b\[</.test(text)){let line=typedLine.get(agent.id)??''
      for(const ch of text.replace(/\x1b\[20[01]~/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')){if(ch==='\r'){if(line.trim()&&!line.trim().startsWith('/'))typedPrompt.add(agent.id);line=''}else if(ch==='\x7f'||ch==='\b')line=line.slice(0,-1);else if(ch==='\x03'||ch==='\x15')line='';else if(ch>=' ')line=(line+ch).slice(0,200)}
      typedLine.set(agent.id,line)}
    if(!generated){let input=approvalInputs.get(agent.id);if(!input){input=new ApprovalInput();approvalInputs.set(agent.id,input)}const matched=input.input(text),watch=verificationWatches.get(agent.panelId);if(matched&&agent.parent&&watch){void action(async()=>{const current=await api<EvidenceLead>(`/api/panels/${agent.panelId}/evidence/${encodeURIComponent(watch.lead.id)}`);if(agent.panelId===selectedPanel){await verification(current);alert(current.verificationProgress?.state==='awaiting_approval'?'Review this exact plan to approve execution. The chat phrase did not run Docker.':'No new test was approved. Review the saved result or submit the repaired lab plan first.') }})}}
    if(pane.queue.reduce((size,item)=>size+item.text.length,0)+text.length>128_000){nativeInput=false;alert('Terminal input is backed up. Wait for this pane to reconnect.');return}
    for(let at=0;at<text.length;at+=60_000)pane.queue.push({text:text.slice(at,at+60_000),generated})
    if(pane.sending)return
    pane.sending=true
    void(async()=>{try{while(pane.queue.length&&!ended){const item=pane.queue.shift()!;await rpc.call('input',{panel:agent.panelId,id:agent.id,...item})}}catch(error){pane.queue=[];pane.owned=false;pane.error=error instanceof Error?error.message:'Terminal input disconnected.';nativeInput=false;alert(pane.error)}finally{pane.sending=false;mark()}})()
  }
  const input=new TerminalInput()
  function submitForm(){if(!form||busy)return;const current=form;formError='';void action(()=>current.submit(current.fields.map(item=>item.value)))}
  function cycle(field:Field,direction=1){if(!field.options)return;const choices=field.options;field.value=choices[(choices.indexOf(field.value)+direction+choices.length)%choices.length]!;field.onChange?.()}
  function invoke(choice:Choice|undefined){if(!choice||busy)return;const result=choice.run();if(result instanceof Promise)void result.catch(error=>alert(error.message));mark()}
  function key(event:Key){mark()
    if(form){
      const count=form.fields.length,total=count+2+(formError&&selectedPanel?1:0),field=form.fields[form.selected]
      if(event.name==='escape'){form=undefined;formError='';return}
      if(['tab','down','backtab','up'].includes(event.name)){form.selected=(form.selected+(['backtab','up'].includes(event.name)?total-1:1))%total;return}
      if(event.name==='enter'){
        if(form.selected===count)submitForm()
        else if(form.selected===count+1){form=undefined;formError=''}
        else if(form.selected===count+2)scopeForm(true)
        else form.selected=Math.min(count,form.selected+1)
        return
      }
      if(!field)return
      if(field.options){if(event.name==='left'||event.name==='right'||event.text===' ')cycle(field,event.name==='left'?-1:1);return}
      const chars=Array.from(field.value),pos=Math.min(chars.length,field.cursor??chars.length)
      if(event.name==='left')field.cursor=Math.max(0,pos-1)
      else if(event.name==='right')field.cursor=Math.min(chars.length,pos+1)
      else if(event.name==='home')field.cursor=0
      else if(event.name==='end')field.cursor=chars.length
      else if(event.name==='backspace'&&pos){chars.splice(pos-1,1);field.value=chars.join('');field.cursor=pos-1}
      else if(event.name==='delete'){chars.splice(pos,1);field.value=chars.join('')}
      else if(event.name==='text'){const inserted=Array.from(event.text!.replace(/[\r\n\x00-\x1f]/g,' ')).slice(0,8000-chars.length);chars.splice(pos,0,...inserted);field.value=chars.join('');field.cursor=pos+inserted.length}
      return
    }
    if(menu){
      if(event.name==='escape'){menu=undefined;return}
      if(['tab','down','backtab','up'].includes(event.name))menu.selected=(menu.selected+(['backtab','up'].includes(event.name)?menu.choices.length-1:1))%menu.choices.length
      if(event.name==='pageup')menu.scroll=Math.max(0,menu.scroll-8)
      if(event.name==='pagedown')menu.scroll+=8
      if(event.name==='enter')invoke(menu.choices[menu.selected])
      return
    }
    if(['tab','right','down','backtab','left','up'].includes(event.name)&&hits.length){focus=(focus+(['backtab','left','up'].includes(event.name)?hits.length-1:1)+hits.length)%hits.length;return}
    if(event.name==='enter'&&focus>=0)hits[focus]?.action()
    // Letter keys and custom control chords are deliberately not application commands.
  }
  function route(event:TerminalInputEvent){
    if(event.type==='background'){if(waitingForBackground&&!hostBackground){hostBackground=event.color;backgroundReceived()}return}
    if(event.type==='escape'){if(nativeInput&&!menu&&!form&&chosen())sendNative(chosen()!,'\x1b');else key({name:'escape'});return}
    if(event.type==='data'){if(nativeInput&&!menu&&!form&&chosen())sendNative(chosen()!,event.text);else for(const item of decoder.feed(event.text))key(item);return}
    const region=!menu&&!form?regions.find(item=>event.x>=item.rect.x&&event.x<item.rect.x+item.rect.w&&event.y>=item.rect.y&&event.y<item.rect.y+item.rect.h):undefined
    if(region){const pane=screens.get(region.agent.id)!,mouse=pane.screen.terminal.modes.mouseTrackingMode!=='none'
      if(event.button>=64){if(event.pressed){if(mouse)sendNative(region.agent,`\x1b[<${event.button};${event.x-region.rect.x+1};${event.y-region.rect.y+1}M`);else{pane.scroll=Math.max(0,Math.min(pane.screen.terminal.buffer.active.baseY,pane.scroll+(event.button===64?3:-3)));mark()}}return}
      if(!event.pressed){if(nativePointer===region.agent.id&&mouse)sendNative(region.agent,`\x1b[<${event.button};${event.x-region.rect.x+1};${event.y-region.rect.y+1}m`);nativePointer='';return}
      if(event.button===0){const focused=nativeInput&&chosen()?.id===region.agent.id;paneIndex=region.index;nativeInput=true;focus=-1;if(focused&&mouse){nativePointer=region.agent.id;sendNative(region.agent,`\x1b[<0;${event.x-region.rect.x+1};${event.y-region.rect.y+1}M`)}mark();return}
    }
    nativePointer=''
    if(event.button>=64){if(event.pressed&&menu){menu.scroll=Math.max(0,menu.scroll+(event.button===64?-3:3));mark()}return}
    if(!event.pressed||event.button!==0)return
    const index=hits.findLastIndex(item=>event.x>=item.x&&event.x<item.x+item.w&&event.y>=item.y&&event.y<item.y+item.h)
    if(index>=0){nativeInput=false;focus=index;hits[index]!.action();mark()}
  }
  function data(text:string){clearTimeout(escapeTimer);for(const event of input.feed(text))route(event);if(input.buffer==='\x1b')escapeTimer=setTimeout(()=>{for(const event of input.flushEscape())route(event)},35)}
  function screenLines(agent:AgentTerminalInfo){
    const pane=screens.get(agent.id),buffer=pane?.screen.terminal.buffer.active,lines:string[]=[]
    if(buffer&&pane)for(let row=0;row<pane.rows;row++)lines.push(buffer.getLine(buffer.baseY+row)?.translateToString(true)??'')
    return lines
  }
  function agentState(agent:AgentTerminalInfo){
    const pane=screens.get(agent.id),lines=screenLines(agent),native=agent.kind!=='opencode'
    // A native pane reports its own turns. Redraws, typing and a run it is only waiting on do not make it busy.
    const busyNow=native?agent.readinessReason==='Working':assignedWork(agent.id,runs)
    return activity(agent,requests.find(item=>item.terminalId===agent.id),native?visibleAttention(lines,agent.kind):undefined,busyNow,!native&&Date.now()-(pane?.lastOutput??0)<1200)
  }
  function focusAgent(agent:AgentTerminalInfo){selectedPanel=agent.panelId;view='Agents';paneIndex=Math.max(0,sessions.filter(item=>item.panelId===agent.panelId&&item.state==='running').findIndex(item=>item.id===agent.id));menu=undefined;form=undefined;void refresh();void action(()=>openAgent(agent));mark()}
  function render(){if(ended||!dirty||drawing||process.stdout.writableLength>512_000)return;drawing=true;dirty=false
    const width=Math.max(1,process.stdout.columns||100),height=Math.max(1,process.stdout.rows||30),frame=new Frame(width,height);hits=[];regions=[];let cursor=''
    const hit=(r:Rect,fn:()=>void)=>{const index=hits.length;hits.push({...r,action:fn});return index===focus&&!nativeInput&&!menu&&!form}
    // Buttons are chips on a lighter background and tabs are plain text with a marker; neither needs brackets to read as clickable.
    const button=(x:number,y:number,label:string,fn:()=>void,primary=false,max=width-x)=>{const text=` ${label} `,w=Math.min(text.length,max),selected=hit({x,y,w,h:1},fn);frame.text(x,y,text,w,selected?'\x1b[7m'+c.accent:c.chip+(primary?c.bold+c.accent:c.ink));return w+1}
    const tab=(x:number,y:number,label:string,fn:()=>void,current:boolean,max:number)=>{const selected=hit({x,y,w:max,h:1},fn);frame.text(x,y,(current?'▎ ':'  ')+label,max,selected?c.chip+c.ink:current?c.bold+c.accent:c.ink)}
    const active=sessions.filter(item=>item.state==='running'),side=width>=110?23:width>=75?20:0
    frame.text(1,0,'K R A F L R',13,c.bold+c.ink)
    button(width-17,0,'Help',help);button(width-10,0,'Detach',finish)
    if(side){
      const divider=height-9
      for(let y=1;y<height-1;y++)frame.text(side-1,y,'│',1,c.border)
      tab(0,2,'Investigation',()=>{view='Investigation';focus=-1;mark()},view==='Investigation',side-1)
      button(1,4,'New panel',()=>scopeForm(),false,side-3)
      frame.text(1,6,'RESEARCH SPACES',side-2,c.muted)
      const count=Math.min(panels.length,Math.max(1,Math.min(8,divider-11-Math.max(1,active.length)*2)))
      panels.slice(0,count).forEach((item,index)=>{const y=7+index,selected=hit({x:0,y,w:side-1,h:1},()=>select(item.id));frame.text(1,y,`${item.id===selectedPanel?'◆':'·'} ${item.name}`,side-2,selected?c.chip+c.ink:item.id===selectedPanel?c.bold+c.accent:c.ink)})
      if(panels.length>count)button(1,7+count,'All panels',panelChooser,false,side-3)
      const agentY=Math.max(10,8+count+(panels.length>count?1:0)),step=divider-agentY-2>=active.length*2?2:1
      frame.text(1,agentY,'LIVE AGENTS',side-2,c.muted)
      active.slice(0,4).forEach((agent,index)=>{const y=agentY+2+index*step;if(y>=divider)return;const state=agentState(agent),tone=toneColor[activityTone[state]],selected=hit({x:0,y,w:side-1,h:Math.min(step,divider-y)},()=>focusAgent(agent));frame.text(1,y,activityGlyph(state),1,tone);frame.text(3,y,`${agent.label} / ${agent.parent?'Parent':'Child'}`,side-4,selected?c.chip+c.ink:c.ink);if(step===2&&y+1<divider)frame.text(3,y+1,agent.stoppage&&state!=='approval'?activityLabels[state]:agent.readinessReason??`${activityLabels[state]} · ${panels.find(item=>item.id===agent.panelId)?.name??''}`,side-4,state==='limit'||state==='stopped'?c.red:c.muted)})
      if(!active.length)frame.text(1,agentY+2,'· No sessions yet',side-2,c.muted)
      frame.text(0,divider,'─'.repeat(side-1)+'┤',side,c.border)
      frame.text(1,divider+1,selectedPanel?'PANEL WORKSPACE':'OPEN A RESEARCH SPACE',side-2,c.muted)
      if(selectedPanel){const total:Partial<Record<View,number>>={Leads:counts?.lead,'Killed leads':counts?.killed_lead,Findings:counts?.finding}
        tabs.forEach((name,index)=>tab(0,divider+2+index,total[name]?`${name} (${total[name]})`:name,()=>{view=name;listIndex=0;evidenceOffset=0;evidence=undefined;void refresh();mark()},view===name,side-1));button(1,height-2,'Research record',recordMenu,false,side-3)}
    }
    const area:Rect={x:side?side:0,y:5,w:width-side,h:Math.max(1,height-6)}
    const centered=(y:number,text:string,color=c.ink)=>{const label=clean(text).slice(0,area.w-2);frame.text(area.x+Math.max(0,Math.floor((area.w-label.length)/2)),y,label,area.w,color)}
    centered(1,view==='Investigation'?'INVESTIGATION':(panel?.name??panels.find(item=>item.id===selectedPanel)?.name??'Research space').toUpperCase(),c.bold+c.ink)
    const localAgents=active.filter(item=>item.panelId===selectedPanel).length
    centered(2,`${active.length}/4 Agents active${view==='Investigation'?`  ·  ${panels.length} research spaces`:`  ·  ${localAgents} in this panel  ·  ${view}`}`,c.muted)
    let x=area.x
    const workflow=runs.find(run=>run.status==='running'&&run.purpose!=='collaboration')
    const watched=verificationWatches.get(selectedPanel),progress=watched?.lead.verificationProgress,verdict=progress?.state
    if(view==='Agents'&&(verdict==='failed'||verdict==='interrupted'))centered(3,`✕ Verification / ${progress!.label} · open Review error`,c.red)
    else if(view==='Agents'&&progress?.active)centered(3,`${orbit()} Verification / ${progress.label}`,c.gold)
    else if(view==='Agents'&&workflow)centered(3,`${orbit()} Team / ${workflow.phase}`,c.gold)
    else if(view==='Agents'&&verdict==='verified')centered(3,watched!.lead.tag==='finding'?'✓ Verified — saved in Findings.':'✓ Verified — review the result for Finding acceptance.',c.green)
    x=area.x
    const tool=(label:string,fn:()=>void,primary=false)=>{if(x+label.length+3<=width)x+=button(x,4,label,fn,primary)}
    if(view==='Investigation'){tool('New research panel',()=>scopeForm(),true);tool('Research spaces',panelChooser);tool('Approvals',()=>void action(attention))}
    else if(view==='Agents'){
      // What needs you comes first; controls that are always there follow a divider; leaving the pane sits at the right edge.
      const waiting=new Set([...requests.filter(item=>item.permissions.length||item.question).map(item=>item.terminalId),...active.filter(agent=>['approval','question'].includes(agentState(agent))).map(agent=>agent.id)]).size
      const kickoff=Boolean(parent()&&panel?.scopeVersion&&!researchStarted())
      if(watched)tool(verdict==='awaiting_approval'?'Review test':verdict==='failed'||verdict==='interrupted'?'Review error':'Verification progress',()=>void action(()=>verification(watched.lead)),true)
      if(waiting)tool(`Approvals (${waiting})`,()=>void action(attention),true)
      if(kickoff)tool('Kickoff prompt',chooseHuntDepth,true)
      if(x>area.x){frame.text(x,4,'│',1,c.border);x+=2}
      tool('New session',addAgent);tool('Agent controls',agentMenu);if(panel?.type==='web')tool('Traffic',()=>void action(()=>trafficMenu()));if(!side)tool('Record',recordMenu)
      if(nativeInput){x=Math.max(x,width-'Workspace controls'.length-3);tool('Workspace controls',()=>{nativeInput=false;mark()})}
    }
    else if(view==='Scope'){tool('Edit scope',()=>scopeForm(true),true);if(panel?.type!=='web')tool('Review repository',()=>void action(repositorySuggestion));tool('Attack-surface map',()=>void action(mapView));tool('Research record',recordMenu)}
    else{tool('Research record',recordMenu);if(view==='Leads')tool('Rule out selected lead',killLead);if(view==='Findings')tool('Export report',()=>void action(exportFindingsReport));if(evidenceOffset)tool('Previous',()=>{evidenceOffset=Math.max(0,evidenceOffset-25);listIndex=0;void refresh()});if(evidence?.more)tool('Next',()=>{evidenceOffset+=25;listIndex=0;void refresh()})}
    if(width<75||height<25){frame.text(2,9,'Resize to at least 75 × 25 for the workspace.',width-4,c.gold)}
    else if(view==='Investigation'){
      kraflrAscii.forEach((line,index)=>frame.text(area.x+2,area.y+index,line,area.w-4,c.ink))
      frame.text(area.x+2,area.y+6,'FOLLOW THE EVIDENCE. KEEP THE THREAD.',area.w-4,c.muted)
      let y=area.y+9
      frame.text(area.x,y++,`${active.length}/4 Agents active   /   ${panels.length} research spaces`,area.w,c.muted)
      for(const agent of active){if(y+2>=height-3)break;const state=agentState(agent),selected=hit({x:area.x,y,w:area.w,h:2},()=>focusAgent(agent));frame.text(area.x,y,activityGlyph(state),1,toneColor[activityTone[state]]);frame.text(area.x+2,y,`${agent.label}  /  ${agent.kind}  /  ${activityLabels[state]}`,area.w-2,selected?c.chip+c.ink:c.ink);frame.text(area.x+2,y+1,agent.stoppage?agent.stoppage.reason:panels.find(item=>item.id===agent.panelId)?.name??'',area.w-2,agent.stoppage?c.red:c.muted);y+=3}
      if(!active.length){frame.text(area.x,y++,'Your workspace is quiet. Open a research space to start an agent.',area.w,c.muted);y++}
      for(const item of investigation?.counts??[]){if(y>=height-3)break;const id=item.panelId;const selected=hit({x:area.x,y,w:area.w,h:1},()=>select(id));frame.text(area.x,y++,`${panels.find(p=>p.id===id)?.name??'Research'}  /  ${Math.max(0,item.total-item.closed-item.findings)} leads  /  ${item.findings??0} findings`,area.w,selected?c.chip+c.ink:c.muted)}
    }else if(!panel){frame.text(area.x,area.y,'Open a research space or select New panel.',area.w,c.muted)}
    else if(view==='Agents'){
      const agents=visible(),rectangles=paneLayout(area,agents.length)
      if(!agents.length){frame.text(area.x+2,area.y+1,'No agent terminals yet.',area.w-4,c.ink);frame.text(area.x+2,area.y+3,'Create a session to add a terminal pane here. Up to four agents total.',area.w-4,c.muted);button(area.x+2,area.y+5,'New session',addAgent,true)}
      agents.forEach((agent,index)=>{
        const r=rectangles[index]!,state=agentState(agent),pane=screens.get(agent.id),content={x:r.x+1,y:r.y+1,w:Math.max(1,r.w-2),h:Math.max(1,r.h-3)}
        const broken=state==='limit'||state==='stopped'
        frame.box(r,`${activityGlyph(state)} ${agent.label} / ${agent.parent?'Parent':'Child'}`,index===paneIndex||broken,broken?c.red:c.accent)
        hit({x:r.x,y:r.y,w:r.w,h:1},()=>{paneIndex=index;nativeInput=false;mark()})
        if(pane){ensurePane(agent,pane,content.w,content.h)
          if(pane.error){wrap(pane.error,Math.max(10,content.w-2)).slice(0,Math.max(1,content.h-2)).forEach((line,index)=>frame.text(content.x+1,content.y+index,line,content.w-2,c.red));button(content.x+1,content.y+content.h-1,'Retry pane',()=>void retryPane(agent,pane),true)}
          else{pane.screen.draw(frame,content,pane.scroll);regions.push({agent,rect:content,index});hit(content,()=>{paneIndex=index;nativeInput=true;mark()})
            if(nativeInput&&index===paneIndex&&pane.owned&&pane.screen.cursorVisible&&!pane.scroll&&!menu&&!form){const buffer=pane.screen.terminal.buffer.active;cursor=`\x1b[${content.y+Math.min(content.h-1,buffer.cursorY)+1};${content.x+Math.min(content.w-1,buffer.cursorX)+1}H\x1b[?25h`}
          }
        }
        // The status line reads state first, colored by what it means, then which CLI and model it is.
        const status=agent.modelSelectionRequired?'Confirm model':broken?activityLabels[state]:agent.readinessReason??activityLabels[state]
        frame.text(r.x+1,r.y+r.h-2,'●',1,agent.modelSelectionRequired?c.gold:toneColor[activityTone[state]])
        frame.text(r.x+3,r.y+r.h-2,status,r.w-4,broken?c.red:state==='approval'||state==='question'||agent.modelSelectionRequired?c.gold:c.ink)
        frame.text(r.x+3+status.length,r.y+r.h-2,` · ${agentDetails[agent.kind].name}${agent.model?' · '+agent.model:''}${pane?.attaching?' · connecting':''}`,Math.max(0,r.w-4-status.length),c.muted)
      })
    }else if(view==='Scope'){
      const scope=panel.scopeHistory[0],type=`Type of security research: ${researchLabels[panel.type]}`,text=scope?(panel.type==='web'?[type,`Target: ${scope.targetName}`,`Authorized targets: ${parseWebTargets(scope.webTargets).targets.map(item=>item.text).join(', ')}`,`Rules of engagement: ${scope.roeReference?scope.roeReference+(/^https?:\/\//i.test(scope.roeReference)?' (link, agents read it before testing)':' (file, its text is saved)'):'written in the scope'}`,`Access: ${scope.accessMode==='read_write'?'State-changing tests allowed':'Read-only testing (no state changes)'}`,`Workspace: ${scope.workspacePath}`,`Restrictions: ${scope.restrictions||'None added'}`,'Kraflr shows these targets and rules to every agent; it cannot stop an agent’s own tools from reaching a host.','Changes to scope stop this panel’s earlier-scope agents.']:[type,`Target: ${scope.targetName}`,`Source: ${scope.repository||scope.repositoryDiscovery}`,`Workspace: ${scope.workspacePath}`,`Access: ${accessLabels[scope.accessMode]}`,`Restrictions: ${scope.restrictions||'None added'}`,`Prepared source: ${panel.checkout?.path??'Prepared before agent launch'}`,`Recorded commit: ${panel.checkout?.commit??'Automatic'}`,'Changes to scope stop this panel’s earlier-scope agents.']):['No scope saved. Select Edit scope.']
      let y=area.y;for(const line of wrap(text.join('\n\n'),area.w))if(y<height-3)frame.text(area.x,y++,line,area.w)
    }else{
      const items=evidence?.leads??[],noun=view.toLowerCase();frame.text(area.x,area.y,`${items.length} ${items.length===1?noun.replace(/s$/,''):noun} / select an item for actions`,area.w,c.muted)
      const visibleRows=Math.max(1,Math.floor((area.h-3)/3)),start=Math.max(0,listIndex-visibleRows+1)
      items.slice(start,start+visibleRows).forEach((lead:any,index:number)=>{const y=area.y+2+index*3,selected=hit({x:area.x,y,w:area.w,h:2},()=>{listIndex=start+index;leadActions()}),state=lead.verificationProgress,current=start+index===listIndex
        const path=`${lead.path}:${lead.startLine}–${lead.endLine}`,shown=state&&state.state!=='unverified',glyph=state?.active?orbit():state?.state==='verified'?'✓':['failed','interrupted'].includes(state?.state)?'✕':''
        frame.text(area.x,y,`${current?'›':'·'} ${lead.title}`,area.w,selected?c.chip+c.ink:current?c.bold+c.ink:c.ink)
        frame.text(area.x+2,y+1,path,area.w-2,c.muted)
        // The verification state sits next to the location, colored by what it means: red needs you, yellow is moving, green passed.
        if(shown)frame.text(area.x+2+path.length+3,y+1,`${glyph} ${state.label}`.trim(),Math.max(0,area.w-path.length-5),toneColor[stateTone(state.state)])})
      if(!items.length)frame.text(area.x,area.y+3,'No items in this category yet.',area.w,c.muted)
    }
    frame.text(0,height-1,Date.now()<noticeUntil?notice:busy?`${orbit()} Working…`:nativeInput?'Typing into agent / click a tab or Workspace controls to navigate':'Click a control, or Tab to it and select with Enter.',width,Date.now()<noticeUntil?toneColor[noticeTone]:busy?c.gold:c.muted)
    if(menu){hits=[];const banner=menu.banner,bn=banner?2:0,mw=Math.min(width-4,105),body=wrap(menu.lines.join('\n'),mw-6),mh=Math.min(height-3,Math.max(10+bn,Math.min(body.length,Math.max(12,height-18))+bn+Math.min(menu.choices.length,7)+5)),r={x:Math.floor((width-mw)/2),y:Math.floor((height-mh)/2),w:mw,h:mh};fill(frame,r);frame.box(r,menu.title,true,banner&&banner.tone!=='info'?toneColor[banner.tone]:c.accent)
      // The banner is the one line to read first: red for an error, yellow while something is in progress, green for a pass.
      if(banner)frame.text(r.x+2,r.y+2,banner.text,r.w-4,c.bold+toneColor[banner.tone])
      const choiceCount=Math.min(7,menu.choices.length),bodyCount=mh-choiceCount-4-bn;menu.scroll=Math.min(menu.scroll,Math.max(0,body.length-bodyCount));body.slice(menu.scroll,menu.scroll+bodyCount).forEach((line,index)=>frame.text(r.x+2,r.y+2+bn+index,line,r.w-4,c.muted))
      if(body.length>bodyCount){frame.text(r.x+r.w-4,r.y+1+bn,'↑',1,c.accent);hit({x:r.x+r.w-5,y:r.y+1+bn,w:3,h:1},()=>{menu!.scroll=Math.max(0,menu!.scroll-5);mark()});frame.text(r.x+r.w-4,r.y+bn+bodyCount+1,'↓',1,c.accent);hit({x:r.x+r.w-5,y:r.y+bn+bodyCount+1,w:3,h:1},()=>{menu!.scroll+=5;mark()})}
      const start=Math.max(0,menu.selected-choiceCount+1);menu.choices.slice(start,start+choiceCount).forEach((choice,index)=>{const y=r.y+r.h-choiceCount-1+index,current=start+index===menu!.selected,tone=choice.tone&&choice.tone!=='info'?toneColor[choice.tone]:undefined;frame.text(r.x+2,y,`${current?'›':' '} ${choice.label}`,r.w-4,current?c.chip+c.bold+(tone??c.accent):tone??c.ink);hit({x:r.x+1,y,w:r.w-2,h:1},()=>{menu!.selected=start+index;invoke(choice)})})
    }
    if(form){hits=[];const mw=Math.min(width-4,105),errors=formError?wrap(formError,mw-6).slice(0,3):[],mh=Math.min(height-3,form.fields.length*3+7+errors.length),r={x:Math.floor((width-mw)/2),y:Math.floor((height-mh)/2),w:mw,h:mh};fill(frame,r);frame.box(r,form.title,true,errors.length?c.red:c.accent)
      const count=Math.max(1,Math.floor((mh-7-errors.length)/3)),start=Math.max(0,Math.min(form.fields.length-count,Math.min(form.selected,form.fields.length-1)-count+1))
      form.fields.slice(start,start+count).forEach((field,index)=>{const y=r.y+2+index*3,selected=start+index===form!.selected,pos=field.cursor??Array.from(field.value).length,chars=Array.from(field.value),offset=Math.max(0,pos-(r.w-10)),value=field.options?'‹ '+field.value+' ›':chars.slice(offset,pos).join('')+(selected?'▏':'')+chars.slice(pos).join('');frame.text(r.x+2,y,field.label,r.w-4,c.muted);frame.text(r.x+2,y+1,`${selected?'›':' '} ${value}`,r.w-4,selected?c.bold+c.accent:c.ink);hit({x:r.x+1,y,w:r.w-2,h:2},()=>{form!.selected=start+index;if(field.options)cycle(field);mark()})})
      errors.forEach((line,index)=>frame.text(r.x+2,r.y+r.h-4-errors.length+index,line,r.w-4,c.red))
      const y=r.y+r.h-3,n=form.fields.length
      let bx=r.x+2
      const formButton=(label:string,selected:number,fn:()=>void)=>{const text=` ${label} `;frame.text(bx,y,text,text.length,form!.selected===selected?'\x1b[7m'+c.accent:c.chip+c.ink);hit({x:bx,y,w:text.length,h:1},fn);bx+=text.length+2}
      formButton(busy?'Working…':form.title==='Start a native agent'?'Create session':form.title==='New research panel'?'Create panel':form.title.startsWith('Send ')?'Send':'Save',n,submitForm)
      formButton('Cancel',n+1,()=>{form=undefined;formError='';mark()})
      if(formError&&selectedPanel)formButton('Edit scope',n+2,()=>scopeForm(true))
    }
    const output=frame.ansi(previousFrame)+(cursor||'\x1b[?25l');previousFrame=frame;if(output)process.stdout.write(output,()=>{drawing=false;if(dirty)mark()});else drawing=false
  }
  function fill(frame:Frame,r:Rect){for(let y=r.y;y<r.y+r.h;y++)frame.text(r.x,y,' '.repeat(r.w),r.w)}
  let resolveDone:()=>void=()=>{}
  const done=new Promise<void>(resolve=>{resolveDone=resolve})
  function finish(){if(ended)return;ended=true;clearTimeout(escapeTimer);clearTimeout(paintTimer);process.stdin.off('data',data);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l'+terminalBackground.restore(hostBackground));resolveDone()}
  process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();process.stdin.on('data',data)
  process.stdout.write(terminalBackground.query)
  let backgroundTimer:ReturnType<typeof setTimeout>|undefined
  await Promise.race([backgroundReady,new Promise<void>(resolve=>{backgroundTimer=setTimeout(resolve,180)})]);clearTimeout(backgroundTimer);waitingForBackground=false
  process.stdout.write(terminalBackground.enter+'\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l')
  process.stdout.on('resize',mark);process.once('SIGTERM',finish)
  const drawingTimer=setInterval(()=>{dirty=true;render()},140),refreshTimer=setInterval(()=>void refresh(),1500)
  try{await refresh();render();await done}finally{clearInterval(drawingTimer);clearInterval(refreshTimer);process.stdout.off('resize',mark);process.off('SIGTERM',finish);finish();for(const pane of screens.values())pane.screen.dispose();rpc.close()}
}

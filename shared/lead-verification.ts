import { confirmationNote, type EvidenceLead } from './evidence.ts'
import type { ResearchRun } from './research-run.ts'
import { isAgentExecutor } from './verification.ts'
export interface LeadVerificationProgress {
 state:'unverified'|'preparing'|'analysing'|'awaiting_approval'|'running'|'verified'|'not_reproduced'|'inconclusive'|'failed'|'denied'|'expired'|'interrupted'|'cancelled'|'stale'
 label:string
 active:boolean
 canVerify:boolean
 recordId?:string
 preparationId?:string
 scopeVersion?:number
}
export function leadVerification(lead:Pick<EvidenceLead,'tag'|'status'|'reviews'|'verificationResults'>,scopeVersion:number,preparation?:ResearchRun):LeadVerificationProgress{
 const records=lead.verificationResults.filter(record=>record.scopeVersion===scopeVersion)
 const reopened=(record:typeof records[number])=>{const review=lead.reviews[0];return review?.tag==='lead'&&(record.leadReviewVersion!==undefined?review.version>record.leadReviewVersion:Date.parse(review.savedAt)>=Date.parse(record.finishedAt??record.createdAt))}
 const confirmed=records.find(record=>record.status==='reproduced'&&!reopened(record))
 const record=records.find(record=>record.status==='running')??records.find(record=>record.status==='pending')??confirmed??records[0]
 const result=(state:LeadVerificationProgress['state'],label:string,active=false,canVerify=false):LeadVerificationProgress=>({state,label,active,canVerify:canVerify&&lead.tag==='lead'&&lead.status==='open',recordId:record?.id,scopeVersion:record?.scopeVersion??scopeVersion,preparationId:preparation?.id})
 if(lead.tag==='finding'){
  const accepted=lead.verificationResults.find(item=>item.status==='reproduced'&&item.finding)
  // An agent's own confirmation is named as such; "Verified" is kept for an approved test or the researcher's acceptance.
  const label=!accepted&&confirmationNote(lead.reviews)?'Confirmed by agent':accepted&&accepted.scopeVersion!==scopeVersion?`Verified · scope ${accepted.scopeVersion}`:'Verified'
  return {...result('verified',label),recordId:accepted?.id??record?.id,scopeVersion:accepted?.scopeVersion??record?.scopeVersion}
 }
 if(record?.status==='running')return result('running',isAgentExecutor(record.executor)?`Verifying · ${record.lease?.agentLabel??'agent'} is running the test`:'Verifying',true)
 if(record?.status==='pending')return {...result('awaiting_approval','Test approval needed'),active:true}
 if(confirmed)return result('verified','Verified')
 if(preparation?.scopeVersion===scopeVersion&&preparation.status==='running')return preparation.repairOf?result('analysing','Analysing verification error',true):result('preparing','Verifying · preparing lab',true)
 if(record?.status==='reproduced'&&reopened(record))return result('unverified','Reopened for retest',false,true)
 if(record){
  const state=record.status==='error'?'failed':record.status
  const labels:Record<string,string>={not_reproduced:record.killedLead?'Not reproduced · lead killed':'Not reproduced',inconclusive:'Inconclusive',failed:'Error faced',denied:'Test denied',expired:'Test approval expired',interrupted:'Error faced · test did not finish',cancelled:'Verification cancelled',stale:'Earlier scope or plan'}
  return result(state as LeadVerificationProgress['state'],labels[state]??'Error faced',false,true)
 }
 if(preparation&&['failed','interrupted'].includes(preparation.status))return result(preparation.status==='failed'?'failed':'interrupted','Error faced · lab preparation',false,true)
 return result('unverified','Unverified',false,true)
}

import assert from'node:assert/strict'
import test from'node:test'
import{createOpenCodeChat}from'../server/opencode-chat.ts'
import type{PrivateOpenCode}from'../server/private-opencode.ts'

test('OpenCode direct turns are captured only after native idle and retain full redacted replies',async()=>{
 const text='reply '.repeat(8000),messages:any[]=[{id:'idle1',type:'idle',outcome:'succeeded'},{id:'answer1',type:'assistant',content:[{type:'text',text:text+'secret-value'}]},{id:'user1',type:'user',text:'A harmless question \n'}]
 const server:PrivateOpenCode={url:'http://127.0.0.1:0',credentials:{OPENCODE_SERVER_USERNAME:'test',OPENCODE_SERVER_PASSWORD:'secret-value'},async close(){},async request(path){if(path==='/api/session')return{data:{id:'ses_capture'}};if(path.includes('/message?limit=100'))return{data:messages};throw Error('Unexpected test route '+path)}}
 const chat=await createOpenCodeChat(server,'Capture test')
 let turns=await chat.completedTurns();assert.equal(turns.length,1);assert.equal(turns[0]!.prompt,'A harmless question');assert.ok(turns[0]!.reply.length>16000);assert.doesNotMatch(turns[0]!.reply,/secret-value/)
 messages.shift();turns=await chat.completedTurns();assert.equal(turns.length,0,'A streaming answer must not be persisted as complete')
})

test('restored OpenCode turns are historical and cannot trigger new team work, while a new native model choice is observed without changing it',async()=>{
 const model={providerID:'test',id:'chosen-model'},messages:any[]=[{id:'idle-old',type:'idle',outcome:'succeeded'},{id:'answer-old',type:'assistant',model,content:[{type:'text',text:'Old completed answer'}]},{id:'user-old',type:'user',text:'Review the earlier task'}]
 const mutations:string[]=[]
 const server:PrivateOpenCode={url:'http://127.0.0.1:0',credentials:{OPENCODE_SERVER_USERNAME:'test',OPENCODE_SERVER_PASSWORD:'secret'},async close(){},async request(path,options){if(options?.body)mutations.push(path);if(path==='/api/session/ses_restored')return{data:{id:'ses_restored'}};if(path.includes('/message?limit=100'))return{data:messages};throw Error('Unexpected test route '+path)}}
 const chat=await createOpenCodeChat(server,'Restore test','ses_restored')
 assert.equal((await chat.completedTurns())[0]!.historical,true)
 messages.unshift({id:'idle-new',type:'idle',outcome:'succeeded'},{id:'answer-new',type:'assistant',model,content:[{type:'text',text:'New completed answer'}]},{id:'user-new',type:'user',text:'Review the new task'})
 const fresh=(await chat.completedTurns()).find(turn=>turn.id==='user-new')!
 assert.equal(fresh.historical,false);assert.equal(fresh.model,'test/chosen-model');assert.deepEqual(mutations,[])
})

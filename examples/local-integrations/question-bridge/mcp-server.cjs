"use strict";
const readline=require('readline'),{ask}=require('./client.cjs'),{isQuestionSource}=require('./question-sources.cjs');
const agentAt=process.argv.indexOf('--agent'),agentId=agentAt>=0?process.argv[agentAt+1]:'codex';if(!isQuestionSource(agentId))throw Error('Unsupported question source');
const tool={name:'ask_user',description:'Ask ordinary clarification or multiple-choice questions in the Clawd desktop pet and wait for the real answer. Supports multi-select and custom input. Never use for security approvals, credentials or account permissions.',inputSchema:{type:'object',properties:{questions:{type:'array',minItems:1,items:{type:'object',properties:{question:{type:'string'},header:{type:'string'},options:{type:'array',items:{anyOf:[{type:'string'},{type:'object',properties:{label:{type:'string'},description:{type:'string'}},required:['label']}]}},multiSelect:{type:'boolean'}},required:['question']}},sessionId:{type:'string'}},required:['questions']}};
const pending=new Map(),send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const instructions='For ordinary clarification, choice and confirmation questions, use ask_user so this user can answer in the Clawd desktop pet. Preserve every question and option; use multiSelect for multiple choices. Wait for the actual answer. Cancellation and timeouts are never consent. If the bridge is unavailable, use the native question interface. Security approvals, sandbox escalation, credentials and account permissions must stay in the original trusted approval flow.';
readline.createInterface({input:process.stdin}).on('line',async line=>{
  let request;try{request=JSON.parse(line)}catch{return}if(request.id===undefined){if(request.method==='notifications/cancelled')pending.get(request.params?.requestId)?.abort();return}
  try{let result;
    if(request.method==='initialize')result={protocolVersion:request.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'clawd_questions',version:'2.1.0'},instructions};
    else if(request.method==='ping')result={};
    else if(request.method==='tools/list')result={tools:[tool]};
    else if(request.method==='tools/call'&&request.params?.name==='ask_user'){
      const args=request.params.arguments||{},questions=(args.questions||[]).map(q=>({...q,options:(q.options||[]).map(o=>typeof o==='string'?{label:o}:o)}));
      const controller=new AbortController();pending.set(request.id,controller);
      const answer=await ask({questions,agentId,sessionId:args.sessionId,signal:controller.signal});pending.delete(request.id);
      result={content:[{type:'text',text:JSON.stringify(answer)}],isError:answer.reason==='bridge-unavailable'};
    }else return send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method or tool'}});
    send({jsonrpc:'2.0',id:request.id,result});
  }catch(error){pending.delete(request.id);send({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:error.message}})}
});

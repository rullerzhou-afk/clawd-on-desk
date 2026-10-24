"use strict";
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),{randomUUID}=require('crypto');
const {isQuestionSource}=require('./question-sources.cjs');
function installRoot(){return path.resolve(__dirname,'../../..')}
async function ask({questions,agentId='codex',sessionId,signal,timeoutMs=570000},dependencies={}){
  if(!isQuestionSource(agentId)||!Array.isArray(questions)||!questions.length)return {status:'cancelled',reason:'invalid-question'};
  if(signal?.aborted)return {status:'cancelled',reason:'aborted'};
  let post;try{post=dependencies.post||require(path.join(installRoot(),'hooks/server-config')).postPermissionToRunningServer}catch{return {status:'cancelled',reason:'bridge-unavailable'}}
  const payload={clawd_question_bridge:'clawd-questions-v2',agent_id:agentId,tool_name:'AskUserQuestion',hook_event_name:'PermissionRequest',session_id:sessionId||`${agentId}:question:${randomUUID()}`,tool_input:{questions}};
  return new Promise(resolve=>{
    let settled=false;const finish=result=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);resolve(result)};
    let currentRequest;const abort=()=>{currentRequest?.destroy();finish({status:'cancelled',reason:'aborted'})};signal?.addEventListener('abort',abort,{once:true});
    const httpRequest=(options,callback)=>{currentRequest=http.request(options,callback);if(signal?.aborted)currentRequest.destroy();return currentRequest};
    try{post(JSON.stringify(payload),{timeoutMs,probeTimeoutMs:700,httpRequest},(ok,_port,body,status)=>{
      if(!ok||status!==200)return finish({status:'cancelled',reason:'bridge-unavailable'});
      let decision;try{decision=JSON.parse(body).hookSpecificOutput?.decision}catch{return finish({status:'cancelled',reason:'invalid-response'})}
      if(decision?.behavior==='deny'&&decision.message==='clawd-question-cancelled-v1')return finish({status:'cancelled',reason:'user-cancelled'});
      const answers=decision?.updatedInput?.answers;
      if(decision?.behavior!=='allow'||!answers||questions.some(q=>typeof answers[q.question]!=='string'))return finish({status:'cancelled',reason:'no-answer'});
      finish({status:'answered',answers});
    })}catch{finish({status:'cancelled',reason:'bridge-unavailable'})}
  });
}
module.exports={ask,installRoot};

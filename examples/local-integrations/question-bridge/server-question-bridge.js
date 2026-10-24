"use strict";
const {isQuestionSource}=require('./question-sources.cjs');
function handleQuestionBridge(options){
  const {ctx,data,agentId,res,remoteProfile,sessionAutomationIdentity,prepareElicitationToolInput,resolvePermissionSession,trustedSessionFields,addPendingPermission,removePendingPermission,sendGenericPermissionNoDecision,recordRequestHookEvent}=options;
  if(data.clawd_question_bridge!=='clawd-questions-v2')return false;
  const fallback=()=>{sendGenericPermissionNoDecision(res);return true};
  if(remoteProfile||!isQuestionSource(agentId)||data.tool_name!=='AskUserQuestion'||typeof data.session_id!=='string'||!data.session_id)return fallback();
  if(ctx.doNotDisturb||ctx.hideBubbles||ctx.getBubblePolicy?.('permission')?.enabled===false||(ctx.isAgentEnabled&&!ctx.isAgentEnabled(agentId)))return fallback();
  const prepared=prepareElicitationToolInput(data.tool_input);if(!prepared.canAnswer)return fallback();
  const identity=resolvePermissionSession(data.session_id,'question'),sessionId=identity.sessionId||identity.key||identity.id;
  if(typeof sessionId!=='string')return fallback();
  const entry={res,abortHandler:null,suggestions:[],sessionId,...trustedSessionFields(identity),bubble:null,hideTimer:null,toolName:'AskUserQuestion',
    toolInput:prepared.displayInput,elicitationDetailInput:prepared.detailDisplayInput,detailTruncated:prepared.detailTruncated,elicitationWireInput:prepared.wireInput,
    resolvedSuggestion:null,createdAt:Date.now(),interaction:{intent:'human-question',automationEligibility:{autoTools:false,unattended:false},capabilities:{allowDeny:false,answerQuestions:true,planFeedback:false,nativeFallback:true}},sessionAutomationIdentity,isElicitation:true,isQuestionBridge:true,agentId};
  entry.abortHandler=()=>{if(!res.writableFinished)ctx.resolvePermissionEntry(entry,'no-decision','Client disconnected')};res.on('close',entry.abortHandler);
  addPendingPermission(ctx,entry);recordRequestHookEvent.accepted();
  ctx.updateSession(sessionId,'notification','Elicitation',{agentId,sessionAutomationIdentity,...trustedSessionFields(identity)});
  try{ctx.showPermissionBubble(entry);ctx.permLog(`QUESTION BRIDGE v2: agent=${agentId} session=${sessionId}`)}catch(error){
    removePendingPermission(ctx,entry,'question-bridge-failed');res.removeListener('close',entry.abortHandler);ctx.permLog('QUESTION BRIDGE failed: '+error.message);return fallback();
  }
  return true;
}
module.exports={handleQuestionBridge};

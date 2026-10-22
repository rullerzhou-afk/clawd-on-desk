'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),readline=require('node:readline'),path=require('node:path');
const {ask}=require('./client.cjs');
const {handleQuestionBridge}=require('./server-question-bridge');
const questions=[{question:'选择功能？',multiSelect:true,options:[{label:'搜索',description:'保留原说明'},{label:'导出'}]}];
test('MCP advertises ordinary questions without registering permissions',async()=>{
  const child=spawn(process.execPath,[path.join(__dirname,'mcp-server.cjs'),'--agent','codex'],{stdio:['pipe','pipe','pipe']});
  const reader=readline.createInterface({input:child.stdout});
  const response=new Promise(resolve=>reader.once('line',line=>resolve(JSON.parse(line))));
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}})+'\n');
  try{
    const message=await response;
    assert.equal(message.result.serverInfo.name,'clawd_questions');
    assert.match(message.result.instructions,/Security approvals/);
    assert.deepEqual(Object.keys(message.result.capabilities),['tools']);
  }finally{reader.close();child.kill();}
},{timeout:5000});
test('transport preserves source, full choices, multi-select and the actual answer',async()=>{
  const result=await ask({agentId:'copilot-cli',sessionId:'session-fixture',questions},{post:(body,options,done)=>{
    const sent=JSON.parse(body);
    assert.equal(sent.agent_id,'copilot-cli');assert.equal(sent.session_id,'session-fixture');
    assert.deepEqual(sent.tool_input.questions,questions);assert.ok(options.timeoutMs>0);
    done(true,23333,JSON.stringify({hookSpecificOutput:{decision:{behavior:'allow',updatedInput:{answers:{'选择功能？':'搜索, 自定义\n第二行'}}}}}),200);
  }});
  assert.deepEqual(result,{status:'answered',answers:{'选择功能？':'搜索, 自定义\n第二行'}});
});
test('explicit cancellation, missing answer, timeout and prior abort never become consent',async()=>{
  for(const [decision,reason] of [
    [{behavior:'deny',message:'clawd-question-cancelled-v1'},'user-cancelled'],
    [{behavior:'allow',updatedInput:{answers:{}}},'no-answer'],
  ]){
    const result=await ask({questions},{post:(_body,_opts,done)=>done(true,23333,JSON.stringify({hookSpecificOutput:{decision}}),200)});
    assert.equal(result.status,'cancelled');assert.equal(result.reason,reason);
  }
  const unavailable=await ask({questions},{post:(_body,_opts,done)=>done(false,0,'',0)});
  assert.equal(unavailable.reason,'bridge-unavailable');
  const controller=new AbortController();controller.abort();
  assert.equal((await ask({questions,signal:controller.signal},{post:()=>assert.fail('aborted')})).reason,'aborted');
});
test('unknown sources fail closed, and DND returns no decision before creating a bubble',async()=>{
  assert.equal((await ask({agentId:'unknown',questions})).reason,'invalid-question');
  let fallback=0;
  assert.equal(handleQuestionBridge({ctx:{doNotDisturb:true},data:{clawd_question_bridge:'clawd-questions-v2',tool_name:'AskUserQuestion',session_id:'fixture'},agentId:'codex',sendGenericPermissionNoDecision:()=>fallback++}),true);
  assert.equal(fallback,1);
});

"use strict";
const {test, before, after} = require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");const os=require("node:os");const path=require("node:path");
const {pathToFileURL}=require("node:url");
const home=fs.mkdtempSync(path.join(os.tmpdir(),"clawd-attach-plugin-"));
process.env.HOME=home;process.env.USERPROFILE=home;
let core;const posts=[];const plugins=[];
before(async()=>{
  globalThis.fetch=async(url,options)=>{
    posts.push({url:String(url),body:options?.body?JSON.parse(options.body):null});
    return {status:200,headers:{get:key=>key.toLowerCase()==="x-clawd-server"?"clawd-on-desk":null},text:async()=>"ok"};
  };
  globalThis.Bun={serve:()=>({port:41999,stop:()=>{}})};
  core=await import(pathToFileURL(path.join(__dirname,"../hooks/opencode-family-plugin/core.mjs")).href);
});
after(async()=>{
  for(const plugin of plugins) await plugin.__test.flushDebugLog();
  delete globalThis.Bun;delete globalThis.fetch;
  await fs.promises.rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:100});
});
const params={agentId:"opencode",hookSource:"opencode-plugin",logFileName:"attach-test.log",sessionIdPrefix:"opencode:"};
async function init(plugin,dir,url,serve=true){
  const argv=process.argv;process.argv=serve?["opencode.exe","serve","--port","4096"]:["opencode.exe",dir];
  try{return await plugin({directory:dir,serverUrl:new URL(url),client:{}});}finally{process.argv=argv;}
}
async function emit(plugin,handler,type,id,dir,extra={}){
  posts.length=0;
  await handler.event({event:{type,properties:{sessionID:id,info:{id,directory:dir,...extra}}}});
  await Promise.all([...plugin.__test._statePostTailBySession.values()]);
  return posts.filter(p=>p.url.endsWith("/state")).map(p=>p.body);
}

test("explicit serve mode and root HTTP URL are required; internal TUI URL is never advertised",()=>{
  const get=core.resolveOpencodeServeAttachUrl;
  assert.equal(get("opencode",["opencode.exe","serve"],new URL("http://0.0.0.0:4096")),"http://127.0.0.1:4096/");
  assert.equal(get("opencode",["bun","B:/~BUN/root/src/index.js","serve","--port","4096"],new URL("http://0.0.0.0:4096")),"http://127.0.0.1:4096/");
  assert.equal(get("opencode",["opencode.exe","serve"],"http://[::]:4096/"),"http://[::1]:4096/");
  for(const argv of [["opencode.exe"],["opencode.exe","attach","serve"],["opencode.exe","project\\serve"],
    ["bun","B:/~BUN/root/src/index.js"],["bun","B:/~BUN/root/src/index.js","attach"]])
    assert.equal(get("opencode",argv,"http://localhost:4096/"),null);
  for(const url of ["http://opencode.local/","http://u:secret@localhost:4096/","http://localhost:4096/?token=x"])
    assert.equal(get("opencode",["opencode.exe","serve"],url),null);
  assert.equal(get("mimocode",["mimo.exe","serve"],"http://localhost:4096/"),null);
});

test("serve accepts known leading global options without mistaking option values or TUI arguments for commands",()=>{
  const get=core.resolveOpencodeServeAttachUrl;
  const url="http://127.0.0.1:4096/";
  for(const host of [["opencode.exe"],["bun","B:/~BUN/root/src/index.js"]]){
    for(const prefix of [
      ["--log-level","ERROR"], ["--log-level=DEBUG"],
      ["--logLevel","ERROR"], ["--logLevel=INFO","--printLogs"],
      ["--print-logs"], ["--no-print-logs"], ["--print-logs=false"],
      ["--print-logs","false"], ["--no-pure"],
      ["--print-logs","--log-level","INFO"],
      ["--log-level=WARN","--print-logs=true","--pure=false"],
    ]) assert.equal(get("opencode",[...host,...prefix,"serve","--port","4096"],url),url,JSON.stringify(prefix));
    for(const args of [
      ["--log-level"], ["--log-level","serve"], ["--log-level=serve"],
      ["--unknown","serve"], ["--unknown=value","serve"], ["--","serve"],
      ["--print-logs=serve"], ["--print-logs","project","serve"],
      ["--no-print-logs","false","serve"], ["--no-pure","true","serve"],
      ["--no-print-logs=false","serve"],
      ["--log-level","ERROR","attach","serve"],
      ["--print-logs","run","serve"], ["--log-level","ERROR","project\\serve"],
      ["--help","serve"], ["--version","serve"],
    ]) assert.equal(get("opencode",[...host,...args],url),null,JSON.stringify(args));
  }
});

test("each directory instance advertises its own endpoint, including metadata-only title updates",async()=>{
  const plugin=core.createOpencodeFamilyPlugin(params);plugins.push(plugin);
  const a=path.join(home,"a"),b=path.join(home,"b");
  const first=await init(plugin,a,"http://0.0.0.0:4096/");
  const second=await init(plugin,b,"http://127.0.0.1:4097/");
  const aPosts=await emit(plugin,first,"session.created","ses_A",a,{title:"A"});
  assert.ok(aPosts.length);assert.ok(aPosts.every(p=>p.opencode_attach_url==="http://127.0.0.1:4096/"));
  const bPosts=await emit(plugin,second,"session.created","ses_B",b,{title:"B"});
  assert.ok(bPosts.every(p=>p.opencode_attach_url==="http://127.0.0.1:4097/"));
  const updated=await emit(plugin,first,"session.updated","ses_A",a,{title:"renamed"});
  assert.equal(updated[0].metadata_only,true);assert.equal(updated[0].opencode_attach_url,"http://127.0.0.1:4096/");
  await first.dispose();
  const alive=await emit(plugin,second,"session.idle","ses_B",b);
  assert.equal(alive.at(-1).opencode_attach_url,"http://127.0.0.1:4097/");
  await second.dispose();
});

test("TUI and child sessions clear attach capability; MiMo does not gain the wire field",async()=>{
  const plugin=core.createOpencodeFamilyPlugin(params);plugins.push(plugin);
  const dir=path.join(home,"tui");const handler=await init(plugin,dir,"http://localhost:4096/",false);
  const result=await emit(plugin,handler,"session.created","ses_TUI",dir);
  assert.equal(result.at(-1).opencode_attach_url,null);
  await handler.dispose();
  const root=await init(plugin,dir,"http://localhost:4096/");
  const child=await emit(plugin,root,"session.created","ses_child",dir,{parentID:"ses_parent"});
  assert.equal(child.at(-1).headless,true);assert.equal(child.at(-1).opencode_attach_url,null);
  await root.dispose();
  const mimo=core.createOpencodeFamilyPlugin({...params,agentId:"mimocode",hookSource:"mimocode-plugin",sessionIdPrefix:"mimocode:"});plugins.push(mimo);
  const mh=await init(mimo,dir,"http://localhost:4096/");
  const mp=await emit(mimo,mh,"session.created","ses_mimo",dir);
  assert.equal(Object.hasOwn(mp.at(-1),"opencode_attach_url"),false);await mh.dispose();
});

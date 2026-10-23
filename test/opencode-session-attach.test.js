"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOpencodeAttachUrl, getOpencodeAttachTarget } = require("../src/opencode-attach-target");
const { buildAttachTerminalArgs, createOpencodeSessionAttacher, findOpencodeExecutable } = require("../src/opencode-session-attach");
const session = { agentId: "opencode", opencodeAttachSource: "opencode-plugin", profileId: "local",
  rawSessionId: "opencode:ses_123", cwd: "C:\\project 中文 %PATH% & ' ; $x", state: "working",
  opencodeAttachUrl: "http://0.0.0.0:4096/" };

test("normalizes wildcard listeners without accepting private credentials or internal endpoints", () => {
  assert.equal(normalizeOpencodeAttachUrl("http://0.0.0.0:4096"), "http://127.0.0.1:4096/");
  assert.equal(normalizeOpencodeAttachUrl("http://[::]:4096/"), "http://[::1]:4096/");
  for (const url of [null, "", "http://opencode.local", "file:///a", "http://localhost:4096/path", "http://u:p@localhost:4096/",
    "http://localhost:4096/?token=secret", "http://localhost:4096/#secret", "http://localhost:4096/\n", "http://example.com:4096/", "http://localhost:70000/"]) {
    assert.equal(normalizeOpencodeAttachUrl(url), null, String(url));
  }
});

test("only valid live local root v1 sessions have an attach target", () => {
  assert.deepEqual(getOpencodeAttachTarget(session, "win32"), {url:"http://127.0.0.1:4096/",sessionId:"ses_123",cwd:session.cwd});
  for (const change of [{rawSessionId:"opencode:default"},{rawSessionId:"ses_123;whoami"},{cwd:"relative"},{cwd:"C:\\x\n"},
    {cwd:"\\root-relative"},{headless:true},{host:"wsl:Ubuntu"},{agentId:"mimocode"},{opencodeAttachSource:"opencode-plugin-v2"}]) {
    assert.equal(getOpencodeAttachTarget({...session,...change},"win32"), null);
  }
});

test("terminal command invokes a native program with literal PowerShell arguments", () => {
  const target = getOpencodeAttachTarget(session,"win32");
  const args = buildAttachTerminalArgs("C:\\Program Files\\OpenCode\\opencode.exe",target);
  assert.deepEqual(args.slice(0,7),["--window","new","new-tab","--title","OpenCode","--","powershell.exe"]);
  const command = Buffer.from(args.at(-1),"base64").toString("utf16le");
  assert.ok(command.startsWith("Set-Location -LiteralPath 'C:\\project 中文 %PATH% & '' ; $x'"));
  assert.ok(command.includes("& 'C:\\Program Files\\OpenCode\\opencode.exe' 'attach' 'http://127.0.0.1:4096/' '--session' 'ses_123' '--dir'"));
  assert.ok(!command.includes("cmd.exe"));
});

function harness(extra={}) {
  let current = {...session}; const launches=[];
  const open=createOpencodeSessionAttacher({platform:"win32", getSession:()=>current,
    findExecutable:async()=>"C:\\opencode.exe", stat:async()=>({isDirectory:()=>true}),
    tryLaunch:async(...args)=>{launches.push(args);return {ok:true};}, ...extra});
  return {open, launches, replace:value=>{current=value;}};
}

test("launches only the revalidated current session and returns no private URL",async()=>{
  const h=harness(); assert.deepEqual(await h.open("s"),{status:"ok"});
  assert.equal(h.launches.length,1); assert.equal(h.launches[0][2].shell,false);
});

test("rejects a target removed or changed during asynchronous executable lookup",async()=>{
  for (const replacement of [null,{...session,opencodeAttachUrl:"http://127.0.0.1:9999/"}]) {
    let h; h=harness({findExecutable:async()=>{h.replace(replacement);return "C:\\opencode.exe";}});
    assert.deepEqual(await h.open("s"),{status:"unavailable"});assert.equal(h.launches.length,0);
  }
});

test("a normal session update during executable lookup does not cancel the action",async()=>{
  let h;
  // updateSession() rebuilds the object for every lifecycle event; the new
  // object carries identical attach-relevant fields.
  h=harness({findExecutable:async()=>{h.replace({...session,state:"working",updatedAt:Date.now()});return "C:\\opencode.exe";}});
  assert.deepEqual(await h.open("s"),{status:"ok"});
  assert.equal(h.launches.length,1);
});

test("still rejects a session removed, disabled or retargeted during lookup",async()=>{
  for (const {replacement, enabled} of [
    {replacement:null},
    {replacement:{...session},enabled:false},
    {replacement:{...session,opencodeAttachUrl:null}},
    {replacement:{...session,cwd:"C:\\elsewhere"}},
    {replacement:{...session,rawSessionId:"opencode:ses_other"}},
  ]) {
    let h; const extra={findExecutable:async()=>{h.replace(replacement);return "C:\\opencode.exe";}};
    if (enabled === false) extra.isAgentEnabled=()=>false;
    h=harness(extra);
    assert.deepEqual(await h.open("s"),{status:"unavailable"},JSON.stringify(replacement));
    assert.equal(h.launches.length,0);
  }
});

test("coalesces double-clicks and releases the lock after failure",async()=>{
  let resolve; const h=harness({findExecutable:()=>new Promise(r=>{resolve=r;})});
  const first=h.open("s"); await new Promise(r=>setImmediate(r));
  assert.deepEqual(await h.open("s"),{status:"busy"}); resolve(null);
  assert.deepEqual(await first,{status:"error",reason:"opencode"});
  const retry=h.open("s");await new Promise(r=>setImmediate(r));resolve(null);await retry;
});

test("reports missing directory, native CLI and terminal with stable reasons",async()=>{
  assert.deepEqual(await harness({stat:async()=>{throw Error("private path");}}).open("s"),{status:"error",reason:"directory"});
  assert.deepEqual(await harness({findExecutable:async()=>null}).open("s"),{status:"error",reason:"opencode"});
  assert.deepEqual(await harness({tryLaunch:async()=>({ok:false,error:Error("secret")})}).open("s"),{status:"error",reason:"terminal"});
  assert.deepEqual(await harness({isAgentEnabled:()=>false}).open("s"),{status:"unavailable"});
});

test("native lookup resolves the official npm binary, not the cmd shim",async()=>{
  const calls=[];
  const found=await findOpencodeExecutable({isNativeExecutable:async()=>true,
    execFileAsync:async(bin,args)=>{calls.push([bin,args]);return {stdout:bin==="where.exe"?"C:\\npm\\opencode.cmd\r\n":"1.18.31\n"};}});
  assert.equal(found,"C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe");
  assert.equal(calls.some(([bin])=>bin.endsWith(".cmd")),false);
});

test("native lookup rejects v2 and never runs malformed PATH results",async()=>{
  const found=await findOpencodeExecutable({isNativeExecutable:async()=>true,
    execFileAsync:async(bin)=>({stdout:bin==="where.exe"?"C:\\tools\\opencode.exe":"2.0.15"})});
  assert.equal(found,null);
});

"use strict";

// Explicit, isolated acceptance probe. This does not reserve ports or change
// network configuration; the caller supplies a currently excluded range.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const home = process.env.CLAWD_PORT_SMOKE_HOME;
assert.equal(process.platform,"win32");
assert.ok(home && path.isAbsolute(home));
assert.equal(path.resolve(os.homedir()),path.resolve(home));
assert.equal(path.resolve(process.env.USERPROFILE),path.resolve(home));
const config = require("../../hooks/server-config");
const hint = require("../../src/local-server-port-hint");
const initServer = require("../../src/server");
const { checkLocalServer } = require("../../src/doctor-detectors/local-server");
const runtimePath = path.join(home,".clawd","runtime.json");
assert.equal(config.defaultRuntimeConfigPath(),runtimePath);
const startPort = Number(process.env.CLAWD_SMOKE_RESERVED_START);
assert.ok(Number.isInteger(startPort) && startPort > 1024 && startPort <= 65531);
const excludedText = execFileSync("netsh",["interface","ipv4","show","excludedportrange","protocol=tcp"],{encoding:"utf8"});
const excludedRanges = [...excludedText.matchAll(/^\s*(\d+)\s+(\d+)\s*(?:\*)?\s*$/gm)].map(m=>[Number(m[1]),Number(m[2])]);
assert.ok(excludedRanges.some(([a,b])=>a<=startPort && b>=startPort+4),"supplied ports must really be excluded");
const reserved = Array.from({length:5},(_,i)=>startPort+i);

function makeApi(candidates, publish = true) {
  let server;
  const calls=[],syncs=[],states=[];
  const api = initServer({
    createHttpServer(handler) {
      server=http.createServer(handler);
      const listen=server.listen;
      server.listen=function(port,...args){calls.push(port); return listen.call(this,port,...args);};
      return server;
    },
    runtimeConfigPath:runtimePath,
    getPortCandidates:()=>candidates,
    readRuntimePort:()=>config.readRuntimePort({runtimeConfigPath:runtimePath}),
    readRuntimeIdentity:()=>config.readRuntimeIdentity({runtimeConfigPath:runtimePath}),
    writeRuntimeConfig:(port,options)=>publish && config.writeRuntimeConfig(port,{...options,runtimeConfigPath:runtimePath}),
    clearRuntimeConfig:()=>config.clearRuntimeConfig(runtimePath),
    readLocalServerPortHint:()=>hint.readLocalServerPortHint({homeDir:home}),
    writeLocalServerPortHint:port=>hint.writeLocalServerPortHint(port,{homeDir:home}),
    setImmediate:fn=>syncs.push(fn),
    sessions:new Map(), STATE_SVGS:{working:"working.svg"}, pendingPermissions:[],
    isAgentEnabled:()=>true, updateSession:(...args)=>states.push(args),
  });
  return {api,calls,syncs,states, async close(){
    const done=server.listening ? new Promise(resolve=>server.once("close",resolve)) : Promise.resolve();
    api.cleanup(); server.closeAllConnections(); await done;
  }};
}
function get(port) {
  return new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${port}/state`,res=>{
    let body="";res.on("data",chunk=>{body+=chunk;});res.on("end",()=>resolve(JSON.parse(body)));
  }).on("error",reject));
}
async function main(){
  const first=makeApi(reserved);
  let initial;
  try {
    initial=await first.api.startHttpServer();
    assert.ok(initial && !reserved.includes(initial));
    assert.deepEqual(first.calls,[...reserved,0]);
    assert.ok(first.api.getRuntimeStatus().bindAttempts.every(x=>x.code==="EACCES"));
    assert.equal(config.readRuntimePort({runtimeConfigPath:runtimePath}),initial);
    assert.equal(checkLocalServer(first.api).status,"pass");
    assert.equal((await get(initial)).port,initial);
    const sent=await new Promise(resolve=>config.postStateToRunningServer({agent_id:"claude-code",session_id:"port-smoke",event:"UserPromptSubmit",state:"working"},{sshSecure:false,runtimePort:initial},resolve));
    assert.equal(sent,true);
    assert.equal(first.states.length,1);
  } finally {await first.close();}
  assert.equal(fs.existsSync(runtimePath),false);
  assert.equal(hint.readLocalServerPortHint({homeDir:home}),initial);
  const restarted=makeApi(reserved);
  try {
    assert.equal(await restarted.api.startHttpServer(),initial);
    assert.deepEqual(restarted.calls,[...reserved,initial]);
  } finally {await restarted.close();}
  const blocker=http.createServer();
  await new Promise((resolve,reject)=>{blocker.once("error",reject);blocker.listen(initial,"127.0.0.1",resolve);});
  const drifted=makeApi(reserved);
  let next;
  try {
    next=await drifted.api.startHttpServer();
    assert.ok(next && next!==initial);
    assert.deepEqual(drifted.calls,[...reserved,initial,0]);
    assert.equal(drifted.api.getRuntimeStatus().bindAttempts.at(-1).code,"EADDRINUSE");
  } finally {await drifted.close();await new Promise(resolve=>blocker.close(resolve));}
  const failed=makeApi(reserved,false);
  try {
    assert.equal(await failed.api.startHttpServer(),null);
    assert.equal(failed.api.getRuntimeStatus().listening,false);
    assert.equal(failed.api.getRuntimeStatus().startupFailure.stage,"runtime");
    assert.equal(failed.syncs.length,0);
  } finally {await failed.close();}
  console.log(JSON.stringify({ok:true,platform:os.release(),node:process.version,reserved,initial,restarted:initial,drifted:next,
    checks:["real EACCES","listen(0)","runtime publication","health actual port","state delivery","restart reuse","real EADDRINUSE drift","publication failure closes"]}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});

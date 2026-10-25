"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { stripTypeScriptTypes } = require("node:module");
const { pathToFileURL } = require("node:url");
const config = require("../hooks/server-config");
const values = require("./fixtures/local-port-values.json");
const root = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-local-port-clients-"));
const runtimePath = path.join(home, ".clawd", "runtime.json");
const envBefore = { ...process.env };
let core, openclaw, dsh, extensions;

// Load the actual deployed modules with extra test exports. Type stripping
// removes only types; all discovery and network behavior below is production.
async function instrument(relative, exports, ts = false) {
  let source = fs.readFileSync(path.join(root, relative), "utf8");
  if (ts) {
    source = stripTypeScriptTypes(source);
    source = source.replace(/from "(\.\/[^"\n]+)"/g, (_all, file) =>
      `from ${JSON.stringify(pathToFileURL(path.resolve(root, path.dirname(relative), file)).href)}`);
  }
  return import(`data:text/javascript;base64,${Buffer.from(source + `\nexport { ${exports} };`).toString("base64")}`);
}

before(async () => {
  for (const key of Object.keys(process.env)) {
    if (/^(CLAWD_|HERMES_|DSH_|OPENCLAW_|OPENCODE_|PI_|OMP_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, { HOME:home, USERPROFILE:home, APPDATA:home, LOCALAPPDATA:home,
    HOMEDRIVE:path.parse(home).root.replace(/[\\/]$/, ""), HOMEPATH:home.slice(path.parse(home).root.length - 1),
    PYTHONDONTWRITEBYTECODE:"1" });
  assert.equal(os.homedir(), home, "isolation must be effective before any module loads");
  fs.mkdirSync(path.dirname(runtimePath), { recursive:true });
  core = await import(pathToFileURL(path.join(root, "hooks/opencode-family-plugin/core.mjs")).href);
  openclaw = await instrument("hooks/openclaw-plugin/index.js", "readRuntimePort");
  dsh = await instrument("hooks/dsh-clawd-bridge/lib/clawd-client.js", "runtimePort");
  extensions = await Promise.all(["pi", "omp"].map(name => instrument(`hooks/${name}-extension.ts`, "readRuntimePort, postState", true)));
  assert.equal(dsh.__test.runtimePath, runtimePath);
});
after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
  await fs.promises.rm(home, { recursive:true, force:true, maxRetries:3 });
});
function runtime(value, overrides = {}) {
  fs.writeFileSync(runtimePath, JSON.stringify({ app:"clawd-on-desk", port:value, ownerPid:process.pid, ...overrides }), { mode:0o600 });
}
async function listener() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push({ path:req.url, method:req.method, body:body ? JSON.parse(body) : null });
      res.writeHead(200, { "x-clawd-server":"clawd-on-desk", "content-type":"application/json" });
      res.end(JSON.stringify(req.method === "GET" ? {app:"clawd-on-desk",ok:true} : {decision:"allow"}));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0,"127.0.0.1",resolve); });
  return { server, requests, port:server.address().port, async close() {
    if (!server.listening) return;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}
async function until(predicate) {
  const end = Date.now()+3000;
  while (!predicate()) {
    assert.ok(Date.now()<end, "expected state delivery did not arrive");
    await new Promise(resolve => setTimeout(resolve,10));
  }
}
function family(agentId, v2 = false) {
  const args = {agentId,hookSource:`${agentId}-plugin`,logFileName:`${agentId}-test.log`,sessionIdPrefix:`${agentId}:`};
  return v2 ? core.createOpencodeFamilyPluginV2({...args,pluginId:"clawd-test",markerPluginDirName:"opencode-plugin"})
    : core.createOpencodeFamilyPlugin(args);
}

test("all deployed JS/TS readers share canonical local-port semantics and app validation", async () => {
  const readers = [() => config.readRuntimePort({runtimeConfigPath:runtimePath}),
    core.readRuntimePort, core.readPermissionRuntimePort, openclaw.readRuntimePort, dsh.runtimePort,
    ...extensions.map(ext => ext.readRuntimePort)];
  for (const {value,port} of values) {
    runtime(value);
    for (const read of readers) assert.equal(await read(),port,JSON.stringify(value));
  }
  runtime(45000,{app:"foreign"});
  for (const read of readers) assert.equal(await read(),null);
});

test("CJS dynamic runtime round-trips; CLI installers reject stale owners and remote stays fixed", () => {
  assert.equal(config.writeRuntimeConfig(45000,{runtimeConfigPath:runtimePath}),true);
  assert.equal(config.readRuntimePort({runtimeConfigPath:runtimePath}),45000);
  assert.equal(config.resolveInstallServerPort(undefined,{runtimeConfigPath:runtimePath,isProcessAlive:()=>true}),45000);
  assert.equal(config.resolveInstallServerPort(undefined,{runtimeConfigPath:runtimePath,isProcessAlive:()=>false}),23333);
  assert.equal(config.resolveInstallServerPort(45002,{runtimeConfigPath:runtimePath,isProcessAlive:()=>false}),45002);
  assert.deepEqual(config.getPortCandidates(undefined,{runtimePort:"45000",sshSecure:false}),[45000,...config.SERVER_PORTS]);
  assert.deepEqual(config.getPortCandidates(undefined,{runtimePort:[],sshSecure:false}),config.SERVER_PORTS);
  const remote = {version:2,layoutVersion:1,runtimeKey:"a",profileId:"b",installId:"a".repeat(64),remotePort:45000,routingNonce:"b".repeat(32),deployedAt:123};
  assert.equal(config.readRemoteIdentity({readFileSync:()=>JSON.stringify(remote)}).ok,false);
});

test("Claude and CodeBuddy migrate only owned approval URLs across legacy and dynamic ports", () => {
  const {registerHooks,unregisterHooks} = require("../hooks/install");
  const {registerCodeBuddyHooks,unregisterCodeBuddyHooks} = require("../hooks/codebuddy-install");
  const foreign = {type:"http",url:"http://127.0.0.1:45000/permission"};
  for (const [name,register,unregister] of [["claude",registerHooks,unregisterHooks],["codebuddy",registerCodeBuddyHooks,unregisterCodeBuddyHooks]]) {
    const settingsPath = path.join(home,`${name}-settings.json`);
    fs.writeFileSync(settingsPath,JSON.stringify({hooks:{PermissionRequest:[{matcher:"",hooks:[foreign]}]}}));
    const read = () => JSON.parse(fs.readFileSync(settingsPath,"utf8")).hooks.PermissionRequest.flatMap(entry=>entry.hooks||[]);
    for (const port of [23333,45000,45001,23334]) {
      register({silent:true,settingsPath,port,nodeBin:process.execPath,
        claudeVersionInfo:{version:"2.1.296",status:"known",source:"test"},permissionTarget:{mode:"local"}});
      const hooks = read();
      assert.deepEqual(hooks.filter(h=>h.url===foreign.url),[foreign]);
      assert.equal(hooks.filter(h=>config.isManagedPermissionUrl(h.url)).length,1);
      assert.ok(hooks.some(h=>h.url===config.buildPermissionUrl(port)));
    }
    unregister({silent:true,settingsPath});
    assert.deepEqual(read(),[foreign]);
  }
});

test("restart hints persist independently, reject corrupt content, and never become client targets", () => {
  const hints = require("../src/local-server-port-hint");
  const options = {homeDir:home};
  const file = path.join(home,".clawd","local-server-port.json");
  assert.equal(hints.writeLocalServerPortHint(45000,options),true);
  runtime(45000);
  config.clearRuntimeConfig(runtimePath);
  assert.equal(hints.readLocalServerPortHint(options),45000);
  assert.equal(config.readRuntimePort({runtimeConfigPath:runtimePath}),null);
  assert.equal(config.resolveInstallServerPort(undefined,{runtimeConfigPath:runtimePath}),23333);
  for (const body of ["bad",JSON.stringify({app:"foreign",port:45000}),JSON.stringify({app:"clawd-on-desk",port:23333})," ".repeat(1025)]) {
    fs.writeFileSync(file,body);
    assert.equal(hints.readLocalServerPortHint(options),null);
  }
  for (const port of [0,80,23333,65536]) assert.equal(hints.writeLocalServerPortHint(port,options),false);
});

test("each native client sends to dynamic runtime and recovers its first send after a restart", async (t) => {
  const v1 = family("opencode"), mimo = family("mimocode"), v2 = family("opencode",true);
  const senders = [
    ["CJS", body => new Promise(resolve => config.postStateToRunningServer(body,{runtimePort:config.readRuntimePort({runtimeConfigPath:runtimePath}),sshSecure:false},resolve))],
    ["OpenCode v1",body => v1.__test.postStateToClawd(body)],
    ["MiMo",body => mimo.__test.postStateToClawd(body)],
    ["OpenCode v2",body => v2.__test.postStateToClawdV2(body)],
    ["OpenClaw",body => openclaw.postStateToClawd(body)],
    ["DSH",body => dsh.postState(body)],
    ["Pi",body => extensions[0].postState(body)],
    ["OMP",body => extensions[1].postState(body)],
  ];
  for (const [name,send] of senders) {
    const old = await listener(), next = await listener();
    t.after(() => old.close()); t.after(() => next.close());
    runtime(old.port);
    const body = {agent_id:"opencode",session_id:`test-${name}`,state:"working",event:"PreToolUse"};
    await send(body); await until(() => old.requests.some(r=>r.method==="POST"));
    // Successful cached calls must survive a temporarily missing runtime file.
    if (["OpenCode v1","MiMo","OpenCode v2","OpenClaw"].includes(name)) {
      fs.unlinkSync(runtimePath);
      await send({...body,event:"PostToolUse"});
      await until(() => old.requests.filter(r=>r.method==="POST").length===2);
    }
    runtime(next.port);
    await old.close();
    await send({...body,event:"PostToolUseFailure",state:"error"});
    await until(() => next.requests.some(r=>r.method==="POST"));
    assert.equal(next.requests.filter(r=>r.method==="POST").length,1,name);
    await next.close();
  }
});

test("OpenCode v1/v2 strict permission targets accept dynamic live-owner runtime", async (t) => {
  const target = await listener(); t.after(()=>target.close()); runtime(target.port);
  const body = {agent_id:"opencode",session_id:"test-permission",request_id:"request-1",tool_name:"shell"};
  assert.equal(await family("opencode").__test.postPermissionToClawd(body),true);
  const v2 = family("opencode",true);
  assert.equal((await v2.__test.deliverV2BlockingPermission({body,payload:JSON.stringify(body),reqId:1})).decision,"allow", JSON.stringify({port:target.port,discovered:v2.__test.readPermissionRuntimePort(),requests:target.requests}));
  runtime(target.port,{ownerPid:0});
  assert.equal((await v2.__test.deliverV2BlockingPermission({body,payload:JSON.stringify(body),reqId:2})).decision,null);
  assert.equal(target.requests.length,2,"invalid identity must never probe or send");
});

test("Hermes shares parsed-value semantics and rediscovers before its first state or approval", () => {
  const python = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(python,["-"],{cwd:root,encoding:"utf8",env:process.env,input:String.raw`
import importlib.util, json, os, pathlib, tempfile
from urllib.parse import urlparse
assert pathlib.Path.home() == pathlib.Path(os.environ["HOME"])
spec = importlib.util.spec_from_file_location("clawd_test", "hooks/hermes-plugin/__init__.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
runtime = pathlib.Path.home()/".clawd"/"runtime.json"
assert m._runtime_path() == runtime
for case in json.loads(pathlib.Path("test/fixtures/local-port-values.json").read_text(encoding="utf-8")):
    runtime.write_text(json.dumps({"app":"clawd-on-desk","port":case["value"]}))
    assert m._read_runtime_port() == case["port"], case
runtime.write_text(json.dumps({"app":"clawd-on-desk","port":45002}))
calls=[]
class Response:
    headers={"x-clawd-server":"clawd-on-desk"}
    status=200
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def read(self): return b'{"decision":"allow"}'
def request(req,timeout):
    port=urlparse(req.full_url).port
    calls.append((port, req.get_method()))
    if port != 45002: raise OSError("stale cache")
    return Response()
m._local_urlopen=request
m._cached_port=45001
m._no_server_until=0
m._post_state({"agent_id":"hermes","state":"working"})
assert calls == [(45001,"POST"),(45002,"POST")], calls
calls.clear()
m._cached_port=45001
assert m._post_permission("read_file",{},"test",platform="webui") == {"decision":"allow"}
assert calls == [(45001,"GET"),(45002,"GET"),(45002,"POST")], calls
# A cached success must not access runtime.
m._read_runtime_port=lambda: (_ for _ in ()).throw(AssertionError("unexpected runtime read"))
m._post_state({"state":"working"})
print("Hermes numeric/state/permission/cache checks passed")
`});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

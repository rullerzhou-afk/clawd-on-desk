"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('events'),{PassThrough}=require('stream'),vm=require('vm'),fs=require('fs'),path=require('path');
const {validateCommand,QQMusicController}=require('./qqmusic-controller');
function worker(){const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.stdin=new PassThrough();process.kill=()=>process.emit('exit',0);return process;}
test('Only media actions and finite per-app volume values can reach the worker',()=>{
  for(const action of ['shell','powershell','quit','rm','open'])assert.throws(()=>validateCommand(action),/不支持/);
  for(const value of [-1,101,NaN,Infinity,'45',null])assert.throws(()=>validateCommand('set-volume',value),/音量/);
  assert.deepEqual(validateCommand('set-volume',42),{action:'set-volume',value:42});
  assert.deepEqual(validateCommand('next','arbitrary input'),{action:'next'});
  for(const value of [-1,86401,NaN,Infinity,'12',null])assert.throws(()=>validateCommand('seek',value),/进度/);
  assert.deepEqual(validateCommand('seek',12.5),{action:'seek',value:12.5});
});
test('Worker responses correlate by ID; app failures are not reported as successful controls',async()=>{
  const fake=worker(),controller=new QQMusicController({helperPath:'worker.ps1',spawnProcess:()=>fake});
  const writes=[];fake.stdin.on('data',line=>writes.push(JSON.parse(line)));
  const first=controller.request('status'),second=controller.request('next');
  fake.stdout.write(JSON.stringify({id:writes[1].id,ok:false,error:'QQ rejected next'})+'\n');
  fake.stdout.write(JSON.stringify({id:writes[0].id,ok:true,state:{connected:true,volume:38}})+'\n');
  assert.equal((await first).volume,38);await assert.rejects(second,/QQ rejected/);controller.stop();
});
test('Timeout reaps the worker and does not retry a potentially completed skip',async()=>{
  const fake=worker();let spawned=0,written=0;
  fake.stdin.on('data',()=>written++);
  const controller=new QQMusicController({helperPath:'worker.ps1',spawnProcess:()=>{spawned++;return fake},timeoutMs:10});
  await assert.rejects(controller.request('next'),/超时/);assert.equal(written,1);assert.equal(spawned,1);assert.equal(controller.worker,null);
});
test('Music panel IPC rejects other windows and the pet shortcut accepts only its local hit renderer',async()=>{
  const handlers={},listeners={},opened=[],captured=[];
  const contents={setWindowOpenHandler(){},on(){},send(){}};
  class Window {constructor(options){captured.push(options);this.webContents=contents;this.destroyed=false;}isDestroyed(){return false}setMenu(){}on(){}once(){}loadFile(file){opened.push(file)}show(){}focus(){}close(){}}
  const electron={app:{getPath:()=>__dirname,on(){},whenReady:()=>Promise.resolve()},BrowserWindow:Window,
    ipcMain:{handle:(n,f)=>handlers[n]=f,on:(n,f)=>listeners[n]=f},screen:{getCursorScreenPoint:()=>({x:1,y:1}),getDisplayNearestPoint:()=>({workArea:{x:0,y:0,width:1200,height:800}})},shell:{openPath:async()=>''}};
  const fakeFs={...fs,statSync:()=>({isFile:()=>true})};
  const context={module:{exports:{}},require:name=>name==='fs'?fakeFs:name==='electron'?electron:name==='./qqmusic-controller'?{QQMusicController:class{stop(){}}}:name.endsWith('location.json')?{executable:'QQMusic.exe'}:name.endsWith('desktop-lyrics.cjs')?()=>({request:async()=>({visible:false})}):name.endsWith('library-main.cjs')?()=>({request:async()=>({})}):require(name),
    __dirname,process:{platform:'win32',resourcesPath:path.resolve(__dirname,'../resources'),argv:[]}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'qqmusic-main.js'),'utf8'),context);
  const control=context.module.exports({},{executable:process.execPath.replace(/node\.exe$/i,'QQMusic.exe').replaceAll('\\','/')});
  assert.equal((await handlers['qqmusic-command']({sender:{}},{action:'next'})).ok,false);
  listeners['qqmusic-open']({sender:{getURL:()=> 'https://example.com/hit.html'}});assert.equal(opened.length,0);
  control.show();assert.equal(opened.length,1);assert.equal(captured[0].webPreferences.nodeIntegration,false);assert.equal(captured[0].webPreferences.contextIsolation,true);assert.equal(captured[0].webPreferences.sandbox,true);
  assert.equal(captured[0].resizable,true);assert.equal(captured[0].maximizable,true);
  assert.equal((await handlers['qqmusic-command']({sender:{}},{action:'next'})).ok,false);
  assert.equal((await handlers['qqmusic-command']({sender:{}},{action:'set-lyrics',value:true})).ok,false);
});

test('Lyrics requires an explicit boolean and preserves failures without claiming a state change',async()=>{
  const calls=[],create=require('./desktop-lyrics.cjs');
  const lyrics=create({helperRoot:'known',execFile:(file,args,options,callback)=>{calls.push({file,args,options});callback(null,JSON.stringify({ok:false,error:'QQ music did not confirm'}))}});
  for(const value of [null,0,1,'true',{},undefined])await assert.rejects(lyrics.request('set-lyrics',value),/显示或隐藏/);
  await assert.rejects(lyrics.request('shell',true),/不支持/);assert.equal(calls.length,0);
  await assert.rejects(lyrics.request('set-lyrics',true),/did not confirm/);assert.deepEqual(calls[0].args,['show']);assert.equal(calls[0].options.windowsHide,true);
});

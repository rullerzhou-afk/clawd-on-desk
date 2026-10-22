"use strict";
const {app,BrowserWindow,ipcMain,screen,shell}=require('electron'),path=require('path'),fs=require('fs'),cp=require('child_process');
module.exports=function initGateway(ctx, config={}){
  let panel=null,busy=false;const worker=path.join(__dirname,'gateway-worker.ps1');
  const powershell=config.powershell||'powershell.exe';
  function command(action){
    if(!config.gatewayExecutable||!path.isAbsolute(config.gatewayExecutable))return Promise.resolve({ok:false,error:'Configure an absolute wb2api.exe path'});
    if(!['status','start','stop'].includes(action))return Promise.resolve({ok:false,error:'无效操作'});
    return new Promise(resolve=>cp.execFile(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',worker,'-Action',action,'-GatewayExecutable',config.gatewayExecutable,'-HealthPort',String(config.gatewayPort||7863)],{windowsHide:true,timeout:20000,maxBuffer:65536,encoding:'utf8'},(error,stdout)=>{
      try{const result=JSON.parse(stdout.trim());if(action!=='status')fs.appendFileSync(path.join(app.getPath('userData'),'custom-gateway.log'),JSON.stringify({time:new Date().toISOString(),action,ok:result.ok,running:result.state?.running})+'\n');resolve(result)}catch{resolve({ok:false,error:error?.message||'网关状态读取失败'})}
    }));
  }
  function show(){
    if(panel&&!panel.isDestroyed()){panel.show();panel.focus();return}
    const pet=ctx.win?.getBounds(),point=pet?{x:pet.x,y:pet.y}:screen.getCursorScreenPoint(),area=screen.getDisplayNearestPoint(point).workArea,width=400,height=295;
    panel=new BrowserWindow({width,height,x:Math.max(area.x,Math.min(point.x,area.x+area.width-width)),y:Math.max(area.y,Math.min(point.y-height-10,area.y+area.height-height)),show:false,resizable:false,alwaysOnTop:true,title:'喵云网关 · 桌宠开关',backgroundColor:'#f7f8f3',webPreferences:{preload:path.join(__dirname,'gateway-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    panel.setMenu(null);panel.webContents.setWindowOpenHandler(()=>({action:'deny'}));panel.webContents.on('will-navigate',event=>event.preventDefault());panel.once('ready-to-show',()=>panel?.show());panel.on('closed',()=>{panel=null});panel.loadFile(path.join(__dirname,'gateway.html'));
  }
  ipcMain.handle('custom-gateway-action',async(event,action)=>{
    if(!panel||panel.isDestroyed()||event.sender!==panel.webContents)return {ok:false,error:'无效窗口'};
    if(action==='open'){const status=await command('status');if(!status.ok||!status.state.running)return {ok:false,error:'请先启动喵云网关'};await shell.openExternal(status.state.panelUrl);return status}
    if(busy&&action!=='status')return {ok:false,error:'正在处理上一个操作'};
    if(action!=='status')busy=true;try{return await command(action)}finally{if(action!=='status')busy=false}
  });
  if(process.argv.includes('--gateway-panel'))app.whenReady().then(show);
  return {show,menuItems:()=>[{label:'喵云网关',submenu:[{label:'打开网关开关',click:show},{label:'启动网关',click:()=>{show();command('start').then(result=>panel?.webContents.send('custom-gateway-state',result))}},{label:'停止网关',click:()=>{show();command('stop').then(result=>panel?.webContents.send('custom-gateway-state',result))}}]}]};
};

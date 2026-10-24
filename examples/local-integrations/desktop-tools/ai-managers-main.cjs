"use strict";
const {app,dialog,shell}=require('electron');
const path=require('path'),fs=require('fs'),cp=require('child_process');
const definitions=Object.freeze({
  cockpit:{name:'Cockpit Tools',executable:''},
  ccswitch:{name:'CC Switch',executable:''},
});
let instance;
module.exports=function initAIManagers(config={}){
  const configured=Object.fromEntries(Object.entries(definitions).map(([id,tool])=>[id,{...tool,executable:config.apps?.[id]||''}]));
  if(instance)return instance;
  let statusOpen=false,pendingStatus=null;const opening=new Set();
  const log=(event,details={})=>{try{fs.appendFileSync(path.join(app.getPath('userData'),'custom-tools.log'),JSON.stringify({time:new Date().toISOString(),event,...details})+'\n')}catch{}};
  log('module-loaded',{pid:process.pid});
  function status(){
    if(pendingStatus)return pendingStatus;
    pendingStatus=new Promise(resolve=>cp.execFile(config.powershell||'powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(__dirname,'ai-managers-worker.ps1'),'-CockpitExecutable',configured.cockpit.executable,'-CCSwitchExecutable',configured.ccswitch.executable],
      {windowsHide:true,timeout:12000,maxBuffer:16384,encoding:'utf8'},(error,stdout)=>{
        try{const result=JSON.parse(stdout.trim());if(result.ok!==true||!Array.isArray(result.tools)||result.tools.length!==2)throw Error('Invalid status');resolve(result)}
        catch{resolve({ok:false,error:error?'运行状态暂时读取失败，请刷新重试':'软件状态格式不正确，请刷新重试'})}
      })).finally(()=>{pendingStatus=null});
    return pendingStatus;
  }
  async function open(id){
    const tool=Object.hasOwn(configured,id)?configured[id]:null;if(!tool)return {ok:false,error:'未找到这个工具'};
    if(opening.has(id))return {ok:false,error:'软件正在打开，请稍候'};
    if(!fs.existsSync(tool.executable))return {ok:false,error:'找不到 '+tool.name+'，请检查安装位置'};
    opening.add(id);
    try{const error=await shell.openPath(tool.executable);if(error)return {ok:false,error:'打开 '+tool.name+' 失败：'+error};
      return {ok:true,message:'已请求打开 '+tool.name};
    }catch{return {ok:false,error:'打开 '+tool.name+' 失败，请重试'}}finally{opening.delete(id)}
  }
  async function show(){
    if(statusOpen)return;statusOpen=true;
    try{let again=true;while(again){
      const result=await status();if(!result.ok){await dialog.showMessageBox({type:'warning',title:'AI 工具运行状态',message:result.error,buttons:['知道了']});return}
      const lines=result.tools.map(tool=>tool.name+'：'+(!tool.installed?'未找到安装程序':tool.running?'运行中':'未启动'));
      log('status-presented',{tools:result.tools.map(({id,running,installed})=>({id,running,installed}))});
      const choice=await dialog.showMessageBox({type:'info',title:'AI 工具运行状态',message:lines.join('\n'),detail:'可直接打开原管理界面，或刷新运行状态。',buttons:['打开 Cockpit Tools','打开 CC Switch','刷新状态','关闭'],defaultId:3,cancelId:3,noLink:true});
      again=choice.response===2;
      if(choice.response===0||choice.response===1)await openFromMenu(choice.response===0?'cockpit':'ccswitch');
    }}finally{statusOpen=false}
  }
  async function openFromMenu(id){
    const result=await open(id);if(!result.ok)await dialog.showMessageBox({type:'error',title:'打开软件',message:result.error,buttons:['知道了']});
  }
  const showSafely=()=>show().catch(error=>log('status-error',{message:error.message}));
  app.on('second-instance',(_event,argv)=>{log('second-instance',{panelRequested:argv.includes('--ai-tools-panel')});if(argv.includes('--ai-tools-panel'))showSafely()});
  if(process.argv.includes('--ai-tools-panel'))app.whenReady().then(showSafely);
  instance={show:showSafely,menuItems:()=>Object.entries(configured).map(([id,tool])=>({label:tool.name,submenu:[{label:'打开 '+tool.name,click:()=>openFromMenu(id)},{label:'查看运行状态',click:showSafely}]}))};
  return instance;
};

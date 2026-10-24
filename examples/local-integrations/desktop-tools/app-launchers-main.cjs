"use strict";
const fs=require('fs'),path=require('path'),os=require('os');
const {app,dialog,shell}=require('electron');
const definitions=Object.freeze([
  {id:'qqmusic',name:'QQ音乐',executable:''},
  {id:'notion',name:'Notion',executable:''},
  {id:'doubao',name:'豆包',executable:''},
  {id:'codex',name:'Codex'},
  {id:'workbuddy',name:'WorkBuddy',executable:''},
]);
function executableFor(tool){
  if(tool.executable)return fs.existsSync(tool.executable)?tool.executable:null;
  if(tool.id!=='codex')return null;
  // The desktop installer puts each release in a separate bin directory.
  // Resolve on every click so an update can retire the old executable.
  const root=path.join(os.homedir(),'AppData/Local/OpenAI/Codex/bin');
  try{return fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory())
    .map(entry=>path.join(root,entry.name,'codex.exe'))
    .flatMap(file=>{try{const stat=fs.statSync(file);return stat.isFile()?[{file,modified:stat.mtimeMs}]:[]}catch{return []}})
    .sort((a,b)=>b.modified-a.modified)[0]?.file||null;
  }catch{return null}
}
let instance;
module.exports=function initAppLaunchers(config={}){
  const configured=definitions.map(tool=>({...tool,executable:config.apps?.[tool.id]||tool.executable}));
  if(instance)return instance;
  const opening=new Set();
  const log=(event,details={})=>{try{fs.appendFileSync(path.join(app.getPath('userData'),'custom-tools.log'),JSON.stringify({time:new Date().toISOString(),event,...details})+'\n')}catch{}};
  async function open(id){
    const tool=configured.find(item=>item.id===id);if(!tool||opening.has(id))return;
    opening.add(id);
    try{
      const target=executableFor(tool);if(!target)throw Error('找不到 '+tool.name+'，请检查是否已安装。');
      const error=await shell.openPath(target);if(error)throw Error('打开 '+tool.name+' 失败：'+error);
      log('shortcut-opened',{id});
    }catch(error){log('shortcut-error',{id,message:error.message});await dialog.showMessageBox({type:'error',title:'打开软件',message:error.message,buttons:['知道了']});
    }finally{opening.delete(id)}
  }
  log('shortcuts-loaded',{apps:configured.map(tool=>({id:tool.id,installed:!!executableFor(tool)}))});
  instance={menuItems:()=>[{label:'打开软件',submenu:configured.map(tool=>({label:tool.name,click:()=>{void open(tool.id)}}))}]};
  return instance;
};

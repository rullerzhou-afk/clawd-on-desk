"use strict";
const {app,BrowserWindow,ipcMain,screen,shell,dialog,net}=require('electron');
const path=require('path'),{pathToFileURL}=require('url');
const fs=require('fs');
const {QQMusicController}=require('./qqmusic-controller');
module.exports=function initQQMusic(ctx, options={}){
  if(process.platform!=='win32')return {menuItems:()=>[]};
  const helperRoot=__dirname;
  const nativeRoot=options.nativeRoot||path.join(helperRoot,'.native');
  const helperPath=path.join(helperRoot,'qqmusic-worker.ps1');
  const controller=new QQMusicController({helperPath});
  const location={executable:options.executable||process.env.CLAWD_QQMUSIC_EXECUTABLE};
  if(!location.executable||!path.isAbsolute(location.executable)||path.basename(location.executable).toLowerCase()!=='qqmusic.exe'||!fs.statSync(location.executable).isFile())throw Error('Configure an absolute QQMusic.exe path before enabling this example');
  location.executable=path.resolve(location.executable);
  const lyrics=require(path.join(helperRoot,'desktop-lyrics.cjs'))({helperRoot:nativeRoot,executable:location.executable});
  const library=require(path.join(helperRoot,'library-main.cjs'))({helperRoot:nativeRoot,executable:location.executable,readState:()=>controller.request('status'),storageRoot:path.join(app.getPath('userData'),'qqmusic'),requestJson:async body=>{
    const response=await net.fetch('https://u.y.qq.com/cgi-bin/musicu.fcg',{method:'POST',headers:{'Content-Type':'application/json','Referer':'https://y.qq.com/','User-Agent':'Mozilla/5.0'},body:JSON.stringify(body),credentials:'omit',signal:AbortSignal.timeout(18000)});
    if(!response.ok)throw Error('QQ 音乐歌单服务暂时无法连接');return response.json();
  }});
  const libraryActions=new Set(['library-list','playlist-tracks','playlist-play','queue-status','queue-play','mode-status','set-mode']);
  let panel=null,connectionLogged=false,lastMediaState=null;
  const boundsFile=path.join(app.getPath('userData'),'qqmusic-panel-window.json');
  let savedSize={};try{savedSize=JSON.parse(fs.readFileSync(boundsFile,'utf8'))}catch{}
  const log=(event,details={})=>{try{fs.appendFileSync(path.join(app.getPath('userData'),'qqmusic-control.log'),JSON.stringify({time:new Date().toISOString(),event,...details})+'\n')}catch{}};
  async function command(action,value){
    try{
      if(action==='open'){
        const error=await shell.openPath(location.executable);if(error)throw Error(error);
        return {ok:true,state:null};
      }
      if(action==='lyrics-status'||action==='set-lyrics'){
        const lyricState=await lyrics.request(action,value);
        if(action==='set-lyrics')log('lyrics-completed',{visible:lyricState.visible});
        return {ok:true,lyrics:lyricState};
      }
      if(libraryActions.has(action)){const result=await library.request(action,value);if(action==='playlist-play'||action==='queue-play'||action==='set-mode')log('library-dispatched',{action,count:result.queue?.items?.length,confirmed:result.playbackConfirmed,mode:result.mode});return {ok:true,library:result};}
      const state=action==='seek'?await library.seek(value,lastMediaState):await library.enrichState(await controller.request(action,value));
      lastMediaState=state;
      if(action!=='status')log('command-completed',{action});
      if(!connectionLogged){log('session-status',{connected:state.connected,volumeAvailable:state.volumeAvailable});connectionLogged=true;}
      return {ok:true,state};
    }catch(error){log('command-error',{action,message:error.message});return {ok:false,error:error.message};}
  }
  function show(view){
    if(panel&&!panel.isDestroyed()){panel.show();panel.focus();if(typeof view==='string')panel.webContents.send('qqmusic-view',view);return;}
    const pet=ctx.win&&!ctx.win.isDestroyed()?ctx.win.getBounds():null;
    const work=screen.getDisplayNearestPoint(pet?{x:pet.x,y:pet.y}:screen.getCursorScreenPoint()).workArea;
    const width=Math.min(work.width,Math.max(320,Number.isFinite(savedSize.width)?savedSize.width:400));
    const height=Math.min(work.height-24,Math.max(380,Number.isFinite(savedSize.height)?savedSize.height:650));
    const x=Math.max(work.x,Math.min(work.x+work.width-width,pet?pet.x+pet.width-width:work.x+work.width-width-24));
    const y=Math.max(work.y,Math.min(work.y+work.height-height,pet?(pet.y>=height+work.y?pet.y-height-10:pet.y+pet.height+10):work.y+work.height-height-24));
    panel=new BrowserWindow({width,height,x,y,minWidth:320,minHeight:380,show:false,frame:false,resizable:true,maximizable:true,skipTaskbar:true,alwaysOnTop:true,
      title:'QQ 音乐 · 桌宠控制',backgroundColor:'#f7f8f3',webPreferences:{preload:path.join(__dirname,'preload-qqmusic.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    panel.setMenu(null);panel.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    panel.webContents.on('will-navigate',event=>event.preventDefault());
    panel.webContents.on('did-finish-load',()=>{log('panel-loaded');if(typeof view==='string')panel.webContents.send('qqmusic-view',view)});
    panel.webContents.on('preload-error',(_event,_file,error)=>log('preload-error',{message:error.message}));
    panel.webContents.on('did-fail-load',(_event,code,description)=>log('panel-load-error',{code,description}));
    let resizeTimer=null;
    panel.on('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(panel&&!panel.isDestroyed()){const bounds=panel.getBounds();savedSize={width:bounds.width,height:bounds.height};try{fs.writeFileSync(boundsFile,JSON.stringify(savedSize))}catch{}}},200)});
    panel.on('closed',()=>{clearTimeout(resizeTimer);panel=null;controller.stop()});
    panel.once('ready-to-show',()=>{if(panel&&!panel.isDestroyed())panel.show()});
    panel.loadFile(path.join(__dirname,'qqmusic.html'));
  }
  ipcMain.handle('qqmusic-command',(event,payload)=>{
    if(!panel||panel.isDestroyed()||event.sender!==panel.webContents)return {ok:false,error:'无效的音乐控制窗口'};
    return command(payload?.action,payload?.value);
  });
  ipcMain.on('qqmusic-close',event=>{if(panel&&event.sender===panel.webContents)panel.close()});
  ipcMain.on('qqmusic-open',event=>{
    const allowed=pathToFileURL(path.resolve(__dirname,'../../../src/hit.html')).href;
    if(event.sender.getURL().split(/[?#]/)[0]===allowed)show();
  });
  app.on('will-quit',()=>controller.stop());
  async function quick(action,value){
    const result=await command(action,value);
    if(panel&&!panel.isDestroyed())panel.webContents.send('qqmusic-result',result);
    else if(!result.ok)await dialog.showMessageBox({type:'warning',title:'QQ 音乐',message:result.error,buttons:['知道了']});
  }
  if(process.argv.includes('--qqmusic-panel'))app.whenReady().then(show);
  async function setLyrics(visible){
    const result=await command('set-lyrics',visible);
    if(!result.ok)await dialog.showMessageBox({type:'warning',title:'QQ音乐桌面歌词',message:result.error,buttons:['知道了']});
    if(panel&&!panel.isDestroyed())panel.webContents.send('qqmusic-result',result);
  }
  return {show,menuItems:()=>[{
    label:'QQ 音乐',submenu:[
      {label:'打开音乐控制面板   打开控制面板',click:()=>show()},
      {label:'播放队列',click:()=>show('queue')},
      {label:'我的歌单',click:()=>show('playlists')},
      {label:'播放模式',submenu:[['shuffle','随机播放'],['sequence','顺序播放'],['single','单曲循环'],['repeat','列表循环']].map(([value,label])=>({label,click:()=>quick('set-mode',value)}))},
      {label:'桌面歌词',submenu:[{label:'显示桌面歌词',click:()=>setLyrics(true)},{label:'隐藏桌面歌词',click:()=>setLyrics(false)}]},
      {type:'separator'},
      {label:'上一首',click:()=>quick('previous')},
      {label:'播放 / 暂停',click:()=>quick('toggle')},
      {label:'下一首',click:()=>quick('next')},
      {type:'separator'},
      {label:'QQ 音乐音量 +5%',click:()=>quick('volume-up')},
      {label:'QQ 音乐音量 −5%',click:()=>quick('volume-down')},
      {label:'静音 / 取消静音',click:()=>quick('mute')},
    ],
  }]};
};

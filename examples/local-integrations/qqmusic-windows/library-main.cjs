'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFile}=require('child_process');
const {LibraryCatalog,identifier}=require('./library-catalog.cjs');
const {createPlayer}=require('./library-player.cjs');
const MODES={sequence:{label:'顺序播放',value:2},single:{label:'单曲循环',value:1},repeat:{label:'列表循环',value:3},shuffle:{label:'随机播放',value:4}};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function run(file,args,timeout=9000,executable){file=path.resolve(file);return new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,env:{...process.env,CLAWD_QQMUSIC_EXECUTABLE:executable},encoding:'utf8',timeout,maxBuffer:3*1024*1024,cwd:path.dirname(file)},(error,stdout)=>error?reject(Error('QQ 音乐响应超时，请稍后重试')):resolve(stdout)));}
function parseSnapshot(data){
  const root=(data.windows||[]).find(w=>(w.rows||[]).some(r=>r.name==='播放队列'&&r.type==='ControlType.Button'));
  const rows=root?.rows||[];
  const account=rows.find(r=>r.type==='ControlType.Text'&&/^115292[0-9]{12,14}$/.test(r.name))?.name||null;
  const entry=Object.entries(MODES).find(([,m])=>rows.some(r=>r.type==='ControlType.Button'&&r.name===m.label));
  return {account,mode:entry?.[0]||null};
}
function parseTimeline(data){
  const root=(data.windows||[]).find(w=>(w.rows||[]).some(r=>r.name==='播放队列'&&r.type==='ControlType.Button'));
  const times=(root?.rows||[]).filter(r=>r.type==='ControlType.Text'&&/^\d{1,2}:\d{2}(:\d{2})?$/.test(r.name.trim())).map(r=>r.name.trim().split(':').reduce((n,v)=>n*60+Number(v),0));
  if(times.length!==2||times[1]<=0||times[0]>times[1])return null;
  return {position:times[0],duration:times[1],minimized:root.minimized===true};
}
function parseNativeQueue(data){
  const root=(data.windows||[]).find(w=>w.title==='播放队列'&&Array.isArray(w.items));
  const total=Number(/^共(\d+)首歌曲$/.exec(root?.countText||'')?.[1]);
  if(!root||!Number.isSafeInteger(total)||total<0||total>15000)return null;
  const items=root.items.filter(v=>typeof v.title==='string'&&v.title&&typeof v.artist==='string');
  if(items.every(v=>Number.isFinite(v.orderY))&&new Set(items.map(v=>v.orderY)).size===items.length)items.sort((a,b)=>a.orderY-b.orderY);
  return {total,items:items.map(({title,artist})=>({title,artist})),complete:items.length===total,fresh:root.visible===true,updatedAt:new Date().toISOString()};
}
module.exports=function createLibrary({helperRoot,storageRoot,executable,requestJson,readState,runCommand=run,playerFactory=createPlayer}){
  const configFile=path.join(storageRoot,'qqmusic-library.json'),queueFile=path.join(storageRoot,'qqmusic-queue.json');
  let config={};try{config=JSON.parse(fs.readFileSync(configFile,'utf8'))}catch{}
  let catalog=null,currentAccount=null,queue=null,snapshot=null,snapshotTime=0,changingMode=false,snapshotTask=null,lastTimeline=null,lastNativeQueue=null,observedQueue=null,seekRevision=0,seekIntent=null;
  try{queue=JSON.parse(fs.readFileSync(queueFile,'utf8'));if(!Array.isArray(queue.items)||queue.items.length>15000)queue=null;}catch{}
  const player=playerFactory({executable,storageRoot,helperPath:path.join(helperRoot,'library-native.exe')});
  function save(file,data){fs.mkdirSync(storageRoot,{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data));fs.renameSync(tmp,file);}
  async function native(force=false){
    if(snapshotTask)return snapshotTask;
    if(!force&&snapshot&&Date.now()-snapshotTime<1500)return snapshot;
    snapshotTask=(async()=>{
    const raw=JSON.parse(await runCommand(path.join(helperRoot,'library-native.exe'),['snapshot'],9000,executable));
    snapshot={...parseSnapshot(raw),timeline:parseTimeline(raw),nativeQueue:parseNativeQueue(raw)};snapshotTime=Date.now();
    if(snapshot.nativeQueue?.fresh)observedQueue={...snapshot.nativeQueue,observedAt:Date.now()};
    if(snapshot.account&&snapshot.account!==config.account){config={...config,account:snapshot.account};save(configFile,config);catalog=null;queue=null;observedQueue=null;try{fs.unlinkSync(queueFile)}catch{}}
    return snapshot;
    })();try{return await snapshotTask;}finally{snapshotTask=null;}
  }
  async function getCatalog(){
    try{await native()}catch{}
    if(!config.account)throw Error('请先在 QQ 音乐登录并展开主窗口，然后刷新歌单');
    const account=identifier(config.account);
    if(!catalog||currentAccount!==account){catalog=new LibraryCatalog({request:requestJson,account});currentAccount=account;}
    return catalog;
  }
  function queueState(){
    const observed=observedQueue?{...observedQueue,fresh:snapshot?.nativeQueue?.fresh===true}:null;
    const nativeQueue=observed||(snapshot?.nativeQueue&&(snapshot.nativeQueue.fresh||!queue)?snapshot.nativeQueue:null);
    if(nativeQueue){
      const current=nativeQueue;
      const items=current.items.map(item=>{const known=(queue?.items||[]).filter(v=>v.title===item.title&&v.artist===item.artist);return known.length===1?{...known[0]}:{...item,readOnly:true};});
      const revision=crypto.createHash('sha256').update(JSON.stringify(items.map(v=>[v.title,v.artist]))).digest('hex').slice(0,16);
      lastNativeQueue={...current,id:'native',name:current.fresh?'QQ 音乐当前队列':'QQ 音乐队列（上次显示）',revision,items,source:'qqmusic-native',notice:!current.fresh?'原生队列窗口已隐藏，内容可能过期；请展开 QQ 音乐播放队列后刷新':current.complete?'已读取 QQ 音乐实际播放队列':'QQ 音乐当前仅开放部分队列：已读 '+items.length+' / '+current.total+' 首，展开队列后刷新可重新读取'};
      return lastNativeQueue;
    }
    return queue?{...queue,source:'desktop-playlist',notice:'显示从桌宠发送的完整播放列表；QQ 音乐内临时更改需展开原生队列后刷新'}:{items:[],name:'播放队列尚未初始化',source:'none',notice:'请在 QQ 音乐手动展开一次“播放队列”，然后点这里的刷新'};
  }
  async function enrichState(state){
    const intent=seekIntent;
    if(intent&&intent.title===state.title&&Date.now()<intent.until){
      const elapsed=state.playback==='Playing'?(Date.now()-intent.at)/1000:0;
      return {...state,position:Math.min(intent.duration,intent.position+elapsed),duration:intent.duration,canSeek:true,timelineSource:'estimated',seekRevision:intent.revision};
    }
    if(state.duration>0)return state;
    // UI Automation runs in the background. Media controls never await it.
    if(!snapshotTask&&Date.now()-snapshotTime>1000)void native().catch(()=>{});
    const info=snapshot?.timeline;
    if(info&&!info.minimized){
      const elapsed=state.playback==='Playing'?(Date.now()-snapshotTime)/1000:0;
      const position=Math.min(info.duration,info.position+elapsed);
      lastTimeline={...info,position,title:state.title,playback:state.playback,receivedAt:Date.now()};return {...state,...info,position,canSeek:true,timelineSource:'native',seekRevision};
    }
    if(lastTimeline&&lastTimeline.title===state.title){const now=Date.now(),elapsed=lastTimeline.playback==='Playing'?(now-lastTimeline.receivedAt)/1000:0;lastTimeline={...lastTimeline,position:Math.min(lastTimeline.duration,lastTimeline.position+elapsed),receivedAt:now,playback:state.playback};return {...state,position:lastTimeline.position,duration:lastTimeline.duration,canSeek:true,timelineSource:'estimated'};}
    const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');
    const candidates=(queue?.items||[]).filter(item=>item.seconds>0&&normalize(state.title).startsWith(normalize(item.title))&&normalize(state.artist).includes(normalize(item.artist)));
    if(candidates.length===1)return {...state,position:null,duration:candidates[0].seconds,canSeek:true,timelineSource:'metadata'};
    return {...state,timelineSource:'unavailable'};
  }
  async function play(list,index){
    if(!Number.isInteger(index)||index<0||index>=list.items.length)throw Error('请选择列表中的歌曲');
    let beforeTitle=null;try{beforeTitle=(await readState?.())?.title;}catch{}
    const dispatched=await player.play(list.items,index);
    observedQueue=null;
    queue={revision:Date.now().toString(36),id:list.id,name:list.name,items:dispatched.ordered,selectedId:list.items[index].id,updatedAt:new Date().toISOString()};save(queueFile,queue);
    try{await native(true);}catch{}
    if(readState){
      const normalized=text=>String(text||'').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');
      const title=normalized(list.items[index].title);
      for(let attempt=0;attempt<(list.items.length>1000?12:6);attempt++){
        try{const state=await readState();if(title&&normalized(state.title).startsWith(title)&&state.playback==='Playing')return {queue:queueState(),playbackConfirmed:true,notice:beforeTitle===state.title?'所选歌曲正在播放，歌单请求已发送':'已切换到所选歌曲'};}catch{}
        await wait(650);
      }
      return {queue:queueState(),playbackConfirmed:false,notice:'歌单已交给 QQ 音乐，但所选歌曲尚未开始播放，请查看 QQ 音乐中的版权或会员提示'};
    }
    return {queue:queueState(),notice:'播放请求已交给 QQ 音乐，正在同步当前歌曲'};
  }
  return {enrichState,async seek(value,cachedState){
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>86400)throw Error('播放进度必须是有效的秒数');
    const state=await enrichState(cachedState||await readState());
    if(!state.duration)throw Error('请展开 QQ 音乐主窗口，读取歌曲时长后再调整进度');
    if(value>state.duration)throw Error('播放进度超出当前歌曲范围');
    const revision=++seekRevision,at=Date.now();
    seekIntent={revision,position:value,duration:state.duration,title:state.title,at,until:at+2500};
    try{await runCommand(executable,['/silent','/seekto',String(value)]);}catch(error){if(seekIntent?.revision===revision)seekIntent=null;throw error;}
    if(revision!==seekRevision)return enrichState(cachedState||state);
    lastTimeline={position:value,duration:state.duration,title:state.title,playback:state.playback,receivedAt:Date.now()};
    return {...state,position:value,canSeek:true,timelineSource:'estimated',seekRevision:revision,seekDispatched:true};
  },async request(action,value){
    switch(action){
      case 'library-list':{const api=await getCatalog();return {playlists:await api.playlists(value===true)};}
      case 'playlist-tracks':{const api=await getCatalog();return {playlist:await api.playlist(identifier(typeof value==='object'?value?.id:value),value?.refresh===true)};}
      case 'playlist-play':{const api=await getCatalog();return play(await api.playlist(identifier(value?.id)),value?.index??0);}
      case 'queue-status':try{await native(true);}catch{}return {queue:queueState()};
      case 'queue-play':{
        const selected=lastNativeQueue?.revision===value?.revision?lastNativeQueue:queue?.revision===value?.revision?queue:null;
        if(!selected)throw Error('播放队列已变化，请刷新后重试');
        if(!Number.isInteger(value.index)||value.index<0||value.index>=selected.items.length)throw Error('请选择列表中的歌曲');
        const item=selected.items[value.index];
        if(!item.id||item.readOnly)throw Error('这首歌曲尚未对应到编号，请从“我的歌单”选择后播放');
        await player.select(item);
        observedQueue=null;seekIntent=null;lastTimeline=null;
        // Picking an existing track does not reload or rotate the entire list.
        queue={...selected,selectedId:item.id,updatedAt:new Date().toISOString()};save(queueFile,queue);
        return {queue:queueState(),playbackPending:true,selected:item,notice:'切歌请求已发送'};
      }
      case 'mode-status':return {mode:(await native(true)).mode,modes:MODES};
      case 'set-mode':{
        if(!Object.hasOwn(MODES,value))throw Error('不支持的播放模式');if(changingMode)throw Error('正在切换播放模式，请稍候');changingMode=true;
        try{
          await runCommand(executable,['/silent','/playmode',String(MODES[value].value)]);
          for(let i=0;i<5;i++){const state=await native(true);if(state.mode===value)return {mode:value,modes:MODES};await wait(200);}
          throw Error('尚未确认 QQ 音乐的播放模式，请刷新状态');
        }finally{changingMode=false;}
      }
      default:throw Error('不支持的歌单操作');
    }
  }};
};
module.exports.parseSnapshot=parseSnapshot;
module.exports.MODES=MODES;
module.exports.parseTimeline=parseTimeline;
module.exports.parseNativeQueue=parseNativeQueue;

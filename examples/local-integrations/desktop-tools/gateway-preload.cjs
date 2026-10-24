const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('gateway',{command:action=>ipcRenderer.invoke('custom-gateway-action',action),onState:callback=>ipcRenderer.on('custom-gateway-state',(_event,result)=>callback(result))});

const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('odradekWorkspace',Object.freeze({
 update:value=>ipcRenderer.send('odradek:workspace',value),
 subscribe:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('odradek:workspace-state',listener);return()=>ipcRenderer.removeListener('odradek:workspace-state',listener);},
 subscribeLearning:callback=>{const listener=(_event,visible)=>callback(visible!==false);ipcRenderer.on('odradek:learning-visibility',listener);return()=>ipcRenderer.removeListener('odradek:learning-visibility',listener);},
 beforeClose:(callback,onCancel=()=>{})=>{
  const listener=(_event,value)=>{if(typeof value?.id!=='string'||!value.id.trim()||value.id.length>100)return;Promise.resolve().then(callback).then(()=>ipcRenderer.send('odradek:learning-close-result',{id:value.id,ok:true}),error=>ipcRenderer.send('odradek:learning-close-result',{id:value.id,ok:false,error:String(error?.message??error).slice(0,500)}));};
  const cancelListener=()=>onCancel();ipcRenderer.on('odradek:prepare-learning-close',listener);ipcRenderer.on('odradek:learning-close-cancelled',cancelListener);ipcRenderer.send('odradek:learning-ready');return()=>{ipcRenderer.removeListener('odradek:prepare-learning-close',listener);ipcRenderer.removeListener('odradek:learning-close-cancelled',cancelListener);};
 }
}));

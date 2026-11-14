const catalog=require('../assets/theme/workspaces.json');
const nodePath=require('node:path');
const neonCSS=require('node:fs').readFileSync(nodePath.join(__dirname,'../assets/theme/neon.css'),'utf8');
const MODES=Object.freeze([...new Set([...catalog.tabs,...catalog.tools].map(item=>item.id))]);
const PREVIEW='http://127.0.0.1:5291/arm-manual/';
const STUDIO='http://127.0.0.1:8790/';
const BUTTONS=Object.freeze({manual:'manual-joints',automatic:'show-lab',sync:'show-live',camera:'show-live',safety:'show-live',presets:'tab-presets',map:'tab-map'});
function trustedFrame(event,contents,origin){
 if(event.sender!==contents||event.senderFrame!==contents.mainFrame)return false;
 try{return new URL(event.senderFrame.url).origin===origin;}catch{return false;}
}
function dockBounds(value,size){
 if(!value||!['x','y','width','height'].every(k=>Number.isFinite(value[k])))return null;
 const [width,height]=size,x=Math.max(0,Math.min(width,Math.round(value.x))),y=Math.max(0,Math.min(height,Math.round(value.y)));
 return{x,y,width:Math.max(0,Math.min(width-x,Math.round(value.width))),height:Math.max(0,Math.min(height-y,Math.round(value.height)))};
}
// These are presentation/navigation actions on the existing Studio. No hardware
// API or preview targets cross this bridge; Studio still owns every control.
function selectScript(mode){const id=BUTTONS[mode];if(!id)return null;return `document.documentElement.dataset.labView=${JSON.stringify(mode)};document.getElementById(${JSON.stringify(id)})?.click();` ;}
function frameStyleScript(mode){if(!MODES.includes(mode))return null;return `(()=>{let style=document.getElementById('odradek-neon-theme');if(!style){style=document.createElement('style');style.id='odradek-neon-theme';document.head.append(style);}style.textContent=${JSON.stringify(neonCSS)};document.documentElement.dataset.labView=${JSON.stringify(mode)};if(${JSON.stringify(mode)}==='safety'){const setup=document.querySelector('details.setup');if(setup)setup.open=true;}})();`;}
function isControlFrame(url){return ['http://127.0.0.1:8787/studio/manual/index.html','http://127.0.0.1:8787/studio/automatic/index.html'].includes(url);}
function rehearsalPose(value){
 const limits={base:[-180,180],shoulder:[0,180],elbow:[0,180],gripper:[61.9,179.92]};
 if(!value||!Object.entries(limits).every(([key,[min,max]])=>Number.isFinite(value[key])&&value[key]>=min&&value[key]<=max))return null;
 return Object.fromEntries(Object.keys(limits).map(key=>[key,value[key]]));
}
const studioCSS=`
body{background:#100b10!important}.masthead{padding:8px 12px!important;border-top:0!important;justify-content:flex-end!important}.masthead .brand,.tabs,.mode-intro,#panel-manual>.automatic-switch,#panel-automatic>.automatic-switch,.automatic-note,body>footer{display:none!important}
.connection-strip{padding:8px 12px!important;flex-wrap:wrap;letter-spacing:.5px!important}.strip-right{display:none!important}main{padding:0 12px!important}.repair-panel{margin:12px!important}
iframe{height:calc(100vh - 115px)!important;min-height:470px!important;border-radius:0!important}#motion-lab{padding-top:12px}.workflow{margin-top:14px}.live-panel{margin-top:12px}.trackpad-matrix{margin-top:12px}.lab-stage{display:none!important}
`;
class Workspace{
 constructor({window,WebContentsView,ipcMain,path,restartServices}){
  this.window=window;this.mode='preview';this.ready=false;this.bounds=null;this.revision=0;
  this.view=new WebContentsView({webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,preload:path.join(__dirname,'studio-preload.cjs')}});
  window.contentView.addChildView(this.view);this.view.setVisible(false);
  const wc=this.view.webContents;
  this.serviceState={busy:false,message:'Ready. Only app-owned services are restarted; external Controller services are left running.'};
  this.serviceStatus=()=>{if(!wc.isDestroyed())wc.send('odradek:service-state',this.serviceState);};
  wc.setWindowOpenHandler(()=>({action:'deny'}));
  wc.on('will-navigate',(event,url)=>{try{if(new URL(url).origin!==new URL(STUDIO).origin)event.preventDefault();}catch{event.preventDefault();}});
  wc.on('did-finish-load',async()=>{this.ready=false;try{await wc.insertCSS(neonCSS+'\n'+studioCSS);this.ready=true;await this.applyMode();this.serviceStatus();}catch(error){this.send({error:'Studio could not finish loading: '+error.message});}});
  wc.on('did-frame-finish-load',()=>{void this.decorateFrames();});
  wc.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3){this.ready=false;this.send({error:'Studio unavailable. Use Repair local services. '+description});}});
  wc.on('render-process-gone',()=>{this.ready=false;this.send({error:'Studio closed unexpectedly. Use Repair local services.'});});
  this.onRequest=(event,value)=>{
   if(!trustedFrame(event,window.webContents,new URL(PREVIEW).origin)||!MODES.includes(value?.mode))return;
  const zoom=window.webContents.getZoomFactor?.()??1;
   const scaled=value.bounds&&Object.fromEntries(['x','y','width','height'].map(k=>[k,value.bounds[k]*zoom]));
   const bounds=dockBounds(scaled,window.getContentSize());if(!bounds)return;
   this.bounds=bounds;this.view.setBounds(bounds);this.setMode(value.mode);
  };
  this.onStudio=(event,value)=>{
   if(!trustedFrame(event,wc,new URL(STUDIO).origin)||!MODES.includes(value)||value==='preview'||!this.ready||this.mode==='preview')return;
   if(['camera','safety'].includes(this.mode)&&value==='sync')return;
   this.mode=value;void this.decorateFrames();this.send({mode:value,ready:true});
  };
  this.onRehearsal=(event,value)=>{if(!this.ready||this.mode!=='automatic'||!trustedFrame(event,wc,new URL(STUDIO).origin))return;const pose=rehearsalPose(value);if(pose)this.send({rehearsal:pose});};
  this.onServiceRestart=async event=>{
   if(!trustedFrame(event,wc,new URL(STUDIO).origin)||this.mode!=='safety'||!this.ready||this.serviceState.busy||!restartServices)return;
   this.serviceState={busy:true,message:'Stopping app-owned services cleanly, then reopening them…'};this.serviceStatus();
   try{await restartServices();this.serviceState={busy:false,message:'Clean restart complete. Services are available. No movement was replayed.'};}
   catch(error){this.serviceState={busy:false,error:true,message:'Clean restart stopped: '+error.message};}
   this.serviceStatus();
  };
  ipcMain.on('odradek:workspace',this.onRequest);ipcMain.on('odradek:studio-tab',this.onStudio);ipcMain.on('odradek:rehearsal',this.onRehearsal);
  ipcMain.on('odradek:service-restart',this.onServiceRestart);
  window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)this.setMode('preview');});
  window.on('closed',()=>{ipcMain.removeListener('odradek:workspace',this.onRequest);ipcMain.removeListener('odradek:studio-tab',this.onStudio);ipcMain.removeListener('odradek:rehearsal',this.onRehearsal);ipcMain.removeListener('odradek:service-restart',this.onServiceRestart);if(!wc.isDestroyed())wc.close();});
 }
 send(value){if(!this.window.webContents.isDestroyed())this.window.webContents.send('odradek:workspace-state',value);}
 setMode(mode){
  const changed=this.mode!==mode;this.mode=mode;
  this.view.setVisible(mode!=='preview'&&Boolean(this.bounds?.width&&this.bounds?.height));
  if(mode==='preview'){this.send({mode,ready:this.ready});return;}
  if(!this.view.webContents.getURL())void this.view.webContents.loadURL(STUDIO+'#presets').catch(error=>this.send({error:error.message}));
  else if(changed&&this.ready)void this.applyMode();
 }
 async applyMode(){
  const code=selectScript(this.mode);if(!code||!this.ready)return;
  const revision=++this.revision;
  try{await this.view.webContents.executeJavaScript(code);await this.decorateFrames();if(revision===this.revision)this.send({mode:this.mode,ready:true});}
  catch(error){this.send({error:'Could not open Studio workspace: '+error.message});}
 }
 async decorateFrames(){
  const mode=this.mode,code=frameStyleScript(mode);if(!code||this.view.webContents.isDestroyed())return;
  const frames=this.view.webContents.mainFrame.framesInSubtree??[];
  const results=await Promise.allSettled(frames.filter(frame=>isControlFrame(frame.url)).map(frame=>frame.executeJavaScript(code)));
  if(results.some(result=>result.status==='rejected')&&mode===this.mode)this.send({error:'A control panel could not apply its theme. Reload this workspace.'});
 }
 navigate(mode){if(!MODES.includes(mode))return;this.send({mode});this.setMode(mode);}
 reload(){if(this.view.webContents.getURL())this.view.webContents.reload();}
}
module.exports={Workspace,MODES,dockBounds,trustedFrame,selectScript,rehearsalPose,frameStyleScript,isControlFrame};

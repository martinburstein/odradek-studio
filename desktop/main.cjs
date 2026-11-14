const {app,BrowserWindow,WebContentsView,ipcMain,Menu,dialog,shell}=require('electron');
const path=require('node:path');
const {Supervisor}=require('./supervisor.cjs');
const {Workspace}=require('./workspace.cjs');
const {createServiceRestart}=require('./service-restart.cjs');
const {createLearningSave}=require('./learning-save.cjs');
const allowed=new Set(['http://127.0.0.1:5291','http://127.0.0.1:5274','http://127.0.0.1:8787','http://127.0.0.1:8790']);
const offlineLearning=process.argv.includes('--learning');
const offlineLearningRoute='5291/arm-manual/?offline-learning=1'+(process.argv.includes('--iteration-ghosts')?'&iteration-ghosts=1':'');
let window,supervisor,workspace,learningSave,restartPending=null,quitting=false,quitPending=false,pendingLearning=false,learningReady=false,reloadPending=false;
function openLearning(){if(!window)return;workspace?.navigate('preview');window.webContents.send('odradek:learning-visibility',true);}
async function prepareLearning(){if(learningReady)await learningSave.prepare();}
function cancelLearningClose(){if(window&&!window.webContents.isDestroyed())window.webContents.send('odradek:learning-close-cancelled');}
async function reloadViewer(ignoreCache=false){
 if(reloadPending||restartPending||quitPending||quitting)return;reloadPending=true;
 try{await prepareLearning();if(restartPending||quitPending||quitting){reloadPending=false;return;}if(ignoreCache)window.webContents.reloadIgnoringCache();else window.webContents.reload();}
 catch(error){reloadPending=false;cancelLearningClose();dialog.showErrorBox('Reload stopped',error.message);}
}
app.setName('Odradek Studio');app.setAppUserModelId('com.odradek.studio');
app.setPath('userData',path.join(app.getPath('appData'),'odradek-studio'));
const locked=app.requestSingleInstanceLock();if(!locked)app.quit();
else{
 app.on('second-instance',(_event,argv=[])=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();if(argv.includes('--learning')){if(window.webContents.isLoadingMainFrame())pendingLearning=true;else openLearning();}}});
 app.whenReady().then(async()=>{
  const resources=app.isPackaged?process.resourcesPath:path.resolve(__dirname,'..');
  supervisor=new Supervisor({resources,dataRoot:path.join(app.getPath('userData'),'runtime'),packaged:app.isPackaged,version:app.getVersion(),offlineLearning});
  window=new BrowserWindow({title:'Odradek Studio',width:1280,height:900,minWidth:760,minHeight:650,backgroundColor:'#100b10',show:false,
   webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,preload:path.join(__dirname,'preload.cjs')}});
  let restartLocalServices;
  learningSave=createLearningSave({window,ipcMain});
  const onLearningReady=event=>{if(event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame.origin==='http://127.0.0.1:5291')learningReady=true;};
  ipcMain.on('odradek:learning-ready',onLearningReady);
  window.on('close',event=>{if(!quitting){event.preventDefault();app.quit();}});
  window.on('closed',()=>{learningSave.dispose();ipcMain.removeListener('odradek:learning-ready',onLearningReady);});
  workspace=offlineLearning?{mode:'preview',navigate(){},reload(){}}:new Workspace({window,WebContentsView,ipcMain,path,restartServices:()=>restartLocalServices()});
  window.webContents.on('did-finish-load',()=>{reloadPending=false;if(pendingLearning){pendingLearning=false;openLearning();}});
  window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)learningReady=false;});
  window.webContents.on('render-process-gone',()=>{learningReady=false;reloadPending=false;});
  window.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&typeof input.key==='string'&&(input.key==='F5'||((input.control||input.meta)&&input.key.toLowerCase()==='r'))){event.preventDefault();void reloadViewer(Boolean(input.shift));}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{try{if(!allowed.has(new URL(url).origin))event.preventDefault();}catch{event.preventDefault();}});
  window.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  window.on('page-title-updated',event=>{event.preventDefault();window.setTitle('Odradek Studio');});
  const load=route=>window.loadURL('http://127.0.0.1:'+route);
  const restartCore=createServiceRestart({supervisor,workspace,load,prepareRestart:prepareLearning,canRestart:()=>!quitPending&&!quitting,...(offlineLearning?{routeForMode:()=>offlineLearningRoute}:{})});
  restartLocalServices=async()=>{
   if(quitPending||quitting)throw Error('The app is closing.');
   if(restartPending)throw Error('A clean service restart is already running.');
   const operation=restartCore();restartPending=operation;
   try{await operation;}catch(error){if(!quitPending&&!quitting)cancelLearningClose();throw error;}finally{if(restartPending===operation)restartPending=null;}
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
   {label:'Application',submenu:[
    {label:'Stylus Learning · offline',click:openLearning},
    {label:'Automatic · Motion Lab',enabled:!offlineLearning,click:()=>workspace.navigate('automatic')},
    {label:'Manual',enabled:!offlineLearning,click:()=>workspace.navigate('manual')},
    {label:'Sync View',enabled:!offlineLearning,click:()=>workspace.navigate('sync')},
    {label:'Simulation',click:()=>{workspace.navigate('preview');window.webContents.send('odradek:learning-visibility',false);}},
    {label:'Live Camera',enabled:!offlineLearning,click:()=>workspace.navigate('camera')},
    {label:'Safety Check',enabled:!offlineLearning,click:()=>workspace.navigate('safety')},
    {type:'separator'},
    {label:offlineLearning?'Restart offline viewer':'Repair local services',click:async()=>{try{await restartLocalServices();}catch(error){if(!quitPending&&!quitting)dialog.showErrorBox('Repair stopped',error.message);}}},
    {label:'Open data folder',click:()=>shell.openPath(path.join(app.getPath('userData'),'runtime'))},
    {type:'separator'},{role:'quit'}]},
   {label:'View',submenu:[{label:'Reload',accelerator:'CmdOrCtrl+R',click:()=>reloadViewer()},{role:'togglefullscreen'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]},
   {label:'Help',submenu:[{label:'About Odradek Studio',click:()=>dialog.showMessageBox(window,{title:'Odradek Studio',message:'Odradek Studio '+app.getVersion(),detail:'3D preview and Odradek Studio. Pull arrows move the preview only. A new robot requires its own qualification. Bot Crossing visual engine by Jarren Rocks (MIT).'})}]}
  ]));
  try{await supervisor.start();await load(offlineLearning?offlineLearningRoute:'5291/arm-manual/');window.show();}
  catch(error){window.show();dialog.showErrorBox('Odradek Studio startup',error.message);}
 }).catch(error=>{dialog.showErrorBox('Odradek Studio',error.message);app.quit();});
 app.on('window-all-closed',()=>app.quit());
 app.on('before-quit',event=>{
  if(quitting||!supervisor)return;event.preventDefault();
  if(quitPending)return;quitPending=true;
  // Keep the original service cleanup prompt. Learning persistence runs beside
  // it; a slow data save must never delay the Controller's shutdown request.
  const restarting=restartPending;
  Promise.resolve().then(async()=>{
   const results=await Promise.allSettled([supervisor.stop(),prepareLearning()]);
   if(restarting){await restarting.catch(()=>{});await supervisor.stop();}
   const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
   quitting=true;app.quit();
  }).catch(error=>{cancelLearningClose();dialog.showErrorBox('Could not finish closing',error.message);}).finally(()=>{quitPending=false;});
 });
}

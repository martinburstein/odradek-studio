// Execute only the shell wiring in a JS VM with fake Electron classes.
// No Electron process, window, device service or desktop interaction is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),source=await fs.readFile(new URL('../desktop/main.cjs',import.meta.url),'utf8');
async function shell(learning,extra=[]){
 const calls={supervisors:[],workspaces:[],windows:[],menus:null,errors:[],events:[],quit:false},app=new EventEmitter();Object.assign(app,{isPackaged:false,setName(){},setAppUserModelId(){},setPath(){},getPath:()=>'/test/appdata',getVersion:()=> '0.5.0',requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),quit(){calls.quit=true;}});
 class Contents extends EventEmitter{constructor(){super();this.session={setPermissionRequestHandler(){}};this.sent=[];this.mainFrame={origin:'',url:''};this.url='';this.reloads=0;}setWindowOpenHandler(){}send(...args){this.sent.push(args);if(args[0]==='odradek:prepare-learning-close')calls.events.push('prepare');}isLoadingMainFrame(){return !!this.loading;}getURL(){return this.url;}isDestroyed(){return false;}reload(){this.reloads++;}reloadIgnoringCache(){this.reloads++;}}
 class Window extends EventEmitter{constructor(options){super();this.options=options;this.webContents=new Contents();this.urls=[];calls.windows.push(this);}async loadURL(url){this.urls.push(url);this.webContents.url=url;this.webContents.mainFrame.url=url;this.webContents.mainFrame.origin=new URL(url).origin;}show(){}focus(){}isMinimized(){return false;}setTitle(){}}
 class Supervisor{constructor(options){this.options=options;calls.supervisors.push(this);}async start(){this.started=true;calls.events.push('start');}async stop(){this.stopped=true;calls.events.push('stop');}}
 class Workspace{constructor(){this.mode='manual';this.modes=[];calls.workspaces.push(this);}navigate(mode){this.mode=mode;this.modes.push(mode);}reload(){}}
 const electron={app,BrowserWindow:Window,WebContentsView:class{},ipcMain:new EventEmitter(),Menu:{buildFromTemplate:value=>value,setApplicationMenu:value=>{calls.menus=value;}},dialog:{showErrorBox:(...args)=>calls.errors.push(args),showMessageBox(){}},shell:{openPath(){}}};
 const modules={'electron':electron,'node:path':path,'./supervisor.cjs':{Supervisor},'./workspace.cjs':{Workspace},'./service-restart.cjs':require('../desktop/service-restart.cjs'),'./learning-save.cjs':require('../desktop/learning-save.cjs')};
 vm.runInNewContext(source,{require:key=>{if(!(key in modules))throw Error('Unexpected module '+key);return modules[key];},__dirname:path.resolve('desktop'),process:{argv:['app',...(learning?['--learning']:[]),...extra]}},{filename:'desktop/main.cjs'});
 await new Promise(setImmediate);const contents=calls.windows[0].webContents,event={sender:contents,senderFrame:contents.mainFrame};return{app,calls,ready(){electron.ipcMain.emit('odradek:learning-ready',event);},respond(ok=true){const message=contents.sent.filter(row=>row[0]==='odradek:prepare-learning-close').at(-1);assert.ok(message);electron.ipcMain.emit('odradek:learning-close-result',event,{id:message[1].id,ok,error:ok?undefined:'Save failed'});},dispose(){calls.windows[0].emit('closed');}};
}
test('offline launch starts only an offline supervisor and never constructs the Studio dock',async()=>{
 const {app,calls}=await shell(true);assert.equal(calls.errors.length,0);assert.equal(calls.supervisors[0].options.offlineLearning,true);assert.equal(calls.workspaces.length,0);assert.match(calls.windows[0].urls[0],/offline-learning=1$/);
 const menu=calls.menus[0].submenu;for(const label of ['Manual','Automatic · Motion Lab','Sync View','Live Camera','Safety Check'])assert.equal(menu.find(row=>row.label===label).enabled,false);
 menu.find(row=>row.label==='Stylus Learning · offline').click();assert.deepEqual(calls.windows[0].webContents.sent.at(-1),['odradek:learning-visibility',true]);menu.find(row=>row.label==='Simulation').click();assert.deepEqual(calls.windows[0].webContents.sent.at(-1),['odradek:learning-visibility',false]);
 await menu.find(row=>row.label==='Restart offline viewer').click();assert.match(calls.windows[0].urls.at(-1),/offline-learning=1$/);assert.equal(calls.workspaces.length,0);
 app.emit('before-quit',{preventDefault(){}});await new Promise(setImmediate);assert.equal(calls.supervisors[0].stopped,true);
});
test('ordinary startup preserves Manual workspace access and a second-instance learning request only changes presentation',async()=>{
 const {app,calls}=await shell(false);assert.equal(calls.errors.length,0);assert.equal(calls.supervisors[0].options.offlineLearning,false);assert.equal(calls.workspaces.length,1);assert.equal(calls.windows[0].urls[0],'http://127.0.0.1:5291/arm-manual/');
 assert.equal(calls.menus[0].submenu.find(row=>row.label==='Manual').enabled,true);
 app.emit('second-instance',{},['app','--learning']);assert.equal(calls.workspaces[0].modes.at(-1),'preview');assert.deepEqual(calls.windows[0].webContents.sent.at(-1),['odradek:learning-visibility',true]);assert.equal(calls.supervisors.length,1);
 calls.windows[0].webContents.loading=true;app.emit('second-instance',{},['app','--learning']);const count=calls.windows[0].webContents.sent.length;calls.windows[0].webContents.loading=false;calls.windows[0].webContents.emit('did-finish-load');assert.equal(calls.windows[0].webContents.sent.length,count+1);
});
test('quit requests Controller cleanup promptly and waits for the exact learning save acknowledgement',async()=>{
 const h=await shell(true);h.ready();h.calls.events.length=0;h.app.emit('before-quit',{preventDefault(){}});h.app.emit('before-quit',{preventDefault(){}});await new Promise(setImmediate);assert.deepEqual(h.calls.events,['stop','prepare']);assert.equal(h.calls.quit,false);h.respond();await new Promise(setImmediate);assert.equal(h.calls.quit,true);h.dispose();
});
test('a rejected learning save keeps the app open after service cleanup and cancels the learner close lock',async()=>{
 const h=await shell(true);h.ready();h.app.emit('before-quit',{preventDefault(){}});await new Promise(setImmediate);h.respond(false);await new Promise(setImmediate);assert.equal(h.calls.supervisors[0].stopped,true);assert.equal(h.calls.quit,false);assert.equal(h.calls.errors[0][0],'Could not finish closing');assert.deepEqual(h.calls.windows[0].webContents.sent.at(-1),['odradek:learning-close-cancelled']);h.dispose();
});
test('F5 reload coalesces while saving and a service restart stops before awaiting the learner',async()=>{
 const h=await shell(true),contents=h.calls.windows[0].webContents;h.ready();let prevented=0;for(let i=0;i<2;i++)contents.emit('before-input-event',{preventDefault(){prevented++;}},{type:'keyDown',key:'F5'});await new Promise(setImmediate);assert.equal(prevented,2);assert.equal(contents.reloads,0);h.respond();await new Promise(setImmediate);assert.equal(contents.reloads,1);contents.emit('did-finish-load');
 h.calls.events.length=0;const restart=h.calls.menus[0].submenu.find(row=>row.label==='Restart offline viewer').click();await new Promise(setImmediate);assert.deepEqual(h.calls.events,['stop','prepare']);h.respond();await restart;assert.deepEqual(h.calls.events,['stop','prepare','start']);h.dispose();
});
test('quit during a pending restart cannot leave newly started services behind',async()=>{
 const h=await shell(true);h.ready();h.calls.events.length=0;const restart=h.calls.menus[0].submenu.find(row=>row.label==='Restart offline viewer').click();await new Promise(setImmediate);h.app.emit('before-quit',{preventDefault(){}});await new Promise(setImmediate);h.respond();await restart;await new Promise(setImmediate);assert.equal(h.calls.quit,true);assert.equal(h.calls.events.at(-1),'stop');h.dispose();
});
test('quit supersedes a pending F5 refresh after the same save acknowledgement',async()=>{
 const h=await shell(true),contents=h.calls.windows[0].webContents;h.ready();contents.emit('before-input-event',{preventDefault(){}},{type:'keyDown',key:'F5'});h.app.emit('before-quit',{preventDefault(){}});await new Promise(setImmediate);h.respond();await new Promise(setImmediate);assert.equal(h.calls.quit,true);assert.equal(contents.reloads,0);h.dispose();
});


test('iteration-ghost launch and restart remain cold offline with no Studio dock',async()=>{
 const {calls}=await shell(true,['--iteration-ghosts']);
 assert.equal(calls.supervisors[0].options.offlineLearning,true);assert.equal(calls.workspaces.length,0);
 assert.match(calls.windows[0].urls[0],/offline-learning=1&iteration-ghosts=1$/);
 await calls.menus[0].submenu.find(row=>row.label==='Restart offline viewer').click();
 assert.match(calls.windows[0].urls.at(-1),/offline-learning=1&iteration-ghosts=1$/);assert.equal(calls.errors.length,0);
});

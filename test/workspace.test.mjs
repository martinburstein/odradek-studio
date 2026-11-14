import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import fs from 'node:fs';
const require=createRequire(import.meta.url);
const {Workspace,MODES,dockBounds,trustedFrame,selectScript,rehearsalPose,frameStyleScript,isControlFrame}=require('../desktop/workspace.cjs');
test('workspace bridge accepts only its owning main frame and named Studio navigation',()=>{
 const contents={mainFrame:{url:'http://127.0.0.1:5291/arm-manual/'}};
 const event={sender:contents,senderFrame:contents.mainFrame};
 assert.equal(trustedFrame(event,contents,'http://127.0.0.1:5291'),true);
 assert.equal(trustedFrame({...event,senderFrame:{url:contents.mainFrame.url}},contents,'http://127.0.0.1:5291'),false);
 assert.equal(trustedFrame(event,contents,'http://127.0.0.1:8790'),false);
 assert.equal(selectScript('sync'),'document.documentElement.dataset.labView="sync";document.getElementById("show-live")?.click();');
 assert.equal(selectScript('http://evil.invalid/'),null);
 assert.deepEqual(dockBounds({x:-20,y:48,width:5000,height:900},[1280,850]),{x:0,y:48,width:1280,height:802});
 assert.equal(dockBounds({x:NaN,y:0,width:2,height:2},[1280,850]),null);
 assert.deepEqual(rehearsalPose({base:1,shoulder:90,elbow:80,gripper:120,command:'move'}),{base:1,shoulder:90,elbow:80,gripper:120});
 assert.equal(rehearsalPose({base:1,shoulder:90,elbow:NaN,gripper:120}),null);
 assert.equal(rehearsalPose({base:1,shoulder:190,elbow:80,gripper:120}),null);
});
class Contents extends EventEmitter{
 constructor(url=''){super();this.url=url;this.mainFrame={url};this.scripts=[];this.sent=[];}
 setWindowOpenHandler(){}getURL(){return this.url;}isDestroyed(){return false;}
 async loadURL(url){this.url=url;this.mainFrame.url=url;}
 async insertCSS(){}async executeJavaScript(code){this.scripts.push(code);}
 send(...args){this.sent.push(args);}close(){this.closed=true;}reload(){this.reloaded=true;}
}
test('persistent Studio dock switches existing controls without a motion bridge',async()=>{
 const ipc=new EventEmitter(),win=new EventEmitter();win.webContents=new Contents('http://127.0.0.1:5291/arm-manual/');win.getContentSize=()=>[1280,850];win.contentView={addChildView(view){win.child=view;}};
 class View{constructor(options){this.options=options;this.webContents=new Contents();}setVisible(value){this.visible=value;}setBounds(value){this.bounds=value;}}
 const workspace=new Workspace({window:win,WebContentsView:View,ipcMain:ipc,path:require('node:path')});
 const request=(mode,bounds={x:660,y:48,width:620,height:802})=>ipc.emit('odradek:workspace',{sender:win.webContents,senderFrame:win.webContents.mainFrame},{mode,bounds});
 request('manual');assert.equal(workspace.view.webContents.getURL(),'http://127.0.0.1:8790/#presets');
 workspace.view.webContents.emit('did-finish-load');await new Promise(setImmediate);
 assert.deepEqual(workspace.view.webContents.scripts,[selectScript('manual')]);
 request('automatic');await new Promise(setImmediate);
 const studioEvent={sender:workspace.view.webContents,senderFrame:workspace.view.webContents.mainFrame},sample={base:1,shoulder:90,elbow:80,gripper:120};
 ipc.emit('odradek:rehearsal',studioEvent,sample);assert.deepEqual(win.webContents.sent.at(-1),['odradek:workspace-state',{rehearsal:sample}]);
 request('sync');await new Promise(setImmediate);const count=win.webContents.sent.length;ipc.emit('odradek:rehearsal',studioEvent,sample);assert.equal(win.webContents.sent.length,count);
 assert.equal(workspace.view.webContents.scripts.at(-1),selectScript('sync'));
 for(const mode of ['camera','safety']){request(mode);await new Promise(setImmediate);assert.equal(workspace.view.webContents.scripts.at(-1),selectScript(mode));ipc.emit('odradek:studio-tab',studioEvent,'sync');assert.equal(workspace.mode,mode);}
 request('preview');assert.equal(workspace.view.visible,false);assert.equal(workspace.view.webContents.closed,undefined);
 request('manual');assert.equal(workspace.view.visible,true);assert.equal(win.child,workspace.view);
 request('bad-mode');assert.equal(workspace.mode,'manual');
 win.webContents.getZoomFactor=()=>1.25;request('manual',{x:400,y:40,width:400,height:600});assert.deepEqual(workspace.view.bounds,{x:500,y:50,width:500,height:750});
 ipc.emit('odradek:workspace',{sender:{},senderFrame:win.webContents.mainFrame},{mode:'sync',bounds:{x:0,y:0,width:2,height:2}});assert.equal(workspace.mode,'manual');
 win.emit('closed');assert.equal(workspace.view.webContents.closed,true);assert.equal(ipc.listenerCount('odradek:workspace'),0);
});
test('six canonical primary tabs separate live status, camera and the existing checklist',()=>{
 const catalog=JSON.parse(fs.readFileSync(new URL('../assets/theme/workspaces.json',import.meta.url)));
 assert.deepEqual(catalog.tabs.map(tab=>tab.label),['Automatic','Manual','Sync View','Simulation','Live Camera','Safety Check']);
 for(const tab of catalog.tabs)assert.ok(MODES.includes(tab.id));
 const setup={open:false},checkbox={checked:true},nodes=new Map();
 const document={documentElement:{dataset:{}},head:{append(node){nodes.set(node.id,node);}},createElement(){return{};},getElementById(id){return nodes.get(id);},querySelector(selector){return selector==='details.setup'?setup:checkbox;}};
 for(const mode of ['safety','camera','sync','safety'])vm.runInNewContext(frameStyleScript(mode),{document});
 assert.equal(nodes.size,1);assert.equal(setup.open,true);assert.equal(checkbox.checked,true);assert.equal(document.documentElement.dataset.labView,'safety');
 assert.equal(nodes.get('odradek-neon-theme').textContent,fs.readFileSync(new URL('../assets/theme/neon.css',import.meta.url),'utf8'));
 assert.equal(isControlFrame('http://127.0.0.1:8787/studio/automatic/index.html'),true);
 assert.equal(isControlFrame('http://evil.invalid/studio/automatic/index.html'),false);
 assert.equal(frameStyleScript('unrecognized'),null);
});
test('service restart is admitted only from the active Safety main frame and reports completion or failure',async()=>{
 const ipc=new EventEmitter(),win=new EventEmitter();win.webContents=new Contents('http://127.0.0.1:5291/arm-manual/');win.getContentSize=()=>[1280,850];win.contentView={addChildView(){}};
 class View{constructor(){this.webContents=new Contents();}setVisible(){}setBounds(){}}
 let count=0,finish,fail=false;
 const workspace=new Workspace({window:win,WebContentsView:View,ipcMain:ipc,path:require('node:path'),restartServices:()=>{count++;if(fail)throw Error('cleanup pending');return new Promise(resolve=>{finish=resolve;});}});
 const wc=workspace.view.webContents,event={sender:wc,senderFrame:wc.mainFrame};workspace.mode='manual';await wc.loadURL('http://127.0.0.1:8790/#manual');workspace.ready=true;
 ipc.emit('odradek:service-restart',event);assert.equal(count,0);
 workspace.mode='safety';ipc.emit('odradek:service-restart',{sender:win.webContents,senderFrame:win.webContents.mainFrame});assert.equal(count,0);
 ipc.emit('odradek:service-restart',{sender:wc,senderFrame:{url:wc.mainFrame.url}});assert.equal(count,0);
 ipc.emit('odradek:service-restart',event);ipc.emit('odradek:service-restart',event);assert.equal(count,1);assert.equal(workspace.serviceState.busy,true);
 finish();await new Promise(setImmediate);assert.equal(workspace.serviceState.busy,false);assert.match(workspace.serviceState.message,/Clean restart complete/);
 fail=true;ipc.emit('odradek:service-restart',event);await new Promise(setImmediate);assert.equal(count,2);assert.equal(workspace.serviceState.error,true);assert.match(workspace.serviceState.message,/cleanup pending/);
 win.emit('closed');assert.equal(ipc.listenerCount('odradek:service-restart'),0);
});

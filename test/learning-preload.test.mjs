import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';

const source=await readFile(new URL('../desktop/preload.cjs',import.meta.url),'utf8');
function loadPreload(){
 const ipcRenderer=new EventEmitter(),sent=[],order=[];let api;
 ipcRenderer.send=(channel,value)=>{sent.push({channel,value});if(channel==='odradek:learning-ready')order.push({channel,prepareListeners:ipcRenderer.listenerCount('odradek:prepare-learning-close'),cancelListeners:ipcRenderer.listenerCount('odradek:learning-close-cancelled')});};
 const contextBridge={exposeInMainWorld(_name,value){api=value;}};
 vm.runInNewContext(source,{require:name=>{assert.equal(name,'electron');return{contextBridge,ipcRenderer};}},{filename:'desktop/preload.cjs'});
 return{api,ipcRenderer,sent,order};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('preload reports readiness only after close and cancel listeners are installed',()=>{
 const h=loadPreload();h.api.beforeClose(()=>{});
 assert.deepEqual(h.order,[{channel:'odradek:learning-ready',prepareListeners:1,cancelListeners:1}]);
});

test('preload waits for save completion and acknowledges the matching request id',async()=>{
 const h=loadPreload();let finish,called=0;h.api.beforeClose(()=>{called++;return new Promise(resolve=>{finish=resolve;});});
 h.ipcRenderer.emit('odradek:prepare-learning-close',{}, {id:'nonce-abc'});await Promise.resolve();
 assert.equal(called,1);assert.equal(h.sent.filter(message=>message.channel==='odradek:learning-close-result').length,0);
 finish();await settle();
 const ack=h.sent.at(-1);assert.equal(ack.channel,'odradek:learning-close-result');assert.equal(ack.value.id,'nonce-abc');assert.equal(ack.value.ok,true);
});

test('preload bounds callback error text and ignores malformed request ids',async()=>{
 const h=loadPreload();let called=0;h.api.beforeClose(()=>{called++;return Promise.reject(Error('x'.repeat(700)));});
 for(const id of [null,42,'x'.repeat(101),''])h.ipcRenderer.emit('odradek:prepare-learning-close',{}, {id});
 await settle();
 assert.equal(called,0);assert.equal(h.sent.filter(message=>message.channel==='odradek:learning-close-result').length,0);
 h.ipcRenderer.emit('odradek:prepare-learning-close',{}, {id:'valid'});await settle();
 const result=h.sent.at(-1).value;assert.equal(result.id,'valid');assert.equal(result.ok,false);assert.equal(result.error.length,500);
});

test('preload forwards close cancellation and unsubscribe removes both listeners',()=>{
 const h=loadPreload();let cancelled=0;const unsubscribe=h.api.beforeClose(()=>{},()=>cancelled++);
 h.ipcRenderer.emit('odradek:learning-close-cancelled',{});assert.equal(cancelled,1);
 unsubscribe();assert.equal(h.ipcRenderer.listenerCount('odradek:prepare-learning-close'),0);assert.equal(h.ipcRenderer.listenerCount('odradek:learning-close-cancelled'),0);
 h.ipcRenderer.emit('odradek:prepare-learning-close',{}, {id:'after-unsubscribe'});assert.equal(h.sent.filter(message=>message.channel==='odradek:learning-close-result').length,0);
});

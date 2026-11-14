import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createLearningStore} from '../src/replica/learning/storage.js';
import {createExperiment} from '../src/replica/learning/simulation.js';
import {createEvolution,evolveGeneration,initializeEvolution} from '../src/replica/learning/evolution.js';
import {makeLearningRun} from '../src/replica/learning/run.js';

const clone=value=>JSON.parse(JSON.stringify(value));
const localStore=()=>{const values=new Map();return{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),values};};
const newRun=(id,updatedAt)=>{const run=makeLearningRun(createExperiment(),{seed:41,population:12,generations:3});run.id=id;run.updatedAt=updatedAt;return run;};
function unfinishedRun(){
 const experiment=createExperiment(),state=createEvolution({seed:52,population:12,generations:3});
 const fitness=()=>({loss:2,staticLoss:1,dynamicLoss:3});initializeEvolution(state,experiment,fitness);
 let calls=0;evolveGeneration(state,experiment,{fitness,cancelled:()=>calls++>=3});
 const run=makeLearningRun(experiment,{seed:52,population:12,generations:3});run.id='unfinished-checkpoint';run.status='paused';run.updatedAt='2026-11-14T20:00:00.000Z';run.snapshots[0].loss=state.best.loss;run.checkpoint=clone(state);
 return run;
}
function blockedFactory(factory){
 return{open(name,version){
  const request=factory.open(name,version);
  return new Proxy(request,{
   get(target,key){return Reflect.get(target,key,target);},
   set(target,key,value){
    if(key==='onblocked'&&typeof value==='function'){Reflect.set(target,key,value,target);queueMicrotask(()=>value.call(target,{type:'blocked',target}));return true;}
    return Reflect.set(target,key,value,target);
   },
  });
 }};
}
async function withAbortedPut(callback){
 const original=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...values){const request=original.apply(this,values),transaction=this.transaction;queueMicrotask(()=>{try{transaction.abort();}catch{}});return request;};
 try{return await callback();}finally{IDBObjectStore.prototype.put=original;}
}

test('save, list, latest and reopen preserve multiple validated runs',async()=>{
 const indexedDB=new IDBFactory(),localStorage=localStore(),store=createLearningStore({indexedDB,localStorage});
 const earlier=newRun('run-earlier','2026-11-14T19:00:00.000Z'),later=newRun('run-later','2026-11-14T20:00:00.000Z');
 await store.save(earlier);await store.save(later);
 assert.deepEqual((await store.list()).map(row=>row.id),['run-later','run-earlier']);
 assert.equal((await store.latest()).id,later.id);assert.equal((await store.load(earlier.id)).id,earlier.id);
 await store.close();
 const reopened=createLearningStore({indexedDB,localStorage});
 assert.equal((await reopened.latest()).id,later.id);assert.deepEqual((await reopened.list()).map(row=>row.id),['run-later','run-earlier']);
});

test('an unfinished partial-generation checkpoint round-trips exactly',async()=>{
 const indexedDB=new IDBFactory(),store=createLearningStore({indexedDB,localStorage:localStore()}),run=unfinishedRun();
 assert.equal(run.checkpoint.status,'cancelled');assert.equal(run.checkpoint.pending.candidates.length,3);
 await store.save(run);const loaded=await store.load(run.id);
 assert.deepEqual(loaded.checkpoint,run.checkpoint);
 assert.equal(loaded.checkpoint.pending.generation,1);assert.equal(loaded.checkpoint.evaluations,4);
});

test('aborted write preserves old record and last-successful latest pointer without unhandled rejects',async()=>{
 const indexedDB=new IDBFactory(),localStorage=localStore(),store=createLearningStore({indexedDB,localStorage});
 const original=newRun('stable-id','2026-11-14T19:00:00.000Z');await store.save(original);
 const changed=clone(original);changed.updatedAt='2026-11-14T21:00:00.000Z';changed.status='cancelled';
 const unhandled=[],handler=reason=>unhandled.push(reason);process.on('unhandledRejection',handler);
 try{await withAbortedPut(async()=>{
   await assert.rejects(store.save(changed));await new Promise(resolve=>setTimeout(resolve,10));
   assert.equal((await store.load(original.id)).updatedAt,original.updatedAt);
   assert.equal(localStorage.values.get('odradek.stylus-learning.v1'),original.id);
  });
  assert.deepEqual(unhandled,[]);
 }finally{process.off('unhandledRejection',handler);}
});

test('unavailable IndexedDB rejects promptly and unavailable localStorage falls back to newest saved run',async()=>{
 const noStorage=createLearningStore({indexedDB:undefined,localStorage:null});
 await assert.rejects(noStorage.save(newRun('unavailable','2026-11-14T20:00:00.000Z')),/unavailable/);
 await assert.rejects(noStorage.list(),/unavailable/);assert.equal(await noStorage.latest().catch(()=>null),null);
 const indexedDB=new IDBFactory(),brokenLocalStorage={getItem(){throw Error('blocked');},setItem(){throw Error('quota');}},store=createLearningStore({indexedDB,localStorage:brokenLocalStorage});
 const newest=newRun('newest','2026-11-14T20:00:00.000Z');await store.save(newRun('older','2026-11-14T19:00:00.000Z'));await store.save(newest);
 assert.equal((await store.latest()).id,newest.id);
 const stalePointer=createLearningStore({indexedDB,localStorage:{getItem:()=> 'missing-run',setItem(){}}});assert.equal((await stalePointer.latest()).id,newest.id);
});

test('blocked open rejects once, closes a late success and allows a retry',async()=>{
 const indexedDB=new IDBFactory(),blockedStore=createLearningStore({indexedDB:blockedFactory(indexedDB),localStorage:localStore()});
 await assert.rejects(blockedStore.list(),/blocked by another open connection/);
 await new Promise(resolve=>setTimeout(resolve,10));
 const retry=createLearningStore({indexedDB,localStorage:localStore()});
 const run=newRun('after-block','2026-11-14T20:00:00.000Z');await retry.save(run);assert.equal((await retry.load(run.id)).id,run.id);
});

test('close drains an in-flight write and later operations reopen cleanly',async()=>{
 const indexedDB=new IDBFactory(),store=createLearningStore({indexedDB,localStorage:localStore()});
 await store.list();
 const beforeClose=store.save(newRun('before-close','2026-11-14T19:00:00.000Z'));
 const closing=store.close();
 const afterClose=store.save(newRun('after-close','2026-11-14T20:00:00.000Z'));
 await Promise.all([beforeClose,closing,afterClose]);
 assert.deepEqual((await store.list()).map(row=>row.id),['after-close','before-close']);
 await store.close();await store.close();
});

import {parseLearningRun,RUN_STORAGE_KEY} from './run.js';
export function createLearningStore({indexedDB=globalThis.indexedDB,localStorage=globalThis.localStorage}={}){
 let connection,closing=null,activeOperations=0,idleWaiters=[];
 const database=()=>{
  if(connection)return connection;
  if(!indexedDB)return Promise.reject(Error('Local learning storage is unavailable. Export your run to keep it.'));
  const pending=new Promise((resolve,reject)=>{
   const request=indexedDB.open('odradek-stylus-learning',1);let settled=false;
   request.onupgradeneeded=()=>request.result.createObjectStore('runs',{keyPath:'id'});
   request.onerror=()=>{if(settled)return;settled=true;reject(request.error??Error('Could not open local learning storage.'));};
   request.onblocked=()=>{if(settled)return;settled=true;reject(Error('Local learning storage is blocked by another open connection. Close the other lab window and retry.'));};
   request.onsuccess=()=>{if(settled){request.result.close();return;}settled=true;resolve(request.result);};
  });
  connection=pending;
  pending.catch(()=>{if(connection===pending)connection=null;});
  return pending;
 };
 const waitForIdle=()=>activeOperations===0?Promise.resolve():new Promise(resolve=>idleWaiters.push(resolve));
 const finishOperation=()=>{activeOperations--;if(activeOperations===0)for(const resolve of idleWaiters.splice(0))resolve();};
 const operation=async(mode,act)=>{
  if(closing)await closing;
  activeOperations++;
  try{const db=await database();return await new Promise((resolve,reject)=>{let transaction,request;try{transaction=db.transaction('runs',mode);request=act(transaction.objectStore('runs'));}catch(error){reject(error);return;}transaction.oncomplete=()=>resolve(request.result);transaction.onerror=()=>reject(transaction.error??Error('Learning storage transaction failed.'));transaction.onabort=()=>reject(transaction.error??Error('Learning save interrupted.'));});}
  finally{finishOperation();}
 };
 const load=async id=>{const data=await operation('readonly',store=>store.get(id));return data?parseLearningRun(JSON.stringify(data)):null;};
 const list=async()=>{const values=await operation('readonly',store=>store.getAll());return values.map(value=>({id:value.id,seed:value.seed,status:value.status,generation:value.history.at(-1)?.generation??0,updatedAt:value.updatedAt})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));};
 return{
  async save(run){const data=parseLearningRun(JSON.stringify(run));await operation('readwrite',store=>store.put(data));try{localStorage?.setItem(RUN_STORAGE_KEY,data.id);}catch{}return data;},
  list,
  load,
  async latest(){let id;try{id=localStorage?.getItem(RUN_STORAGE_KEY);}catch{}if(id){const saved=await load(id);if(saved)return saved;}const [newest]=await list();return newest?load(newest.id):null;},
  async close(){if(closing)return closing;const current=connection;if(!current)return;const task=(async()=>{let db;try{db=await current;}catch{if(connection===current)connection=null;return;}await waitForIdle();db.close();if(connection===current)connection=null;})();closing=task;try{await task;}finally{if(closing===task)closing=null;}},
 };
}

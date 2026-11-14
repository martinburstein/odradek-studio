import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export function createSyncUsage({root,directory}){
 let controller,initializing,selected,idle;
 const close=()=>{clearTimeout(idle);controller?.close();controller=null;selected=null;};
 const read=async()=>{
  try{
   const {chatId}=JSON.parse(await fs.readFile(path.join(directory,'sync-view.json'),'utf8'));
   if(!/^[a-f0-9-]{36}$/i.test(chatId))throw Error('No pinned chat');
   if(!controller){
    initializing??=(async()=>{
     const base=path.resolve(root,'../Token Counter/src');
     const {CodexMonitor}=require(path.join(base,'codex-monitor.cjs'));
     const {UsageClient}=require(path.join(base,'usage-client.cjs'));
     const {TokenCounterController}=require(path.join(base,'controller.cjs'));
     controller=new TokenCounterController({monitor:new CodexMonitor({pollMs:2000}),usage:new UsageClient(),selectedId:chatId});selected=chatId;await controller.start();
    })().catch(e=>{close();throw e;}).finally(()=>{initializing=null;});
    await initializing;
   }else if(initializing)await initializing;
   if(selected!==chatId){controller.select(chatId);selected=chatId;}
   clearTimeout(idle);idle=setTimeout(close,60000);idle.unref();
   const s=controller.snapshot();return Object.fromEntries(['taskId','taskTitle','tokens','tokenStatus','tokenAt','accountStatus','accountAt','remaining','windowMinutes','resetsAt'].map(k=>[k,s[k]??null]));
  }catch{return {tokens:null,remaining:null,tokenStatus:'unavailable',accountStatus:'unavailable'};}
 };
 return {read,close};
}

const usage=createSyncUsage({root:process.argv[2],directory:process.argv[3]});
process.on('message',async message=>{if(Number.isSafeInteger(message?.id))process.send?.({id:message.id,value:await usage.read()});});
process.once('disconnect',()=>{usage.close();process.exit(0);});

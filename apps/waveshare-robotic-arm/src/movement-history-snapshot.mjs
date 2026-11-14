import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

// Only JSON parsed here and projections of that deeply frozen JSON are trusted
// for digest reuse. Object.freeze supplied by a caller is not sufficient.
const immutable=new WeakSet(),digests=new WeakMap(),prefixes=new WeakMap(),histories=new WeakSet(),rowJSON=new WeakMap(),appendHistories=new WeakMap(),seedableHistories=new WeakSet(),commitSnapshots=new WeakMap();
const appendHashStates=new WeakMap();
export const isImmutableHistoryValue=value=>!!value&&immutable.has(value);
function freezeParsed(value){
 if(value&&immutable.has(value))return value;
 if(value&&typeof value==='object'){
  for(const child of Object.values(value))freezeParsed(child);
  Object.freeze(value);immutable.add(value);
 }
 return value;
}
export function appendHistory(prefix,row){
 if(!histories.has(prefix))throw Error('A private immutable history prefix is required');
 const value=Object.freeze({...prefix,commands:Object.freeze([...prefix.commands,row])});
 // The outer structure is fixed, but the appended row remains mutable. Never
 // admit this value to immutable or cache its complete digest/serialization.
 appendHistories.set(value,prefix);return value;
}
function serializedRow(row,index){
 let text=row&&typeof row==='object'?rowJSON.get(row):undefined;
 if(text===undefined){
  const wrapped=JSON.stringify({[String(index)]:row});text=wrapped==='{}'?'null':wrapped.slice(wrapped.indexOf(':')+1,-1);
  if(row&&immutable.has(row))rowJSON.set(row,text);
 }
 return text;
}
function visitHistoryJSON(value,write,onRow,onCommandsEnd){
 if(value&&(histories.has(value)||appendHistories.has(value))){
  // Reproduce JSON.stringify's exact property/row order from private frozen
  // JSON. Row representations were already computed while validating the read.
  // Mutable caller objects always take the original native serialization path.
  write('{');let first=true;
  for(const key of Object.keys(value)){
   if(!first)write(',');first=false;write(JSON.stringify(key)+':');
   if(key==='commands'){
    write('[');
    for(let index=0;index<value.commands.length;index++){
     if(index)write(',');const text=serializedRow(value.commands[index],index);
     write(text);
     onRow?.(index,text);
    }
    onCommandsEnd?.();write(']');
   }else write(JSON.stringify(value[key]));
  }
  write('}');
 }else write(JSON.stringify(value));
}
export function historyJSON(value){
 if(!value||(!histories.has(value)&&!appendHistories.has(value)))return JSON.stringify(value);
 const parts=[];visitHistoryJSON(value,text=>parts.push(text));return parts.join('');
}
export function prepareHistoryCommit(history){
 const prefix=appendHistories.get(history);
 if(!prefix||!seedableHistories.has(prefix))return {bytes:historyJSON(history)+'\n',token:null};
 // Capture the exact tail during the same serialization used for the write.
 // It may change during asynchronous IO; no post-await object is trusted.
 const parts=[];let tailText;
 visitHistoryJSON(history,text=>parts.push(text),(_index,text)=>tailText=text);
 const bytes=parts.join('')+'\n';let token=null;
 try{
  const row=JSON.parse(tailText);let reusable=true;
  if(!row||typeof row.id!=='string'||!['intent','complete','blocked'].includes(row.state))return {bytes,token};
  const canonical=JSON.stringify(row,(_key,item)=>{
   if(typeof item==='number'&&!Number.isFinite(item))throw Error('Non-finite movement history value');
   if(Object.is(item,-0))reusable=false;
   return item;
  });
  if(!reusable)return {bytes,token};
  const value=freezeParsed({...prefix,commands:[...prefix.commands,row]});
  histories.add(value);seedableHistories.add(value);rowJSON.set(row,canonical);
  const retained=prefixes.get(prefix);if(retained)prefixes.set(value,new Map(retained));
  const rows=value.commands.map(item=>rowJSON.get(item)??JSON.stringify(item)),envelope=JSON.stringify({...value,commands:[]});
  token=Object.freeze({});commitSnapshots.set(token,{text:bytes,value,rows,envelope});
 }catch{
  // Unsupported serialization still takes the ordinary durable-write/read path.
  // In particular, raw JSON overflow must not bypass normal read validation.
 }
 return {bytes,token};
}
function historyHash(value){
 const prefix=value&&appendHistories.get(value);
 if(prefix){
  let saved=appendHashStates.get(prefix);
  if(!saved){
   const state=createHash('sha256');let suffix='',afterCommands=false;
   visitHistoryJSON(prefix,text=>{if(afterCommands)suffix+=text;else state.update(text);},undefined,()=>{afterCommands=true;});
   saved={state,suffix};appendHashStates.set(prefix,saved);
  }
  // This state contains only a privately parsed frozen prefix. The current
  // mutable tail still runs native serialization on every digest invocation.
  const hash=saved.state.copy(),index=prefix.commands.length;
  if(index)hash.update(',');hash.update(serializedRow(value.commands[index],index));hash.update(saved.suffix);return hash;
 }
 const hash=createHash('sha256');visitHistoryJSON(value,text=>hash.update(text));return hash;
}
export function historyFileDigest(value){return historyHash(value).update('\n').digest('hex');}
export function historyDigest(value){
 if(value&&immutable.has(value)&&digests.has(value))return digests.get(value);
 const hash=historyHash(value);
 const result=hash.digest('hex');
 if(value&&immutable.has(value))digests.set(value,result);
 return result;
}
export function historyPrefix(history,count,{withoutLastRecovery=false}={}){
 if(!Number.isInteger(count)||count<0||count>history.commands.length)throw Error('Invalid history prefix');
 const trusted=immutable.has(history),key=count+':'+withoutLastRecovery;
 let cache=trusted?prefixes.get(history):null;
 if(cache?.has(key))return cache.get(key);
 const commands=history.commands.slice(0,count);
 if(withoutLastRecovery&&count){commands[count-1]={...commands[count-1]};delete commands[count-1].manualRecovery;if(trusted){Object.freeze(commands[count-1]);immutable.add(commands[count-1]);}}
 const result={...history,commands};
 if(trusted){Object.freeze(commands);immutable.add(commands);Object.freeze(result);immutable.add(result);if(histories.has(history))histories.add(result);if(seedableHistories.has(history))seedableHistories.add(result);if(!cache){cache=new Map();prefixes.set(history,cache);}cache.set(key,result);}
 return result;
}
export class MovementHistorySnapshot {
 #bytes=null;#value=null;#rows=null;#envelope=null;#reusable=false;
 #clear(){this.#bytes=null;this.#value=null;this.#rows=null;this.#envelope=null;this.#reusable=false;}
 acceptCommitted(token){
  const prepared=commitSnapshots.get(token);if(!prepared)return false;
  // This Buffer never leaves the snapshot. Every read below still rereads all
  // file bytes; a changed, missing or unreadable file cannot use this seed.
  this.#bytes=Buffer.from(prepared.text,'utf8');this.#value=prepared.value;this.#rows=prepared.rows;this.#envelope=prepared.envelope;this.#reusable=true;return true;
 }
 async read(file){
  let bytes;
  try{bytes=await fs.readFile(file);}catch(error){this.#clear();if(error.code==='ENOENT'){const empty=freezeParsed({version:1,commands:[]});histories.add(empty);seedableHistories.add(empty);return empty;}throw error;}
  // A fresh complete byte comparison detects equal-size and timestamp-preserving
  // external edits. Never rely on mtime, row count or a cached path identity.
  if(this.#bytes?.equals(bytes))return this.#value;
  const previous=this.#value,previousRows=this.#rows,previousEnvelope=this.#envelope,previousReusable=this.#reusable;
  this.#clear();
  const value=JSON.parse(bytes.toString('utf8'));
  if(value.version!==1||!Array.isArray(value.commands)||value.commands.some(r=>!r||typeof r.id!=='string'||!['intent','complete','blocked'].includes(r.state)))throw Error('Invalid movement history');
  // Fresh parsing plus exact canonical JSON equality permits structural reuse.
  // This preserves object-digest semantics (including property order), rather
  // than treating row IDs, timestamps, counts or caller objects as evidence.
  let reusable=true;
  const canonical=value=>JSON.stringify(value,(_key,item)=>{
   if(typeof item==='number'&&!Number.isFinite(item))throw Error('Non-finite movement history value');
   // JSON.stringify also collapses -0 to 0. Keep its parsed semantics but skip
   // structural reuse whenever either version contains this representation.
   if(Object.is(item,-0))reusable=false;
   return item;
  });
  const rows=value.commands.map(canonical),envelope=canonical({...value,commands:[]});
  let common=0;
  if(previous&&previousReusable&&reusable&&envelope===previousEnvelope){
   while(common<rows.length&&common<previousRows.length&&rows[common]===previousRows[common]){
    value.commands[common]=previous.commands[common];common++;
   }
  }
  const frozen=freezeParsed(value),priorPrefixes=previous&&prefixes.get(previous);
  histories.add(frozen);if(reusable)seedableHistories.add(frozen);for(let index=0;index<frozen.commands.length;index++)rowJSON.set(frozen.commands[index],rows[index]);
  if(common&&priorPrefixes){
   const retained=new Map([...priorPrefixes].filter(([key])=>Number(key.split(':')[0])<=common));
   if(retained.size)prefixes.set(frozen,retained);
  }
  this.#value=frozen;this.#bytes=bytes;this.#rows=rows;this.#envelope=envelope;this.#reusable=reusable;return this.#value;
 }
}

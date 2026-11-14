import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {compileScore,exportScore,framesFromPreset} from '../public/presets/motion-score.js';

export const PRESET_JOINTS=['base','shoulder','elbow','gripper'];
export const CAPTURE_MAX_AGE_MS=2000; // Controller background poll runs every 1500 ms.
const text=(value,max,required=false)=>{
 if(typeof value!=='string'||value.length>max||required&&!value.trim())throw Error(`Enter ${required?'a nonempty value':'text'} of at most ${max} characters`);
 return value.trim();
};
export function captureStatus(status,now=Date.now()){
 if(!status?.connected||!['serial','simulator'].includes(status.mode))throw Error('Connect the arm in Manual, then return here to capture');
 const e=status.execution??{};
 if(status.movement?.active||status.movement?.session||status.task?.active||e.busy||e.lifecycle||e.cleanupPending||e.recoveryRequired||e.outstandingTransportOperations)throw Error('Wait for the current movement or controller operation to finish');
 const age=now-Date.parse(status.telemetryUpdatedAt);
 if(!Number.isFinite(age)||age<0||age>CAPTURE_MAX_AGE_MS)throw Error('Joint readings are stale; wait for fresh feedback');
 const source=status.mode==='serial'?'encoder':'simulator',pose=source==='encoder'?status.measured:status.simulated;
 if(!pose||PRESET_JOINTS.some(j=>!Number.isFinite(pose[j])))throw Error('All four measured joints are required');
 const radians=Object.fromEntries(PRESET_JOINTS.map(j=>[j,pose[j]]));
 const degrees=Object.fromEntries(PRESET_JOINTS.map(j=>[j,pose[j]*180/Math.PI+(j==='shoulder'?90:0)]));
 return {source,radians,degrees,measuredAt:status.telemetryUpdatedAt,capturedAt:new Date(now).toISOString()};
}
export function projectPresetFeedback(status,now=Date.now()){
 try{return {available:true,capturable:true,...captureStatus(status,now)};}
 catch(error){return {available:Boolean(status?.connected),capturable:false,source:status?.mode==='simulator'?'simulator':'encoder',reason:error.message};}
}

// All edits are serialized and revision checked. Atomic replacement preserves the
// old library if a write fails; archived presets retain their captured positions.
export function createPresetLibrary(directory){
 const file=path.join(directory,'library.json');let queue=Promise.resolve();
 async function read(){
  try{
   const library=JSON.parse(await fs.readFile(file,'utf8'));
   if(library.schema!=='roarm-movement-presets-v1'||!Number.isInteger(library.revision)||!Array.isArray(library.presets))throw Error('Unrecognized preset library');
   return library;
  }catch(error){if(error.code==='ENOENT')return {schema:'roarm-movement-presets-v1',revision:0,presets:[]};throw error;}
 }
 function edit(revision,fn){
  const task=queue.then(async()=>{
   const library=await read();
   if(revision!==library.revision){const error=Error('The library changed in another window. Reload it before editing.');error.status=409;throw error;}
   const result=await fn(library);
   library.revision++;library.updatedAt=new Date().toISOString();
   await fs.mkdir(directory,{recursive:true});
   const tmp=path.join(directory,`.library-${randomUUID()}.tmp`);
   try{await fs.writeFile(tmp,JSON.stringify(library,null,2)+'\n',{flag:'wx'});await fs.rename(tmp,file);}
   finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
   return {library,selectedId:result?.id??null};
  });queue=task.catch(()=>{});return task;
 }
 function preset(library,id){const p=library.presets.find(p=>p.id===id);if(!p)throw Error('Movement not found');return p;}
 return {
  read,
  create:({revision,name})=>edit(revision,library=>{
   name=text(name,80,true);
   if(library.presets.some(p=>!p.archived&&p.name.toLowerCase()===name.toLowerCase()))throw Error('A movement with that name already exists');
   if(library.presets.length>=500)throw Error('Library is full; export it before starting a new library');
   const p={id:randomUUID(),name,notes:'',source:null,positions:[],archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};library.presets.push(p);return p;
  }),
  design:({revision,design})=>edit(revision,library=>{
   if(design?.schema!=='odradek-motion-design-v1')throw Error('A motion design export is required');
   const name=text(design.name,80,true);
   if(library.presets.some(p=>!p.archived&&p.name.toLowerCase()===name.toLowerCase()))throw Error('A movement with that name already exists; choose a new version name');
   if(library.presets.length>=500)throw Error('Library is full');
   const score=compileScore({frames:design.frames,style:design.style,tempo:design.tempo});
   const canonical=exportScore(score,{name,source:'designed'}),now=new Date().toISOString();
   const positions=score.frames.map(f=>({id:randomUUID(),label:f.label,source:'designed',degrees:{...f.pose},radians:Object.fromEntries(PRESET_JOINTS.map(j=>[j,(f.pose[j]-(j==='shoulder'?90:0))*Math.PI/180])),durationMs:f.durationMs,holdMs:f.holdMs,measuredAt:null,capturedAt:null,designedAt:now}));
   const p={id:randomUUID(),name,notes:'Offline motion design. Timings and interpolation are previews, not measured arm motion.',source:'designed',positions,design:{style:canonical.style,tempo:canonical.tempo,previewDurationMs:canonical.previewDurationMs},archived:false,createdAt:now,updatedAt:now};library.presets.push(p);return p;
  }),
  update:({revision,id,name,notes,positionId,label,order,removePositionId,archived})=>edit(revision,library=>{
   const p=preset(library,id);
   if(name!==undefined){const n=text(name,80,true);if(library.presets.some(q=>q.id!==id&&!q.archived&&q.name.toLowerCase()===n.toLowerCase()))throw Error('A movement with that name already exists');p.name=n;}
   if(notes!==undefined)p.notes=text(notes,2000);
   if(archived!==undefined){if(typeof archived!=='boolean')throw Error('Invalid archive value');if(!archived&&library.presets.some(q=>q.id!==id&&!q.archived&&q.name.toLowerCase()===p.name.toLowerCase()))throw Error('An active movement already uses that name');p.archived=archived;}
   if(positionId!==undefined){const pos=p.positions.find(q=>q.id===positionId);if(!pos)throw Error('Position not found');pos.label=text(label,80,true);}
   if(removePositionId!==undefined){if(!p.positions.some(q=>q.id===removePositionId))throw Error('Position not found');p.positions=p.positions.filter(q=>q.id!==removePositionId);}
   if(order!==undefined){if(!Array.isArray(order)||order.length!==p.positions.length||new Set(order).size!==order.length||order.some(id=>!p.positions.some(q=>q.id===id)))throw Error('Order must contain each position exactly once');p.positions=order.map(id=>p.positions.find(q=>q.id===id));}
   if(p.design&&(order!==undefined||removePositionId!==undefined)){
    // The old anchor has no incoming transition. If moved into the sequence,
    // give it the ordinary 1.2-second design transition rather than a jump.
    p.positions.forEach((pos,i)=>{if(i>0&&pos.durationMs===0)pos.durationMs=1200;});
    if(p.positions.length>=2)p.design.previewDurationMs=compileScore({frames:framesFromPreset(p),style:p.design.style,tempo:p.design.tempo}).durationMs;
    else delete p.design.previewDurationMs;
   }
   p.updatedAt=new Date().toISOString();return p;
  }),
  capture:({revision,id,replacePositionId},readStatus)=>edit(revision,async library=>{
   const p=preset(library,id);if(p.archived)throw Error('Restore this movement before capturing');
   if(replacePositionId!==undefined&&!p.positions.some(q=>q.id===replacePositionId))throw Error('Position not found');
   if(!replacePositionId&&p.positions.length>=64)throw Error('A movement can contain up to 64 positions');
   const sample=captureStatus(await readStatus());
   if(p.source&&p.source!==sample.source)throw Error('Simulator and arm captures belong in separate movements');
   p.source=sample.source;
   const old=p.positions.find(q=>q.id===replacePositionId);
   if(p.positions.some(q=>q.id!==replacePositionId&&q.measuredAt===sample.measuredAt))throw Error('This reading was already captured. Wait for new feedback');
   const position={id:old?.id??randomUUID(),label:old?.label??`Position ${p.positions.length+1}`,...sample};
   if(old)p.positions[p.positions.indexOf(old)]=position;else p.positions.push(position);
   p.updatedAt=new Date().toISOString();return p;
  })
 };
}

export function exportPreset(preset){
 if(!preset||preset.archived)throw Error('Choose an active movement');
 return {schema:'roarm-movement-preset-v1',id:preset.id,name:preset.name,notes:preset.notes,source:preset.source,...(preset.design?{design:structuredClone(preset.design)}:{}),coordinateSystem:'controller-radians / manual-degrees (shoulder +90)',positions:preset.positions.map(p=>structuredClone(p)),replay:{positionOrder:'as-listed',entry:'Position 1 is the first target, not an assumed starting pose',execution:'Use the existing shared Controller and tools/movement.mjs after current admission; this file grants no movement authority',intermediatePathRecorded:false},updatedAt:preset.updatedAt};
}

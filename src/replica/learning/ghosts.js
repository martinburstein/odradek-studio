import * as THREE from 'three';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {createReplicaModel,applyReplicaPose,MM_SCALE} from '../rig.js';
import {frameAt,replayEpisode,snapshotOptions} from './run.js';

export const MAX_ITERATION_GHOSTS=256;
export function iterationGhostSnapshots(run,kind='best'){
 const all=snapshotOptions(run,{kind}),valid=all.filter(row=>row.failed!==true);
 const selected=valid.length<=MAX_ITERATION_GHOSTS?valid:Array.from({length:MAX_ITERATION_GHOSTS},(_,i)=>valid[Math.round(i*(valid.length-1)/(MAX_ITERATION_GHOSTS-1))]);
 return{selected,total:all.length,failed:all.length-valid.length,sampled:selected.length<valid.length};
}

// Merge the actual Blockbench parts by moving joint, then draw each joint in
// one instanced batch. All iterations share the existing Engine and CameraRig.
export function createIterationGhosts(scene,asset){
 const group=new THREE.Group();group.name='Saved iteration ghosts';group.visible=false;scene.add(group);
 const source=createReplicaModel(asset,{textures:false}),jointSet=new Set(Object.values(source.joints)),ancestors=new Set();
 for(const joint of jointSet)for(let p=joint;p;p=p.parent)ancestors.add(p);
 const joints={},bySource=new Map();
 function skeleton(node){if(!ancestors.has(node))return null;const copy=new THREE.Group();copy.name=node.name;copy.position.copy(node.position);copy.quaternion.copy(node.quaternion);copy.scale.copy(node.scale);bySource.set(node,copy);for(const child of node.children){const next=skeleton(child);if(next)copy.add(next);}return copy;}
 const root=skeleton(source.group);for(const[key,joint]of Object.entries(source.joints))joints[key]=bySource.get(joint);
 source.group.updateMatrixWorld(true);
 const pieces=new Map(),batches=[];
 source.group.traverse(mesh=>{if(!mesh.isMesh)return;let joint=mesh.parent;while(joint&&!jointSet.has(joint))joint=joint.parent;if(!joint||joint===source.joints.base||joint===source.joints.tool)return;
  const transformed=mesh.geometry.index?mesh.geometry.toNonIndexed():mesh.geometry.clone();
  for(const key of Object.keys(transformed.attributes))if(key!=='position')transformed.deleteAttribute(key);
  transformed.clearGroups();transformed.applyMatrix4(new THREE.Matrix4().copy(joint.matrixWorld).invert().multiply(mesh.matrixWorld));
  if(!pieces.has(joint.name))pieces.set(joint.name,[]);pieces.get(joint.name).push(transformed);
 });
 const material=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.025,depthWrite:false,side:THREE.FrontSide});
 for(const[name,parts]of pieces){const geometry=mergeGeometries(parts,false);parts.forEach(part=>part.dispose());geometry.computeBoundingBox();const mesh=new THREE.InstancedMesh(geometry,material,MAX_ITERATION_GHOSTS);mesh.name=`Iteration ghosts: ${name}`;mesh.count=0;mesh.frustumCulled=false;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);group.add(mesh);batches.push({mesh,bone:root.getObjectByName(name)});}
 const barrelGeometry=new THREE.CylinderGeometry(1,1,1,8),barrels=new THREE.InstancedMesh(barrelGeometry,material,MAX_ITERATION_GHOSTS);barrels.name='Iteration ghost styluses';barrels.count=0;barrels.frustumCulled=false;barrels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);group.add(barrels);source.dispose();
 let rows=[],epoch=0,disposed=false,enabled=false,key=null,lastTime=null,opacity=.2,summary=null,loadedRun=null,toolRadius=3.4;
 const bounds=new THREE.Box3(),transformedBounds=new THREE.Box3(),frontPoint=new THREE.Vector3(),rearPoint=new THREE.Vector3();
 const matrix=new THREE.Matrix4(),midpoint=new THREE.Vector3(),axis=new THREE.Vector3(),rotation=new THREE.Quaternion(),up=new THREE.Vector3(0,1,0),scale=new THREE.Vector3();
 const counts=()=>{for(const{mesh}of batches)mesh.count=rows.length;barrels.count=rows.length;material.opacity=opacity/Math.sqrt(Math.max(1,rows.length));};
 function setFrame(time){if(!enabled||disposed||!rows.length||time===lastTime)return;lastTime=time;
  rows.forEach(({episode},index)=>{const frame=frameAt(episode,time);if(!frame)return;applyReplicaPose(root,joints,frame.pose);for(const{mesh,bone}of batches)mesh.setMatrixAt(index,bone.matrixWorld);
   frontPoint.set(frame.front.x,frame.front.y,frame.front.z).multiplyScalar(MM_SCALE);rearPoint.set(frame.rear.x,frame.rear.y,frame.rear.z).multiplyScalar(MM_SCALE);
   axis.subVectors(frontPoint,rearPoint);const length=axis.length();axis.normalize();rotation.setFromUnitVectors(up,axis);midpoint.copy(frontPoint).add(rearPoint).multiplyScalar(.5);scale.set(toolRadius*MM_SCALE,length,toolRadius*MM_SCALE);matrix.compose(midpoint,rotation,scale);barrels.setMatrixAt(index,matrix);
  });for(const{mesh}of batches)mesh.instanceMatrix.needsUpdate=true;barrels.instanceMatrix.needsUpdate=true;
 }
 function clear(){epoch++;key=null;loadedRun=null;rows=[];lastTime=null;summary=null;bounds.makeEmpty();group.visible=false;counts();}
 async function load(run,{kind='best',taskId='train-horizontal',onProgress=()=>{}}={}){
  const nextKey=`${run.id}|${run.snapshots.length}|${run.history.at(-1)?.generation??0}|${kind}|${taskId}`;if(key===nextKey&&loadedRun===run){group.visible=enabled;if(summary)onProgress(summary);return;}
  clear();key=nextKey;loadedRun=run;toolRadius=run.experiment.tool.barrelRadius;const token=epoch,selection=iterationGhostSnapshots(run,kind);group.visible=enabled;
  for(const snapshot of selection.selected){if(token!==epoch||disposed||!enabled)return;const episode=replayEpisode(run,snapshot,{split:taskId.startsWith('test-')?'test':'train',taskId});rows.push({snapshot,episode});
   const color=new THREE.Color().setHSL(.88-.39*rows.length/Math.max(1,selection.selected.length),.75,.65);for(const{mesh}of batches)mesh.setColorAt(rows.length-1,color);barrels.setColorAt(rows.length-1,color);
   // Frame the actual merged arm bounds across the entire retained episode,
   // not only the selected solid arm's nominal working pose.
   for(const frame of episode.frames){applyReplicaPose(root,joints,frame.pose);for(const{mesh,bone}of batches)bounds.union(transformedBounds.copy(mesh.geometry.boundingBox).applyMatrix4(bone.matrixWorld));for(const p of [frame.front,frame.rear])bounds.expandByPoint(frontPoint.set(p.x,p.y,p.z).multiplyScalar(MM_SCALE));}
   if(rows.length%4===0){summary={loaded:rows.length,...selection,selected:undefined,ready:false,revision:token};onProgress(summary);await new Promise(resolve=>setTimeout(resolve,0));}
  }
  if(token!==epoch||disposed||!enabled)return;counts();for(const{mesh}of batches)if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;if(barrels.instanceColor)barrels.instanceColor.needsUpdate=true;
  if(!bounds.isEmpty())bounds.expandByScalar(Math.max(5,toolRadius)*MM_SCALE);
  lastTime=null;setFrame(0);summary={loaded:rows.length,...selection,selected:undefined,ready:true,revision:token};onProgress(summary);
 }
 return{group,load,setFrame,clear,setEnabled(value){enabled=Boolean(value);group.visible=enabled&&rows.length>0;if(!enabled)clear();},setOpacity(value){if(Number.isFinite(value))opacity=Math.max(.03,Math.min(.6,value));counts();},get count(){return rows.length;},get framePoints(){if(bounds.isEmpty())return[];return[0,1,2,3,4,5,6,7].map(i=>({x:i&1?bounds.max.x:bounds.min.x,y:i&2?bounds.max.y:bounds.min.y,z:i&4?bounds.max.z:bounds.min.z}));},get frames(){return rows.map(row=>({generation:row.snapshot.generation,frame:frameAt(row.episode,lastTime??0)}));},dispose(){if(disposed)return;disposed=true;clear();group.removeFromParent();for(const{mesh}of batches){mesh.geometry.dispose();mesh.dispose();}barrelGeometry.dispose();barrels.dispose();material.dispose();}};
}

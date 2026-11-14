import * as THREE from 'three';
import {MM_SCALE} from '../rig.js';
import {toolGeometry} from './geometry.js';

// Preview-only overlays for the existing Bot Crossing scene. Coordinates in
// simulator frames are millimeters in the replica's world frame.
const COLORS=Object.freeze({target:0xffb547,contact:0x53e6f2,miss:0xff5367,dig:0xff364f,collision:0xff1744,idle:0xa88cff,tilt:0xc5a5ff});
const CAPACITY=12000;
const point=(p)=>new THREE.Vector3(p.x*MM_SCALE,p.y*MM_SCALE,p.z*MM_SCALE);
const validPoint=p=>p&&[p.x,p.y,p.z].every(Number.isFinite);

export function createLearningVisuals(scene){
 if(!scene?.add)throw Error('An existing THREE scene is required.');
 const group=new THREE.Group();group.name='Stylus learning overlays';scene.add(group);
 const disposable=[];
 const material=(color,options={})=>{const m=new THREE.LineBasicMaterial({color,transparent:true,opacity:.92,...options});disposable.push(m);return m;};
 const sphereGeometry=new THREE.SphereGeometry(1,12,8);disposable.push(sphereGeometry);
 const marker=new THREE.Mesh(sphereGeometry,new THREE.MeshBasicMaterial({color:COLORS.target}));disposable.push(marker.material);marker.name='Desired target marker';marker.scale.setScalar(3.5*MM_SCALE);group.add(marker);
 const contactMarker=new THREE.Mesh(sphereGeometry,new THREE.MeshBasicMaterial({color:COLORS.contact}));disposable.push(contactMarker.material);contactMarker.name='Actual tip marker';contactMarker.scale.setScalar(2.6*MM_SCALE);group.add(contactMarker);
 const targetGeometry=new THREE.BufferGeometry();disposable.push(targetGeometry);
 const targetPositions=new Float32Array(CAPACITY*3);targetGeometry.setAttribute('position',new THREE.BufferAttribute(targetPositions,3));
 const targetLine=new THREE.Line(targetGeometry,material(COLORS.target));targetLine.name='Desired target path';group.add(targetLine);
 const trailGeometry=new THREE.BufferGeometry();disposable.push(trailGeometry);
 const trailPositions=new Float32Array(CAPACITY*3);const trailColors=new Float32Array(CAPACITY*3);
 trailGeometry.setAttribute('position',new THREE.BufferAttribute(trailPositions,3));trailGeometry.setAttribute('color',new THREE.BufferAttribute(trailColors,3));
 const trail=new THREE.Line(trailGeometry,material(0xffffff,{vertexColors:true}));trail.name='Actual tip trail';group.add(trail);
 // An angle reference in the selected endpoint's radial vertical plane.
 const guideGeometry=new THREE.BufferGeometry();disposable.push(guideGeometry);guideGeometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(6),3));
 const guide=new THREE.Line(guideGeometry,material(COLORS.tilt));guide.name='45 degree tilt guide';group.add(guide);
 // Low-poly illustrative barrel, active nibs at both ends, and a layered sleeve.
 const toolGroup=new THREE.Group();toolGroup.name='Modeled taped tool';group.add(toolGroup);
 const barrelMaterial=new THREE.MeshStandardMaterial({color:COLORS.idle,roughness:.62,metalness:.12});disposable.push(barrelMaterial);
 const barrel=new THREE.Mesh(new THREE.CylinderGeometry(3.4*MM_SCALE,3.4*MM_SCALE,1,10,1),barrelMaterial);disposable.push(barrel.geometry);barrel.name='Stylus barrel';toolGroup.add(barrel);
 const nibMaterials=[new THREE.MeshStandardMaterial({color:COLORS.contact,roughness:.5}),new THREE.MeshStandardMaterial({color:COLORS.target,roughness:.5})];disposable.push(...nibMaterials);
 const nibs=[0,1].map((end)=>{const mesh=new THREE.Mesh(sphereGeometry,nibMaterials[end]);mesh.name=end===0?'Front active endpoint':'Rear active endpoint';toolGroup.add(mesh);return mesh;});
 const sleeveMaterials=[new THREE.MeshStandardMaterial({color:COLORS.target,roughness:.9}),new THREE.MeshStandardMaterial({color:0xf5b84b,roughness:.9}),new THREE.MeshStandardMaterial({color:0xc78d32,roughness:.9})];disposable.push(...sleeveMaterials);
 const sleeves=[
  new THREE.Mesh(new THREE.CylinderGeometry(5.5*MM_SCALE,5.5*MM_SCALE,8*MM_SCALE,10),sleeveMaterials[0]),
  new THREE.Mesh(new THREE.CylinderGeometry(5.8*MM_SCALE,5.8*MM_SCALE,1.4*MM_SCALE,10),sleeveMaterials[1]),
  new THREE.Mesh(new THREE.CylinderGeometry(5.8*MM_SCALE,5.8*MM_SCALE,1.4*MM_SCALE,10),sleeveMaterials[2]),
 ];
 sleeves.forEach((mesh,index)=>{disposable.push(mesh.geometry);mesh.name=['Illustrative tape sleeve','Tape edge band one','Tape edge band two'][index];toolGroup.add(mesh);});
 let experiment=null,episode=null,count=0,lastTime=-Infinity,disposed=false;
 const put=(geometry,attribute,data,countVertices)=>{attribute.array.set(data);attribute.needsUpdate=true;geometry.setDrawRange(0,countVertices);geometry.computeBoundingSphere();};
 const reset=()=>{count=0;lastTime=-Infinity;trailGeometry.setDrawRange(0,0);targetGeometry.setDrawRange(0,0);};
 function setExperiment(value){experiment=value??null;}
 function setEpisode(value){episode=value??null;reset();if(!episode)return;
  const frames=Array.isArray(episode.frames)?episode.frames:[];let n=0;
  for(const f of frames){if(n>=CAPACITY||!validPoint(f?.target))break;const q=point(f.target);targetPositions.set([q.x,q.y,q.z],n*3);n++;}
  put(targetGeometry,targetGeometry.getAttribute('position'),targetPositions,n);
 }
 function setFrame(frame){if(!frame||!validPoint(frame.tip))return;
  const actual=point(frame.tip);contactMarker.position.copy(actual);contactMarker.visible=true;
  if(validPoint(frame.target)){
   const desired=point(frame.target);marker.position.copy(desired);marker.visible=true;
   const degrees=experiment?.tool?.targetTilt??45,theta=THREE.MathUtils.degToRad(Math.max(1,Math.min(89,degrees)));
   const yaw=Number.isFinite(frame.pose?.base)?frame.pose.base:0,end=experiment?.tool?.end??'front',sign=end==='front'?-1:1;
   const horizontal=Math.cos(theta)*22*MM_SCALE,vertical=Math.sin(theta)*22*MM_SCALE;
   const a=[desired.x,desired.y,desired.z],b=[desired.x+sign*Math.sin(yaw)*horizontal,desired.y+vertical,desired.z+sign*Math.cos(yaw)*horizontal];
   guideGeometry.getAttribute('position').array.set([...a,...b]);guideGeometry.getAttribute('position').needsUpdate=true;guideGeometry.computeBoundingSphere();guide.visible=true;
  }else{marker.visible=false;guide.visible=false;}
  if(validPoint(frame.front)&&validPoint(frame.rear)){
   const front=point(frame.front),rear=point(frame.rear),axis=new THREE.Vector3().subVectors(front,rear),length=axis.length();
   if(length>1e-8){axis.normalize();const orientation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),axis),tool=experiment?.tool??{};
    toolGroup.visible=true;barrel.position.copy(rear).lerp(front,.5);barrel.quaternion.copy(orientation);barrel.scale.set((tool.barrelRadius??3.4)/3.4,length,(tool.barrelRadius??3.4)/3.4);
    const activeEnd=tool.end==='rear'?1:0,nibRadius=(tool.nibRadius??1.5)*MM_SCALE;
    nibs[0].material=nibMaterials[activeEnd===0?0:1];nibs[0].position.copy(front);nibs[0].scale.setScalar(nibRadius);
    nibs[1].material=nibMaterials[activeEnd===1?0:1];nibs[1].position.copy(rear);nibs[1].scale.setScalar(nibRadius);
    let wrist;if(frame.pose&&experiment?.tool){try{wrist=point(toolGeometry(frame.pose,experiment.tool).wrist);}catch{wrist=null;}}
    if(!wrist){const frontReach=Number.isFinite(tool.frontReach)?tool.frontReach:107.5,rearReach=Number.isFinite(tool.rearReach)?tool.rearReach:42.5;wrist=rear.clone().lerp(front,rearReach/(frontReach+rearReach));}
    sleeves.forEach((mesh,index)=>{mesh.position.copy(wrist);mesh.position.addScaledVector(axis,[0,-5,5][index]*MM_SCALE);mesh.quaternion.copy(orientation);mesh.scale.set((tool.tapeRadius??5.5)/5.5,1,(tool.tapeRadius??5.5)/5.5);});
   }
  }else toolGroup.visible=false;
  if(Number.isFinite(frame.time)&&frame.time<=lastTime)return;
  if(count<CAPACITY){trailPositions.set([actual.x,actual.y,actual.z],count*3);
   const c=new THREE.Color(frame.collision?COLORS.collision:frame.dig?COLORS.dig:frame.desiredContact&&!frame.contact?COLORS.miss:frame.contact?COLORS.contact:COLORS.idle);
   trailColors.set([c.r,c.g,c.b],count*3);count++;lastTime=Number.isFinite(frame.time)?frame.time:lastTime+1;
   put(trailGeometry,trailGeometry.getAttribute('position'),trailPositions,count);
   trailGeometry.getAttribute('color').needsUpdate=true;
  }
 }
 function clear(){reset();marker.visible=contactMarker.visible=guide.visible=toolGroup.visible=false;episode=null;}
 function dispose(){if(disposed)return;disposed=true;group.removeFromParent();for(const r of new Set(disposable))r.dispose();}
 clear();
 return{setExperiment,setEpisode,setFrame,clear,dispose,group};
}

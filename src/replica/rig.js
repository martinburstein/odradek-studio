import * as THREE from 'three';
import {BOUNDS,degrees,validPose} from '../../apps/bot-crossing/src/arm-manual/model.js';
export const MM_SCALE=.035,BB_SCALE=MM_SCALE*10;
export const RIG_NAMES=Object.freeze({base:'01 · Base yaw / servo 11',shoulder:'02 · Shoulder / paired servos 12 + 13',elbow:'03 · Elbow / servo 14',gripper:'04 · Gripper drive / servo 15',leftJaw:'05 · Left jaw',rightJaw:'06 · Right jaw',tool:'07 · Held stylus / illustrative'});
const t2=Math.atan2(30,236.82),t3=Math.atan2(1.73,280.15);
export function applyReplicaPose(root,joints,pose){
 if(!validPose(pose))throw Error('Preview angles are outside joint travel.');
 joints.base.rotation.set(0,pose.base,0);joints.shoulder.rotation.set(pose.shoulder+t2,0,0);joints.elbow.rotation.set(pose.elbow+t3-t2,0,0);
 const opening=(BOUNDS.gripper[1]-degrees('gripper',pose.gripper))/(BOUNDS.gripper[1]-BOUNDS.gripper[0])*.65;
 joints.leftJaw.rotation.z=-opening;joints.rightJaw.rotation.z=opening;root.updateMatrixWorld(true);
}
export function validateAsset(asset){
 if(asset?.meta?.format_version!=='5.0'||asset.meta.model_format!=='free'||!Array.isArray(asset.elements)||!Array.isArray(asset.groups)||!Array.isArray(asset.outliner)||asset.elements.length>3000)throw Error('Use a Blockbench 5 Generic Model with the original joint groups.');
 const finite=v=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&Math.abs(n)<2000);
 const ids=new Set();for(const g of asset.groups){if(typeof g.uuid!=='string'||typeof g.name!=='string'||ids.has(g.uuid)||!finite(g.origin)||g.rotation&&!finite(g.rotation))throw Error('Invalid or duplicate group transform.');ids.add(g.uuid);}
 for(const name of Object.values(RIG_NAMES))if(asset.groups.filter(g=>g.name===name).length!==1)throw Error('Keep the named joint group: '+name);
 let vertices=0,faces=0;
 for(const e of asset.elements){if(typeof e.uuid!=='string'||typeof e.name!=='string'||ids.has(e.uuid)||!['cube','mesh'].includes(e.type)||!finite(e.origin??[0,0,0])||e.rotation&&!finite(e.rotation))throw Error('Invalid model element.');ids.add(e.uuid);
  if(e.type==='cube'&&(!finite(e.from)||!finite(e.to)))throw Error('Invalid cube bounds.');
  if(e.type==='mesh'&&(!e.vertices||!e.faces||Object.values(e.vertices).some(v=>!finite(v))||Object.values(e.faces).some(f=>!Array.isArray(f.vertices)||f.vertices.length<3||f.vertices.some(k=>!Object.hasOwn(e.vertices,k)))))throw Error('Invalid polygon mesh.');
  vertices+=Object.keys(e.vertices??{}).length;faces+=Object.keys(e.faces??{}).length;if(vertices>100000||faces>100000)throw Error('Use a low-poly asset under 100,000 vertices/faces.');
  for(const f of Object.values(e.faces??{})){
   if(f.texture!==undefined&&f.texture!==null&&(!Number.isInteger(f.texture)||f.texture<0||f.texture>=(asset.textures?.length??0)))throw Error('Face references an unknown texture.');
   if(f.uv){const values=e.type==='cube'?[f.uv]:Object.values(f.uv);if(values.some(v=>!Array.isArray(v)||v.length!==(e.type==='cube'?4:2)||v.some(n=>!Number.isFinite(n)||Math.abs(n)>100000)))throw Error('Invalid texture coordinates.');}
  }
 }
 const groupIds=new Set(asset.groups.map(g=>g.uuid)),elementIds=new Set(asset.elements.map(e=>e.uuid));
 const seen=new Set(),walk=(nodes,depth=0)=>{if(depth>32)throw Error('Model hierarchy is too deep.');for(const n of nodes){const id=typeof n==='string'?n:n?.uuid;if(!ids.has(id)||seen.has(id)||(typeof n==='string'?!elementIds.has(id):!groupIds.has(id)))throw Error('Missing, repeated or mistyped hierarchy node.');seen.add(id);if(typeof n!=='string'){if(!Array.isArray(n.children))throw Error('Invalid group children.');walk(n.children,depth+1);}}};walk(asset.outliner);
 if(seen.size!==ids.size)throw Error('All model parts must belong to the assembly hierarchy.');
 const groupByName=Object.fromEntries(asset.groups.map(g=>[g.name,g])),parent=new Map();function bind(nodes,p=null){for(const n of nodes){const id=typeof n==='string'?n:n.uuid;parent.set(id,p);if(typeof n!=='string')bind(n.children,id);}}bind(asset.outliner);
 if(parent.get(groupByName[RIG_NAMES.shoulder].uuid)!==groupByName[RIG_NAMES.base].uuid||parent.get(groupByName[RIG_NAMES.elbow].uuid)!==groupByName[RIG_NAMES.shoulder].uuid||parent.get(groupByName[RIG_NAMES.gripper].uuid)!==groupByName[RIG_NAMES.elbow].uuid||['leftJaw','rightJaw','tool'].some(key=>parent.get(groupByName[RIG_NAMES[key]].uuid)!==groupByName[RIG_NAMES.gripper].uuid))throw Error('Keep base → shoulder → elbow → gripper and jaw/tool hierarchy.');
 if(!Array.isArray(asset.textures)||asset.textures.length>32||(asset.textures??[]).some(t=>typeof t.name!=='string'||typeof t.source!=='string'||t.source.length>1500000||!/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(t.source)||[t.uv_width??8,t.uv_height??8].some(n=>!Number.isFinite(n)||n<1||n>16384)))throw Error('Use at most 32 embedded PNG textures with valid UV dimensions.');
 let pixels=0;for(const texture of asset.textures){let bytes;try{bytes=Uint8Array.from(atob(texture.source.split(',')[1]),c=>c.charCodeAt(0));}catch{throw Error('Invalid embedded PNG.');}if(bytes.length<33||[137,80,78,71,13,10,26,10].some((v,i)=>bytes[i]!==v))throw Error('Invalid embedded PNG.');const view=new DataView(bytes.buffer),w=view.getUint32(16),h=view.getUint32(20);pixels+=w*h;if(w<1||h<1||w>2048||h>2048||pixels>16000000)throw Error('Texture dimensions exceed this low-poly workbench limit.');}
 return asset;
}
export function createReplicaModel(asset,{textures=true,ghost=false,measured=false}={}){
 validateAsset(asset);
 const root=new THREE.Group();root.name='RoArm-M2-S replica';
 const bones=new Map(),parts=new Map(),geometries=[],maps=[];
 const materials=(asset.textures??[]).map(t=>{
  const color=ghost?0x67e3ec:measured?0xab9ce9:parseInt(t.name.match(/#([a-f0-9]{6})/i)?.[1]??'a0aaa4',16);
  const material=new THREE.MeshStandardMaterial({color,roughness:t.name.includes('Alloy')?.4:.72,metalness:t.name.includes('Brass')||t.name.includes('Alloy')?.45:.04,flatShading:true,side:THREE.DoubleSide,transparent:ghost||measured,opacity:ghost?.23:measured?.35:1,depthWrite:!ghost&&!measured,wireframe:measured});
  if(textures&&!ghost&&!measured){const map=new THREE.TextureLoader().load(t.source);map.colorSpace=THREE.SRGBColorSpace;map.magFilter=THREE.NearestFilter;maps.push(map);material.map=map;material.color.set(0xffffff);}
  if(t.name.includes('LED')){material.emissive.set(color);material.emissiveIntensity=.5;}
  return material;
 });
 const fallback=new THREE.MeshStandardMaterial({color:0xa4aaa4});
 const groups=new Map(asset.groups.map(g=>[g.uuid,g])),elements=new Map(asset.elements.map(e=>[e.uuid,e]));
 function element(e,parent,origin){
  const pivot=new THREE.Group();pivot.name=e.name;pivot.position.fromArray((e.origin??[0,0,0]).map((n,i)=>(n-origin[i])*BB_SCALE));pivot.rotation.set(...(e.rotation??[0,0,0]).map(n=>n*Math.PI/180),'ZYX');parent.add(pivot);
  let geometry,indices=[];
  if(e.type==='cube'){
   geometry=new THREE.BoxGeometry(...e.to.map((n,i)=>Math.max(.001,n-e.from[i])*BB_SCALE));
   const faceOrder=['east','west','up','down','south','north'];indices=faceOrder.map(f=>e.faces?.[f]?.texture??0);
   for(let i=0;i<geometry.groups.length;i++){
    geometry.groups[i].materialIndex=indices[i];const face=e.faces?.[faceOrder[i]],texture=asset.textures[indices[i]],w=texture?.uv_width??8,h=texture?.uv_height??8,rect=face?.uv??[0,0,w,h],uv=geometry.attributes.uv;
    for(let corner=0;corner<4;corner++){let u=corner%2,v=corner>1?1:0;for(let turn=0;turn<((face?.rotation??0)/90)%4;turn++)[u,v]=[v,1-u];uv.setXY(i*4+corner,(rect[0]+(rect[2]-rect[0])*u)/w,1-(rect[1]+(rect[3]-rect[1])*v)/h);}
   }
   const mesh=new THREE.Mesh(geometry,materials.length?materials:fallback);mesh.position.fromArray(e.to.map((n,i)=>((n+e.from[i])/2-(e.origin??[0,0,0])[i])*BB_SCALE));mesh.castShadow=true;mesh.receiveShadow=true;pivot.add(mesh);
  }else{
   geometry=new THREE.BufferGeometry();const positions=[],uv=[];
   for(const face of Object.values(e.faces)){const start=positions.length/3,texture=asset.textures[face.texture??0],w=texture?.uv_width??8,h=texture?.uv_height??8;for(let i=1;i<face.vertices.length-1;i++)for(const id of [face.vertices[0],face.vertices[i],face.vertices[i+1]]){positions.push(...e.vertices[id].map(n=>n*BB_SCALE));const u=face.uv?.[id]??[0,0];uv.push(u[0]/w,1-u[1]/h);}geometry.addGroup(start,positions.length/3-start,Number.isInteger(face.texture)?face.texture:0);}
   geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.computeVertexNormals();const mesh=new THREE.Mesh(geometry,materials.length?materials:fallback);mesh.castShadow=true;mesh.receiveShadow=true;pivot.add(mesh);
  }
  geometries.push(geometry);parts.set(e.name,pivot);
 }
 function hierarchy(nodes,parent,origin=[0,0,0]){for(const node of nodes){if(typeof node==='string'){element(elements.get(node),parent,origin);continue;}const g=groups.get(node.uuid),bone=new THREE.Group();bone.name=g.name;bone.position.fromArray(g.origin.map((n,i)=>(n-origin[i])*BB_SCALE));bone.rotation.set(...(g.rotation??[0,0,0]).map(n=>n*Math.PI/180),'ZYX');parent.add(bone);bones.set(g.name,bone);hierarchy(node.children,bone,g.origin);}}
 hierarchy(asset.outliner,root);
 const joints=Object.fromEntries(Object.entries(RIG_NAMES).map(([key,name])=>[key,bones.get(name)]));
 const tip=new THREE.Object3D();tip.name='Stylus TCP';tip.position.set(0,10.75*BB_SCALE,.12*BB_SCALE);joints.tool.add(tip);
 let currentPose=null;
 function setPose(pose){applyReplicaPose(root,joints,pose);currentPose={...pose};}
 function toolLength(mm){joints.tool.scale.y=mm/107.5;root.updateMatrixWorld(true);}
 const positionOf=joint=>joints[joint].getWorldPosition(new THREE.Vector3());
 return {group:root,joints,parts,setPose,toolLength,positionOf,tip:()=>tip.getWorldPosition(new THREE.Vector3()),pose:()=>currentPose&&{...currentPose},dispose(){root.removeFromParent();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());fallback.dispose();maps.forEach(t=>t.dispose());}};
}

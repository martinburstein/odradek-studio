import * as THREE from 'three'
import {Engine} from '../core/engine.js'
import {CameraRig} from '../core/camera.js'
import {Settings} from '../core/settings.js'
import {createRoArmModel,roarmForwardKinematics} from '../world/roarm-model.js'
import {createWorkbench} from './workbench.js'
import {JOINTS,BOUNDS,DEFAULT_POSE,POINTS,degrees,pullTarget,freshObservation,validPose} from './model.js'
import './style.css'

const embedded=new URLSearchParams(location.search).has('embedded'),studioOrigin='http://127.0.0.1:8790'
document.querySelector('#app').innerHTML=`<main class="joint-lab"><div id="world" aria-label="Interactive 3D RoArm above a keyboard and trackpad"></div>
 <header class="hud header"><div><p class="kicker">BOT CROSSING / ODRADEK</p><h1>JOINT MANUAL <span>01</span></h1></div><span class="preview-badge">PREVIEW</span></header>
 <nav class="hud joints" aria-label="Select arm joint">${JOINTS.map((j,i)=>`<button data-joint="${j}" aria-pressed="${i===0}"><small>0${i+1}</small>${j[0].toUpperCase()+j.slice(1)}<strong data-angle="${j}">—</strong></button>`).join('')}</nav>
 <section class="hud inspector"><div class="inspector-title"><span class="kicker">PULL TO POSITION</span><button id="reset-camera" aria-label="Reset 3D camera">↗</button></div><h2 id="selected-joint">Base</h2><p class="range" id="joint-range"></p><div class="power-scale" role="group" aria-label="Full pull angle">${[2,5,15].map(n=>`<button data-power="${n}" aria-pressed="${n===5}">${n}°</button>`).join('')}</div><p class="hint">Select a joint on the arm.<br>Pull its handle. Release to preview.</p><label class="grip-lock"><input id="grip-lock" type="checkbox" checked> Keep gripper fixed</label><button id="use-measured" disabled>Use live pose</button><p id="live-state" class="source-state">Example pose / waiting for feedback</p><p class="preview-note">Arrow length sets angle, not speed. No robot movement.</p></section>
 <section class="hud point-panel"><div class="inspector-title"><span class="kicker">LAPTOP / POINT MAP</span><button id="toggle-points" aria-expanded="true" aria-label="Collapse point map">−</button></div><div id="point-content"><div class="point-grid" role="group" aria-label="Select trackpad point">${POINTS.map(p=>`<button data-point="${p.id}" aria-pressed="false">${p.label}</button>`).join('')}<button data-point="PRINT_SCREEN" class="print-point" aria-pressed="true">Print Screen</button></div><p id="point-selection">Print Screen</p><button id="teach-point" ${embedded?'':'hidden'}>Teach this point in Studio →</button></div></section>
 <div id="joint-handles" aria-label="Drag a joint handle"></div><svg id="pull-arrow" aria-hidden="true"><defs><marker id="arrowhead" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 Z" fill="#ffad4b"/></marker></defs><path id="arrow-shadow"/><path id="arrow-line" marker-end="url(#arrowhead)"/><text id="arrow-text"/></svg>
 <footer class="hud footer"><span><b>ALT + DRAG</b> orbit · Drag empty space to pan · Wheel to zoom</span><span>LINKAGE PREVIEW / REFERENCE LAPTOP</span></footer><p id="notice" role="status" class="hud notice">Drag a joint to begin.</p></main>`
const $=id=>document.getElementById(id),stage=$('world')
const settings=new Settings({storageKey:'botcrossing.odradek-joint-manual.v1'});settings.transient=true
settings.applyAll({tiltShift:false,antialias:true,bloom:true,bloomStrength:.2,shadows:'medium',autoFrame:false,autoFocus:false,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches})
const engine=new Engine(settings).mount(stage),{scene,camera}=engine,rig=new CameraRig(camera,engine.canvas,settings)
rig.maxDistance=90;rig.worldLimit=45
scene.background=new THREE.Color('#0a101b');scene.fog=new THREE.Fog('#0a101b',65,150)
scene.add(new THREE.HemisphereLight(0xc7e9ff,0x151323,2.0))
const key=new THREE.DirectionalLight(0xffe0bb,3.2);key.position.set(-12,30,16);key.castShadow=true;Object.assign(key.shadow.camera,{left:-25,right:25,top:30,bottom:-25,near:1,far:100});key.shadow.normalBias=.04;scene.add(key)
const rim=new THREE.PointLight(0x338ee5,150,70);rim.position.set(12,13,-6);scene.add(rim)
const bench=createWorkbench(scene)
const solid=createRoArmModel(),ghost=createRoArmModel(),measured=createRoArmModel();scene.add(solid.group,ghost.group,measured.group)
for(const model of [solid,ghost,measured])model.group.getObjectByName('roarm-pilot-cab').visible=false
function tint(model,color,opacity){model.group.traverse(o=>{if(!o.isMesh)return;o.material=o.material.clone();o.material.color.set(color);o.material.emissive?.set(color);o.material.emissiveIntensity=.16;o.material.transparent=true;o.material.opacity=opacity;o.material.depthWrite=false;o.material.wireframe=model===measured})}
tint(ghost,0x6ed9f7,.27);tint(measured,0x9e91ff,.30)
for(const model of [solid,ghost,measured]){
 const material=new THREE.MeshStandardMaterial({color:model===solid?0xf1e6c9:model===ghost?0x6ed9f7:0x9e91ff,transparent:model!==solid,opacity:model===solid?1:.35})
 const pen=new THREE.Mesh(new THREE.CylinderGeometry(.075,.10,2.1,12),material);pen.position.y=1.75;pen.name='held-stylus';model.group.getObjectByName('roarm-wrist-tool').add(pen)
 const tip=new THREE.Mesh(new THREE.ConeGeometry(.07,.22,12),material);tip.rotation.z=Math.PI;tip.position.y=2.91;model.group.getObjectByName('roarm-wrist-tool').add(tip)
}
const jointNodes={base:'roarm-turntable',shoulder:'roarm-shoulder-pivot',elbow:'roarm-distal-joint',gripper:'roarm-wrist-tool'}
const handles=new Map(),handleMeshes=[]
for(const joint of JOINTS){
 const m=new THREE.Mesh(new THREE.SphereGeometry(joint==='base'?.65:.47,20,14),new THREE.MeshStandardMaterial({color:0x77d5ec,emissive:0x136786,emissiveIntensity:.45,transparent:true,opacity:.9,depthTest:false}));m.userData.joint=joint;m.renderOrder=20;scene.add(m);handleMeshes.push(m)
 const b=document.createElement('button');b.className='joint-handle';b.dataset.handle=joint;b.setAttribute('aria-label',`Pull ${joint} joint`);b.textContent=joint.toUpperCase();$('joint-handles').append(b);handles.set(joint,{mesh:m,button:b,node:solid.group.getObjectByName(jointNodes[joint])})
}
let pose={...DEFAULT_POSE},selected='base',point='PRINT_SCREEN',pull=null,fullPull=5,observation=null,seeded=false,userEdited=false,tween=null,context=null
function showPose(model,value){model.updateObservation({source:'simulation-preview',state:'measured',pose:value})}
showPose(solid,pose);ghost.group.visible=false;measured.group.visible=false;bench.selectPoint(point)
function home(){rig.focus(new THREE.Vector3(0,7,10),{distance:stage.clientHeight<600?70:58,elevated:true});rig.setOrbit(false);rig.desiredAzimuth=-.6;rig.desiredPolar=.87;rig.target.copy(rig.desiredTarget);rig.distance=rig.desiredDistance;rig.azimuth=rig.desiredAzimuth;rig.polar=rig.desiredPolar;rig.update(0)}
home();$('reset-camera').onclick=home
function notify(text){$('notice').textContent=text}
function renderControls(){
 for(const j of JOINTS){document.querySelector(`[data-angle="${j}"]`).textContent=degrees(j,pose[j]).toFixed(1)+'°';document.querySelector(`[data-joint="${j}"]`).setAttribute('aria-pressed',String(j===selected));handles.get(j).button.classList.toggle('selected',j===selected);handles.get(j).button.disabled=j==='gripper'&&$('grip-lock').checked;handles.get(j).mesh.material.color.set(j===selected?0xffa445:0x77d5ec)}
 $('selected-joint').textContent=selected[0].toUpperCase()+selected.slice(1);$('joint-range').textContent=`${degrees(selected,pose[selected]).toFixed(1)}° · motor range ${BOUNDS[selected][0]}–${BOUNDS[selected][1]}°`
}
function selectJoint(j){if(!JOINTS.includes(j))return;cancelPull();selected=j;renderControls();notify(j==='gripper'&&$('grip-lock').checked?'Gripper is fixed. Clear the preview lock to explore its motion.':'Pull the '+j+' handle to choose a relative angle.')}
document.querySelectorAll('[data-joint]').forEach(b=>b.onclick=()=>selectJoint(b.dataset.joint))
document.querySelectorAll('[data-power]').forEach(b=>b.onclick=()=>{cancelPull();fullPull=Number(b.dataset.power);document.querySelectorAll('[data-power]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)))})
$('grip-lock').onchange=()=>{cancelPull();renderControls()}
function selectPoint(id){if(id!=='PRINT_SCREEN'&&!POINTS.some(p=>p.id===id))return;point=id;bench.selectPoint(id);$('point-selection').textContent=POINTS.find(p=>p.id===id)?.label??'Print Screen';document.querySelectorAll('[data-point]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.point===id)))}
document.querySelectorAll('[data-point]').forEach(b=>b.onclick=()=>selectPoint(b.dataset.point))
$('toggle-points').onclick=()=>{const open=$('point-content').hidden;$('point-content').hidden=!open;$('toggle-points').textContent=open?'−':'+';$('toggle-points').setAttribute('aria-expanded',String(open))}
$('teach-point').onclick=()=>window.parent.postMessage({type:'odradek-preview-point',pointId:point},studioOrigin)
const screenVector=new THREE.Vector3(),ray=new THREE.Raycaster()
function project(v){screenVector.copy(v).project(camera);const r=stage.getBoundingClientRect();return {x:(screenVector.x*.5+.5)*r.width,y:(-.5*screenVector.y+.5)*r.height,z:screenVector.z}}
function tipOf(value){const p=roarmForwardKinematics(value);return new THREE.Vector3(p.x,p.y,p.z)}
function tangent(j){const a=project(tipOf(pose)),plus={...pose,[j]:pose[j]+.035},b=project(tipOf(plus));let x=b.x-a.x,y=b.y-a.y;if(j==='gripper'||Math.hypot(x,y)<.5){x=0;y=-1}const n=Math.hypot(x,y);return {x:x/n,y:y/n}}
function beginPull(e,j){
 if(e.button!==0||e.altKey||e.ctrlKey||e.shiftKey||pull||tween)return false
 if(j==='gripper'&&$('grip-lock').checked){selectJoint(j);return false}
 selected=j;renderControls();const r=stage.getBoundingClientRect(),anchor=project(handles.get(j).mesh.position)
 pull={pointerId:e.pointerId,joint:j,start:{x:e.clientX-r.left,y:e.clientY-r.top},anchor,axis:tangent(j),base:{...pose},pixels:0,result:null};rig.enabled=false
 engine.canvas.setPointerCapture(e.pointerId);e.preventDefault();e.stopImmediatePropagation();return true
}
for(const [j,{button}]of handles){button.addEventListener('pointerdown',e=>beginPull(e,j));button.onclick=()=>selectJoint(j);button.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;if(j==='gripper'&&$('grip-lock').checked)return;e.preventDefault();selected=j;const result=pullTarget(pose,j,(e.key==='ArrowLeft'||e.key==='ArrowDown'?-1:1)*44,fullPull);animateTo(result.pose);notify(`Preview ${j}: ${result.deltaDegrees>0?'+':''}${result.deltaDegrees.toFixed(1)}°`)})}
engine.canvas.addEventListener('pointerdown',e=>{
 if(e.button!==0||e.altKey||e.ctrlKey||e.shiftKey)return
 const r=stage.getBoundingClientRect();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera)
 const hit=ray.intersectObjects(handleMeshes,false)[0];if(hit)beginPull(e,hit.object.userData.joint)
},true)
function drawArrow(e){
 if(!pull||e.pointerId!==pull.pointerId)return
 const r=stage.getBoundingClientRect(),dx=e.clientX-r.left-pull.start.x,dy=e.clientY-r.top-pull.start.y
 pull.pixels=dx*pull.axis.x+dy*pull.axis.y;pull.result=pullTarget(pull.base,pull.joint,pull.pixels,fullPull)
 const start=pull.anchor,length=Math.max(-220,Math.min(220,pull.pixels)),end={x:start.x+pull.axis.x*length,y:start.y+pull.axis.y*length}
 const d=`M ${start.x} ${start.y} L ${end.x} ${end.y}`;$('arrow-line').setAttribute('d',d);$('arrow-shadow').setAttribute('d',d)
 $('arrow-text').setAttribute('x',Math.max(18,Math.min(r.width-160,end.x+14)));$('arrow-text').setAttribute('y',Math.max(30,end.y-18));$('arrow-text').textContent=`${pull.result.deltaDegrees>=0?'+':''}${pull.result.deltaDegrees.toFixed(1)}°${pull.result.limited?' / LIMIT':''}`;$('pull-arrow').classList.add('visible')
 showPose(ghost,pull.result.pose);ghost.group.visible=true;notify(`${pull.joint.toUpperCase()} · ${Math.round(pull.result.power*100)}% pull · release to preview`)
}
function cancelPull(){if(!pull)return;pull=null;rig.enabled=true;ghost.group.visible=false;$('pull-arrow').classList.remove('visible')}
function animateTo(target){userEdited=true;tween={from:{...pose},to:{...target},elapsed:0};pose={...target};renderControls()}
window.addEventListener('pointermove',drawArrow,true)
window.addEventListener('pointerup',e=>{if(!pull||e.pointerId!==pull.pointerId)return;const result=pull.result;cancelPull();if(result&&Math.abs(result.deltaDegrees)>.01){animateTo(result.pose);notify(`Preview moved ${result.joint} ${result.deltaDegrees>0?'+':''}${result.deltaDegrees.toFixed(1)}°. Real arm untouched.`)}else notify('Joint selected. Pull farther to preview a move.')},true)
window.addEventListener('pointercancel',cancelPull,true)
document.addEventListener('keydown',e=>{if(e.key==='Escape'||(e.key==='Alt'&&pull)){cancelPull();notify('Pull cancelled.')}})
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelPull()});window.addEventListener('blur',cancelPull)
function acceptObservation(value){
 observation=value
 if(freshObservation(value)){showPose(measured,value.pose);measured.group.visible=true;if(!seeded&&!userEdited&&!pull){pose={...value.pose};showPose(solid,pose);seeded=true;renderControls()}$('live-state').textContent=value.source==='hardware'?'Live arm / violet outline':'Simulator feedback / violet outline';$('use-measured').disabled=Boolean(pull)}
 else{measured.group.visible=false;$('live-state').textContent=seeded?'Live outline unavailable / preview retained':'Example pose / no live observation';$('use-measured').disabled=true}
}
$('use-measured').onclick=()=>{if(!freshObservation(observation))return;cancelPull();animateTo(observation.pose);notify('Preview reset to current measured joints.')}
let reading=false
async function readObservation(){if(reading||document.hidden)return;reading=true;try{const r=await fetch('/api/roarm/observation',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('Unavailable');acceptObservation(await r.json())}catch{acceptObservation(null)}finally{reading=false}}
window.addEventListener('message',event=>{if(event.origin!==studioOrigin||event.source!==window.parent||event.data?.type!=='odradek-preview-context')return;context=event.data;if(context.observation)acceptObservation(context.observation)})
if(embedded)window.parent.postMessage({type:'odradek-preview-ready'},studioOrigin)
else{void readObservation();setInterval(()=>void readObservation(),1900)}
engine.add({update(dt){
 if(!pull)rig.update(dt)
 if(tween){tween.elapsed+=dt;const t=Math.min(1,tween.elapsed/.5),ease=t*t*(3-2*t);showPose(solid,Object.fromEntries(JOINTS.map(j=>[j,tween.from[j]+(tween.to[j]-tween.from[j])*ease])));if(t===1)tween=null}
 solid.group.updateMatrixWorld(true)
 for(const [j,h]of handles){h.node.getWorldPosition(h.mesh.position);if(j==='base')h.mesh.position.y+=.35;const p=project(h.mesh.position);h.button.style.transform=`translate(${p.x+14}px,${p.y-18}px)`;h.button.hidden=p.z< -1||p.z>1;h.mesh.scale.setScalar(j===selected?1.12:1)}
 if(observation&&!freshObservation(observation)){measured.group.visible=false;$('use-measured').disabled=true;$('live-state').textContent='Live outline stale / preview retained'}
}})
renderControls();engine.start()
// Inspection only: no setter, hardware client or physical command API.
window.odradekJointPreview={snapshot:()=>({previewOnly:true,pose:{...pose},selectedJoint:selected,selectedPoint:point,pulling:Boolean(pull),fullPullDegrees:fullPull,measuredFresh:freshObservation(observation),jointBounds:BOUNDS})}

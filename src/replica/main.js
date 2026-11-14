import * as THREE from 'three';
import {Engine} from '../../apps/bot-crossing/src/core/engine.js';
import {CameraRig} from '../../apps/bot-crossing/src/core/camera.js';
import {Settings} from '../../apps/bot-crossing/src/core/settings.js';
import {createWorkbench} from '../../apps/bot-crossing/src/arm-manual/workbench.js';
import {DEFAULT_POSE,POINTS,freshObservation} from '../../apps/bot-crossing/src/arm-manual/model.js';
import {JOINTS,BOUNDS,degrees,radians,validPose,DEFAULT_DESK,DESK_FIELDS,validateDesk,slingshot,exactTarget,createPoseHistory} from './state.js';
import {MM_SCALE,createReplicaModel,validateAsset} from './rig.js';
import {SESSION_KEY,makeSession,parseSession} from './session.js';
import {mountWorkspace} from './workspace.js';
import {mountLearningPanel} from './learning/panel.js';
import {learningSetup} from './learning/setup.js';
import {learningFramePoints,fitLearningFrame,captureRigView,restoreRigView} from './learning/framing.js';
import modelText from '../../assets/roarm/RoArm-M2-S.bbmodel?raw';
import modelUrl from '../../assets/roarm/RoArm-M2-S.bbmodel?url';
import setupDiagramUrl from '../../assets/setup/setup.canonical.svg?url';
import setupSource from '../../references/setup/source.json';
import './style.css';
import '../../assets/theme/neon.css';

const parameters=new URLSearchParams(location.search),offlineLearning=parameters.has('offline-learning'),builtin=JSON.parse(modelText),embedded=parameters.has('embedded'),studioOrigin='http://127.0.0.1:8790';
document.title=`Odradek Studio ${__ODRADEK_VERSION__}`;
const title=j=>j[0].toUpperCase()+j.slice(1);
document.querySelector('#app').innerHTML=`<main class="replica-lab"><div id="world" aria-label="RoArm-M2-S replica and adjustable laptop workbench"></div>
 <header class="panel mast"><div><p class="eyebrow">ODRADEK LAB ${__ODRADEK_VERSION__} <span>BOT CROSSING ENGINE</span></p><h1>RoArm <span>M2-S</span></h1><p class="subhead">4 joints · 5 servos · editable Blockbench asset</p></div><div class="header-tools"><span class="preview-badge">SIMULATOR</span><button id="setup-toggle" aria-expanded="false">Setup map</button><button id="desk-toggle" aria-expanded="false">Desk setup</button><button id="session-toggle" aria-expanded="false">Session</button><button id="help-toggle" aria-expanded="false" aria-label="Show controls">?</button></div></header>
 <nav class="joint-bank panel" aria-label="Select a joint">${JOINTS.map((j,i)=>`<button data-joint="${j}" aria-pressed="${i===0}"><small>0${i+1}</small><span>${title(j)}</span><strong data-angle="${j}">—</strong></button>`).join('')}</nav>
 <section class="panel inspector" aria-label="Selected joint controls"><div class="panel-heading"><span class="eyebrow">JOINT CONTROL</span><button id="reset-camera" aria-label="Reset camera">↗</button></div><h2 id="selected-joint">Base</h2><p id="joint-range" class="muted"></p><div class="pull-scales" role="group" aria-label="Maximum angle per full pull">${[1,10,30].map(n=>`<button data-power="${n}" aria-pressed="${n===10}">${n}°</button>`).join('')}</div><p class="pull-hint">Pull back. Watch the arrow grow.<br>Release to turn the preview.</p><label class="field-label" for="target-angle">EXACT ANGLE / DEGREES</label><form id="exact-form"><input id="target-angle" type="number" step="any" inputmode="decimal"><button type="submit">Set preview</button></form><div class="small-actions"><button id="nudge-down" aria-label="Decrease selected joint by 0.1 degree">− 0.1°</button><button id="nudge-up" aria-label="Increase selected joint by 0.1 degree">+ 0.1°</button></div><label class="lock"><input id="grip-lock" type="checkbox" checked> Keep gripper fixed</label><div class="small-actions"><button id="undo" disabled>Undo</button><button id="redo" disabled>Redo</button></div><button id="use-measured" disabled>Use live pose</button><p id="live-state" class="live-state">Reference pose · no live outline</p><p class="scope-note">Preview only. No robot movement.</p></section>
 <section class="panel point-panel" aria-label="Reference point map"><div class="panel-heading"><span class="eyebrow">POINT MAP</span><button id="points-toggle" aria-expanded="true" aria-label="Collapse point map">−</button></div><div id="point-content"><div class="point-grid" role="group" aria-label="Select a target reference">${POINTS.map(p=>`<button data-point="${p.id}" aria-pressed="false">${p.label}</button>`).join('')}<button data-point="PRINT_SCREEN" aria-pressed="true">Print Screen</button></div><p id="point-name">Print Screen</p><button id="teach-point" ${embedded?'':'hidden'}>Teach in Studio →</button><p class="muted">Marks are references.<br>Desk dimensions pending.</p></div></section>
 <aside class="panel tip-readout"><span class="eyebrow">STYLUS TIP / MM</span><p id="tip-position">X — · Y — · Z —</p><small id="tip-clearance">Illustrative geometry</small></aside>
 <section id="setup" class="panel drawer setup" hidden aria-label="Canonical setup diagram"><div class="drawer-heading"><div><span class="eyebrow">${setupSource.id} / ILLUSTRATIVE SETUP</span><h2>The example setup.</h2></div><button data-close="setup">Close</button></div><p class="muted">Illustrative arrangement: arm left, laptop centered, tripod camera right, monitor behind. Adjust Desk setup for your own workspace; this diagram is not a calibrated physical registration.</p><div class="setup-image" id="setup-image"><img src="${setupDiagramUrl}" alt="Illustrative desk schematic: RoArm and downward stylus on the left, Dell laptop with blue Print Screen marker in the center, camera on a tripod and separate keyboard to the right, large monitor behind. Not to scale."></div><div class="drawer-actions"><button id="setup-zoom" aria-pressed="false">Enlarge diagram</button><a class="file-button" href="${setupDiagramUrl}" download="Odradek-Studio-Setup-Example.svg">Download SVG</a><span class="muted">Dimensions pending · desk settings stay unchanged</span></div></section>
 <div id="joint-handles" aria-label="Pull a joint handle"></div><svg id="pull-overlay" aria-hidden="true"><defs><marker id="arrowhead" markerWidth="9" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#ffbd69"/></marker></defs><path id="band"/><path id="arrow-line" marker-end="url(#arrowhead)"/><circle id="pull-cursor" r="8"/><text id="pull-label"/></svg>
 <section id="help" class="panel help" hidden><h2>Pull to pose.</h2><p>Grab a joint on the arm and pull along its guide. The stretched band goes toward your pointer; the arrow shows the opposite turn. A longer pull sets a larger angle. Release to animate.</p><p><b>Alt + drag</b> orbit · Empty drag pan · Wheel zoom<br><b>Escape</b> cancel · Arrow keys on a handle make small adjustments.</p><p>Exact angles affect the selected preview joint. The gripper starts fixed. The violet outline is live feedback; it never overwrites your draft. This is kinematic rehearsal: contact, load, collisions and precise gripper opening are not simulated.</p><button data-close="help">Got it</button></section>
 <section id="desk" class="panel drawer" hidden aria-label="Desk dimensions"><div class="drawer-heading"><div><span class="eyebrow">SETUP / MILLIMETERS</span><h2>Fit your desk.</h2></div><button data-close="desk">Close</button></div><p class="muted">Provisional layout until measured. X is right, Z forward from the arm base; Y is height above the table. Rotation uses degrees.</p><form id="desk-form"><div class="dimension-fields">${DESK_FIELDS.map(([key,label,value,min,max])=>`<label>${label}${key==='laptopYaw'?' / °':' / mm'}<input type="number" data-dimension="${key}" value="${value}" min="${min}" max="${max}" step="any" required></label>`).join('')}</div><div class="drawer-actions"><button type="submit">Apply dimensions</button><button type="button" id="desk-reset">Restore nominal</button><span id="dimension-state">Not physically registered</span></div></form></section>
 <section id="session" class="panel drawer session" hidden aria-label="Saved simulator session"><div class="drawer-heading"><div><span class="eyebrow">LOCAL / PORTABLE</span><h2>Continue anywhere.</h2></div><button data-close="session">Close</button></div><p class="muted">Committed preview changes save on this computer. Export a session to carry the pose, desk and exact Blockbench asset to another computer.</p><label class="field-label">Session name<input id="session-name" maxlength="80" value="Workbench"></label><div class="drawer-actions"><button id="export-session">Export session</button><label class="file-button">Open session<input id="import-session" type="file" accept=".json,.odradek.json"></label><a class="file-button" href="${modelUrl}" download="RoArm-M2-S.bbmodel">Blockbench source</a><label class="file-button">Load edited .bbmodel<input id="import-model" type="file" accept=".bbmodel"></label></div><p id="session-state" class="muted">Nothing is uploaded.</p></section>
 <footer class="panel footer"><span><b>ALT + DRAG</b> orbit · Wheel zoom</span><span id="asset-status">191 parts / Blockbench source</span><span>KINEMATIC PREVIEW</span></footer><p id="notice" role="status" class="panel notice">Select a joint, pull back, release.</p></main>`;
const $=id=>document.getElementById(id),stage=$('world');
let pose={...DEFAULT_POSE},desk={...DEFAULT_DESK},selected='base',selectedPoint='PRINT_SCREEN',asset=builtin,customAsset=false,fullPull=10,pull=null,tween=null,observation=null,hasDraft=false,angleDirty=false,saveWarning=false;
let history=createPoseHistory(pose),sessionName='Workbench';
let workspaceMode='manual',rehearsal=null,learning=null,learningDraft=null;
function notify(message){$('notice').textContent=message;}
const workspaces=!embedded&&!offlineLearning?mountWorkspace({root:document.querySelector('.replica-lab'),notify,initialMode:parameters.has('learning')?'preview':'manual'}):null;
const learningButton=document.createElement('button');learningButton.id='learning-toggle';learningButton.textContent='Learning Lab';learningButton.setAttribute('aria-expanded','false');document.querySelector('.header-tools').prepend(learningButton);
const outlineLabel=document.createElement('label');outlineLabel.className='lock outline-control';outlineLabel.innerHTML='<input id="show-live" type="checkbox"> Show live outline';$('use-measured').after(outlineLabel);
try{const raw=localStorage.getItem(SESSION_KEY);if(raw){const restored=parseSession(raw);pose=restored.pose;desk=restored.desk;selected=restored.selectedJoint;selectedPoint=restored.selectedPoint;fullPull=restored.fullPull;$('grip-lock').checked=restored.gripLocked;$('show-live').checked=restored.showLive;sessionName=restored.name;if(restored.asset){asset=restored.asset;customAsset=true;}hasDraft=true;history=createPoseHistory(pose);}}catch{saveWarning=true;}
$('session-name').value=sessionName;
const settings=new Settings({storageKey:'odradek.replica.graphics'});settings.transient=true;settings.applyAll({renderScale:1,autoQuality:false,tiltShift:false,antialias:true,bloom:true,bloomStrength:.15,shadows:'low',autoFrame:false,autoFocus:false,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches});
const engine=new Engine(settings).mount(stage),{scene,camera}=engine,rig=new CameraRig(camera,engine.canvas,settings);rig.maxDistance=100;rig.worldLimit=50;
scene.background=new THREE.Color('#100b10');scene.fog=new THREE.Fog('#100b10',75,160);scene.add(new THREE.HemisphereLight(0xffe4c4,0x30202c,2.7));
const light=new THREE.DirectionalLight(0xffe6bd,3.3);light.position.set(-15,35,20);light.castShadow=true;Object.assign(light.shadow.camera,{left:-30,right:30,top:35,bottom:-30,near:1,far:110});light.shadow.normalBias=.03;scene.add(light);
const rim=new THREE.DirectionalLight(0xffa565,1.8);rim.position.set(20,18,-15);scene.add(rim);
const bench=createWorkbench(scene);bench.group.getObjectByName('work-table').material.color.set('#261a21');
let solid,ghost,measured;
function installAsset(next){validateAsset(next);const built=[createReplicaModel(next),createReplicaModel(next,{textures:false,ghost:true}),createReplicaModel(next,{textures:false,measured:true})];for(const old of [solid,ghost,measured])old?.dispose();[solid,ghost,measured]=built;scene.add(solid.group,ghost.group,measured.group);solid.setPose(pose);ghost.group.visible=false;measured.group.visible=false;asset=next;$('asset-status').textContent=`${asset.elements.length} parts / Blockbench source`;applyDesk(desk);}
const handles=new Map(),hitMeshes=[],ray=new THREE.Raycaster(),projected=new THREE.Vector3();
for(const joint of JOINTS){const mesh=new THREE.Mesh(new THREE.SphereGeometry(.45,16,12),new THREE.MeshStandardMaterial({color:0x71d9e9,emissive:0x21596a,emissiveIntensity:.4,depthTest:false}));mesh.userData.joint=joint;mesh.renderOrder=25;scene.add(mesh);hitMeshes.push(mesh);const button=document.createElement('button');button.className='joint-handle';button.textContent=joint.toUpperCase();button.setAttribute('aria-label',`Pull ${joint} joint`);$('joint-handles').append(button);handles.set(joint,{mesh,button});}
const guideMaterial=new THREE.LineBasicMaterial({color:0xffbd69,transparent:true,opacity:.7,depthTest:false});let guide=new THREE.Line(new THREE.BufferGeometry(),guideMaterial);guide.renderOrder=20;scene.add(guide);
const tipMarker=new THREE.Mesh(new THREE.OctahedronGeometry(.12),new THREE.MeshBasicMaterial({color:0x8de9ee,depthTest:false}));tipMarker.renderOrder=24;scene.add(tipMarker);
function project(position){projected.copy(position).project(camera);const r=stage.getBoundingClientRect();return{x:(projected.x*.5+.5)*r.width,y:(-.5*projected.y+.5)*r.height,z:projected.z};}
let learningCamera=null,learningExperiment=null;
function frameLearning(){
 if(!learning?.active||!learningExperiment)return;
 const panelElement=document.querySelector('.learning-panel'),canvas=stage.getBoundingClientRect(),panel=panelElement.getBoundingClientRect(),hud=document.querySelector('.learning-hud').getBoundingClientRect(),mast=document.querySelector('.mast').getBoundingClientRect();
 const bottomPanel=canvas.width<=900||panelElement.classList.contains('learning-compact'),right=bottomPanel?canvas.width-16:Math.max(80,panel.left-canvas.left-20),bottom=bottomPanel?Math.max(180,panel.top-canvas.top-16):canvas.height-90;
 const rectangle={left:Math.min(hud.right-canvas.left+16,right-100),right,top:mast.bottom-canvas.top+16,bottom};
 if(rectangle.bottom-rectangle.top<50)return;
 const view=fitLearningFrame([...learningFramePoints(learningExperiment),...(learning?.ghostFramePoints??[])],{width:canvas.width,height:canvas.height,fov:camera.fov,rectangle,maxDistance:rig.maxDistance});
 rig.focus(new THREE.Vector3(view.target.x,view.target.y,view.target.z),{distance:view.distance,elevated:true});rig.setOrbit(false);rig.desiredAzimuth=view.azimuth;rig.desiredPolar=view.polar;rig.target.copy(rig.desiredTarget);rig.distance=rig.desiredDistance;rig.azimuth=rig.desiredAzimuth;rig.polar=rig.desiredPolar;rig.update(0);
}
function home(){if(learning?.active){frameLearning();return;}rig.focus(new THREE.Vector3(0,8.8,7),{distance:stage.clientHeight<600?64:45,elevated:true});rig.setOrbit(false);rig.desiredAzimuth=-.62;rig.desiredPolar=.94;rig.target.copy(rig.desiredTarget);rig.distance=rig.desiredDistance;rig.azimuth=rig.desiredAzimuth;rig.polar=rig.desiredPolar;rig.update(0);}
function applyDesk(value){desk=validateDesk(value);const laptop=bench.laptop;laptop.position.set(desk.laptopX*MM_SCALE,desk.laptopHeight*MM_SCALE-.202,desk.laptopZ*MM_SCALE);laptop.scale.set(desk.laptopWidth/(11.25/MM_SCALE),1,desk.laptopDepth/(7.42/MM_SCALE));laptop.rotation.y=desk.laptopYaw*Math.PI/180;const pad=laptop.getObjectByName('trackpad-point-map');pad.scale.set(desk.trackpadWidth/115/laptop.scale.x,1,desk.trackpadDepth/67/laptop.scale.z);
 // The captured texture's PrtSc is column 12 of 14. Center its marker on that
 // actual key rather than the neighboring Delete key in the initial diagram.
 const keyWidth=(2020-10*15)/14,centerU=(24+12*(keyWidth+10)+keyWidth/2)/2048; laptop.getObjectByName('marked-print-screen-key').position.set((centerU-.5)*10.5,.27,-1.15-(.5-81/900)*4.45);
 for(const model of [solid,ghost,measured])model?.toolLength(desk.toolLength);document.querySelectorAll('[data-dimension]').forEach(input=>{input.value=desk[input.dataset.dimension];});}
function sessionData(includeAsset=false){return makeSession({pose,desk,asset:includeAsset||customAsset?asset:null,name:$('session-name').value,selectedJoint:selected,selectedPoint,fullPull,gripLocked:$('grip-lock').checked,showLive:$('show-live').checked});}
function persist(){try{localStorage.setItem(SESSION_KEY,JSON.stringify(sessionData()));$('session-state').textContent='Saved on this computer. Export to carry it to another.';}catch{$('session-state').textContent='Local save unavailable. Export a session to keep this draft.';}}
function render(){
 for(const joint of JOINTS){document.querySelector(`[data-angle="${joint}"]`).textContent=degrees(joint,pose[joint]).toFixed(2)+'°';document.querySelector(`[data-joint="${joint}"]`).setAttribute('aria-pressed',String(selected===joint));const h=handles.get(joint);h.button.classList.toggle('selected',selected===joint);h.button.disabled=joint==='gripper'&&$('grip-lock').checked;h.mesh.material.color.set(selected===joint?0xffbd69:0x71d9e9);}
 $('selected-joint').textContent=title(selected);$('joint-range').textContent=`${BOUNDS[selected][0]}° to ${BOUNDS[selected][1]}° · ${selected==='shoulder'?'paired drive':selected==='gripper'?'motor angle':'joint travel'}`;
 if(!angleDirty&&document.activeElement!==$('target-angle'))$('target-angle').value=degrees(selected,pose[selected]).toFixed(3);
 $('target-angle').min=BOUNDS[selected][0];$('target-angle').max=BOUNDS[selected][1];$('undo').disabled=!history.canUndo();$('redo').disabled=!history.canRedo();document.querySelectorAll('[data-power]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.power)===fullPull)));
}
function cancelPull(){if(!pull)return;try{if(engine.canvas.hasPointerCapture(pull.pointer))engine.canvas.releasePointerCapture(pull.pointer);}catch{}pull=null;rig.enabled=true;ghost.group.visible=false;$('pull-overlay').classList.remove('active');}
function movePreview(next,{record=true}={}){cancelPull();if(record)history.push(next);tween={from:solid.pose()??{...pose},to:{...next},elapsed:0};pose={...next};hasDraft=true;angleDirty=false;render();persist();}
function chooseJoint(joint){if(!JOINTS.includes(joint))return;cancelPull();selected=joint;angleDirty=false;render();notify(joint==='gripper'&&$('grip-lock').checked?'Gripper is fixed. Clear the preview lock to explore it.':`Pull ${joint} back along its guide, or enter an exact preview angle.`);}
document.querySelectorAll('[data-joint]').forEach(button=>button.onclick=()=>chooseJoint(button.dataset.joint));
document.querySelectorAll('[data-power]').forEach(button=>button.onclick=()=>{cancelPull();fullPull=Number(button.dataset.power);render();persist();});
$('target-angle').oninput=()=>{angleDirty=true;};
$('exact-form').onsubmit=event=>{event.preventDefault();if(selected==='gripper'&&$('grip-lock').checked){notify('Gripper is fixed. Clear its preview lock first.');return;}try{if(!$('target-angle').value.trim())throw Error('Enter a target angle.');movePreview(exactTarget(pose,selected,Number($('target-angle').value)));notify(`${title(selected)} preview set to ${degrees(selected,pose[selected]).toFixed(2)}°.`);}catch(error){notify(error.message);}};
for(const[id,delta]of [['nudge-down',-.1],['nudge-up',.1]])$(id).onclick=()=>{if(selected==='gripper'&&$('grip-lock').checked){notify('Gripper is fixed.');return;}try{movePreview(exactTarget(pose,selected,Math.round((degrees(selected,pose[selected])+delta)*10000)/10000));}catch(error){notify(error.message);}};
$('grip-lock').onchange=()=>{cancelPull();render();persist();};$('undo').onclick=()=>movePreview(history.undo(),{record:false});$('redo').onclick=()=>movePreview(history.redo(),{record:false});$('reset-camera').onclick=home;
function tangent(joint){
 if(joint==='gripper'){const origin=project(solid.positionOf('gripper')),v=new THREE.Vector3(1,0,0).applyQuaternion(solid.joints.gripper.getWorldQuaternion(new THREE.Quaternion())).add(solid.positionOf('gripper')),end=project(v),n=Math.hypot(end.x-origin.x,end.y-origin.y);return n>.5?{x:(end.x-origin.x)/n,y:(end.y-origin.y)/n}:{x:1,y:0};}
 const current=solid.pose()??pose,at=project(solid.tip()),direction=degrees(joint,current[joint])+.12<=BOUNDS[joint][1]?1:-1,probe={...current,[joint]:current[joint]+.002*direction};
 // The differential probe is preview geometry only; do not change the solid.
 ghost.setPose(probe);const next=project(ghost.tip()),n=Math.hypot(next.x-at.x,next.y-at.y);return n>.01?{x:(next.x-at.x)*direction/n,y:(next.y-at.y)*direction/n}:{x:0,y:-1};
}
function beginPull(event,joint){
 if(learning?.active||event.button!==0||event.altKey||event.ctrlKey||event.shiftKey||pull||tween)return;
 if(joint==='gripper'&&$('grip-lock').checked){chooseJoint(joint);return;}
 selected=joint;angleDirty=false;render();const rect=stage.getBoundingClientRect();pull={pointer:event.pointerId,joint,start:{x:event.clientX-rect.left,y:event.clientY-rect.top},anchor:project(solid.positionOf(joint)),axis:tangent(joint),base:{...pose},result:null};rig.enabled=false;engine.canvas.setPointerCapture(event.pointerId);event.preventDefault();event.stopImmediatePropagation();notify('Pull back. The arrow shows the proposed turn.');
}
for(const[joint,{button}]of handles){button.addEventListener('pointerdown',event=>beginPull(event,joint));button.onclick=()=>{if(!pull)chooseJoint(joint);};button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();if(joint==='gripper'&&$('grip-lock').checked)return;chooseJoint(joint);try{movePreview(exactTarget(pose,joint,degrees(joint,pose[joint])+(['ArrowLeft','ArrowDown'].includes(event.key)?-.1:.1)));}catch(error){notify(error.message);}};}
engine.canvas.addEventListener('pointerdown',event=>{if(event.button!==0||event.altKey||event.ctrlKey||event.shiftKey)return;const rect=stage.getBoundingClientRect();ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),camera);const hit=ray.intersectObjects(hitMeshes,false)[0];if(hit)beginPull(event,hit.object.userData.joint);},true);
window.addEventListener('pointermove',event=>{
 if(!pull||pull.pointer!==event.pointerId)return;const rect=stage.getBoundingClientRect(),dx=event.clientX-rect.left-pull.start.x,dy=event.clientY-rect.top-pull.start.y,projection=dx*pull.axis.x+dy*pull.axis.y;
 pull.result=slingshot(pull.base,pull.joint,projection,fullPull);const {anchor:a,axis,result}=pull,stretch=Math.max(-180,Math.min(180,projection)),cursor={x:a.x+axis.x*stretch,y:a.y+axis.y*stretch},sign=Math.sign(result.delta)||-Math.sign(projection)||1,length=22+result.power*132,end={x:a.x+axis.x*sign*length,y:a.y+axis.y*sign*length};
 $('band').setAttribute('d',`M ${a.x-axis.y*9} ${a.y+axis.x*9} L ${cursor.x} ${cursor.y} L ${a.x+axis.y*9} ${a.y-axis.x*9}`);$('arrow-line').setAttribute('d',`M ${a.x} ${a.y} L ${end.x} ${end.y}`);$('pull-cursor').setAttribute('cx',cursor.x);$('pull-cursor').setAttribute('cy',cursor.y);$('pull-label').setAttribute('x',Math.max(12,Math.min(rect.width-180,end.x+12)));$('pull-label').setAttribute('y',Math.max(25,end.y-18));$('pull-label').textContent=`${result.delta>=0?'+':''}${result.delta.toFixed(2)}° → ${result.target.toFixed(2)}°${result.limited?' / LIMIT':''}`;$('pull-overlay').classList.add('active');ghost.setPose(result.pose);ghost.group.visible=true;notify(`${title(pull.joint)} · ${Math.round(result.power*100)}% pull · release to preview`);
},true);
window.addEventListener('pointerup',event=>{if(!pull||pull.pointer!==event.pointerId)return;const result=pull.result;cancelPull();if(result&&Math.abs(result.delta)>.001){movePreview(result.pose);notify(`Preview: ${title(result.joint)} ${result.delta>=0?'+':''}${result.delta.toFixed(2)}°. Robot unchanged.`);}else notify(result?.limited?'This joint is at its preview limit. Pull the other way.':'Joint selected. Pull farther along the guide.');},true);
window.addEventListener('pointercancel',cancelPull,true);window.addEventListener('blur',cancelPull);document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelPull();});document.addEventListener('keydown',event=>{if(event.key==='Escape'){cancelPull();for(const id of ['setup','desk','session','help']){$(id).hidden=true;$(id+'-toggle').setAttribute('aria-expanded','false');}notify('Pull cancelled.');}if(event.key==='Alt'&&pull)cancelPull();});
function selectPoint(id){if(id!=='PRINT_SCREEN'&&!POINTS.some(p=>p.id===id))return;selectedPoint=id;bench.selectPoint(id);$('point-name').textContent=POINTS.find(p=>p.id===id)?.label??'Print Screen';document.querySelectorAll('[data-point]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.point===id)));}
document.querySelectorAll('[data-point]').forEach(button=>button.onclick=()=>{selectPoint(button.dataset.point);persist();});$('points-toggle').onclick=()=>{const open=$('point-content').hidden;$('point-content').hidden=!open;$('points-toggle').setAttribute('aria-expanded',String(open));$('points-toggle').textContent=open?'−':'+';};$('teach-point').onclick=()=>window.parent.postMessage({type:'odradek-preview-point',pointId:selectedPoint},studioOrigin);
for(const id of ['setup','desk','session','help']){$(id+'-toggle').onclick=()=>{cancelPull();const open=$(id).hidden;for(const other of ['setup','desk','session','help']){ $(other).hidden=other!==id||!open;$(other+'-toggle').setAttribute('aria-expanded',String(other===id&&open));}};}
$('setup-zoom').onclick=()=>{const enlarged=$('setup-image').classList.toggle('enlarged');$('setup-zoom').setAttribute('aria-pressed',String(enlarged));$('setup-zoom').textContent=enlarged?'Fit diagram':'Enlarge diagram';};
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>{$(button.dataset.close).hidden=true;$(button.dataset.close+'-toggle').setAttribute('aria-expanded','false');});
$('desk-form').onsubmit=event=>{event.preventDefault();try{applyDesk(Object.fromEntries([...document.querySelectorAll('[data-dimension]')].map(input=>[input.dataset.dimension,Number(input.value)])));hasDraft=true;persist();$('dimension-state').textContent='Saved layout · physical registration pending';notify('Desk dimensions applied to the preview.');}catch(error){notify(error.message);}};$('desk-reset').onclick=()=>{applyDesk(DEFAULT_DESK);persist();notify('Nominal dimensions restored.');};
$('session-name').onchange=persist;
function download(name,text,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
$('export-session').onclick=()=>{try{const data=sessionData(true);download(data.name.replace(/[^a-z0-9_-]/gi,'-')+'.odradek.json',JSON.stringify(data,null,2)+'\n');notify('Session exported: preview pose, desk and Blockbench asset.');}catch(error){notify(error.message);}};
$('import-session').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>6000000)throw Error('Session file must be under 6 MB.');const session=parseSession(await file.text()),next=session.asset??builtin;validateAsset(next);cancelPull();tween=null;pose=session.pose;desk=session.desk;selected=session.selectedJoint;fullPull=session.fullPull;$('grip-lock').checked=session.gripLocked;$('show-live').checked=session.showLive;customAsset=Boolean(session.asset);installAsset(next);selectPoint(session.selectedPoint);history=createPoseHistory(pose);$('session-name').value=session.name;hasDraft=true;angleDirty=false;render();persist();refreshLiveOutline();notify('Session restored. Preview only; no robot request.');}catch(error){notify('Session not opened: '+error.message);}finally{event.target.value='';}};
$('import-model').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>6000000)throw Error('Model must be under 6 MB.');const next=validateAsset(JSON.parse(await file.text()));cancelPull();tween=null;installAsset(next);customAsset=true;hasDraft=true;persist();notify('Edited Blockbench asset loaded. Joint controls remain preview-only.');}catch(error){notify('Model not loaded: '+error.message);}finally{event.target.value='';}};
function refreshLiveOutline(){const fresh=freshObservation(observation);measured.group.visible=!learning?.active&&fresh&&$('show-live').checked;$('use-measured').disabled=!fresh||Boolean(pull);$('live-state').textContent=fresh?`${observation.source==='hardware'?'Live arm':'Controller simulator'} · ${$('show-live').checked?'violet outline':'outline hidden'}`:'Live outline unavailable · preview retained';}
function acceptObservation(value){observation=value;if(freshObservation(value)){measured.setPose(value.pose);if(!learning?.active&&!hasDraft&&!pull&&!tween){pose={...value.pose};solid.setPose(pose);history=createPoseHistory(pose);render();hasDraft=true;}}refreshLiveOutline();}
$('show-live').onchange=()=>{refreshLiveOutline();persist();};
$('use-measured').onclick=()=>{if(!freshObservation(observation))return;movePreview(observation.pose);notify('Preview reset to current measured pose.');};
let reading=false;async function readObservation(){if(offlineLearning||learning?.active||reading||document.hidden)return;reading=true;try{const r=await fetch('/api/roarm/observation',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error();acceptObservation(await r.json());}catch{acceptObservation(null);}finally{reading=false;}}
window.addEventListener('message',event=>{if(event.origin===studioOrigin&&event.source===window.parent&&event.data?.type==='odradek-preview-context')acceptObservation(event.data.observation);});
function updateGuide(){
 const bone=solid.joints[selected];if(guide.parent===bone)return;guide.removeFromParent();bone.add(guide);const r=selected==='base'?3.5:selected==='shoulder'?2.6:2.2,points=[];
 for(let i=0;i<=40;i++){const a=(i/40-.5)*Math.PI*1.2;points.push(selected==='base'?new THREE.Vector3(Math.sin(a)*r,0,Math.cos(a)*r):selected==='gripper'?new THREE.Vector3(Math.sin(a)*r,Math.cos(a)*r,0):new THREE.Vector3(0,Math.cos(a)*r,Math.sin(a)*r));}
 guide.geometry.dispose();guide.geometry=new THREE.BufferGeometry().setFromPoints(points);
}
installAsset(asset);selectPoint(selectedPoint);home();render();if(saveWarning)notify('Previous local draft could not be read. Use Open session to restore an export.');
learning=mountLearningPanel({
 root:document.querySelector('.replica-lab'),scene,notify,getAsset:()=>asset,
 onFrame:frameLearning,
 getContext:()=>learningSetup(pose,desk,learningDraft),
 onOpen(){
  learningCamera=captureRigView(rig);
  learningDraft={desk:{...desk},pose:{...pose},fields:Object.fromEntries([...document.querySelectorAll('[data-dimension]')].map(input=>[input.dataset.dimension,input.value]))};
  cancelPull();tween=null;rehearsal=null;workspaces?.select('preview');ghost.group.visible=measured.group.visible=false;learningButton.setAttribute('aria-expanded','true');
  for(const id of ['setup','desk','session','help'])$(id).hidden=true;
  for(const id of ['setup-toggle','desk-toggle','session-toggle','help-toggle'])$(id).disabled=true;
 },
 onClose(){
  if(learningDraft){applyDesk(learningDraft.desk);solid.setPose(learningDraft.pose);for(const input of document.querySelectorAll('[data-dimension]'))input.value=learningDraft.fields[input.dataset.dimension];learningDraft=null;}
  solid.joints.tool.visible=true;tipMarker.visible=true;learningButton.setAttribute('aria-expanded','false');
  for(const id of ['setup-toggle','desk-toggle','session-toggle','help-toggle'])$(id).disabled=false;
  if(learningCamera){restoreRigView(rig,learningCamera);learningCamera=null;}learningExperiment=null;
  render();refreshLiveOutline();
 },
 onExperiment(experiment){applyDesk(experiment.desk);solid.joints.tool.visible=false;tipMarker.visible=false;learningExperiment=experiment;frameLearning();},
 onPose(next){solid.setPose(next);}
});
learningButton.onclick=()=>learning.toggle();
document.querySelector('.replica-lab').addEventListener('odradek-learning-layout',frameLearning);
window.addEventListener('resize',()=>{if(learning?.active)frameLearning();});
window.odradekWorkspace?.subscribeLearning?.(visible=>visible?learning.open():learning.close());
window.odradekWorkspace?.beforeClose?.(()=>learning.saveBeforeClose(),()=>learning.cancelClose());
if(offlineLearning||parameters.has('learning'))learning.open();
if(offlineLearning&&parameters.has('iteration-ghosts'))learning.showGhosts(true,{play:true});
window.addEventListener('odradek-workspace',event=>{workspaceMode=event.detail;if(workspaceMode!=='preview'&&learning?.active)learning.close();cancelPull();tween=null;rehearsal=null;solid.setPose(pose);render();if(workspaceMode==='automatic')notify('Offline rehearsal on the replica. Your pose is preserved; gripper lock applies.');else notify('Select a joint, pull back, release.');});
window.addEventListener('odradek-rehearsal',event=>{
 if(workspaceMode!=='automatic')return;
 const next=Object.fromEntries(JOINTS.map(j=>[j,radians(j,event.detail?.[j])]));if(!validPose(next))return;
 if($('grip-lock').checked)next.gripper=pose.gripper;rehearsal=next;tween=null;solid.setPose(next);
 for(const j of JOINTS)document.querySelector(`[data-angle="${j}"]`).textContent=degrees(j,next[j]).toFixed(2)+'°';
});
if(embedded)window.parent.postMessage({type:'odradek-preview-ready'},studioOrigin);else{void readObservation();setInterval(()=>void readObservation(),1900);}
engine.add({update(dt){
 if(learning?.active)learning.update(dt);
 if(!pull)rig.update(dt);if(tween){tween.elapsed+=dt;const t=Math.min(1,tween.elapsed/(settings.get('reducedMotion')?.01:.42)),k=t*t*(3-2*t);solid.setPose(Object.fromEntries(JOINTS.map(j=>[j,tween.from[j]+(tween.to[j]-tween.from[j])*k])));if(t===1)tween=null;}
 solid.group.updateMatrixWorld(true);for(const[joint,h]of handles){h.mesh.visible=!learning?.active;h.mesh.position.copy(solid.positionOf(joint));const p=project(h.mesh.position);h.button.style.transform=`translate(${p.x+14}px,${p.y-18}px)`;h.button.hidden=p.z< -1||p.z>1;h.mesh.scale.setScalar(joint===selected?1.1:.8);}
 const tip=solid.tip();tipMarker.position.copy(tip);const tipText=`X ${(tip.x/MM_SCALE).toFixed(1)} · Y ${(tip.y/MM_SCALE).toFixed(1)} · Z ${(tip.z/MM_SCALE).toFixed(1)}`,heightText=`Height above table: ${(tip.y/MM_SCALE).toFixed(1)} mm · model estimate`;if($('tip-position').textContent!==tipText)$('tip-position').textContent=tipText;if($('tip-clearance').textContent!==heightText)$('tip-clearance').textContent=heightText;
 updateGuide();
 if(observation?.state==='live'&&!freshObservation(observation)){measured.group.visible=false;$('use-measured').disabled=true;$('live-state').textContent='Live outline stale · preview retained';}
}});engine.start();

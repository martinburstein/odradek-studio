import {mountMotionLab} from './motion-lab.js';

// Diagram adapted from Martin's original Pencil Pusher 10-Point Trackpad Matrix.
// Original: AI Typewriter Files/Chrome UI/public/app.js
// Source SHA-256: f000236384e9de8a74e3c478ccd099cb39bdca19c2f40816d384f35153d4cae8
// Original point definitions, projection and canvas renderer retained. No printer
// coordinates, calibration state, network requests or movement controls imported.
const CALIBRATION_POINT_DEFS = [
  { id: "NW", label: "NW", type: "surface", u: 0.08, v: 0.12 },
  { id: "N", label: "N", type: "surface", u: 0.5, v: 0.12 },
  { id: "NE", label: "NE", type: "surface", u: 0.92, v: 0.12 },
  { id: "W", label: "W", type: "surface", u: 0.08, v: 0.48 },
  { id: "E", label: "E", type: "surface", u: 0.92, v: 0.48 },
  { id: "SW", label: "SW", type: "surface", u: 0.08, v: 0.72 },
  { id: "S", label: "S", type: "surface", u: 0.5, v: 0.72 },
  { id: "SE", label: "SE", type: "surface", u: 0.92, v: 0.72 },
  { id: "LEFT_CLICK", label: "Left Click", type: "button", u: 0.25, v: 0.9 },
  { id: "RIGHT_CLICK", label: "Right Click", type: "button", u: 0.75, v: 0.9 },
];
const TRACKPAD_POINTS=Object.freeze(CALIBRATION_POINT_DEFS.map(point=>Object.freeze({...point})));
function pointMapPresetName(pointId,mode){
 const point=TRACKPAD_POINTS.find(p=>p.id===pointId);
 if(!point||!['hover','contact'].includes(mode))throw Error('Choose a valid point and Hover or Contact.');
 return `Point Map · ${point.label} · ${mode==='hover'?'Hover':'Contact'}`;
}
function pointMapPreset(library,pointId,mode){const name=pointMapPresetName(pointId,mode).toLowerCase();return library.presets.find(p=>!p.archived&&p.name.toLowerCase()===name);}
function pointMapPosition(library,pointId,mode){
 const p=pointMapPreset(library,pointId,mode),position=p?.positions?.[0];
 return p?.source==='encoder'&&p.positions.length===1&&position?.source==='encoder'&&['base','shoulder','elbow','gripper'].every(j=>Number.isFinite(position.degrees?.[j])&&Number.isFinite(position.radians?.[j]))?position:null;
}
function mountTrackpadMatrix(root,{getState,onCapture}){
const MOUSEPAD_BLUE = "#4aa3dd";
const MOUSEPAD_BLUE_SOFT = "rgba(74, 163, 221, 0.70)";
const MOUSEPAD_BLUE_GLOW = "rgba(74, 163, 221, 0.65)";
const MOUSEPAD_BLUE_LINE = "rgba(74, 163, 221, 0.92)";
const MOUSEPAD_BLUE_LINE_SOFT = "rgba(74, 163, 221, 0.82)";
const calibrationCanvas=root.querySelector('canvas');
const calibrationPoints=TRACKPAD_POINTS;
const HOVER_OFFSET_TOWARD_VIEWER=-90;
let modalOpen=true,selectedPointId='LEFT_CLICK',calibrationMode='contact';
let cameraRotX=-0.56,cameraRotY=0.42,projectedCalibrationPoints=[],drag=null;
const getActiveCalibrationBucket=()=>null,hasHoverCalibration=point=>Boolean(pointMapPosition(getState().library,point.id,'hover')),hasContactCalibration=point=>Boolean(pointMapPosition(getState().library,point.id,'contact'));
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function resizeCalibrationCanvas() {
  if (!calibrationCanvas) {
    return;
  }

  const rect = calibrationCanvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.round(rect.width * ratio));
  const height = Math.max(260, Math.round(rect.height * ratio));
  if (calibrationCanvas.width !== width || calibrationCanvas.height !== height) {
    calibrationCanvas.width = width;
    calibrationCanvas.height = height;
  }
}

function rotatePoint(point, rotX, rotY) {
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const cosX = Math.cos(rotX);
  const sinX = Math.sin(rotX);

  const rotatedX = point.x * cosY + point.z * sinY;
  const rotatedZ = -point.x * sinY + point.z * cosY;
  const rotatedY = point.y * cosX - rotatedZ * sinX;
  const depthZ = point.y * sinX + rotatedZ * cosX;

  return { x: rotatedX, y: rotatedY, z: depthZ };
}

function projectPoint(point, scene) {
  const rotated = rotatePoint(point, cameraRotX, cameraRotY);
  const perspective = 1 / (1 + rotated.z * 0.0018);
  return {
    x: scene.centerX + rotated.x * perspective,
    y: scene.centerY + rotated.y * perspective,
    z: rotated.z,
    perspective,
  };
}

function drawStar(ctx, x, y, outerRadius, innerRadius, points) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const angle = (Math.PI / points) * i - Math.PI / 2;
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const sx = x + Math.cos(angle) * radius;
    const sy = y + Math.sin(angle) * radius;
    if (i === 0) {
      ctx.moveTo(sx, sy);
    } else {
      ctx.lineTo(sx, sy);
    }
  }
  ctx.closePath();
}

function drawOctagon(ctx, x, y, radius) {
  ctx.beginPath();

  for (let i = 0; i < 8; i += 1) {
    const angle = -Math.PI / 8 + i * Math.PI / 4;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;

    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }

  ctx.closePath();
  ctx.stroke();
}

function drawATFieldNode(ctx, x, y, options = {}) {
  const {
    mode = "contact",
    selected = false,
    calibrated = false,
    radius = 16,
  } = options;

  const isHover = mode === "hover";
  const outerColor = MOUSEPAD_BLUE;
  const innerColor = MOUSEPAD_BLUE_SOFT;
  const dotColor = "#d8f1ff";
  const glowColor = MOUSEPAD_BLUE_GLOW;

  ctx.save();
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = selected ? 14 : 7;

  if (selected) {
    ctx.strokeStyle = "#d8f1ff";
    ctx.lineWidth = 2;
    drawOctagon(ctx, x, y, radius + 6);
  }

  const radii = [radius, radius * 0.68, radius * 0.38];
  for (let i = 0; i < radii.length; i += 1) {
    ctx.strokeStyle = i === 0 ? outerColor : innerColor;
    ctx.lineWidth = i === 0 ? 1.8 : 1.2;
    drawOctagon(ctx, x, y, radii[i]);
  }

  ctx.beginPath();
  ctx.arc(x, y, calibrated ? 3.6 : 2.8, 0, Math.PI * 2);
  ctx.fillStyle = calibrated ? dotColor : "rgba(0, 0, 0, 0.85)";
  ctx.strokeStyle = dotColor;
  ctx.lineWidth = 1.3;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawGrid(ctx, width, height) {
  ctx.save();
  ctx.strokeStyle = "rgba(74, 163, 221, 0.12)";
  ctx.lineWidth = 1;
  const spacing = Math.max(28, Math.round(width / 22));
  for (let x = 0; x <= width; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawProjectedLine(ctx, from, to, color, width = 1.4) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function drawProjectedLineSet(ctx, points, color, width = 1.4, closed = false) {
  if (!points.length) {
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  if (closed) {
    ctx.closePath();
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function getTrackpadCorners(scene, depth = 0) {
  return [
    { x: -scene.padWidth / 2, y: -scene.padHeight / 2, z: depth },
    { x: scene.padWidth / 2, y: -scene.padHeight / 2, z: depth },
    { x: scene.padWidth / 2, y: scene.padHeight / 2, z: depth },
    { x: -scene.padWidth / 2, y: scene.padHeight / 2, z: depth },
  ];
}

function renderCalibrationScene() {
  if (!modalOpen || !calibrationCanvas) {
    return;
  }

  resizeCalibrationCanvas();
  const ctx = calibrationCanvas.getContext("2d");
  const width = calibrationCanvas.width;
  const height = calibrationCanvas.height;
  const scene = {
    centerX: width / 2,
    centerY: height / 2 + height * 0.02,
    padWidth: width * 0.54,
    padHeight: height * 0.46,
    lift: height * 0.05,
  };

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0b0e10";
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, width, height);

  const isHoverMode = calibrationMode === "hover";
  const padFillTop = "rgba(74, 163, 221, 0.18)";
  const padFillMid = "rgba(74, 163, 221, 0.10)";
  const padFillBottom = "rgba(74, 163, 221, 0.18)";
  const padShadow = "rgba(74, 163, 221, 0.24)";
  const padLine = MOUSEPAD_BLUE;
  const clickLineColor = MOUSEPAD_BLUE_LINE;
  const clickDividerColor = MOUSEPAD_BLUE_LINE_SOFT;

  ctx.save();
  const vignette = ctx.createRadialGradient(
    scene.centerX,
    scene.centerY - height * 0.1,
    width * 0.06,
    scene.centerX,
    scene.centerY,
    width * 0.56
  );
  vignette.addColorStop(0, "rgba(74, 163, 221, 0.10)");
  vignette.addColorStop(1, "rgba(11, 14, 16, 0)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  const corners3D = getTrackpadCorners(scene, 0);
  const projectedCorners = corners3D.map((point) => projectPoint(point, scene));

  const clickStripV = 0.8;
  const clickLocalY = -scene.padHeight / 2 + scene.padHeight * clickStripV;
  const clickLine = [
    projectPoint({ x: -scene.padWidth / 2, y: clickLocalY, z: 0 }, scene),
    projectPoint({ x: scene.padWidth / 2, y: clickLocalY, z: 0 }, scene),
  ];
  const clickDivider = [
    projectPoint({ x: 0, y: clickLocalY, z: 0 }, scene),
    projectPoint({ x: 0, y: scene.padHeight / 2, z: 0 }, scene),
  ];

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(projectedCorners[0].x, projectedCorners[0].y);
  for (let i = 1; i < projectedCorners.length; i += 1) {
    ctx.lineTo(projectedCorners[i].x, projectedCorners[i].y);
  }
  ctx.closePath();
  const padFill = ctx.createLinearGradient(0, projectedCorners[0].y, 0, projectedCorners[2].y);
  padFill.addColorStop(0, padFillTop);
  padFill.addColorStop(0.62, padFillMid);
  padFill.addColorStop(1, padFillBottom);
  ctx.fillStyle = padFill;
  ctx.shadowColor = padShadow;
  ctx.shadowBlur = 28;
  ctx.fill();
  ctx.restore();

  drawProjectedLine(ctx, projectedCorners[0], projectedCorners[1], padLine, 2.1);
  drawProjectedLine(ctx, projectedCorners[1], projectedCorners[2], padLine, 2.1);
  drawProjectedLine(ctx, projectedCorners[2], projectedCorners[3], padLine, 2.1);
  drawProjectedLine(ctx, projectedCorners[3], projectedCorners[0], padLine, 2.1);
  drawProjectedLine(ctx, clickLine[0], clickLine[1], clickLineColor, 1.8);
  drawProjectedLine(ctx, clickDivider[0], clickDivider[1], clickDividerColor, 1.6);

  const hoverPlaneHeight = scene.lift + HOVER_OFFSET_TOWARD_VIEWER;
  const hoverFootprintBottom = getTrackpadCorners(scene, 0);
  const hoverFootprintTop = getTrackpadCorners(scene, HOVER_OFFSET_TOWARD_VIEWER);
  const projectedHoverBottom = hoverFootprintBottom.map((point) => projectPoint(point, scene));
  const projectedHoverTop = hoverFootprintTop.map((point) => projectPoint(point, scene));

  projectedCalibrationPoints = calibrationPoints
    .map((point) => {
      const localX = -scene.padWidth / 2 + scene.padWidth * point.u;
      const localY = -scene.padHeight / 2 + scene.padHeight * point.v;
      const surfacePoint = {
        x: localX,
        y: localY,
        z: scene.lift,
      };
      const hoverPoint = {
        x: localX,
        y: localY,
        z: hoverPlaneHeight,
      };
      const activePoint3D = calibrationMode === "hover" ? hoverPoint : surfacePoint;
      const projected = projectPoint(activePoint3D, scene);
      return {
        ...point,
        bucket: getActiveCalibrationBucket(point),
        surfaceProjection: projectPoint(surfacePoint, scene),
        hoverProjection: projectPoint(hoverPoint, scene),
        screenX: projected.x,
        screenY: projected.y,
        depth: projected.z,
        radius: 10 * projected.perspective + 3,
      };
    })
    .sort((a, b) => a.depth - b.depth);

  if (calibrationMode === "hover") {
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(255, 255, 255, 0.45)";
    ctx.shadowBlur = 6;
    drawProjectedLineSet(ctx, projectedHoverBottom, "rgba(255, 255, 255, 0.44)", 1.25, true);
    for (let i = 0; i < projectedHoverBottom.length; i += 1) {
      drawProjectedLine(
        ctx,
        projectedHoverBottom[i],
        projectedHoverTop[i],
        "rgba(255, 255, 255, 0.75)",
        1.5
      );
    }
    drawProjectedLineSet(ctx, projectedHoverTop, "rgba(255, 255, 255, 0.75)", 1.5, true);
    ctx.restore();
  }

  ctx.font = `${Math.max(12, Math.round(width * 0.014))}px "Bahnschrift Condensed", "Arial Narrow", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  for (const point of projectedCalibrationPoints) {
    const isSelected = point.id === selectedPointId;
    ctx.save();
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(point.screenX, point.screenY, point.radius + 8, 0, Math.PI * 2);
      ctx.fillStyle = isHoverMode ? "rgba(210, 252, 255, 0.22)" : "rgba(112, 241, 255, 0.18)";
      ctx.shadowColor = isHoverMode ? "rgba(210, 252, 255, 0.42)" : "rgba(112, 241, 255, 0.4)";
      ctx.shadowBlur = 24;
      ctx.fill();
    }

    if (isHoverMode) {
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.38)";
      ctx.lineWidth = 1.05;
      ctx.shadowBlur = 0;
      drawProjectedLine(ctx, point.surfaceProjection, point.hoverProjection, "rgba(255, 255, 255, 0.38)", 1.05);
      ctx.restore();
    }

    drawATFieldNode(ctx, point.screenX, point.screenY, {
      mode: calibrationMode,
      selected: point.id === selectedPointId,
      calibrated: calibrationMode === "hover"
        ? hasHoverCalibration(point)
        : hasContactCalibration(point),
      radius: 16,
    });
    ctx.restore();

    ctx.save();
    ctx.fillStyle = isHoverMode ? (isSelected ? "#ffffff" : "#dffcff") : isSelected ? "#efffff" : "#ffd9b0";
    ctx.strokeStyle = "rgba(11, 14, 16, 0.92)";
    ctx.lineWidth = 3;
    ctx.strokeText(point.label.toUpperCase(), point.screenX + point.radius + 7, point.screenY - 2);
    ctx.fillText(point.label.toUpperCase(), point.screenX + point.radius + 7, point.screenY - 2);
    ctx.restore();
  }
}

function pickCalibrationPoint(clientX, clientY) {
  const rect = calibrationCanvas.getBoundingClientRect();
  const scaleX = calibrationCanvas.width / rect.width;
  const scaleY = calibrationCanvas.height / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;

  for (let i = projectedCalibrationPoints.length - 1; i >= 0; i -= 1) {
    const point = projectedCalibrationPoints[i];
    const dx = x - point.screenX;
    const dy = y - point.screenY;
    if (Math.hypot(dx, dy) <= point.radius + 8) {
      return point;
    }
  }
  return null;
}

function selectPoint(id){
 const point=calibrationPoints.find(p=>p.id===id);if(!point)return;selectedPointId=id;
 root.querySelector('[data-map-selection]').textContent=point.label+' / '+(calibrationMode==='hover'?'Hover':'Contact');
 for(const button of root.querySelectorAll('[data-map-point]'))button.setAttribute('aria-pressed',String(button.dataset.mapPoint===id));
 refresh();
}
function refresh(){
 const {library,feedback,busy,lastFeedbackAt}=getState();
 const fresh=feedback?.capturable&&feedback.source==='encoder'&&Date.now()-lastFeedbackAt<2500;
 for(const button of root.querySelectorAll('[data-map-point]')){
  const id=button.dataset.mapPoint,h=Boolean(pointMapPosition(library,id,'hover')),c=Boolean(pointMapPosition(library,id,'contact'));
  button.querySelector('small').textContent=`H ${h?'✓':'—'} · C ${c?'✓':'—'}`;
 }
 for(const mode of ['hover','contact']){
  const position=pointMapPosition(library,selectedPointId,mode),button=root.querySelector(`[data-map-capture="${mode}"]`);
  button.disabled=busy||!fresh;button.textContent=`${position?'Update':'Set'} ${mode==='hover'?'Hover':'Contact'} from current`;
  root.querySelector(`[data-map-record="${mode}"]`).textContent=position?['base','shoulder','elbow','gripper'].map(j=>`${j==='shoulder'?'S':j==='gripper'?'G':j==='elbow'?'E':'B'} ${position.degrees[j].toFixed(1)}°`).join(' · '):'Not set';
 }
 const count=TRACKPAD_POINTS.reduce((n,p)=>n+Number(Boolean(pointMapPosition(library,p.id,'hover')))+Number(Boolean(pointMapPosition(library,p.id,'contact'))),0);
 root.querySelector('[data-map-progress]').textContent=`${count} / 20 POSES SET`;
 root.querySelector('[data-map-live]').textContent=fresh?'Current: '+['base','shoulder','elbow','gripper'].map(j=>`${j[0].toUpperCase()+j.slice(1)} ${feedback.degrees[j].toFixed(1)}°`).join(' · '):feedback?.source==='simulator'?'Connect the physical arm to set these points.':feedback?.reason??'Waiting for fresh measured arm positions.';
 if(root.getBoundingClientRect().width>0)renderCalibrationScene();
}
const list=root.querySelector('[data-map-points]');
for(const point of calibrationPoints){
 const button=document.createElement('button');button.type='button';button.dataset.mapPoint=point.id;button.textContent=point.label;button.setAttribute('aria-pressed','false');
 button.append(document.createElement('small'));
 button.addEventListener('click',()=>selectPoint(point.id));list.append(button);
}
for(const button of root.querySelectorAll('[data-map-mode]'))button.addEventListener('click',()=>{
 calibrationMode=button.dataset.mapMode;for(const b of root.querySelectorAll('[data-map-mode]'))b.setAttribute('aria-pressed',String(b===button));selectPoint(selectedPointId);
});
for(const button of root.querySelectorAll('[data-map-capture]'))button.addEventListener('click',()=>void onCapture(selectedPointId,button.dataset.mapCapture));
calibrationCanvas.addEventListener('pointerdown',event=>{
 if(event.button!==0)return;const hit=pickCalibrationPoint(event.clientX,event.clientY);if(hit){selectPoint(hit.id);return;}
 drag={x:event.clientX,y:event.clientY};calibrationCanvas.setPointerCapture(event.pointerId);
});
calibrationCanvas.addEventListener('pointermove',event=>{
 if(!drag)return;cameraRotY=clamp(cameraRotY+(event.clientX-drag.x)*.009,-.9,.9);cameraRotX=clamp(cameraRotX+(event.clientY-drag.y)*.008,-1,-.08);drag={x:event.clientX,y:event.clientY};renderCalibrationScene();
});
for(const event of ['pointerup','pointercancel','lostpointercapture'])calibrationCanvas.addEventListener(event,()=>{drag=null;});
root.querySelector('[data-map-reset]').addEventListener('click',()=>{cameraRotX=-.56;cameraRotY=.42;renderCalibrationScene();});
window.addEventListener('resize',renderCalibrationScene);
window.addEventListener('studio:tab',event=>{if(event.detail==='map')requestAnimationFrame(renderCalibrationScene);});
new ResizeObserver(()=>{if(calibrationCanvas.getBoundingClientRect().width>0)renderCalibrationScene();}).observe(calibrationCanvas);
selectPoint(selectedPointId);
return {refresh,select:selectPoint};
}

const $=id=>document.getElementById(id);
const joints=['base','shoulder','elbow','gripper'];
let library={revision:0,presets:[]},selectedId=null,feedback=null,busy=false,showArchived=false,noticeTimer,lastFeedbackAt=0,motionLab=null,pointMap=null,automaticMode='lab',manualMode='3d';
const workspaceTabs=['manual','automatic','presets','map'];
let currentTab=workspaceTabs.includes(location.hash.slice(1))?location.hash.slice(1):'manual';
// An open workspace belongs to the user; service launches never reset it.
const selected=()=>library.presets.find(p=>p.id===selectedId);
function node(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
const topPreview=node('button','subtle','▶ Preview motion');topPreview.id='preview-preset-top';topPreview.type='button';$('metadata').after(topPreview);
function notify(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,error?12000:5000);}
let sessionRenewal=null;
async function api(route,body){
 const request=()=>fetch('/api/'+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(route==='repair'?60000:route==='stop'?15000:8000)});
 let response=await request();
 if(response.status===401&&!body){
  // Renew only read requests after a Studio restart. Never replay a mutation.
  sessionRenewal??=fetch('/index.html',{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)throw Error('Studio session renewal failed');}).finally(()=>{sessionRenewal=null;});
  await sessionRenewal;response=await request();
 }
 const value=await response.json();if(!response.ok){const e=Error(value.error||'Request failed');e.status=response.status;throw e;}return value;
}
async function load(){library=await api('library');if(!selected())selectedId=library.presets.find(p=>!p.archived)?.id??null;renderLibrary();renderEditor();pointMap?.refresh();}
async function mutate(route,body,message){
 if(busy)return;busy=true;renderCapture();
 try{const result=await api(route,{...body,revision:library.revision});library=result.library;selectedId=result.selectedId??selectedId;renderLibrary();renderEditor();if(message)notify(message);return result;}
 catch(error){notify(error.message,true);if(error.status===409)await load();}
 finally{busy=false;renderCapture();}
}
function detailsDirty(){const p=selected();return p&&($('preset-name').value!==p.name||$('preset-notes').value!==p.notes);}
async function saveDetails(){if(!detailsDirty())return;await mutate('update',{id:selectedId,name:$('preset-name').value,notes:$('preset-notes').value},'Movement details saved.');}
async function captureMapPoint(pointId,mode){
 if(busy)return;
 const name=pointMapPresetName(pointId,mode);
 await saveDetails();if(detailsDirty()||busy)return;
 busy=true;renderCapture();
 try{
  // Use only the shared library's fresh, idle encoder capture. Never submit a
  // movement or trust the displayed angles as the saved measurement.
  const live=await api('feedback');feedback=live;lastFeedbackAt=Date.now();
  if(!live.capturable||live.source!=='encoder')throw Error(live.reason||'Fresh physical arm readings are required.');
  library=await api('library');
  let p=pointMapPreset(library,pointId,mode);
  if(!p){const created=await api('create',{revision:library.revision,name});library=created.library;p=library.presets.find(p=>p.id===created.selectedId);}
  if(!p||p.source&&p.source!=='encoder'||p.positions.length>1)throw Error('This Point Map movement has incompatible positions. Review it in Movement Preset before changing it.');
  const result=await api('capture',{revision:library.revision,id:p.id,...(p.positions[0]?{replacePositionId:p.positions[0].id}:{})});
  library=result.library;selectedId=p.id;renderLibrary();renderEditor();notify(`${name} saved from measured joints.`);
 }catch(error){notify(error.message,true);if(error.status===409)await load();}
 finally{busy=false;renderCapture();}
}
function setTab(tab){
 currentTab=tab;history.replaceState(null,'','#'+tab);
 for(const name of workspaceTabs){const active=name===tab;$('panel-'+name).hidden=!active;$('tab-'+name).setAttribute('aria-selected',String(active));$('tab-'+name).tabIndex=active?0:-1;}
 if(tab==='manual'&&manualMode==='3d')ensureJointPreview();
 const frame=tab==='manual'&&manualMode==='joints'||tab==='automatic'&&automaticMode==='live'?$(tab+'-frame'):null;if(frame&&feedback?.controllerOnline&&!frame.getAttribute('src'))frame.src=frame.dataset.src;
 if(tab==='presets')void refreshFeedback();
 window.dispatchEvent(new CustomEvent('studio:tab',{detail:tab}));
}
const jointPreviewOrigin='http://127.0.0.1:5274';
function ensureJointPreview(){const frame=$('joint-preview-frame');if(!frame.getAttribute('src'))frame.src=frame.dataset.src;}
function previewContext(){
 const frame=$('joint-preview-frame');if(!frame.getAttribute('src'))return;
 const live=feedback?.capturable&&Date.now()-lastFeedbackAt<2500;
 frame.contentWindow.postMessage({type:'odradek-preview-context',observation:{state:live?'live':'stale',source:feedback?.source==='encoder'?'hardware':feedback?.source==='simulator'?'simulator':null,pose:live?feedback.radians:null,observedAt:feedback?.measuredAt??null}},jointPreviewOrigin);
}
function manualWorkspace(mode){
 manualMode=mode;$('joint-preview-frame').hidden=mode!=='3d';$('manual-frame').hidden=mode!=='joints';
 $('manual-3d').setAttribute('aria-pressed',String(mode==='3d'));$('manual-joints').setAttribute('aria-pressed',String(mode==='joints'));
 if(mode==='3d')ensureJointPreview();setTab('manual');previewContext();
}
$('manual-3d').addEventListener('click',()=>manualWorkspace('3d'));$('manual-joints').addEventListener('click',()=>manualWorkspace('joints'));
$('joint-preview-frame').addEventListener('load',previewContext);
function automaticWorkspace(mode){automaticMode=mode;$('motion-lab').hidden=mode!=='lab';$('automatic-live').hidden=mode!=='live';$('show-lab').setAttribute('aria-pressed',String(mode==='lab'));$('show-live').setAttribute('aria-pressed',String(mode==='live'));if(mode==='live')motionLab?.pause();else motionLab?.refresh();setTab('automatic');}
$('show-lab').addEventListener('click',()=>automaticWorkspace('lab'));$('show-live').addEventListener('click',()=>automaticWorkspace('live'));
for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>setTab(button.dataset.tab));
for(const button of document.querySelectorAll('[data-switch]'))button.addEventListener('click',()=>setTab(button.dataset.switch));
document.querySelector('.tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const tabs=workspaceTabs;let i=tabs.indexOf(currentTab);i=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length;event.preventDefault();setTab(tabs[i]);$('tab-'+tabs[i]).focus();});
window.addEventListener('hashchange',()=>{const t=location.hash.slice(1);if(workspaceTabs.includes(t))setTab(t);});
for(const j of joints){const card=node('div','reading');card.append(node('span','label',j),node('strong','waiting','—'),node('small','',j==='shoulder'?'PAIRED / +90°':j==='base'?'SIGNED MOTOR °':j==='gripper'?'MOTOR ANGLE °':'JOINT BEND °'));card.dataset.joint=j;$('readings').append(card);}
function renderFeedback(){
 const fresh=feedback?.capturable&&Date.now()-lastFeedbackAt<2500;
 for(const card of $('readings').children){const value=card.querySelector('strong');value.textContent=fresh?feedback.degrees[card.dataset.joint].toFixed(2)+'°':'—';value.classList.toggle('waiting',!fresh);}
 $('signal').classList.toggle('live',Boolean(fresh&&feedback.source==='encoder'));
 $('connection').textContent=!feedback?.controllerOnline?'CONTROLLER OFFLINE':fresh?feedback.source==='encoder'?'ARM CONNECTED / MEASURED FEEDBACK':'SIMULATOR / NO PHYSICAL READINGS':'CONTROLLER ONLINE / '+(feedback.available?'WAITING FOR CAPTURE':'ARM DISCONNECTED');
 $('reading-kind').textContent=fresh?(feedback.source==='encoder'?'ENCODER / LIVE':'SIMULATOR / TEST DATA'):'WAITING FOR FEEDBACK';
 $('feedback-note').textContent=fresh?`Latest reading ${new Date(feedback.measuredAt).toLocaleTimeString()} · All four joints captured together. Shoulder uses paired motors; gripper shows motor angle.`:feedback?.reason??'Reading the shared Controller…';
 for(const item of document.querySelectorAll('.frame-offline'))item.hidden=feedback?.controllerOnline!==false;
 const frame=currentTab==='manual'&&manualMode==='joints'||currentTab==='automatic'&&automaticMode==='live'?$(currentTab+'-frame'):null;if(frame&&feedback?.controllerOnline&&!frame.getAttribute('src'))frame.src=frame.dataset.src;
 previewContext();
 renderCapture();
}
let polling=false;
async function refreshFeedback(){
 if(polling||document.hidden)return;polling=true;
 try{
  feedback=await api('feedback');lastFeedbackAt=Date.now();

 }
 catch{feedback={controllerOnline:false,capturable:false,reason:'Studio connection lost. Reconnecting automatically; this workspace stays open.'};}
 finally{polling=false;renderFeedback();}
}
function renderLibrary(){
 motionLab?.updateLibrary(library);
 const active=library.presets.filter(p=>!p.archived);$('library-count').textContent=`${active.length} MOVEMENT${active.length===1?'':'S'}`;
 const query=$('search').value.toLowerCase(),items=library.presets.filter(p=>p.archived===showArchived&&p.name.toLowerCase().includes(query));$('library-list').replaceChildren();
 if(!items.length)$('library-list').append(node('p','library-empty',query?'No matching movements.':showArchived?'No archived movements.':'Your taught movements will live here.'));
 for(const p of items){const button=node('button','library-item'+(p.id===selectedId?' selected':''));button.append(node('strong','',p.name),node('small','',`${p.positions.length} POSITION${p.positions.length===1?'':'S'}${p.source==='simulator'?' / SIM':p.source==='designed'?' / DRAFT':''}`));button.setAttribute('aria-pressed',String(p.id===selectedId));button.addEventListener('click',async()=>{if(busy)return;await saveDetails();if(detailsDirty())return;selectedId=p.id;renderLibrary();renderEditor();});$('library-list').append(button);}
 $('archive-toggle').textContent=showArchived?'Show active movements':'Show archived';
}
function renderEditor(){
 const p=selected();$('empty').hidden=Boolean(p);$('editor').hidden=!p;if(!p)return;
 $('preset-name').value=p.name;$('preset-notes').value=p.notes;$('save-details').hidden=true;
 $('preset-kind').textContent=p.archived?'ARCHIVED MOVEMENT':p.source==='simulator'?'SIMULATOR MOVEMENT':p.source==='encoder'?'TAUGHT MOVEMENT':p.source==='designed'?'DESIGNED / OFFLINE DRAFT':'NEW MOVEMENT';
 $('save-state').textContent='SAVED LOCALLY';$('position-count').textContent=`${p.positions.length} POSITION${p.positions.length===1?'':'S'}`;
 $('archive-preset').textContent=p.archived?'Restore':'Archive';$('export-preset').disabled=!p.positions.length||p.archived;
 $('preview-preset').disabled=p.positions.length<2||p.archived;
 topPreview.disabled=p.positions.length<2||p.archived;
 $('positions').replaceChildren();
 for(const [index,position]of p.positions.entries()){
  const card=node('article','position'),head=node('div','position-heading'),label=node('input','position-label');label.value=position.label;label.maxLength=80;label.setAttribute('aria-label',`Position ${index+1} label`);
  label.addEventListener('change',async()=>{await saveDetails();if(detailsDirty())return;await mutate('update',{id:p.id,positionId:position.id,label:label.value},'Position label saved.');});
  head.append(node('span','position-number',String(index+1).padStart(2,'0')),label);card.append(head);
  const values=node('div','position-values');for(const j of joints){const value=node('div');value.append(node('small','',j),node('strong','',position.degrees[j].toFixed(2)+'°'));values.append(value);}card.append(values);
  const bottom=node('div','position-bottom'),actions=node('div','position-actions');bottom.append(node('span','position-time',position.source==='designed'?`Designed offline · ${position.durationMs??1200} ms / hold ${position.holdMs??0} ms`:new Date(position.capturedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})));
  const add=(title,caption,fn,disabled=false)=>{const b=node('button','',caption);b.title=title;b.setAttribute('aria-label',title);b.disabled=disabled;b.addEventListener('click',async()=>{await saveDetails();if(detailsDirty())return;await fn();});actions.append(b);return b;};
  const recapture=add(`Recapture Position ${index+1}`,'Recapture',()=>mutate('capture',{id:p.id,replacePositionId:position.id},`Position ${index+1} recaptured.`),!feedback?.capturable||p.archived);recapture.dataset.recapture='true';
  const reorder=async delta=>{const order=p.positions.map(q=>q.id);[order[index],order[index+delta]]=[order[index+delta],order[index]];await mutate('update',{id:p.id,order},'Position order saved.');};
  add(`Move Position ${index+1} earlier`,'↑',()=>reorder(-1),index===0||p.archived);add(`Move Position ${index+1} later`,'↓',()=>reorder(1),index===p.positions.length-1||p.archived);
  add(`Remove Position ${index+1}`,'×',()=>mutate('update',{id:p.id,removePositionId:position.id},'Position removed.'),p.archived).className='remove';bottom.append(actions);card.append(bottom);$('positions').append(card);
 }
 renderCapture();
}
function renderCapture(){
 pointMap?.refresh();
 const p=selected(),fresh=feedback?.capturable&&Date.now()-lastFeedbackAt<2500,compatible=!p?.source||p.source===feedback?.source;
 $('capture').disabled=busy||!p||p.archived||!fresh||!compatible||p.positions.length>=64;
 $('capture').textContent=busy?'Saving…':`＋ Set Position ${(p?.positions.length??0)+1}`;
 $('capture-help').textContent=p?.archived?'Restore this movement to add positions.':p?.source==='designed'?'Offline design. Preview and edit timing in Automatic; create a new movement to teach measured arm positions.':!compatible?'Create a separate movement for simulator and physical arm readings.':fresh?'Position capture records all four measured joints. It does not move the arm.':feedback?.reason??'Adjust the arm in Manual, then capture its readings here.';
 for(const b of document.querySelectorAll('[data-recapture]'))b.disabled=busy||!fresh||!compatible||p?.archived;
}
function newMovement(){if(busy)return;$('new-form').hidden=!$('new-form').hidden;if(!$('new-form').hidden)$('new-name').focus();}
for(const id of ['new','first-movement'])$(id).addEventListener('click',newMovement);
const dirty=()=>{$('save-details').hidden=!detailsDirty();$('save-state').textContent=detailsDirty()?'UNSAVED DETAILS':'SAVED LOCALLY';};
$('preset-name').addEventListener('input',dirty);$('preset-notes').addEventListener('input',dirty);
$('metadata').addEventListener('submit',async event=>{event.preventDefault();await saveDetails();});
$('new-form').addEventListener('submit',async event=>{event.preventDefault();await saveDetails();if(detailsDirty())return;const before=library.revision;await mutate('create',{name:$('new-name').value},'Movement created. Adjust the arm, then set Position 1.');if(library.revision>before){showArchived=false;$('search').value='';renderLibrary();$('new-form').hidden=true;$('new-name').value='';}});
$('search').addEventListener('input',renderLibrary);
$('archive-toggle').addEventListener('click',()=>{showArchived=!showArchived;renderLibrary();});
$('archive-preset').addEventListener('click',async()=>{await saveDetails();if(detailsDirty())return;await mutate('update',{id:selectedId,archived:!selected().archived},selected().archived?'Movement restored.':'Movement archived. Its positions are preserved.');});
$('capture').addEventListener('click',async()=>{await saveDetails();if(detailsDirty())return;await mutate('capture',{id:selectedId},'Position saved with all four joint readings.');});
$('to-manual').addEventListener('click',()=>setTab('manual'));
$('preview-preset').addEventListener('click',async()=>{await saveDetails();if(detailsDirty())return;try{automaticWorkspace('lab');motionLab.previewPreset(selectedId);}catch(error){notify(error.message,true);}});
topPreview.addEventListener('click',()=>$('preview-preset').click());
async function download(id){try{await saveDetails();if(detailsDirty())return;const data=await api('export'+(id?'?id='+encodeURIComponent(id):'')),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'})),link=node('a');link.href=url;link.download=id?`${selected().name.replace(/[^a-z0-9_-]/gi,'-')}.json`:'odradek-movement-library.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){notify(error.message,true);}}
$('export-library').addEventListener('click',()=>void download());$('export-preset').addEventListener('click',()=>void download(selectedId));
$('stop').addEventListener('click',async()=>{motionLab?.pause();if($('stop').disabled)return;$('stop').disabled=true;try{const result=await api('stop',{});notify(result.message||'Software stop requested. Check that the arm has stopped.');}catch(error){notify(`Stop not confirmed: ${error.message}. Use the physical power switch if needed.`,true);}finally{$('stop').disabled=false;void refreshFeedback();}});
window.addEventListener('beforeunload',event=>{if(detailsDirty()){event.preventDefault();event.returnValue='';}});
window.addEventListener('message',event=>{if(event.origin===jointPreviewOrigin&&event.source===$('joint-preview-frame').contentWindow){if(event.data?.type==='odradek-preview-ready')previewContext();else if(event.data?.type==='odradek-preview-point'){const id=event.data.pointId;if(TRACKPAD_POINTS.some(p=>p.id===id)){setTab('map');pointMap?.select(id);}else if(id==='PRINT_SCREEN'){const p=library.presets.find(p=>!p.archived&&p.name==='Print Screen');if(p&&!detailsDirty()){selectedId=p.id;renderLibrary();renderEditor();setTab('presets');}}}return;}if(event.origin==='http://127.0.0.1:8787'&&event.source===document.getElementById('manual-frame').contentWindow&&event.data?.studioRepair===true){void repairController();return;}if(event.origin==='http://127.0.0.1:8787'&&[document.getElementById('manual-frame').contentWindow,document.getElementById('automatic-frame').contentWindow].includes(event.source)&&event.data?.studioTab&&['manual','automatic','presets'].includes(event.data.studioTab)){if(event.data.studioTab==='automatic')automaticWorkspace('live');else setTab(event.data.studioTab);}});
motionLab=mountMotionLab($('motion-lab'),{saveDesign:async design=>{await saveDetails();if(detailsDirty())return;return mutate('design',{design},'Motion design saved as an offline preset draft.');},onSaved:id=>{selectedId=id;showArchived=false;renderLibrary();renderEditor();setTab('presets');}});
pointMap=mountTrackpadMatrix($('trackpad-matrix'),{getState:()=>({library,feedback,busy,lastFeedbackAt}),onCapture:captureMapPoint});
// Offset UI reads from the Controller's 1500 ms feedback timer to avoid
// repeatedly reserving the same idle slot before hardware polling can run.
setTab(currentTab);void load().catch(error=>notify(error.message,true));void refreshFeedback();setInterval(()=>void refreshFeedback(),1700);setInterval(renderCapture,500);

// Repair is operator-triggered and independent of an unavailable Controller iframe.
let repairBusy=false,repairCandidate=null;
function renderRepair(){
 $('repair-controller').disabled=repairBusy;
 $('repair-check').disabled=repairBusy||!repairCandidate||!$('repair-confirm').checked;
 $('repair-confirm').disabled=repairBusy;
 $('repair-close').disabled=repairBusy;
}
async function repairController(confirmed=false){
 if(repairBusy)return;
 repairBusy=true;$('repair-panel').hidden=false;$('repair-panel').scrollIntoView({block:'start',behavior:'smooth'});renderRepair();
 $('repair-status').textContent=confirmed?'Observing stationary feedback for at least 30 seconds. No movement is being sent…':'Restoring the Controller connection…';
 try{
  const result=await api('repair',confirmed?{confirmed:true,commandId:repairCandidate.commandId,originalRowSHA256:repairCandidate.originalRowSHA256}:{});
  repairCandidate=result.recovery;$('repair-confirm').checked=false;
  $('repair-inspection').hidden=!repairCandidate;
  $('repair-status').textContent=result.message;
  if(result.ready){
   // Reload display frames only. No move or previous request is replayed.
   for(const id of ['manual-frame','automatic-frame']){const frame=$(id);if(frame.getAttribute('src'))frame.src=frame.dataset.src;}
  }
  await refreshFeedback();
 }catch(error){repairCandidate=null;$('repair-inspection').hidden=true;$('repair-status').textContent='Repair stopped: '+error.message;}
 finally{repairBusy=false;renderRepair();}
}
$('repair-controller').addEventListener('click',()=>void repairController());
$('repair-check').addEventListener('click',()=>{if($('repair-confirm').checked&&repairCandidate)void repairController(true);});
$('repair-confirm').addEventListener('change',renderRepair);
$('repair-close').addEventListener('click',()=>{$('repair-panel').hidden=true;$('repair-confirm').checked=false;});

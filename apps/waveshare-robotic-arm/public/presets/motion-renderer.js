import {GEOMETRY,OFFSET_MODEL_REVISION,KINEMATIC_MODELS,forwardKinematics} from './kinematics.js';
import {SCORE_JOINTS,sampleScore} from './motion-score.js';
const rad=pose=>Object.fromEntries(SCORE_JOINTS.map(j=>[j,(pose[j]-(j==='shoulder'?90:0))*Math.PI/180]));
export function illustrationJoints(pose){
 const p=rad(pose),r=GEOMETRY.l2*Math.sin(p.shoulder+GEOMETRY.t2rad);
 const elbow=[r*Math.cos(p.base),r*Math.sin(p.base),GEOMETRY.l2*Math.cos(p.shoulder+GEOMETRY.t2rad)];
 const tip=forwardKinematics(p,OFFSET_MODEL_REVISION);
 return {pose:p,points:[[0,0,-100],[0,0,0],elbow,[tip.x,tip.y,tip.z]],tip:[tip.x,tip.y,tip.z]};
}
export function motionTrail(score,count=100){return Array.from({length:count},(_,i)=>illustrationJoints(sampleScore(score,score.durationMs*i/(count-1)).pose).tip);}
export function drawMotion(canvas,pose,{view='perspective',anchor,trail=[],time=0}={}){
 const width=canvas.clientWidth||700,height=canvas.clientHeight||320,dpr=Math.min(devicePixelRatio||1,2);
 if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
 const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,width,height);
 const scale=Math.min(width/780,height/520),yaw=view==='side'?0:view==='top'?-.45:-.65,pitch=view==='side'?0:view==='top'?Math.PI/2:.4;
 const project=p=>{
  const x=p[0]-150,y=p[1],z=p[2]-130;
  return [width/2+(x*Math.cos(yaw)-y*Math.sin(yaw))*scale,height/2-(z*Math.cos(pitch)-(x*Math.sin(yaw)+y*Math.cos(yaw))*Math.sin(pitch))*scale];
 };
 const line=(a,b,color,w=1)=>{const p=project(a),q=project(b);c.strokeStyle=color;c.lineWidth=w;c.beginPath();c.moveTo(...p);c.lineTo(...q);c.stroke();};
 const dot=(p,r,color)=>{const q=project(p);c.fillStyle=color;c.beginPath();c.arc(...q,r,0,Math.PI*2);c.fill();};
 const glow=c.createRadialGradient(width*.55,height*.45,0,width*.55,height*.45,width*.6);glow.addColorStop(0,'#ff7a000e');glow.addColorStop(1,'#ff7a0000');c.fillStyle=glow;c.fillRect(0,0,width,height);
 for(let i=-3;i<=6;i++){line([i*100,-300,-100],[i*100,300,-100],'#7b3d191f');line([-300,i*100,-100],[600,i*100,-100],'#7b3d191f');}
 line([0,0,-100],[90,0,-100],'#e0894766',1.5);line([0,0,-100],[0,90,-100],'#53f0a266',1.5);
 for(let i=1;i<trail.length;i++)line(trail[i-1],trail[i],'#53f0a23b',1);
 function arm(p,color,ghost=false){
  const scene=illustrationJoints(p),pts=scene.points,across=[-Math.sin(scene.pose.base),Math.cos(scene.pose.base),0];
  const add=(a,b,k)=>a.map((v,i)=>v+b[i]*k);
  for(let i=0;i<pts.length-1;i++){
   const a=pts[i],b=pts[i+1],w=i===0?23:i===1?17:12;
   for(const side of [-1,1])line(add(a,across,side*w),add(b,across,side*w),color,ghost?1:1.6);
   line(add(a,across,-w),add(a,across,w),color);line(add(b,across,-w),add(b,across,w),color);
   if(!ghost)line(a,b,'#ffad562b',7);
  }
  const angle=scene.pose.shoulder+scene.pose.elbow+KINEMATIC_MODELS[OFFSET_MODEL_REVISION].distalOffsetRad;
  const axis=[Math.sin(angle)*Math.cos(scene.pose.base),Math.sin(angle)*Math.sin(scene.pose.base),Math.cos(angle)];
  const tip=pts.at(-1),palm=add(tip,axis,22),opening=12+Math.max(0,(p.gripper-61.9)/(179.912109375-61.9))*20;
  line(tip,palm,color,2);for(const side of [-1,1]){const jaw=add(palm,across,opening*side),end=add(jaw,axis,32);line(palm,jaw,color);line(jaw,end,color,1.8);line(end,add(end,across,-side*8),color);}
  if(!ghost)for(const p of pts.slice(1)){const q=project(p);c.fillStyle='#1b100b';c.strokeStyle='#ffc689';c.lineWidth=1.5;c.beginPath();c.arc(...q,7,0,Math.PI*2);c.fill();c.stroke();dot(p,2,'#ff9d2e');}
 }
 if(anchor)arm(anchor,'#ffbd7940',true);arm(pose,'#ff9d2e');dot(illustrationJoints(pose).tip,3,'#53f0a2');
 c.font='10px Consolas, monospace';c.fillStyle='#ba865c';c.fillText('ILLUSTRATION / NOT LIVE ARM',15,23);c.fillStyle='#9d775d';c.fillText('Linkage model · approximate gripper',15,height-14);
 c.textAlign='right';c.fillText((time/1000).toFixed(2)+' s',width-15,23);c.textAlign='left';
}

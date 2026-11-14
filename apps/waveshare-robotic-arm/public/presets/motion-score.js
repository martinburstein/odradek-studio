// Pure offline choreography. No Controller, transport, camera or network calls.
// Original implementation: synchronized quintic Bezier channels with monotone
// tangents. Pacing limits describe the illustration, not measured servo limits.
export const SCORE_JOINTS=Object.freeze(['base','shoulder','elbow','gripper']);
export const SCORE_BOUNDS=Object.freeze({base:[-180,180],shoulder:[0,180],elbow:[0,180],gripper:[61.9,179.912109375]});
export const PREVIEW_PACING=Object.freeze({
 base:{velocity:35,acceleration:90,jerk:650},
 shoulder:{velocity:20,acceleration:60,jerk:400},
 elbow:{velocity:30,acceleration:80,jerk:550},
 gripper:{velocity:20,acceleration:60,jerk:400}
});
export const ILLUSTRATION_POSE=Object.freeze({base:0,shoulder:90,elbow:80,gripper:120});
const finite=(v,name,min,max)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error(`${name} must be between ${min} and ${max}`);return v;};
export function scorePose(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('A four-joint pose is required');
 return Object.fromEntries(SCORE_JOINTS.map(j=>[j,finite(value[j],j,...SCORE_BOUNDS[j])]));
}
export function validateFrames(frames){
 if(!Array.isArray(frames)||frames.length<2||frames.length>64)throw Error('A preview needs 2–64 positions');
 return frames.map((f,i)=>{
  if(!f||typeof f.label!=='string'||!f.label.trim()||f.label.length>80)throw Error('Each position needs a short label');
  return {label:f.label.trim(),pose:scorePose(f.pose),durationMs:i===0?0:finite(f.durationMs??1200,'Transition duration',150,15000),holdMs:finite(f.holdMs??0,'Hold duration',0,5000)};
 });
}
function derivative(points,T){const n=points.length-1;return points.slice(1).map((p,i)=>n*(p-points[i])/T);}
function channel(p0,p1,v0,v1,T){
 const points=[p0,p0+v0*T/5,p0+2*v0*T/5,p1-2*v1*T/5,p1-v1*T/5,p1];
 const velocity=derivative(points,T),acceleration=derivative(velocity,T),jerk=derivative(acceleration,T);
 return {points,velocity,acceleration,jerk};
}
function deCasteljau(points,u){let row=points;while(row.length>1)row=row.slice(1).map((p,i)=>row[i]*(1-u)+p*u);return row[0];}
const maxAbs=values=>Math.max(...values.map(Math.abs));
function build(frames,style,timeScale){
 const durations=frames.map((f,i)=>i===0?0:f.durationMs*timeScale/1000);
 const tangents=frames.map((f,i)=>Object.fromEntries(SCORE_JOINTS.map(j=>{
  if(style==='pose'||i===0||i===frames.length-1||f.holdMs>0)return [j,0];
  const before=(f.pose[j]-frames[i-1].pose[j])/durations[i],after=(frames[i+1].pose[j]-f.pose[j])/durations[i+1];
  // This 0.8*min slope construction keeps each Bezier control polygon
  // monotone: 2*T*(v0+v1)/5 <= .64*endpoint travel. No overshoot.
  return [j,before*after>0?Math.sign(before)*.8*Math.min(Math.abs(before),Math.abs(after)):0];
 })));
 let timeMs=frames[0].holdMs*timeScale;const segments=[];
 for(let i=1;i<frames.length;i++){
  const from=frames[i-1],to=frames[i],durationMs=durations[i]*1000;
  const channels=Object.fromEntries(SCORE_JOINTS.map(j=>[j,channel(from.pose[j],to.pose[j],tangents[i-1][j],tangents[i][j],durations[i])]));
  const segment={index:i,label:to.label,startMs:timeMs,endMs:timeMs+durationMs,holdEndMs:timeMs+durationMs+to.holdMs*timeScale,durationMs,channels};
  segments.push(segment);timeMs=segment.holdEndMs;
 }
 return {segments,durationMs:timeMs,initialHoldMs:frames[0].holdMs*timeScale};
}
export function compileScore({frames,style='flow',tempo=1}={}){
 const normalized=validateFrames(frames);if(!['flow','pose'].includes(style))throw Error('Choose flow or pose pacing');finite(tempo,'Tempo',.5,2);
 const first=build(normalized,style,1/tempo);let stretch=1;
 for(const segment of first.segments)for(const j of SCORE_JOINTS){const c=segment.channels[j],l=PREVIEW_PACING[j];stretch=Math.max(stretch,maxAbs(c.velocity)/l.velocity,Math.sqrt(maxAbs(c.acceleration)/l.acceleration),Math.cbrt(maxAbs(c.jerk)/l.jerk));}
 // A single common scale retains relative timing and inter-joint synchrony.
 // Derivative Bezier convex-hull bounds cover the entire interval (floating
 // point arithmetic, not a formal interval proof or hardware qualification).
 const timing=build(normalized,style,stretch/tempo);
 if(timing.durationMs>300000)throw Error('This illustration exceeds the five-minute preview budget');
 const peaks=Object.fromEntries(SCORE_JOINTS.map(j=>[j,Object.fromEntries(['velocity','acceleration','jerk'].map(k=>[k,Math.max(...timing.segments.map(s=>maxAbs(s.channels[j][k])))]))]));
 const returnsToStart=SCORE_JOINTS.every(j=>Math.abs(normalized[0].pose[j]-normalized.at(-1).pose[j])<1e-9);
 return {schema:'odradek-motion-score-v1',mode:'offline-illustration',frames:normalized,style,tempo,timeScale:stretch/tempo,pacingStretch:stretch,...timing,peaks,returnsToStart,physicalMotionVerified:false,hardwareCommands:0};
}
export function sampleScore(score,timeMs){
 if(score?.schema!=='odradek-motion-score-v1')throw Error('Compile a motion score before sampling');
 finite(timeMs,'Preview time',0,1e9);const t=Math.min(timeMs,score.durationMs);
 let segment=score.segments.find(s=>t<=s.holdEndMs)??score.segments.at(-1);
 const atStart=t<score.initialHoldMs,holding=atStart||t>segment.endMs||t>=score.durationMs;
 const pose={},velocity={},acceleration={},jerk={};
 for(const j of SCORE_JOINTS){
  const c=segment.channels[j],u=Math.max(0,Math.min(1,(t-segment.startMs)/segment.durationMs));
  pose[j]=atStart?score.frames[0].pose[j]:deCasteljau(c.points,u);
  velocity[j]=holding?0:deCasteljau(c.velocity,u);acceleration[j]=holding?0:deCasteljau(c.acceleration,u);jerk[j]=holding?0:deCasteljau(c.jerk,u);
 }
 return {timeMs:t,pose,velocity,acceleration,jerk,phaseIndex:atStart?0:segment.index,label:atStart?score.frames[0].label:segment.label,holding,complete:t>=score.durationMs};
}
export function framesFromPreset(preset){
 if(!preset||!Array.isArray(preset.positions))throw Error('Choose a saved movement');
 return validateFrames(preset.positions.map((p,i)=>({label:p.label||`Position ${i+1}`,pose:p.degrees,durationMs:p.durationMs??1200,holdMs:p.holdMs??0})));
}
export function retargetFrames(frames,baseline,{intensity=1,mirror=false}={}){
 const input=validateFrames(frames),anchor=scorePose(baseline);finite(intensity,'Intensity',.25,1.5);if(typeof mirror!=='boolean')throw Error('Mirror must be a boolean');
 return validateFrames(input.map(f=>({...f,pose:Object.fromEntries(SCORE_JOINTS.map(j=>[j,anchor[j]+(f.pose[j]-input[0].pose[j])*intensity*(j==='base'&&mirror?-1:1)]))})));
}
export function exportScore(score,{name,source='designed'}={}){
 if(typeof name!=='string'||!name.trim()||name.length>80)throw Error('Give the score a short name');
 return {schema:'odradek-motion-design-v1',name:name.trim(),source,coordinateSystem:'manual-degrees (shoulder +90)',style:score.style,tempo:score.tempo,frames:structuredClone(score.frames),previewDurationMs:score.durationMs,pacingStretch:score.pacingStretch,previewPacing:PREVIEW_PACING,peaks:score.peaks,physicalMotionVerified:false,hardwareCommands:0,note:'Offline motion design. Timings and interpolation are illustrative, not executable RoArm servo commands. First frame is the preview anchor, not a measured starting pose.'};
}

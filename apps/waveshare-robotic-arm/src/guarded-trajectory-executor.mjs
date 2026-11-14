import {planGuardedElbow,elbowReference} from './guarded-elbow-trajectory.mjs';

// All I/O is injected by the shared Movement/Controller. No queues or retries.
export async function executeGuardedTrajectory({trajectory,signal,clock,wait,guard,read,validateSample,persist,send,records=[],origin=null}){
 if(JSON.stringify(trajectory)!==JSON.stringify(planGuardedElbow(trajectory?.startTick)))throw Error('Trajectory changed from the fixed reviewed profile');
 const p=trajectory.policy;let previousAt=null;
 const check=()=>{if(signal?.aborted)throw Error('Trajectory cancelled');};
 for(const point of trajectory.points){
  check();if(origin!==null)await wait(Math.max(0,origin+point.atMs-p.prepareLeadMs-clock()),signal);check();guard();
  const sample=await read(signal);check();validateSample(sample);
  const at=Date.parse(sample?.observedAt),now=clock();
  if(!Number.isFinite(at)||at>now||now-at>500||previousAt!==null&&(at<=previousAt||at-previousAt>500))throw Error('Trajectory feedback stale or interrupted');
  previousAt=at;
  if(origin!==null&&now-origin-point.atMs>p.maxLatenessMs)throw Error('Trajectory slot late; no catch-up');
  const expected=origin===null?trajectory.startTick:elbowReference(trajectory.startTick,now-origin);
  if(!Number.isInteger(sample.elbowTick)||Math.abs(sample.elbowTick-expected)>p.maxTrackingErrorTicks)throw Error('Trajectory tracking error exceeded guard');
  const record={index:point.index,atMs:point.atMs,referenceTick:point.referenceTick,targetTick:point.tick,command:{...point.command},feedback:sample,phase:'intent',intendedAt:origin===null?null:new Date(origin+point.atMs).toISOString(),preparedAt:new Date(clock()).toISOString()};
  records.push(record);await persist(records);check();
  if(origin!==null)await wait(Math.max(0,origin+point.atMs-clock()),signal);check();guard();
  if(origin!==null&&clock()-origin-point.atMs>p.maxLatenessMs)throw Error('Trajectory slot late after journal; no dispatch');
  if(origin===null)origin=clock();
  record.dispatchedAt=new Date(clock()).toISOString();record.phase='attempted';
  const receipt=await send(point.command,signal,{origin,point,record});check();
  record.receipt=receipt;record.phase=receipt?.sent===true||receipt?.acknowledged===true?'delivered':'uncertain';
  await persist(records);check();
  if(record.phase!=='delivered')throw Error('Trajectory delivery unconfirmed; no retry');
 }
 return {origin,records};
}

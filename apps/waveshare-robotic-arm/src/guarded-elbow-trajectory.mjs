import {elbowCommandForTick} from './z-lift-actuators.mjs';

export const GUARDED_ELBOW_POLICY=Object.freeze({revision:'guarded-elbow-quintic-v1',durationMs:45000,intervalMs:200,prepareLeadMs:150,maxLatenessMs:100,maxDeltaTicks:3,maxTrackingErrorTicks:12,observationWindowMs:54000,timeoutMs:55000,speed:20,acceleration:1});
export const sameTrajectoryPolicy=x=>JSON.stringify(x)===JSON.stringify(GUARDED_ELBOW_POLICY);
export function elbowReference(startTick,elapsedMs){
 const u=Math.max(0,Math.min(1,elapsedMs/GUARDED_ELBOW_POLICY.durationMs));
 return startTick+(2389-startTick)*(10*u**3-15*u**4+6*u**5);
}
// Analytic limits describe the requested reference, never measured servo motion.
export function planGuardedElbow(startTick){
 if(!Number.isInteger(startTick)||Math.abs(startTick-2052)>4)throw Error('Guarded stroke requires the admitted horizontal start');
 const p=GUARDED_ELBOW_POLICY,d=2389-startTick,T=p.durationMs/1000;
 const peakSpeedTicksPerSecond=1.875*d/T,peakAccelerationTicksPerSecondSquared=(10/Math.sqrt(3))*d/T**2;
 if(peakSpeedTicksPerSecond>p.speed||peakAccelerationTicksPerSecondSquared>p.acceleration)throw Error('Reference exceeds conservative documented F20/acc1 limits');
 const points=Array.from({length:p.durationMs/p.intervalMs+1},(_,index)=>{
  const atMs=index*p.intervalMs,referenceTick=elbowReference(startTick,atMs),tick=Math.round(referenceTick);
  return {index,atMs,referenceTick,tick,command:elbowCommandForTick(tick)};
 });
 if(points.some((point,i)=>point.tick<startTick||point.tick>2389||i&&(point.tick<points[i-1].tick||point.tick-points[i-1].tick>p.maxDeltaTicks)))throw Error('Quantized trajectory exceeds monotone step bounds');
 return {policy:{...p},startTick,targetTick:2389,peakSpeedTicksPerSecond,peakAccelerationTicksPerSecondSquared,points,physicalMotionVerified:false};
}

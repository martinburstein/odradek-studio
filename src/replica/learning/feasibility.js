// Pure reference-geometry feasibility map. No DOM, device, Node or network imports.
import {padPoint,referenceIK,toolGeometry,geometryContacts} from './geometry.js';

const finiteMean=values=>{const kept=values.filter(Number.isFinite);return kept.length?kept.reduce((sum,x)=>sum+x,0)/kept.length:null;};

// Exact-position reference IK has no independent wrist rotation. This preserves
// the original robustness-study arithmetic and result shape.
export function fixedAngleFeasibility(experiment,{uCount=15,vCount=9,tolerance=experiment.tiltTolerance}={}){
 if(!Number.isInteger(uCount)||uCount<2||uCount>101||!Number.isInteger(vCount)||vCount<2||vCount>101||!Number.isFinite(tolerance)||tolerance<0||tolerance>45)throw Error('Invalid fixed-angle grid settings.');
 const rows=[];
 for(let iu=0;iu<uCount;iu++)for(let iv=0;iv<vCount;iv++){
  const u=iu/(uCount-1),v=iv/(vCount-1),target=padPoint(experiment.frame,u,v),solutions=referenceIK(target,experiment.tool,experiment.gripper).map(pose=>{
   const geometry=toolGeometry(pose,experiment.tool),contact=geometryContacts(geometry,experiment.desk,experiment.frame,experiment.tool);
   return{pose,angleError:Math.abs(geometry.tilt-experiment.tool.targetTilt),collision:contact.collision};
  });
  const best=solutions.reduce((answer,row)=>!answer||row.angleError<answer.angleError?row:answer,null),clear=solutions.filter(row=>!row.collision),bestClear=clear.reduce((answer,row)=>!answer||row.angleError<answer.angleError?row:answer,null);
  rows.push({u,v,positionReachable:solutions.length>0,collisionFreePositionReachable:clear.length>0,bestAngleError:best?.angleError??null,bestCollisionFreeAngleError:bestClear?.angleError??null,withinTolerance:best?.angleError<=tolerance,collisionFreeWithinTolerance:bestClear?.angleError<=tolerance});
 }
 const summarize=key=>{const found=rows.filter(row=>Number.isFinite(row[key]));return{count:found.length,meanDegrees:finiteMean(found.map(row=>row[key])),maxDegrees:found.length?Math.max(...found.map(row=>row[key])):null,withinToleranceCount:found.filter(row=>row[key]<=tolerance).length};};
 return{grid:{uCount,vCount,points:rows.length},targetTiltDegrees:experiment.tool.targetTilt,toleranceDegrees:tolerance,positionReachableCount:rows.filter(row=>row.positionReachable).length,collisionFreePositionReachableCount:rows.filter(row=>row.collisionFreePositionReachable).length,angleErrorAmongPositionReachable:summarize('bestAngleError'),angleErrorAmongCollisionFreeReachable:summarize('bestCollisionFreeAngleError'),points:rows};
}

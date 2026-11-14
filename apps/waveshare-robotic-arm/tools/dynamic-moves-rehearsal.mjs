// One reusable suite runner. Uses an isolated Controller simulator, never a live API.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Controller} from '../src/controller.mjs';
import {dynamicMove, dynamicMoves} from '../src/dynamic-moves.mjs';

export async function rehearseDynamicMove(name) {
 const routine=dynamicMove(name); // Reject unknown names before constructing anything.
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'roarm-dynamic-sim-'));
 const controller=new Controller({directory}),owner='dynamic-move-rehearsal';
 const started=Date.now();
 try {
  await controller.connect({mode:'simulator'});
  await controller.claim(owner);
  const start={...controller.simulated};
  const begun=await controller.movement.begin({owner,moves:routine.moves,seconds:routine.seconds});
  const steps=[];
  for(let index=0;index<routine.moves.length;index++) {
   const row=await controller.movement.execute({owner,sessionId:begun.session.id,index,commandId:randomUUID()});
   if(row.state!=='complete'||row.result.outcome!=='simulated'||row.result.cleanupVerified!==true)throw Error('Simulator leg did not complete cleanly');
   steps.push({index,move:row.move,outcome:row.result.outcome,observed:row.result.observed,
    pauseMs:routine.pausesMs[index],cleanupVerified:row.result.cleanupVerified});
  }
  return {name,mode:'simulator',steps,start,end:{...controller.simulated},
   finiteSessionComplete:controller.movement.session===null,physicalMovementVerified:false,
   elapsedMs:Date.now()-started,rhythm:'Pauses are recorded for choreography playback; this accelerated simulator verifies endpoints, not physical timing.'};
 } finally {
  // Only this in-process simulator exists; no server, token, COM port or live runtime.
  await controller.disconnect();
  await fs.rm(directory,{recursive:true,force:true});
 }
}

export async function rehearseDynamicSuite() {
 const moves=[];
 for(const {name} of dynamicMoves())moves.push(await rehearseDynamicMove(name));
 return {schema:'roarm-dynamic-ten-rehearsal-v1',mode:'simulator',moves,
  physicalMovementVerified:false,hardwareCommands:0,liveRuntimeModified:false};
}

export function createZLiftPanel({request,perform,owner}){
  const $=id=>document.getElementById(id);
  const fields=['baseSecured','workspaceClear','gripperEmpty','powerSwitchReady','experimentalMotionAccepted'];
  let state=null,session=null,owned=false,online=false,busy=false,lastPreview=null;
  const checks=()=>Object.fromEntries(fields.map(k=>[k,$(`lift-${k}`).checked]));
  function update(next,context={}){
    state=next;session=context.session;owned=context.owned;online=context.online;busy=context.busy;
    const preview=state?.zLift?.preview,result=state?.zLift?.result;
    const visible=['visible-elbow-57-ticks-v1','visible-elbow-114-ticks-v1'].includes(preview?.plan?.experiment);
    const degrees=visible?Math.abs(preview.plan.delta.elbow*180/Math.PI).toFixed(1):null;
    $('lift-run').textContent=visible?'Arm one test: elbow up '+degrees+'°':'Arm one test: lift 2 mm';
    if(preview?.id!==lastPreview){for(const key of fields)$(`lift-${key}`).checked=false;lastPreview=preview?.id;}
    const available=online&&session?.role==='admin'&&session?.local&&owned&&state?.connected&&state.mode==='serial'&&!state.armed&&!state.commissioned&&!state.zLift?.active&&!state.execution?.busy&&!state.execution?.lifecycle&&!busy;
    $('lift-prepare').disabled=!available;
    const unexpired=preview&&Date.parse(preview.expiresAt)>Date.now();
    $('lift-run').disabled=!available||!unexpired||!preview?.ready||!Object.values(checks()).every(Boolean);
    $('lift-observe').disabled=!available||!result||Boolean(result.operatorObservation);
    $('lift-summary').replaceChildren();
    const line=text=>{const p=document.createElement('p');p.textContent=text;$('lift-summary').append(p);};
    if(state?.zLift?.active)line('ONE LIFT TEST ACTIVE — keep clear. Stop software queue prevents further commands; use the physical switch if intervention is needed.');
    else if(!preview)line('Claim controls, then prepare a preview from three fresh USB readings. Preparing does not move the arm.');
    if(preview){
      line(`Calculation model: ${preview.plan.modelLabel??preview.plan.modelRevision}. Coordinate agreement does not identify installed firmware or verify physical travel.`);
      line(`${visible?'Visible elbow experiment: about '+degrees+'° upward':'Requested lift: +'+preview.plan.liftMm+' mm in Z'}; motor-step model predicts +${preview.plan.predictedRiseMm.toFixed(2)} mm. Only the elbow receives a target; base, shoulder and gripper are monitored. No automatic return.`);
      line(`Model estimates: shoulder ${(preview.plan.delta.shoulder*180/Math.PI).toFixed(3)}°, elbow ${(preview.plan.delta.elbow*180/Math.PI).toFixed(3)}°. These are not measured physical travel.`);
      line(`Preview ${unexpired?'expires':'expired'} at ${new Date(preview.expiresAt).toLocaleTimeString()}. Test uses one slow joint command and up to 8 seconds of feedback observation.`);
      if(!preview.ready)line(`BLOCKED: ${preview.blockers.join(' ')}`);
      else line('Reviewed preflight evidence found. Check the setup below, then explicitly arm this one test. This does not approve general motion.');
    }
    if(result)line(`Last trial: ${result.outcome}. ${result.estimatedRiseMm===undefined?'':`Joint-derived rise estimate: ${result.estimatedRiseMm.toFixed(2)} mm.`} Physical movement is not automatically verified. ${result.operatorObservation?`Operator reported: ${result.operatorObservation.outcome}.`:'Record what you actually saw below.'}`);
  }
  const sync=()=>update(state,{session,owned,online,busy});
  for(const key of fields)$(`lift-${key}`).addEventListener('change',sync);
  $('lift-prepare').addEventListener('click',()=>void perform(()=>request('/api/z-lift/prepare',{owner:owner()}),'Lift preview prepared; no motion sent.'));
  $('lift-run').addEventListener('click',()=>void perform(()=>request('/api/z-lift/execute',{owner:owner(),previewId:state?.zLift?.preview?.id,confirmations:checks()}),'Lift trial finished. Inspect the arm and record what you saw.'));
  $('lift-observe').addEventListener('click',()=>void perform(()=>request('/api/z-lift/observe',{owner:owner(),trialId:state?.zLift?.result?.id,outcome:$('lift-outcome').value}),'Operator observation saved privately. No hardware profile was approved.'));
  return {update};
}

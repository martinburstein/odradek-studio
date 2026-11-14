import { REST_POSE, JOINT_KEYS, selectWireObservation, blendPose, previewPose, buildWireScene, projectWirePoint } from './wire-geometry.js';

/** Observation-only renderer. No API, command or transport dependency. */
export function mountWireArm(container) {
  const root = document.createElement('section');
  root.className = 'wire-home'; root.setAttribute('aria-label','3D arm above keyboard');
  root.innerHTML = `<div class="wire-heading"><div><p class="wire-kicker">DESKTOP COMPANION</p><h2>RoArm-M2-S <span> / WIRE VIEW</span></h2></div><span class="wire-source" role="status" aria-live="polite">No feedback</span></div>
    <canvas class="wire-canvas" role="img" aria-label="3D wireframe arm above a decorative keyboard"></canvas>
    <div class="wire-toolbar"><p class="wire-caption">Waiting for joint feedback · rest illustration</p><div><button type="button" class="wire-preview" aria-pressed="false">Preview animation</button><button type="button" class="wire-angle">Rotate view</button></div></div>
    <p class="wire-note">Approximate linkage · illustrative gripper and keyboard · view controls only</p>`;
  container.append(root);
  const canvas=root.querySelector('canvas'), ctx=canvas.getContext('2d');
  const badge=root.querySelector('.wire-source'), caption=root.querySelector('.wire-caption');
  const previewButton=root.querySelector('.wire-preview'), angleButton=root.querySelector('.wire-angle');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let status={}, current={...REST_POSE}, from=current, target=current, transitionAt=0;
  let observationKey='', lastSource=null, preview=false, previewAt=0, disposed=false, frame=0, lastDraw=0;
  let yaw=-0.65, width=0, height=0, drawingKey='';
  function resize() {
    const rect=canvas.getBoundingClientRect(), dpr=Math.min(devicePixelRatio || 1,2);
    width=rect.width; height=rect.height; drawingKey='';
    canvas.width=Math.round(width*dpr); canvas.height=Math.round(height*dpr); ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  const observer=new ResizeObserver(resize); observer.observe(canvas);
  function accept(now, tick) {
    const observation=selectWireObservation(status,now);
    if (observation.pose) {
      const key=JSON.stringify([observation.source, ...JOINT_KEYS.map(k=>observation.pose[k])]);
      if(key!==observationKey) {
        from={...current}; target=observation.pose; transitionAt=tick; observationKey=key;
        // A change of evidence source snaps to that observation instead of blending sources.
        if(lastSource!==observation.source || reduced.matches) { current={...target}; from={...target}; }
        lastSource=observation.source;
      }
      if(!preview) current=reduced.matches ? {...target} : blendPose(from,target,(tick-transitionAt)/220);
    } else {
      // Cancel interpolation at the last displayed pose; reconnection begins from here.
      from={...current}; target={...current}; observationKey='';
    }
    return observation;
  }
  function draw(pose) {
    if(!width || !height) return;
    const key=JSON.stringify([pose,yaw,width,height]);
    if(key===drawingKey) return;
    drawingKey=key;
    ctx.clearRect(0,0,width,height);
    const glow=ctx.createRadialGradient(width*.55,height*.45,0,width*.55,height*.45,width*.45);
    glow.addColorStop(0,'rgba(255,132,25,.075)'); glow.addColorStop(1,'rgba(255,132,25,0)');
    ctx.fillStyle=glow; ctx.fillRect(0,0,width,height);
    const scene=buildWireScene(pose), camera={width,height,yaw};
    const lines=scene.edges.map(edge=>({...edge,p:projectWirePoint(edge.a,camera),q:projectWirePoint(edge.b,camera)}));
    lines.sort((a,b)=>(a.p.depth+a.q.depth)-(b.p.depth+b.q.depth));
    for(const line of lines) {
      const keyboard=['keyboard','key'].includes(line.kind);
      ctx.strokeStyle=keyboard ? 'rgba(162,108,66,.38)' : line.kind==='detail' ? 'rgba(255,169,87,.33)' : line.kind==='joint' ? '#ffcc92' : '#ff962e';
      ctx.lineWidth=keyboard ? .7 : line.kind==='detail' ? .7 : 1.35;
      ctx.shadowColor='#ff7a18'; ctx.shadowBlur=keyboard ? 0 : 5;
      ctx.beginPath(); ctx.moveTo(line.p.x,line.p.y); ctx.lineTo(line.q.x,line.q.y); ctx.stroke();
    }
    ctx.shadowBlur=0;
    for(const joint of scene.joints) {
      const p=projectWirePoint(joint,camera); ctx.fillStyle='#ffe0b9'; ctx.beginPath(); ctx.arc(p.x,p.y,2.2,0,Math.PI*2); ctx.fill();
    }
    root.dataset.pose=JSON.stringify(pose);
  }
  function paint(tick) {
    if(disposed) return;
    frame=requestAnimationFrame(paint);
    if(document.hidden || !root.getClientRects().length || tick-lastDraw<33) return;
    lastDraw=tick;
    const observation=accept(Date.now(),tick);
    root.dataset.source=preview ? 'preview' : observation.state==='live' ? observation.source : observation.state;
    const label=preview ? 'VISUAL PREVIEW' : observation.state==='live' ? `${observation.source.toUpperCase()} · LIVE` : observation.state==='offline' ? 'OFFLINE · FROZEN' : lastSource ? 'STALE · FROZEN' : 'NO JOINT FEEDBACK';
    if(badge.textContent!==label) badge.textContent=label;
    const observed=observation.observedAt ? new Date(observation.observedAt).toLocaleTimeString() : 'unavailable';
    const description=preview ? reduced.matches ? 'Preview paused · reduced motion enabled' : 'Local animation · no robot commands' : observation.state==='live' ? `Following ${observation.source==='hardware' ? 'measured arm' : 'simulated'} joints · ${observed}` : lastSource ? `Last ${lastSource} pose held · feedback ${observed}` : 'Rest illustration · waiting for joint feedback';
    if(caption.textContent!==description) caption.textContent=description;
    draw(preview ? previewPose(reduced.matches ? 0 : (tick-previewAt)/1000) : current);
  }
  function togglePreview() {
    preview=!preview; previewAt=performance.now(); observationKey='';
    previewButton.textContent=preview ? 'Follow arm' : 'Preview animation'; previewButton.setAttribute('aria-pressed',String(preview));
  }
  function rotate() { yaw=yaw===-0.65 ? 0.5 : -0.65; }
  previewButton.addEventListener('click',togglePreview); angleButton.addEventListener('click',rotate);
  resize(); frame=requestAnimationFrame(paint);
  return {
    update(next={}) { status=next && typeof next==='object' ? next : {}; },
    destroy() { disposed=true; cancelAnimationFrame(frame); observer.disconnect(); previewButton.removeEventListener('click',togglePreview); angleButton.removeEventListener('click',rotate); root.remove(); }
  };
}

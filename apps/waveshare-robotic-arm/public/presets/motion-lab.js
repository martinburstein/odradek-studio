import {compileScore,sampleScore,framesFromPreset,retargetFrames,exportScore,SCORE_JOINTS,ILLUSTRATION_POSE} from './motion-score.js';
import {motionRecipes,recipeFrames} from './motion-recipes.js';
import {drawMotion,motionTrail} from './motion-renderer.js';
const make=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const svgNS='http://www.w3.org/2000/svg';
export function mountMotionLab(container,{saveDesign,onSaved}={}){
 container.innerHTML=`<div class="lab">
 <div class="lab-head"><div><p class="eyebrow">OFFLINE MOTION LAB</p><h3 id="lab-title">Curious scan</h3><p id="lab-description"></p></div><span class="lab-offline">ARM NOT REQUIRED</span></div>
 <div class="lab-controls"><label>Movement phrase<select id="lab-source" aria-label="Movement phrase"></select></label><label>Motion character<select id="lab-style"><option value="flow">Flow through positions</option><option value="pose">Settle at each position</option></select></label></div>
 <div class="lab-slider-row"><label>Intensity <span id="lab-intensity-label">100%</span><input id="lab-intensity" type="range" min="25" max="150" value="100" step="5"></label><label>Tempo <span id="lab-tempo-label">1.00×</span><input id="lab-tempo" type="range" min="50" max="200" value="100" step="5"></label></div>
 <div class="lab-stage"><canvas id="lab-canvas" role="img" aria-label="Offline illustration of the arm's planned movement"></canvas><div class="lab-view-buttons"><button data-view="perspective" aria-pressed="true">3D</button><button data-view="side" aria-pressed="false">Side</button><button data-view="top" aria-pressed="false">Top</button></div></div>
 <div class="lab-transport"><div class="lab-play-row"><button id="lab-play" class="primary">▶ Play preview</button><button id="lab-reset">↺ Reset</button><select id="lab-repeats" aria-label="Preview repetitions"><option value="1">Play once</option><option value="3">3 repeats</option></select><span id="lab-play-status">READY</span></div><div class="lab-progress-row"><input id="lab-scrub" aria-label="Preview timeline" type="range" min="0" max="1000" value="0" step="1"><span id="lab-clock" class="lab-clock"></span></div><div class="lab-phase-row"><span id="lab-phase"></span><span id="lab-cycle"></span></div></div>
 <div id="lab-readouts" class="lab-readouts"></div><div class="lab-plot"><div class="lab-legend"><span>BASE</span><span>SHOULDER</span><span>ELBOW</span><span>GRIPPER</span></div><svg id="lab-graph" viewBox="0 0 640 100" role="img" aria-label="Joint angle offsets over preview time"></svg></div>
 <details class="lab-inspector"><summary>Timing &amp; pauses</summary><p>Transition is the time into this position. A hold makes the arm pause there. Fast phrases are slowed together to stay within the preview's pacing bounds.</p><div id="lab-phases" class="lab-phase-list"></div></details>
 <details class="lab-inspector"><summary>Starting pose &amp; direction</summary><p>This is a design anchor, not the current arm position. Changing it shifts the whole phrase without accumulating offsets.</p><div id="lab-baseline" class="lab-baseline"></div><div class="lab-baseline-actions"><button id="lab-anchor-apply">Apply anchor</button><button id="lab-anchor-reset">Illustration pose</button><label><input id="lab-mirror" type="checkbox"> Mirror turn</label></div></details>
 <details class="lab-inspector"><summary>Preview checks &amp; GitHub inspiration</summary><pre id="lab-checks"></pre><p>Flow preserves position, velocity and acceleration across joins. Turning points and explicit holds come to rest. Jerk is bounded within each segment; it may jump at joins. These are mathematical preview results, not a measured servo response or collision clearance check.</p><div class="lab-sources"><a href="https://github.com/pollen-robotics/reachy_mini_dances_library" target="_blank" rel="noopener">Reachy choreography ↗</a><a href="https://github.com/pantor/ruckig" target="_blank" rel="noopener">Ruckig motion timing ↗</a><a href="https://github.com/Intempus-Inc/robot-rigs" target="_blank" rel="noopener">Robot animation rigs ↗</a></div></details>
 <div class="lab-save-row"><input id="lab-name" maxlength="80" aria-label="Design name" placeholder="Name this motion design"><button id="lab-save">Save as preset draft</button><button id="lab-export">Export design ↓</button></div><p class="lab-note">Drafts are labelled DESIGNED in Movement Preset. Preview and saving send no arm commands. Physical playback still uses the existing Controller.</p><p id="lab-message" class="lab-message" role="status" aria-live="polite"></p>
 </div>`;
 const $=id=>container.querySelector('#'+id);let library={presets:[]},source='recipe:curious-scan',baseFrames=recipeFrames('curious-scan'),frames=[],score=null,trail=[],anchor={...ILLUSTRATION_POSE},view='perspective',playing=false,time=0,lastTick=null,raf=null,cycle=1,saving=false;
 const message=(text,error=false)=>{$('lab-message').textContent=text;$('lab-message').classList.toggle('error',error);};
 for(const j of SCORE_JOINTS){const box=make('div');box.append(make('small',j),make('strong','—'));box.dataset.joint=j;$('lab-readouts').append(box);const label=make('label',j[0].toUpperCase()+j.slice(1)),input=make('input');input.type='number';input.step='0.1';input.value=anchor[j];input.dataset.joint=j;label.append(input);$('lab-baseline').append(label);}
 function options(){
  $('lab-source').replaceChildren();const group=make('optgroup');group.label='Motion phrases';for(const r of motionRecipes()){const o=make('option',r.name);o.value='recipe:'+r.id;group.append(o);}$('lab-source').append(group);
  const presets=library.presets.filter(p=>!p.archived&&p.positions.length>=2);if(presets.length){const group=make('optgroup');group.label='Your saved movements';for(const p of presets){const o=make('option',p.name+(p.source==='designed'?' · draft':''));o.value='preset:'+p.id;group.append(o);}$('lab-source').append(group);}
  $('lab-source').value=source;
 }
 function pause(){playing=false;lastTick=null;if(raf!==null)cancelAnimationFrame(raf);raf=null;$('lab-play').textContent='▶ Play preview';$('lab-play-status').textContent=time>=score?.durationMs?'COMPLETE':time>0?'PAUSED':'READY';}
 function readAnchor(){return Object.fromEntries([...$('lab-baseline').querySelectorAll('input')].map(input=>[input.dataset.joint,Number(input.value)]));}
 function writeAnchor(){for(const input of $('lab-baseline').querySelectorAll('input'))input.value=anchor[input.dataset.joint].toFixed(2);}
 function drawGraph(){
  const svg=$('lab-graph');svg.replaceChildren();const data=Array.from({length:121},(_,i)=>sampleScore(score,score.durationMs*i/120).pose),start=score.frames[0].pose,range=Math.max(2,...data.flatMap(p=>SCORE_JOINTS.map(j=>Math.abs(p[j]-start[j]))))*1.15;
  for(const y of [18,50,82]){const line=document.createElementNS(svgNS,'path');line.setAttribute('d',`M30 ${y}H630`);line.setAttribute('stroke','#63351d66');svg.append(line);}
  const colors=['#ff9d2e','#53f0a2','#79aef8','#c198f5'];SCORE_JOINTS.forEach((j,k)=>{const path=document.createElementNS(svgNS,'path');path.setAttribute('d',data.map((p,i)=>`${i?'L':'M'}${30+i*5} ${50-(p[j]-start[j])/range*40}`).join(' '));path.setAttribute('stroke',colors[k]);path.setAttribute('stroke-width','1.5');path.setAttribute('fill','none');svg.append(path);});
  for(const [value,y]of [[range,11],[0,53],[-range,96]]){const text=document.createElementNS(svgNS,'text');text.textContent=value.toFixed(0)+'°';text.setAttribute('x','3');text.setAttribute('y',String(y));text.setAttribute('fill','#b68a64');text.setAttribute('font-size','8');svg.append(text);}
  const cursor=document.createElementNS(svgNS,'path');cursor.id='lab-cursor';cursor.setAttribute('stroke','#ffdfb9');cursor.setAttribute('stroke-width','1');svg.append(cursor);
 }
 function timingEditor(){
  $('lab-phases').replaceChildren();baseFrames.forEach((f,i)=>{const row=make('div',undefined,'lab-phase-item');row.append(make('span',`${String(i+1).padStart(2,'0')} / ${f.label}`));for(const [key,title,min,max]of [['durationMs','Transition (ms)',150,15000],['holdMs','Hold (ms)',0,5000]]){const label=make('label',title),input=make('input');input.type='number';input.min=min;input.max=max;input.step=50;input.value=f[key];input.disabled=i===0&&key==='durationMs';input.setAttribute('aria-label',`${f.label} ${title}`);input.addEventListener('change',()=>{const old=baseFrames[i][key];baseFrames[i][key]=Number(input.value);if(!rebuild()){baseFrames[i][key]=old;input.value=old;rebuild(false);}});label.append(input);row.append(label);}$('lab-phases').append(row);});
 }
 function rebuild(clearMessage=true){
  pause();try{
   const nextFrames=retargetFrames(baseFrames,anchor,{intensity:Number($('lab-intensity').value)/100,mirror:$('lab-mirror').checked});
   const next=compileScore({frames:nextFrames,style:$('lab-style').value,tempo:Number($('lab-tempo').value)/100});
   frames=nextFrames;score=next;trail=motionTrail(score);time=0;cycle=1;
   $('lab-repeats').querySelector('option[value="3"]').disabled=!score.returnsToStart;if(!score.returnsToStart)$('lab-repeats').value='1';
   $('lab-intensity-label').textContent=$('lab-intensity').value+'%';$('lab-tempo-label').textContent=(Number($('lab-tempo').value)/100).toFixed(2)+'×';
   $('lab-checks').textContent=`${frames.length} positions · ${(score.durationMs/1000).toFixed(2)} seconds\n${score.style==='flow'?'Flowing joins':'Rest at every position'} · no waypoint overshoot\nShared pacing stretch: ${score.pacingStretch.toFixed(2)}×\nPreview derivative upper bounds (deg/s, deg/s², deg/s³):\n`+SCORE_JOINTS.map(j=>`${j.padEnd(9)} ${Object.values(score.peaks[j]).map(v=>v.toFixed(2)).join(' / ')}`).join('\n')+'\nNo physical commands · no collision clearance claim';
   $('lab-play').disabled=false;$('lab-save').disabled=false;$('lab-export').disabled=false;
   drawGraph();render();if(clearMessage)message(!score.returnsToStart?'This phrase ends away from its starting pose, so it plays once without an invented return.':score.pacingStretch>1.001?'The preview lengthened the phrase to keep its motion smooth.':'');return true;
  }catch(e){message(e.message,true);$('lab-play').disabled=true;$('lab-save').disabled=true;$('lab-export').disabled=true;return false;}
 }
 function loadSource(value){
  pause();source=value;let name,description;
  if(value.startsWith('recipe:')){const id=value.slice(7),recipe=motionRecipes().find(r=>r.id===id);if(!recipe)throw Error('Unknown phrase');baseFrames=recipeFrames(id);name=recipe.name;description=recipe.description;anchor={...ILLUSTRATION_POSE};}
  else{const p=library.presets.find(p=>p.id===value.slice(7));if(!p)throw Error('Saved movement unavailable');baseFrames=framesFromPreset(p);name=p.name;description=p.source==='encoder'?'Preview of your captured positions. The path between captures is designed here; it was not recorded from the arm.':p.source==='designed'?'A saved offline design. Adjust its motion, then save a new version.':'Preview of simulator positions, not physical arm readings.';anchor={...baseFrames[0].pose};}
  $('lab-source').value=source;$('lab-title').textContent=name;$('lab-description').textContent=description;$('lab-name').value=name+' · design';$('lab-intensity').value='100';$('lab-tempo').value='100';$('lab-style').value='flow';$('lab-mirror').checked=false;
  const saved=source.startsWith('preset:')?library.presets.find(p=>p.id===source.slice(7)):null;if(saved?.design){$('lab-style').value=saved.design.style;$('lab-tempo').value=String(saved.design.tempo*100);}
  writeAnchor();timingEditor();rebuild();
 }
 function render(){
  if(!score)return;const sample=sampleScore(score,time);drawMotion($('lab-canvas'),sample.pose,{view,anchor:score.frames[0].pose,trail,time});
  $('lab-scrub').value=String(Math.round(1000*time/score.durationMs));$('lab-clock').textContent=`${(time/1000).toFixed(1)} / ${(score.durationMs/1000).toFixed(1)} s`;
  $('lab-phase').textContent=sample.complete?'Phrase complete':`${sample.phaseIndex+1}. ${sample.label}${sample.holding?' · hold':''}`;$('lab-cycle').textContent=`${cycle} / ${$('lab-repeats').value} PLAY${$('lab-repeats').value==='1'?'':'S'}`;
  for(const box of $('lab-readouts').children)box.querySelector('strong').textContent=sample.pose[box.dataset.joint].toFixed(2)+'°';
  const x=30+600*time/score.durationMs;$('lab-cursor')?.setAttribute('d',`M${x} 5V95`);
  if(!playing)$('lab-play-status').textContent=sample.complete?'COMPLETE':time>0?'PAUSED':'READY';
 }
 function tick(now){
  if(!playing)return;if(document.hidden||!container.getClientRects().length){pause();return;}
  if(lastTick!==null)time=Math.min(score.durationMs,time+Math.min(250,now-lastTick));lastTick=now;
  render();if(time>=score.durationMs){if(cycle<Number($('lab-repeats').value)){cycle++;time=0;lastTick=null;}else{pause();render();return;}}
  raf=requestAnimationFrame(tick);
 }
 $('lab-play').addEventListener('click',()=>{if(playing){pause();return;}if(!score)return;if(time>=score.durationMs){time=0;cycle=1;}playing=true;lastTick=null;$('lab-play').textContent='Ⅱ Pause preview';$('lab-play-status').textContent='PREVIEWING';raf=requestAnimationFrame(tick);});
 $('lab-reset').addEventListener('click',()=>{pause();time=0;cycle=1;render();});$('lab-scrub').addEventListener('input',()=>{pause();time=score.durationMs*Number($('lab-scrub').value)/1000;render();});
 $('lab-source').addEventListener('change',()=>{try{loadSource($('lab-source').value);}catch(e){message(e.message,true);}});
 for(const id of ['lab-style','lab-intensity','lab-tempo','lab-mirror'])$(id).addEventListener('input',()=>rebuild());
 $('lab-repeats').addEventListener('change',()=>{pause();cycle=1;render();});
 $('lab-anchor-apply').addEventListener('click',()=>{const previous=anchor;anchor=readAnchor();if(!rebuild()){anchor=previous;writeAnchor();}});
 $('lab-anchor-reset').addEventListener('click',()=>{anchor={...ILLUSTRATION_POSE};writeAnchor();rebuild();});
 for(const b of container.querySelectorAll('[data-view]'))b.addEventListener('click',()=>{view=b.dataset.view;for(const v of container.querySelectorAll('[data-view]'))v.setAttribute('aria-pressed',String(v===b));render();});
 $('lab-save').addEventListener('click',async()=>{if(saving||!score)return;saving=true;$('lab-save').disabled=true;try{const design=exportScore(score,{name:$('lab-name').value});const result=await saveDesign(design);if(result){message('Saved as an offline preset draft.');onSaved?.(result.selectedId);}}catch(e){message(e.message,true);}finally{saving=false;$('lab-save').disabled=false;}});
 $('lab-export').addEventListener('click',()=>{try{const data=exportScore(score,{name:$('lab-name').value}),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'})),a=make('a');a.href=url;a.download=data.name.replace(/[^a-z0-9_-]/gi,'-')+'.motion.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message('Motion design exported.');}catch(e){message(e.message,true);}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});window.addEventListener('studio:tab',e=>{if(e.detail!=='automatic')pause();else render();});
 new ResizeObserver(()=>render()).observe($('lab-canvas'));
 options();loadSource(source);
 return {pause,refresh:render,updateLibrary(value){library=value;options();},previewPreset(id){options();loadSource('preset:'+id);},inspect:()=>({playing,time,score})};
}

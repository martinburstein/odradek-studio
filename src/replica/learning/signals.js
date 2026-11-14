import {makeTasks,taskTarget} from './tasks.js';

const PALETTE={actual:'#53e6f2',target:'#ffb547',gap:'#a88cff',bad:'#ff5367',muted:'#b79579',line:'#754124'};
const X0=32,X1=308,Y0=12,Y1=84;
const number=value=>Number(value.toPrecision(3)).toString();

// These charts expose retained replay samples. Existing episode metrics still
// cover every integration step; plots do not fabricate missing samples.
export function buildTrialSignals(episode,experiment){
 if(!episode||!Number.isFinite(episode.duration)||episode.duration<=0||!Array.isArray(episode.frames)||!episode.frames.length||episode.frames.length>12000)throw Error('Trial signals need a finite sampled episode.');
 const task=['train','validation','test'].flatMap(makeTasks).find(row=>row.id===episode.taskId);
 if(!task||!Number.isFinite(experiment?.dt)||experiment.dt<=0||!Number.isFinite(experiment.maxPenetration))throw Error('Trial signals need the matching task and model settings.');
 let previous=-1;
 const samples=episode.frames.map(frame=>{
  if(![frame.time,frame.speed,frame.gap,frame.force].every(Number.isFinite)||![frame.desiredContact,frame.contact,frame.dig,frame.collision].every(value=>typeof value==='boolean')||frame.time<0||frame.time>episode.duration||frame.time<=previous||frame.speed<0||frame.force<0)throw Error('Trial signal samples must be finite and strictly time ordered.');
  previous=frame.time;
  const current=taskTarget(task,frame.time,experiment.frame,experiment).point,next=taskTarget(task,frame.time+experiment.dt,experiment.frame,experiment).point;
  const targetSpeed=Math.hypot(next.x-current.x,next.y-current.y,next.z-current.z)/experiment.dt;
  return{time:frame.time,speed:frame.speed,targetSpeed,gap:frame.gap,load:frame.force,requested:frame.desiredContact,state:frame.collision?'collision':frame.dig?'dig':frame.desiredContact&&!frame.contact?'miss':frame.force>0&&!frame.desiredContact?'unrequested-load':'unmarked'};
 });
 const windows=[];let start=null;
 for(let i=0;i<samples.length;i++){const sample=samples[i];if(sample.requested&&start===null)start=sample.time;if(!sample.requested&&start!==null){windows.push([start,sample.time]);start=null;}}
 if(start!==null)windows.push([start,episode.duration]);
 const gapLow=Math.min(-experiment.maxPenetration,...samples.map(row=>row.gap)),gapHigh=Math.max(.15,...samples.map(row=>row.gap)),gapPad=Math.max(.1,(gapHigh-gapLow)*.06);
 const series=[
  {id:'speed',label:'Tip speed',units:'mm/s',low:0,high:Math.max(1,...samples.flatMap(row=>[row.speed,row.targetSpeed]))*1.05,key:'speed',targetKey:'targetSpeed',color:PALETTE.actual,bounds:[]},
  {id:'gap',label:'Tip gap above the pad',units:'mm',low:gapLow-gapPad,high:gapHigh+gapPad,key:'gap',color:PALETTE.gap,bounds:[-experiment.maxPenetration,.15]},
  {id:'load',label:'Modeled load proxy',units:'N*',low:0,high:Math.max(.001,...samples.map(row=>row.load))*1.05,key:'load',color:PALETTE.actual,bounds:[]},
 ];
 return{duration:episode.duration,samples,windows,series};
}

export function trialSignalMarkup(signals){
 const x=time=>X0+time/signals.duration*(X1-X0);
 return signals.series.map(series=>{
  const y=value=>Y1-(value-series.low)/(series.high-series.low)*(Y1-Y0),polyline=key=>signals.samples.map(row=>`${x(row.time).toFixed(2)},${y(row[key]).toFixed(2)}`).join(' ');
  const windows=signals.windows.map(([from,to])=>`<rect x="${x(from)}" y="${Y0}" width="${x(to)-x(from)}" height="${Y1-Y0}" fill="${PALETTE.actual}" opacity=".06"/>`).join('');
  const bounds=series.bounds.map(value=>`<line x1="${X0}" x2="${X1}" y1="${y(value)}" y2="${y(value)}" stroke="${PALETTE.target}" stroke-dasharray="3 3" opacity=".65"/>`).join('');
  const bad=series.id==='gap'?signals.samples.filter(row=>['collision','dig','miss'].includes(row.state)).map(row=>`<circle cx="${x(row.time)}" cy="${y(row.gap)}" r="1.8" fill="${PALETTE.bad}"><title>${row.state} at ${row.time.toFixed(2)} s</title></circle>`).join(''):series.id==='load'?signals.samples.filter(row=>row.state==='unrequested-load').map(row=>`<circle cx="${x(row.time)}" cy="${y(row.load)}" r="1.8" fill="${PALETTE.target}"><title>Modeled load outside requested contact at ${row.time.toFixed(2)} s</title></circle>`).join(''):'';
  return`<figure class="learning-signal" data-signal="${series.id}"><figcaption>${series.label}<span>${series.units}</span></figcaption><svg viewBox="0 0 320 102" role="img" aria-label="${series.label} in ${series.units} over sampled trial time"><title>${series.label}; retained simulation samples, not measurements</title>${windows}<path d="M${X0} ${Y0}V${Y1}H${X1}" fill="none" stroke="${PALETTE.line}"/>${bounds}${series.targetKey?`<polyline points="${polyline(series.targetKey)}" fill="none" stroke="${PALETTE.target}" stroke-width="1.3"/>`:''}<polyline points="${polyline(series.key)}" fill="none" stroke="${series.color}" stroke-width="1.5"/>${bad}<line data-signal-cursor x1="${X0}" x2="${X0}" y1="${Y0}" y2="${Y1}" stroke="#ffe5c5" stroke-width="1" opacity=".75"/><text x="1" y="${Y0+3}" fill="${PALETTE.muted}" font-size="8">${number(series.high)}</text><text x="1" y="${Y1}" fill="${PALETTE.muted}" font-size="8">${number(series.low)}</text><text x="${X0}" y="98" fill="${PALETTE.muted}" font-size="8">0 s</text><text x="${X1}" y="98" text-anchor="end" fill="${PALETTE.muted}" font-size="8">${number(signals.duration)} s</text></svg></figure>`;
 }).join('');
}

export function updateSignalCursor(container,time,duration){
 if(!Number.isFinite(time)||!Number.isFinite(duration)||duration<=0)return;
 const x=X0+Math.max(0,Math.min(duration,time))/duration*(X1-X0);
 for(const cursor of container.querySelectorAll('[data-signal-cursor]')){cursor.setAttribute('x1',x);cursor.setAttribute('x2',x);}
}

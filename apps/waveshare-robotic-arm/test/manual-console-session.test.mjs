import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as model from '../public/manual/model.js';

// Execute the actual UI against an in-memory controller. No server or serial IO.
async function consoleFixture({missingRepairButton=false}={}){
  class Element{
    constructor(){this.checked=false;this.value='';this.children=new Map();this.listeners={};this.style={setProperty(){}};this.classList={toggle(){}};}
    querySelector(key){if(!this.children.has(key))this.children.set(key,new Element());return this.children.get(key);}
    cloneNode(){return new Element();}
    setAttribute(){} replaceChildren(){} append(){}
    addEventListener(event,fn){this.listeners[event]=fn;}
    click(){if(!this.disabled)return this.listeners.click?.();}
  }
  const elements=new Map(),events={},calls=[],recoveryRequests=[],sessionRequests=[];
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  get('joint-template').content={firstElementChild:new Element()};
  const state={mode:'serial',connected:true,commissioned:false,armed:false,owner:null,ownership:{active:false,ownedByThisDevice:false},execution:{},movement:{historyReady:true},manual:{ready:true},measured:{base:0,shoulder:.012271846,elbow:1.580000212,gripper:3.109379057}};
  const document={hidden:false,getElementById:id=>missingRepairButton&&id==='open-repair'?null:get(id),createTextNode:t=>t,createElement:()=>new Element(),addEventListener:(e,f)=>events[e]=f};
  let failure=null,pause=null;
  const context=vm.createContext({...model,document,console,Date,AbortSignal,crypto:globalThis.crypto,setInterval(){},fetch:async(path,options)=>{
    calls.push(path);const body=options.body?JSON.parse(options.body):null;let data={};
    if(path==='/api/session')data={role:'control'};
    if(path==='/api/status')data={...state,telemetryUpdatedAt:state.telemetryUpdatedAt??new Date().toISOString()};
    if(path==='/api/manual/state')data=state.manual;
    if(path==='/api/owner'){state.owner=body.owner;state.ownership={active:true,ownedByThisDevice:true};}
    if(path==='/api/movement/session'){sessionRequests.push(body);data={session:{id:'test-only'}};}
    if(path==='/api/movement/rebaseline'){assert.equal(body.inspection.stationary,true);assert.equal(body.inspection.noContact,true);if(state.manual.recovery?.powerCycle){assert.equal(body.inspection.operatorAssertedPowerCycle,true);assert.equal(body.inspection.noTouchResetPowerChange,undefined);assert.equal(body.powerCycle,undefined);}else assert.equal(body.inspection.noTouchResetPowerChange,true);recoveryRequests.push(body);state.manual={ready:true};state.movement.historyReady=true;data={recovered:true,noMotionCommandIssued:true};}
    if(path==='/api/movement/execute'){
      if(pause)await pause;
      if(failure){state.movement.historyReady=false;data={state:'blocked',result:{error:failure,cleanupVerified:true}};}
      else data={state:'complete',result:{observed:{...state.measured},residualDegrees:0,cleanupVerified:true}};
    }
    if(path==='/api/stop'){state.owner=null;state.ownership={active:false,ownedByThisDevice:false};}
    return {ok:true,json:async()=>structuredClone(data)};
  }});
  const code=(await fs.readFile(new URL('../public/manual/app.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'');
  vm.runInContext(code,context);
  const settle=async()=>{for(let i=0;i<100;i++){await new Promise(resolve=>setImmediate(resolve));if(!vm.runInContext('busy||polling||stopping',context))return;}throw Error('UI did not settle');};
  await settle();
  return {get,events,document,calls,recoveryRequests,sessionRequests,state,context,settle,fail:text=>failure=text,pause:p=>pause=p,
    enable:async()=>{get('supervision').checked=true;get('supervision').listeners.change();get('enable').click();await settle();},
    move:()=>{vm.runInContext("setTarget(cards.get('base'),'5');cards.get('base').move.click()",context);},
    moveEnabled:()=>vm.runInContext("!cards.get('base').move.disabled",context)};
}

test('console displays the canonical per-joint limits supplied by the controller',async()=>{
  const ui=await consoleFixture();ui.state.manual.endpointToleranceDegrees={base:2.0,shoulder:2.0,elbow:1.0,gripper:1.0};await vm.runInContext('refresh()',ui.context);
  for(const value of ['±2.00°','±1.00°'])assert.ok(ui.get('endpoint-policy').textContent.includes(value));
});
test('direct Move acquires control and executes once without setup assertions or enabling',async()=>{
 const ui=await consoleFixture();assert.equal(ui.moveEnabled(),true);assert.equal(ui.get('enable').hidden,true);assert.equal(ui.get('supervision-row').hidden,true);
 assert.equal(ui.calls.includes('/api/owner'),false);assert.equal(ui.calls.includes('/api/movement/execute'),false);
 for(let i=0;i<2;i++){ui.move();await ui.settle();assert.equal(ui.moveEnabled(),true);}
 assert.equal(ui.calls.filter(p=>p==='/api/movement/execute').length,2);
 assert.equal(ui.calls.filter(p=>p==='/api/owner').length,1);
 for(const r of ui.sessionRequests){assert.equal(r.controlMode,'direct-manual');assert.equal(r.moves.length,1);assert.equal(r.confirmations,undefined);assert.equal(r.inspection,undefined);}
 assert.equal(ui.calls.includes('/api/movement/preview'),false);
});

test('idle lease expiry requires only the next Move click and never claims while idle',async()=>{
 const ui=await consoleFixture();ui.move();await ui.settle();ui.state.owner=null;ui.state.ownership={active:false,ownedByThisDevice:false};await vm.runInContext('refresh()',ui.context);
 const before=ui.calls.length;assert.equal(ui.moveEnabled(),true);await vm.runInContext('tick()',ui.context);assert.equal(ui.calls.slice(before).includes('/api/owner'),false);
 ui.move();await ui.settle();assert.equal(ui.calls.slice(before).filter(p=>p==='/api/owner').length,1);assert.equal(ui.calls.slice(before).filter(p=>p==='/api/movement/execute').length,1);
});

test('hiding an active move stops it and requires a new visible Move click',async()=>{
 const ui=await consoleFixture();let release;ui.pause(new Promise(r=>release=r));ui.move();
 for(let i=0;i<100&&!ui.calls.includes('/api/movement/execute');i++)await new Promise(r=>setImmediate(r));
 assert.ok(ui.calls.includes('/api/movement/execute'));ui.document.hidden=true;ui.events.visibilitychange();release();await ui.settle();
 assert.ok(ui.calls.includes('/api/stop'));assert.equal(ui.moveEnabled(),false);
 const before=ui.calls.length;ui.document.hidden=false;ui.events.visibilitychange();await ui.settle();assert.equal(ui.moveEnabled(),true);assert.equal(ui.calls.slice(before).includes('/api/movement/execute'),false);
});

test('Stop never queues or resumes a move',async()=>{
 const ui=await consoleFixture();ui.get('stop').click();await ui.settle();await vm.runInContext('tick()',ui.context);
 assert.equal(ui.calls.includes('/api/stop'),true);assert.equal(ui.calls.includes('/api/movement/execute'),false);assert.equal(ui.calls.includes('/api/owner'),false);
});

test('fault, stale feedback and another owner block direct requests without takeover',async()=>{
 for(const change of [ui=>ui.state.manual.ready=false,ui=>ui.state.movement.historyReady=false,ui=>ui.state.execution.recoveryRequired=true,ui=>ui.state.telemetryUpdatedAt=new Date(Date.now()-60000).toISOString(),ui=>ui.state.ownership={active:true,ownedByThisDevice:false}]){
 const ui=await consoleFixture();change(ui);await vm.runInContext('refresh()',ui.context);assert.equal(ui.moveEnabled(),false);ui.move();await ui.settle();assert.equal(ui.calls.includes('/api/owner'),false);assert.equal(ui.calls.includes('/api/movement/execute'),false);
 }
 const ui=await consoleFixture();ui.fail('Unexpected manual joint displacement');ui.move();await ui.settle();assert.equal(ui.moveEnabled(),false);assert.equal(ui.get('message').textContent,'Unexpected manual joint displacement');
});

test('mouse and keyboard activity alone never renew, claim or move physical controls',async()=>{
 const ui=await consoleFixture();ui.move();await ui.settle();const before=ui.calls.length;
 for(const event of ['pointermove','wheel','pointerdown','keydown','input']){ui.events[event]();await vm.runInContext('lastRenew=0;tick()',ui.context);}
 for(const path of ['/api/renew','/api/owner','/api/movement/session','/api/movement/execute'])assert.equal(ui.calls.slice(before).includes(path),false);
});

test('recovery requires explicit inspection and resumes controls without a move request',async()=>{
 const ui=await consoleFixture();ui.state.movement.historyReady=false;ui.state.manual={ready:false,recovery:{commandId:'test-blocked',originalRowSHA256:'a'.repeat(64)}};await vm.runInContext('refresh()',ui.context);
 assert.equal(ui.get('recovery').hidden,false);assert.equal(ui.get('recover').disabled,true);
 ui.get('supervision').checked=true;ui.get('supervision').listeners.change();assert.equal(ui.get('recover').disabled,true);
 ui.get('recovery-inspection').checked=true;ui.get('recovery-inspection').listeners.change();assert.equal(ui.get('recover').disabled,false);
 ui.get('recover').click();await ui.settle();assert.ok(ui.calls.includes('/api/movement/rebaseline'));assert.equal(ui.calls.includes('/api/movement/execute'),false);assert.equal(ui.moveEnabled(),true);assert.equal(ui.get('supervision').checked,true);assert.equal(ui.get('recovery').hidden,true);
});
test('power-cycle recovery changes the inspection and never invents unchanged-power facts or sends motion',async()=>{
 const ui=await consoleFixture();ui.state.movement.historyReady=false;ui.state.manual={ready:false,recovery:{commandId:'test-timeout',originalRowSHA256:'a'.repeat(64)}};await vm.runInContext('refresh()',ui.context);
 ui.get('supervision').checked=true;ui.get('recovery-inspection').checked=true;ui.state.manual.recovery.powerCycle=true;await vm.runInContext('refresh()',ui.context);
 assert.equal(ui.get('recovery-inspection').checked,false);assert.match(ui.get('recovery-inspection-text').textContent,/power-cycled/);assert.doesNotMatch(ui.get('recovery-inspection-text').textContent,/not repositioned/);
 ui.get('recovery-inspection').checked=true;ui.get('recovery-inspection').listeners.change();ui.get('recover').click();await ui.settle();
 assert.equal(ui.recoveryRequests.length,1);assert.equal(ui.recoveryRequests[0].inspection.operatorAssertedPowerCycle,true);assert.equal(ui.recoveryRequests[0].inspection.noTouchResetPowerChange,undefined);assert.equal(ui.calls.includes('/api/movement/execute'),false);assert.equal(ui.calls.includes('/api/movement/session'),false);assert.equal(ui.moveEnabled(),false);assert.match(ui.get('message').textContent,/Only the prepared small-wave session/);
});


test('Manual renews only failed reads while retaining edited target and setup panel',async()=>{
 const ui=await consoleFixture();
 vm.runInContext("setTarget(cards.get('gripper'),'155.1');$('setup').hidden=false;globalThis.originalFetch=fetch;globalThis.stale=true;globalThis.bootstrapCount=0;fetch=async(path,options)=>{if(path==='/manual/index.html'){stale=false;bootstrapCount++;return {ok:true,arrayBuffer:async()=>new ArrayBuffer(0)};}if(stale)return {status:401,ok:false,json:async()=>({error:'Old session'})};return originalFetch(path,options);}",ui.context);
 const before=ui.calls.length;await vm.runInContext('tick()',ui.context);
 assert.equal(vm.runInContext('bootstrapCount',ui.context),1);
 assert.equal(vm.runInContext("cards.get('gripper').angle.value",ui.context),'155.1');
 assert.equal(ui.get('setup').hidden,false);
 assert.ok(ui.calls.slice(before).every(p=>['/api/session','/api/status','/api/manual/state'].includes(p)));
 vm.runInContext('stale=true',ui.context);await assert.rejects(vm.runInContext("api('/api/stop',{})",ui.context),/Old session/);
 assert.equal(vm.runInContext('bootstrapCount',ui.context),1);
});


test('a disconnected restart state does not overwrite an edited physical target',async()=>{
 const ui=await consoleFixture();vm.runInContext("setTarget(cards.get('gripper'),'155.1')",ui.context);
 ui.state.connected=false;ui.state.mode='simulator';await vm.runInContext('refresh()',ui.context);
 ui.state.connected=true;ui.state.mode='serial';await vm.runInContext('refresh()',ui.context);
 assert.equal(vm.runInContext("cards.get('gripper').angle.value",ui.context),'155.1');
 assert.equal(ui.calls.includes('/api/movement/execute'),false);
});


test('completed gripper move refreshes the input to measured position without sending another command',async()=>{
 const ui=await consoleFixture();ui.state.measured.gripper=145*Math.PI/180;
 vm.runInContext("setTarget(cards.get('gripper'),'155');cards.get('gripper').move.click()",ui.context);await ui.settle();
 assert.equal(vm.runInContext("cards.get('gripper').angle.value",ui.context),'145.0');
 assert.equal(ui.calls.filter(p=>p==='/api/movement/execute').length,1);
 assert.equal(ui.moveEnabled(),true);
});


test('decimal editing preserves the native field buffer and caret for all four joints across polling',async()=>{
 const ui=await consoleFixture(),before=ui.calls.length;
 for(const {key} of model.JOINTS){
  const card=vm.runInContext(`cards.get('${key}')`,ui.context);
  let buffer='',caret=0,writes=0;
  // Number inputs expose a sanitized value while still displaying an unfinished
  // decimal/sign in their native editing buffer. Assigning value resets that buffer.
  Object.defineProperty(card.angle,'value',{
   configurable:true,
   get:()=>buffer!==''&&Number.isFinite(Number(buffer))?String(Number(buffer)):'',
   set:value=>{writes++;buffer=String(value);caret=0;}
  });
  for(const typed of ['-', '.', '-.', '12.', '12.5', '12.50']){
   buffer=typed;caret=typed.length;const priorWrites=writes;
   card.angle.listeners.input();
   assert.equal(buffer,typed,`${key} keeps ${typed}`);
   assert.equal(caret,typed.length,`${key} keeps the insertion point`);
   assert.equal(writes,priorWrites,`${key} does not rewrite text while typing`);
   await vm.runInContext('refresh()',ui.context);
   assert.equal(buffer,typed,`${key} keeps partial input through feedback polling`);
   assert.equal(caret,typed.length);
  }
  buffer='80.5';caret=2;card.angle.listeners.input();assert.equal(caret,2,`${key} preserves mid-number editing`);
  card.plus.click();assert.equal(buffer,'81.5',`${key} still accepts explicit step buttons`);
 }
 assert.ok(ui.calls.slice(before).every(route=>['/api/status','/api/manual/state'].includes(route)));
});


test('Current readings refresh during an active move without submitting another move',async()=>{
 const ui=await consoleFixture();let release;ui.pause(new Promise(r=>release=r));ui.move();
 for(let i=0;i<100&&!ui.calls.includes('/api/movement/execute');i++)await new Promise(r=>setImmediate(r));
 ui.state.measured.base=2*Math.PI/180;const validations=ui.calls.filter(p=>p==='/api/manual/state').length;
 await vm.runInContext('tick()',ui.context);
 assert.equal(vm.runInContext("cards.get('base').current.textContent",ui.context),'2.0'+String.fromCharCode(176));
 assert.equal(ui.calls.filter(p=>p==='/api/manual/state').length,validations);
 assert.equal(ui.calls.filter(p=>p==='/api/movement/execute').length,1);
 release();await ui.settle();
});

test('unedited targets and sliders follow fresh external pose changes on all four joints without motion requests',async()=>{
 const ui=await consoleFixture(),before=ui.calls.length;
 for(const {key} of model.JOINTS)ui.state.measured[key]+=key==='gripper'?-.05:.05;
 await vm.runInContext('tick()',ui.context);
 for(const {key} of model.JOINTS){
  const card=vm.runInContext(`cards.get('${key}')`,ui.context),expected=model.degrees(key,ui.state.measured[key]).toFixed(1);
  assert.equal(card.angle.value,expected,key);assert.equal(Number(card.slider.value),Number(expected),key);
 }
 ui.state.telemetryUpdatedAt=new Date(Date.now()-60000).toISOString();ui.state.measured.base=.2;
 const card=vm.runInContext("cards.get('base')",ui.context),previous=card.angle.value;
 await vm.runInContext('tick()',ui.context);assert.equal(card.angle.value,previous);
 delete ui.state.telemetryUpdatedAt;ui.state.connected=false;await vm.runInContext('tick()',ui.context);assert.equal(card.angle.value,previous);
 assert.ok(ui.calls.slice(before).every(route=>['/api/status','/api/manual/state'].includes(route)));
});

test('focused fields and unsubmitted drafts survive pose polling while other joints stay in sync',async()=>{
 const ui=await consoleFixture(),card=vm.runInContext("cards.get('base')",ui.context),original=card.angle.value;
 ui.document.activeElement=card.angle;ui.state.measured.base=.1;
 await vm.runInContext('refresh()',ui.context);assert.equal(card.angle.value,original);
 card.angle.value='12.5';card.angle.listeners.input();ui.document.activeElement=null;
 ui.state.measured.base=.2;ui.state.measured.elbow=1.5;
 await vm.runInContext('refresh()',ui.context);assert.equal(card.angle.value,'12.5');
 assert.equal(vm.runInContext("cards.get('elbow').angle.value",ui.context),model.degrees('elbow',1.5).toFixed(1));
 assert.equal(ui.calls.includes('/api/movement/execute'),false);
});

test('each completed joint move resumes measured target sync without overwriting a newer draft',async()=>{
 for(const {key} of model.JOINTS){
  const ui=await consoleFixture();
  vm.runInContext(`setTarget(cards.get('${key}'),'120');cards.get('${key}').move.click()`,ui.context);await ui.settle();
  assert.equal(vm.runInContext(`cards.get('${key}').angle.value`,ui.context),model.degrees(key,ui.state.measured[key]).toFixed(1),key);
  assert.equal(ui.calls.filter(route=>route==='/api/movement/execute').length,1);
 }
 const ui=await consoleFixture();let release;ui.pause(new Promise(resolve=>release=resolve));ui.move();
 for(let i=0;i<100&&!ui.calls.includes('/api/movement/execute');i++)await new Promise(resolve=>setImmediate(resolve));
 vm.runInContext("setTarget(cards.get('base'),'8.5')",ui.context);release();await ui.settle();
 assert.equal(vm.runInContext("cards.get('base').angle.value",ui.context),'8.5');
 assert.equal(ui.calls.filter(route=>route==='/api/movement/execute').length,1);
});
test('a shortfall shows its actual reason and a visible repair entry point',async()=>{
 const ui=await consoleFixture();ui.state.movement.historyReady=false;ui.state.manual={ready:false,reason:'The last joint stopped short. Use Review & repair position.',recovery:{kind:'shortfall',commandId:'test-shortfall'}};
 await vm.runInContext('refresh()',ui.context);assert.equal(ui.get('open-repair').hidden,false);assert.equal(ui.get('readiness').textContent,ui.state.manual.reason);assert.equal(ui.get('recovery').hidden,true);assert.equal(ui.get('supervision-row').hidden,true);
});


test('Current feedback renders before a slow qualification read completes',async()=>{
 const ui=await consoleFixture();let finish;
 ui.context.validationDelay=new Promise(resolve=>finish=resolve);
 vm.runInContext("globalThis.readBeforeDelay=fetch;fetch=async(path,options)=>{if(path==='/api/manual/state')await validationDelay;return readBeforeDelay(path,options);}",ui.context);
 ui.state.measured.base=3*Math.PI/180;
 const pending=vm.runInContext('refresh()',ui.context);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(vm.runInContext("cards.get('base').current.textContent",ui.context),'3.0'+String.fromCharCode(176));
 finish();await pending;assert.equal(ui.calls.includes('/api/movement/execute'),false);
});


test('older cached Manual markup without the new repair button still initializes Current readings',async()=>{
 const ui=await consoleFixture({missingRepairButton:true});
 assert.equal(ui.get('mode').textContent,'ROBOT / USB');
 assert.equal(vm.runInContext("cards.get('base').current.textContent",ui.context),'0.0'+String.fromCharCode(176));
 assert.equal(ui.calls.includes('/api/movement/execute'),false);
});

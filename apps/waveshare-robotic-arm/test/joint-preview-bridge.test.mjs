import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../public/presets/app.js',import.meta.url),'utf8');
function fixture(){
 const sent=[],navigation=[],selections=[],elements=new Map();let listener;
 const get=id=>{if(!elements.has(id))elements.set(id,{contentWindow:{postMessage:(message,origin)=>sent.push({message,origin})},getAttribute:()=> 'loaded',addEventListener(){}});return elements.get(id);};
 const context=vm.createContext({$:get,document:{getElementById:get},window:{addEventListener:(type,fn)=>{assert.equal(type,'message');listener=fn;}},Date,
  feedback:{capturable:true,source:'encoder',measuredAt:new Date().toISOString(),radians:{base:0,shoulder:0,elbow:1,gripper:2.68},privateToken:'never forward',owner:'private'},lastFeedbackAt:Date.now(),
  TRACKPAD_POINTS:[{id:'LEFT_CLICK'}],pointMap:{select:id=>selections.push(id)},library:{presets:[]},setTab:tab=>navigation.push(tab),detailsDirty:()=>false,
  renderLibrary(){},renderEditor(){},repairController(){throw Error('Preview must not repair or command the Controller');},automaticWorkspace(){throw Error('Preview must not open live Automatic');}
 });
 vm.runInContext(source.slice(source.indexOf('const jointPreviewOrigin='),source.indexOf('function automaticWorkspace(')),context);
 vm.runInContext(source.slice(source.indexOf("window.addEventListener('message',event=>"),source.indexOf('motionLab=mountMotionLab')),context);
 return {context,get,sent,navigation,selections,send:change=>listener({origin:'http://127.0.0.1:5274',source:get('joint-preview-frame').contentWindow,data:{type:'odradek-preview-point',pointId:'LEFT_CLICK'},...change})};
}
test('preview bridge forwards only fresh public pose fields to its exact loopback origin',()=>{
 const f=fixture();vm.runInContext('previewContext()',f.context);
 const {message,origin}=f.sent[0];assert.equal(origin,'http://127.0.0.1:5274');
 assert.deepEqual(JSON.parse(JSON.stringify(message)),{type:'odradek-preview-context',observation:{state:'live',source:'hardware',pose:{base:0,shoulder:0,elbow:1,gripper:2.68},observedAt:f.context.feedback.measuredAt}});
 f.context.lastFeedbackAt=Date.now()-3000;vm.runInContext('previewContext()',f.context);assert.equal(f.sent[1].message.observation.state,'stale');assert.equal(f.sent[1].message.observation.pose,null);
});
test('preview navigation rejects wrong origins, sibling windows, unknown points and motion-shaped messages',()=>{
 const f=fixture();
 for(const change of [{origin:'http://evil.test'},{source:{}},{data:{type:'odradek-preview-point',pointId:'INVALID'}},{data:{type:'movement/execute',pointId:'LEFT_CLICK'}},{data:{studioRepair:true}},{data:{studioTab:'automatic'}}])f.send(change);
 assert.deepEqual(f.navigation,[]);assert.deepEqual(f.selections,[]);assert.deepEqual(f.sent,[]);
 f.send({});assert.deepEqual(f.navigation,['map']);assert.deepEqual(f.selections,['LEFT_CLICK']);
});
test('a child ready message sends observation without navigation or preset mutation',()=>{
 const f=fixture();f.send({data:{type:'odradek-preview-ready'}});assert.equal(f.sent.length,1);assert.deepEqual(f.navigation,[]);assert.deepEqual(f.selections,[]);
});

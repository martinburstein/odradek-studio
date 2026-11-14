import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
test('an open Automatic workspace survives launch markers and offline feedback without replacing either frame',async()=>{
 const source=await fs.readFile(new URL('../public/presets/app.js',import.meta.url),'utf8');
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,tabIndex:0,src:'existing:'+id,attributes:{src:'existing:'+id},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k];},removeAttribute(){throw Error('Open frame was replaced');}});return elements.get(id);};
 let response={controllerOnline:true,startup:{id:'first',tab:'manual'}};
 const context=vm.createContext({$:get,document:{hidden:false},history:{replaceState(){}},window:{dispatchEvent(){}},CustomEvent:class{},Date,currentTab:'automatic',automaticMode:'live',feedback:null,polling:false,lastFeedbackAt:0,api:async()=>response,renderFeedback(){},setTab(){throw Error('Workspace changed');}});
 vm.runInContext(source.slice(source.indexOf('async function refreshFeedback(){'),source.indexOf('function renderLibrary(){')),context);
 const frame=get('automatic-frame');get('panel-automatic').hidden=false;await vm.runInContext('refreshFeedback()',context);
 response={controllerOnline:false,capturable:false};await vm.runInContext('refreshFeedback()',context);
 response={controllerOnline:true,startup:{id:'second',tab:'manual'}};await vm.runInContext('refreshFeedback()',context);
 assert.equal(get('automatic-frame'),frame);assert.equal(frame.src,'existing:automatic-frame');assert.equal(get('panel-automatic').hidden,false);assert.equal(vm.runInContext('currentTab',context),'automatic');assert.equal(vm.runInContext('automaticMode',context),'live');
});

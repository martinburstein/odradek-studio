import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('Safety tools require clicks and reuse the original controls',()=>{
 const nodes=new Map(),listeners=new Map(),sent=[];let domReady,stops=0,repairs=0;
 class Element{
  constructor(){this.events={};this.classList={toggle(){}};this.children=[];}
  set id(value){this.key=value;nodes.set(value,this);}get id(){return this.key;}
  set innerHTML(html){for(const match of html.matchAll(/id="([^"]+)"/g)){const node=new Element();node.id=match[1];}}
  setAttribute(){}getAttribute(){return 'false';}prepend(node){this.children.unshift(node);}
  addEventListener(type,handler){this.events[type]=handler;}
 }
 for(const id of ['automatic-live','stop','repair-controller']){const node=new Element();node.id=id;}
 nodes.get('stop').click=()=>stops++;nodes.get('repair-controller').click=()=>repairs++;
 const document={body:{},documentElement:{dataset:{labView:'safety'}},createElement:()=>new Element(),getElementById:id=>nodes.get(id)??null};
 const ipcRenderer={on(channel,handler){listeners.set(channel,handler);},send(...args){sent.push(args);}};
 const context={require:()=>({ipcRenderer}),document,window:{addEventListener(type,callback){if(type==='DOMContentLoaded')domReady=callback;}},MutationObserver:class{observe(){}},requestAnimationFrame:callback=>callback()};
 vm.runInNewContext(fs.readFileSync(new URL('../desktop/studio-preload.cjs',import.meta.url),'utf8'),context);domReady();
 assert.equal(stops,0);assert.equal(repairs,0);assert.equal(sent.length,0);
 const restart=nodes.get('lab-clean-restart');restart.events.click({isTrusted:false});assert.equal(sent.length,0);
 restart.events.click({isTrusted:true});assert.deepEqual(sent,[['odradek:service-restart']]);
 listeners.get('odradek:service-state')({}, {busy:true,message:'Stopping services…'});assert.equal(restart.disabled,true);restart.events.click({isTrusted:true});assert.equal(sent.length,1);
 nodes.get('lab-stop-arm').events.click({isTrusted:true});nodes.get('lab-repair-controller').events.click({isTrusted:true});assert.equal(stops,1);assert.equal(repairs,1);
});

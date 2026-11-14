import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createLearningVisuals} from '../src/replica/learning/visuals.js';
import {MM_SCALE} from '../src/replica/rig.js';
import {toolGeometry} from '../src/replica/learning/geometry.js';

const byName=(root,name)=>root.children.find(child=>child.name===name);

test('learning visuals use the shared millimeter scale and reuse bounded buffers',()=>{
 const scene=new THREE.Scene(),visuals=createLearningVisuals(scene),group=visuals.group;
 assert.equal(scene.children[0],group);
 const path=byName(group,'Desired target path'),trail=byName(group,'Actual tip trail');
 const pathArray=path.geometry.getAttribute('position').array,trailArray=trail.geometry.getAttribute('position').array;
 const experiment={tool:{targetTilt:30,end:'rear',frontReach:100,rearReach:40,barrelRadius:3.2,nibRadius:1.2,tapeRadius:5.4,mountPitch:0,lateralOffset:1.2}};
 visuals.setExperiment(experiment);
 visuals.setEpisode({frames:[{target:{x:10,y:20,z:30}},{target:{x:20,y:30,z:40}}]});
 assert.equal(path.geometry.drawRange.count,2);
 Array.from(pathArray.slice(0,3)).forEach((value,index)=>assert.ok(Math.abs(value-[10,20,30][index]*MM_SCALE)<1e-6));
 const pose={base:Math.PI/2,shoulder:0,elbow:0,gripper:2};
 visuals.setFrame({time:0,pose,tip:{x:100,y:200,z:300},target:{x:10,y:20,z:30},front:{x:80,y:200,z:300},rear:{x:120,y:200,z:300},contact:true,desiredContact:true});
 assert.equal(trail.geometry.drawRange.count,1);
 const marker=byName(group,'Actual tip marker');
 assert.deepEqual(marker.position.toArray(),[100*MM_SCALE,200*MM_SCALE,300*MM_SCALE]);
 const tool=byName(group,'Modeled taped tool'),barrel=byName(tool,'Stylus barrel');
 assert.ok(barrel.geometry instanceof THREE.CylinderGeometry);assert.ok(Math.abs(barrel.geometry.parameters.radiusTop*barrel.scale.x-3.2*MM_SCALE)<1e-6);
 const frontNib=byName(tool,'Front active endpoint'),rearNib=byName(tool,'Rear active endpoint');
 assert.equal(frontNib.visible,true);assert.equal(rearNib.visible,true);
 assert.equal(frontNib.material.color.getHex(),0xffb547);assert.equal(rearNib.material.color.getHex(),0x53e6f2);
 const expectedWrist=toolGeometry(pose,experiment.tool).wrist,sleeve=byName(tool,'Illustrative tape sleeve');
 Array.from(sleeve.position.toArray()).forEach((value,index)=>assert.ok(Math.abs(value-[expectedWrist.x,expectedWrist.y,expectedWrist.z][index]*MM_SCALE)<1e-5));
 const guide=byName(group,'45 degree tilt guide').geometry.getAttribute('position');
 assert.ok(Math.abs(guide.getY(1)-guide.getY(0)-Math.sin(Math.PI/6)*22*MM_SCALE)<1e-6);
 assert.ok(guide.getX(1)>guide.getX(0));assert.ok(Math.abs(guide.getZ(1)-guide.getZ(0))<1e-6); // yawed rear-end radial plane
 visuals.setExperiment({...experiment,tool:{...experiment.tool,end:'front'}});
 visuals.setFrame({time:0,pose,tip:{x:100,y:200,z:300},front:{x:80,y:200,z:300},rear:{x:120,y:200,z:300}});
 assert.equal(frontNib.material.color.getHex(),0x53e6f2);assert.equal(rearNib.material.color.getHex(),0xffb547);
 visuals.setFrame({time:0,tip:{x:999,y:999,z:999}}); // duplicate timestamp does not append
 assert.equal(trail.geometry.drawRange.count,1);
 visuals.setFrame({time:1,tip:{x:101,y:201,z:301},desiredContact:true,contact:false,dig:true});
 assert.equal(trail.geometry.drawRange.count,2);
 assert.deepEqual(trailArray,trail.geometry.getAttribute('position').array);
 assert.ok(trail.geometry.getAttribute('color').getX(1)>trail.geometry.getAttribute('color').getY(1));
 assert.equal(pathArray.length,12000*3);
 visuals.clear();assert.equal(path.geometry.drawRange.count,0);assert.equal(trail.geometry.drawRange.count,0);assert.equal(tool.visible,false);
 visuals.setFrame({time:2,tip:{x:0,y:0,z:0}});assert.equal(trail.geometry.drawRange.count,1);
 visuals.dispose();assert.equal(scene.children.length,0);
 assert.ok(pathArray.every(Number.isFinite));
});

test('visuals reject missing scene and dispose idempotently',()=>{
 assert.throws(()=>createLearningVisuals(null),/THREE scene/);
 const scene=new THREE.Scene(),visuals=createLearningVisuals(scene),geometries=[];
 visuals.group.traverse(object=>{if(object.geometry)geometries.push(object.geometry);});
 let disposed=0;for(const geometry of new Set(geometries)){const original=geometry.dispose.bind(geometry);geometry.dispose=()=>{disposed++;original();};}
 visuals.dispose();visuals.dispose();assert.equal(scene.children.length,0);assert.equal(disposed,new Set(geometries).size);
});

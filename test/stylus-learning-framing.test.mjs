import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createExperiment} from '../src/replica/learning/simulation.js';
import {learningFramePoints,fitLearningFrame,captureRigView,restoreRigView} from '../src/replica/learning/framing.js';

test('working arm, tool and laptop fit outside the learning controls at large and minimum viewports',()=>{
 const experiment=createExperiment(),before=JSON.stringify(experiment),points=learningFramePoints(experiment);
 for(const viewport of [
  {width:1920,height:1080,rectangle:{left:316,right:1534,top:126,bottom:990}},
  {width:760,height:650,rectangle:{left:288,right:744,top:100,bottom:280}},
  {width:760,height:650,rectangle:{left:288,right:744,top:100,bottom:490}},
  {width:960,height:720,rectangle:{left:316,right:944,top:122,bottom:540}},
  {width:720,height:520,rectangle:{left:288,right:704,top:92,bottom:368}},
 ]){
  const fitted=fitLearningFrame(points,{...viewport,fov:38});assert.equal(fitted.fitted,true);
  const camera=new THREE.PerspectiveCamera(38,viewport.width/viewport.height,.5,900),target=new THREE.Vector3(fitted.target.x,fitted.target.y,fitted.target.z),{distance:d,azimuth:a,polar:p}=fitted;
  camera.position.copy(target).add(new THREE.Vector3(d*Math.sin(p)*Math.sin(a),d*Math.cos(p),d*Math.sin(p)*Math.cos(a)));camera.lookAt(target);camera.updateMatrixWorld();
  for(const point of points){const projected=new THREE.Vector3(point.x,point.y,point.z).project(camera),x=(projected.x+1)*viewport.width/2,y=(1-projected.y)*viewport.height/2;
   assert.ok(x>=viewport.rectangle.left-1e-5&&x<=viewport.rectangle.right+1e-5&&y>=viewport.rectangle.top-1e-5&&y<=viewport.rectangle.bottom+1e-5,`Scene point left visible area: ${x},${y}`);
  }
 }
 assert.equal(JSON.stringify(experiment),before);
});

test('framing exposes a distance-limited fit instead of claiming impossible viewport coverage',()=>{
 const points=learningFramePoints(createExperiment()),view=fitLearningFrame(points,{width:760,height:650,fov:38,rectangle:{left:400,right:410,top:200,bottom:210},maxDistance:10});
 assert.equal(view.fitted,false);assert.equal(view.distance,10);
 assert.throws(()=>fitLearningFrame(points,{width:760,height:650,fov:38,rectangle:{left:20,right:10,top:0,bottom:600}}),/rectangle/);
 assert.throws(()=>fitLearningFrame([{x:NaN,y:0,z:0}],{width:760,height:650,fov:38,rectangle:{left:0,right:760,top:0,bottom:650}}),/finite scene/);
});

test('learning restores the exact prior Manual rig view without retaining mutable vectors',()=>{
 const rig={target:new THREE.Vector3(1,2,3),desiredTarget:new THREE.Vector3(4,5,6),distance:35,desiredDistance:40,azimuth:.4,desiredAzimuth:.8,polar:.9,desiredPolar:1.1,orbiting:true,focus(target){this.desiredTarget.copy(target);},setOrbit(value){this.orbiting=value;},update(dt){assert.equal(dt,0);}};
 const saved=captureRigView(rig);rig.target.set(0,0,0);rig.desiredTarget.set(0,0,0);rig.distance=10;rig.desiredDistance=12;rig.azimuth=rig.desiredAzimuth=0;rig.polar=rig.desiredPolar=.4;rig.orbiting=false;
 restoreRigView(rig,saved);assert.deepEqual(captureRigView(rig),saved);assert.notEqual(rig.target,saved.target);assert.notEqual(rig.desiredTarget,saved.desiredTarget);
});

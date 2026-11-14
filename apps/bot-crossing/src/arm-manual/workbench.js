import * as THREE from 'three'
import {POINTS} from './model.js'
import {roarmForwardKinematics} from '../world/roarm-model.js'

/** Reference layout only; this deck has no screen, hardware registration or input API. */
export function createWorkbench(scene){
 const group=new THREE.Group();group.name='odradek-laptop-workbench';scene.add(group)
 const mat=(color,extra={})=>new THREE.MeshStandardMaterial({color,roughness:.65,...extra})
 const silver=mat(0x58646e,{metalness:.55}),dark=mat(0x111924),amber=mat(0xff862c,{emissive:0x6e2903}),cyan=mat(0x68d5ed,{emissive:0x146779,emissiveIntensity:.8})
 function box(parent,name,w,h,d,x,y,z,m){const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);o.name=name;o.position.set(x,y,z);o.castShadow=true;o.receiveShadow=true;parent.add(o);return o}
 box(group,'work-table',37,.45,35,0,-.28,9,dark)
 const grid=new THREE.GridHelper(36,36,0x3f6975,0x1b2b3b);grid.position.set(0,-.03,9);group.add(grid)
 const pose={base:13.886718722158188*Math.PI/180,shoulder:(145.5468750032243-90)*Math.PI/180,elbow:74.79492184688608*Math.PI/180,gripper:154*Math.PI/180}
 const tip=roarmForwardKinematics(pose),distal=pose.shoulder+pose.elbow+Math.atan2(1.73,280.15)
 const laptop=new THREE.Group();laptop.name='reference-laptop-deck';laptop.position.set(tip.x-4.65,.28,tip.z+Math.sin(distal)*2.85+2.65);group.add(laptop)
 box(laptop,'laptop-body',11.25,.25,7.42,0,0,0,silver)
 box(laptop,'keyboard-inset',10.6,.06,4.6,0,.16,-1.1,dark)
 box(laptop,'screenless-hinge',10.5,.14,.16,0,.22,-3.58,dark)
 const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=900
 const ctx=canvas.getContext('2d');ctx.fillStyle='#121c28';ctx.fillRect(0,0,2048,900)
 const rows=[['Esc','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','PrtSc','Del'],['~','1','2','3','4','5','6','7','8','9','0','−','=','⌫'],['Tab','Q','W','E','R','T','Y','U','I','O','P','[',']','\\'],['Caps','A','S','D','F','G','H','J','K','L',';','\'','Enter'],['Shift','Z','X','C','V','B','N','M',',','.','/','Shift'],['Ctrl','Fn','Win','Alt','SPACE','Alt','Ctrl','←','↑','↓','→']]
 ctx.textAlign='center';ctx.textBaseline='middle'
 rows.forEach((row,r)=>{const gap=10,w=(2020-gap*(row.length+1))/row.length,h=132;row.forEach((label,c)=>{const x=14+gap+c*(w+gap),y=15+r*146;ctx.fillStyle=label==='PrtSc'?'#22496d':'#253544';ctx.strokeStyle=label==='PrtSc'?'#79d6ff':'#5a7183';ctx.lineWidth=label==='PrtSc'?5:2;ctx.beginPath();ctx.roundRect(x,y,w,h,10);ctx.fill();ctx.stroke();ctx.fillStyle=label==='PrtSc'?'#b8edff':'#c5ced3';ctx.font=`${label.length>4?25:34}px Consolas`;ctx.fillText(label,x+w/2,y+h/2)})})
 const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4
 const keyboard=new THREE.Mesh(new THREE.PlaneGeometry(10.5,4.45),new THREE.MeshStandardMaterial({map:texture,roughness:.8}));keyboard.rotation.x=-Math.PI/2;keyboard.position.set(0,.202,-1.15);laptop.add(keyboard)
 const pad=new THREE.Group();pad.name='trackpad-point-map';pad.position.set(-.3,.19,2.05);laptop.add(pad)
 box(pad,'touch-surface',4.025,.025,2.345,0,0,0,dark)
 const edges=new THREE.EdgesGeometry(new THREE.BoxGeometry(4.025,.03,2.345));const outline=new THREE.LineSegments(edges,new THREE.LineBasicMaterial({color:0x60bdd8}));pad.add(outline)
 const buttons=[box(pad,'left-click-area',1.96,.035,.45,-1.01,.02,.95,dark),box(pad,'right-click-area',1.96,.035,.45,1.01,.02,.95,dark)]
 const points=new Map()
 for(const p of POINTS){const marker=new THREE.Mesh(new THREE.TorusGeometry(.095,.022,5,8),cyan);marker.rotation.x=-Math.PI/2;marker.position.set((p.u-.5)*4.025,.06,(p.v-.5)*2.345);marker.name='point-'+p.id;marker.userData.pointId=p.id;pad.add(marker);points.set(p.id,marker)}
 const printMarker=box(laptop,'marked-print-screen-key',.60,.035,.45,4.65,.27,-2.65,cyan)
 const baseRing=new THREE.Mesh(new THREE.TorusGeometry(2.55,.045,6,64),amber);baseRing.rotation.x=-Math.PI/2;baseRing.position.y=.04;group.add(baseRing)
 function selectPoint(id){for(const [key,marker]of points)marker.scale.setScalar(key===id?1.7:1);buttons[0].material=id==='LEFT_CLICK'?amber:dark;buttons[1].material=id==='RIGHT_CLICK'?amber:dark;printMarker.material=id==='PRINT_SCREEN'?amber:cyan}
 return {group,laptop,points,selectPoint}
}

import {tabletopGeometryPolicy,TABLETOP_CLEARANCE_REVISION} from './training-envelope.mjs';
import {TRAINING_ENVELOPE_POLICY,trainingBodyBounds} from './training-envelope.mjs';
import {REFERENCE_RETURN_POLICY} from './reference-pose-return.mjs';
import {adjacentLinkSeparationMm} from './other-joint-plan.mjs';
import {SERVO_STEP,feedbackAtTicks} from './z-lift-actuators.mjs';

const finite3=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite);
const finiteTriangle=t=>Array.isArray(t)&&t.length===3&&t.every(finite3);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const add=(a,b)=>a.map((x,i)=>x+b[i]);
const scale=(a,s)=>a.map(x=>x*s);
const norm2=a=>dot(a,a);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dist2=(a,b)=>norm2(sub(a,b));
const sweepCertificates=new WeakSet();

function bounds(triangle){return {min:[0,1,2].map(k=>Math.min(...triangle.map(p=>p[k]))),max:[0,1,2].map(k=>Math.max(...triangle.map(p=>p[k])))};}
function aabbGap2(a,b){let d=0;for(let k=0;k<3;k++){const x=Math.max(a.min[k]-b.max[k],b.min[k]-a.max[k],0);d+=x*x;}return d;}

// Ericson's closest-point regions, returning the actual closest point.
function closestPointTriangle(p,a,b,c){
 const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);
 if(d1<=0&&d2<=0)return a;
 const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);
 if(d3>=0&&d4<=d3)return b;
 const vc=d1*d4-d3*d2;
 if(vc<=0&&d1>=0&&d3<=0)return add(a,scale(ab,d1/(d1-d3)));
 const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);
 if(d6>=0&&d5<=d6)return c;
 const vb=d5*d2-d1*d6;
 if(vb<=0&&d2>=0&&d6<=0)return add(a,scale(ac,d2/(d2-d6)));
 const va=d3*d6-d5*d4;
 if(va<=0&&(d4-d3)>=0&&(d5-d6)>=0)return add(b,scale(sub(c,b),(d4-d3)/((d4-d3)+(d5-d6))));
 const denom=1/(va+vb+vc),v=vb*denom,w=vc*denom;
 return add(a,add(scale(ab,v),scale(ac,w)));
}
function closestSegmentSegment(p1,q1,p2,q2){
 const d1=sub(q1,p1),d2=sub(q2,p2),r=sub(p1,p2),a=dot(d1,d1),e=dot(d2,d2),f=dot(d2,r);let s,t;
 if(a<=1e-16&&e<=1e-16)return [p1,p2];
 if(a<=1e-16){s=0;t=Math.max(0,Math.min(1,f/e));}
 else{const c=dot(d1,r);if(e<=1e-16){t=0;s=Math.max(0,Math.min(1,-c/a));}
  else{const b=dot(d1,d2),denom=a*e-b*b;s=denom!==0?Math.max(0,Math.min(1,(b*f-c*e)/denom)):0;t=(b*s+f)/e;
   if(t<0){t=0;s=Math.max(0,Math.min(1,-c/a));}else if(t>1){t=1;s=Math.max(0,Math.min(1,(b-c)/a));}}
 }
 return [add(p1,scale(d1,s)),add(p2,scale(d2,t))];
}
function segmentIntersectsTriangle(p,q,a,b,c){
 const d=sub(q,p),e1=sub(b,a),e2=sub(c,a),h=cross(d,e2),det=dot(e1,h);
 if(Math.abs(det)<1e-12)return false;
 const inv=1/det,s=sub(p,a),u=dot(s,h)*inv;if(u<0||u>1)return false;
 const v3=cross(s,e1),v=dot(d,v3)*inv;if(v<0||u+v>1)return false;
 const t=dot(e2,v3)*inv;return t>=0&&t<=1;
}

/** Exact Euclidean distance between two closed triangle surfaces, with closest points. */
export function triangleSurfaceDistance(first,second){
 if(!finiteTriangle(first)||!finiteTriangle(second))throw new TypeError('Two finite 3D triangles are required');
 const edges=t=>[[t[0],t[1]],[t[1],t[2]],[t[2],t[0]]];
 if(edges(first).some(([a,b])=>segmentIntersectsTriangle(a,b,...second))||edges(second).some(([a,b])=>segmentIntersectsTriangle(a,b,...first)))return {distanceMm:0,pointA:null,pointB:null,intersects:true};
 let best=Infinity,pointA,pointB;
 const consider=(a,b)=>{const d=dist2(a,b);if(d<best){best=d;pointA=a;pointB=b;}};
 for(const p of first){const q=closestPointTriangle(p,...second);consider(p,q);}
 for(const p of second){const q=closestPointTriangle(p,...first);consider(q,p);}
 for(const [a,b] of edges(first))for(const [c,d] of edges(second)){const pair=closestSegmentSegment(a,b,c,d);consider(...pair);}
 return {distanceMm:Math.sqrt(best),pointA,pointB,intersects:false};
}

/** Parse an archived binary STL into millimeter triangles. */
export function parseBinaryStl(bytes,{scaleToMm=1000}={}){
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<84||!Number.isFinite(scaleToMm)||scaleToMm<=0)throw new TypeError('Binary STL bytes and positive scaleToMm are required');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getUint32(80,true);
 if(bytes.byteLength!==84+count*50)throw new Error('Binary STL length does not match its triangle count');
 const triangles=[];for(let i=0;i<count;i++){const offset=84+i*50+12,points=[];for(let j=0;j<3;j++)points.push([0,1,2].map(k=>view.getFloat32(offset+(j*3+k)*4,true)*scaleToMm));if(points.some(p=>!finite3(p)))throw new Error('Binary STL contains a nonfinite vertex');triangles.push(points);}
 return triangles;
}

/** Clip triangles to a local half-space; generated cut edges remain conservative boundaries. */
export function clipTrianglesAtLocalX(triangles,minX){
 if(!Array.isArray(triangles)||!triangles.length||!Number.isFinite(minX)||triangles.some(t=>!finiteTriangle(t)))throw new TypeError('Finite triangle mesh and local X boundary required');
 const result=[];
 for(const tri of triangles){const polygon=[];for(let i=0;i<3;i++){const a=tri[i],b=tri[(i+1)%3],insideA=a[0]>=minX,insideB=b[0]>=minX;if(insideA)polygon.push(a);if(insideA!==insideB){const f=(minX-a[0])/(b[0]-a[0]);polygon.push(a.map((v,k)=>v+f*(b[k]-v)));}}
  for(let i=1;i<polygon.length-1;i++)result.push([polygon[0],polygon[i],polygon[i+1]]);
 }
 if(!result.length)throw new Error('Local-X clipping removed the full triangle mesh');
 return result;
}

function rotateZ(point,angle){const c=Math.cos(angle),s=Math.sin(angle);return [c*point[0]-s*point[1],s*point[0]+c*point[1],point[2]];}
function rotatedMesh(triangles,angle){return triangles.map(t=>t.map(p=>rotateZ(p,angle)));}
function meshGap(a,b){
 const aa=a.map(t=>({triangle:t,bounds:bounds(t)})),bb=b.map(t=>({triangle:t,bounds:bounds(t)}));let best={distanceMm:Infinity,pointA:null,pointB:null,intersects:false};
 for(const x of aa)for(const y of bb){if(aabbGap2(x.bounds,y.bounds)>=best.distanceMm**2)continue;const gap=triangleSurfaceDistance(x.triangle,y.triangle);if(gap.distanceMm<best.distanceMm)best=gap;}
 return best;
}

/** Exact minimum surface distance for two triangle meshes; no topology exception is applied. */
export function triangleMeshSurfaceDistance(first,second){
 if(!Array.isArray(first)||!first.length||!Array.isArray(second)||!second.length||first.some(t=>!finiteTriangle(t))||second.some(t=>!finiteTriangle(t)))throw new TypeError('Two nonempty finite triangle meshes are required');
 const gap=meshGap(first,second);
 return Object.freeze({...gap,physicalGeometryVerified:false,installedGeometryVerified:false});
}

export const SHOULDER_ADJACENT_PAIR=Object.freeze({
 sourceCommit:'f06b2ed6c1ddc5b7690975fdbba84aab626a2229',
 joint:'link1_to_link2',parent:'link1',child:'link2',jointType:'revolute',
 originMm:Object.freeze([0,0,0]),axis:Object.freeze([0,0,-1]),
 attachmentExclusionMm:20,requiredFreeBodySeparationMm:24
});

// Preserve the original proposal pins for historical evidence. Fresh proposals
// bind the revised tabletop policy below; vendor geometry remains identical.
export const LEGACY_REFERENCE_SHOULDER_SOURCE_HASHES=Object.freeze({
  urdf:'e78037cb904db813d7ff7253d06ef0d5390b5834475504665aef3771da758f41',
  srdf:'928ca2fdefd041c9aef3e6e2ec69adfb105820d238dc088acbd9abfdc75b127d',
  link1Mesh:'1068685550867a7d7b896b520397cbce9dfd387bcdabe40d83d4173870be5118',
  link2Mesh:'c03138ec0baf08bd8cfb758acaba224c36f7b6ca6198c6bff0149eb94dd376be',
  trainingEnvelope:'8091356d46a47e5fd00f04c7ca542eae5ddea6f46c77f9059d8eb960f3d93780',
  referencePolicy:'0219badebb536456064ee8c5358d0d38383f6ef1755f824ef9a92b1f86d1b553',
  servoMapping:'10bd2e27df63353067a3fd213b4ec3609162ddfa87f9c46587b10a5d1d2e8b29',
  elbowPairPolicy:'4838fb3cf204d2b52c89a02909e8ed81be5d2a861728a0a47ba62b3d28b28919'
});
export const PROPOSED_REFERENCE_SHOULDER_SOURCE_HASHES=Object.freeze({
  ...LEGACY_REFERENCE_SHOULDER_SOURCE_HASHES,
  trainingEnvelope:'b73ce2ab334be090892d9390e1e17028881c5f45ef035dec840213e1f86ce6d8',
  referencePolicy:'d3e30a6da3762eea999877a8d5214691df89bfd33a53895dc03e33210157905c',
  elbowPairPolicy:'efb32b16deea3feee32e8fa808673474b4e0230e9d61f114fb2bb2099976ab2f'
});

const sameArray=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const sameKeys=(a,b)=>!!a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(k=>a[k]===b[k]);
const boxGap=(a,b)=>Math.max(...[0,1,2].map(k=>Math.max(a.min[k]-b.max[k],b.min[k]-a.max[k])));

/**
 * Offline proposal for the complete fixed reference recovery route. The exact
 * vendor SRDF allowlist applies only to link1/link2; all other geometry gates
 * are evaluated over the full reviewed start ranges and return sequence.
 * This cannot admit or install a physical path.
 */
export function evaluateProposedReferenceRecoveryPath({sourceHashes,urdfJoint,srdfPair,route,startTickRanges,targetTicks}={}){
 const hashMatch=sameKeys(sourceHashes,PROPOSED_REFERENCE_SHOULDER_SOURCE_HASHES);
 const jointMatch=urdfJoint?.name==='link1_to_link2'&&urdfJoint?.type==='revolute'&&urdfJoint?.parent==='link1'&&urdfJoint?.child==='link2'&&sameArray(urdfJoint?.originXyzMm,[0,0,0])&&sameArray(urdfJoint?.originRpyRad,[-1.5707963267949,-1.5707963267949,0])&&sameArray(urdfJoint?.axis,[0,0,-1]);
 const pairMatch=srdfPair?.link1==='link1'&&srdfPair?.link2==='link2'&&srdfPair?.reason==='Adjacent';
 const policy=REFERENCE_RETURN_POLICY;
 const pathMatch=sameArray(route,['base','shoulder','elbow','gripper'])&&!!startTickRanges&&Object.keys(policy.startAndTargetTicks).every(k=>Array.isArray(startTickRanges[k])&&sameArray(startTickRanges[k],policy.startAndTargetTicks[k]))&&
  sameKeys(targetTicks,{base:2038,shoulder:2054,elbow:2052,gripper:2047});
 const base={revision:'proposed-srdf-link1-link2-reference-clearance-v1',status:'blocked',proposalOnly:true,livePolicyChanged:false,physicalGeometryVerified:false,installedGeometryVerified:false,
  sourcePinsMatch:hashMatch,urdfJointMatch:!!jointMatch,srdfAdjacentPairMatch:!!pairMatch,referenceScopeMatch:!!pathMatch,
  adjacentPairException:Object.freeze({pair:'link1/link2',reason:'Pinned SRDF reason=Adjacent',attachmentFloorExclusionMm:20,requiredNonAdjacentSeparationMm:24}),
  requiredBodyHeightMm:0,tabletopClearanceRevision:TABLETOP_CLEARANCE_REVISION,requiredNonAdjacentSeparationMm:24,
  gateMeaning:'Candidate geometry for a new independent review only; no current physical qualification or dispatch authority.',
  sourceEvidenceRequired:['Exact pinned URDF/SRDF/mesh and model-policy digests','Fresh independent servo12/servo13 commissioning and position feedback','Current in-memory inspection of the installed mount, cables and complete path','Independent review and a newly approved physical scope']};
  if(!hashMatch||!jointMatch||!pairMatch||!pathMatch)return Object.freeze({...base,reason:'Pinned source digests, exact link1/link2 topology, or the complete reviewed four-joint route/ranges did not match'});
 const u=policy.uncertaintyRad;
 const axisRange=joint=>{const [a,b]=startTickRanges[joint],angle=tick=>feedbackAtTicks({...targetTicks,[joint]:tick})[joint],lo=Math.min(angle(a),angle(b),angle(targetTicks[joint]))-u,hi=Math.max(angle(a),angle(b),angle(targetTicks[joint]))+u,n=Math.max(1,Math.ceil((hi-lo)/policy.maximumGridStepRad));return {lo,hi,n,step:(hi-lo)/n};};
 // Base yaw is omitted from the geometry grid because this stock model is in
 // the co-rotating shoulder plane; yaw preserves internal heights and gaps.
 // Fixed-base housing and external swept workspace remain outside this model.
 const ranges={shoulder:axisRange('shoulder'),elbow:axisRange('elbow'),gripper:axisRange('gripper')};
 const heights={upperFree:Infinity,distal:Infinity,finger:Infinity};
 const pairs={upperDistalBeyondElbow:Infinity,upperFinger:Infinity,mountDistal:Infinity,mountFinger:Infinity};
 let count=0;
 for(let si=0;si<=ranges.shoulder.n;si++)for(let ei=0;ei<=ranges.elbow.n;ei++)for(let gi=0;gi<=ranges.gripper.n;gi++){
  const shoulder=ranges.shoulder.lo+si*ranges.shoulder.step,elbow=ranges.elbow.lo+ei*ranges.elbow.step,gripper=ranges.gripper.lo+gi*ranges.gripper.step;
  const b=trainingBodyBounds({...feedbackAtTicks(targetTicks),shoulder,elbow,gripper});count++;
  for(const k of Object.keys(heights))heights[k]=Math.min(heights[k],b[k].min[2]);
  pairs.upperDistalBeyondElbow=Math.min(pairs.upperDistalBeyondElbow,adjacentLinkSeparationMm(elbow));
  pairs.upperFinger=Math.min(pairs.upperFinger,boxGap(b.upper,b.finger));
  pairs.mountDistal=Math.min(pairs.mountDistal,boxGap(b.mount,b.distal));
  pairs.mountFinger=Math.min(pairs.mountFinger,boxGap(b.mount,b.finger));
 }
 const floorPolicy=tabletopGeometryPolicy();for(const k of Object.keys(heights))heights[k]+=floorPolicy.modelHeightOffsetMm;
 const minHeightMm=Math.min(...Object.values(heights)),minPairMm=Math.min(...Object.values(pairs));
 const geometryPass=minHeightMm>=policy.requiredBodyHeightMm&&minPairMm>=policy.requiredSelfSeparationMm;
 return Object.freeze({...base,status:geometryPass?'candidate-clear-for-independent-review':'blocked',reason:geometryPass?'Pinned source model meets the actual tabletop plane and 24 mm checks across the full reviewed four-joint recovery envelope; this is not physical qualification':'The full recovery envelope fails an unchanged floor or nonadjacent pair-clearance gate',
  model:Object.freeze({revision:'shoulder-plane-stock-cad-v2',method:'Full Cartesian enclosure of all reviewed shoulder/elbow/gripper start ranges plus policy uncertainty; base yaw is co-rotating and internal-geometry invariant',route:Object.freeze([...route]),startTickRanges:Object.freeze(Object.fromEntries(Object.entries(startTickRanges).map(([k,v])=>[k,Object.freeze([...v])]))),targetTicks:Object.freeze({...targetTicks}),sampledAngleRangesRad:Object.freeze(Object.fromEntries(Object.entries(ranges).map(([k,v])=>[k,Object.freeze([v.lo,v.hi])]))),uncertaintyRad:u,maximumGridStepRad:Math.max(...Object.values(ranges).map(v=>v.step)),gridConfigurations:count,interpolationRemainderMm:policy.interpolationRemainderMm,
   shoulderAttachmentLengthMm:TRAINING_ENVELOPE_POLICY.shoulderAttachmentLengthMm,minimumBodyHeightMm:Object.freeze({...heights}),minimumOtherPairLowerBoundMm:Object.freeze({...pairs}),minimumBodyHeightMarginMm:minHeightMm,minimumPairSeparationMm:minPairMm,
   otherPairRules:Object.freeze(['Only link1/link2 uses the proposed pinned SRDF adjacent-pair exemption','link2/link3 retains its existing 60 mm elbow-collar check','All listed floor and remaining pair thresholds are unchanged'])}),
  vendorAdjacentPair:Object.freeze({pair:'link1/link2',excludedFrom24mmPairGate:true,scope:'only exact pinned SRDF pair; no blanket adjacent-pair exemption'}),
  physicalQualificationRequired:true});
}

/**
 * Apply the one documented proximal attachment exclusion without exempting the
 * complete parent/child pair. A source-mesh gap below 24 mm remains blocked.
 */
export function assessShoulderAdjacentPair({topology,sweep,attachmentExclusionMm=20,requiredSeparationMm=24}={}){
 const exact=topology&&topology.sourceCommit===SHOULDER_ADJACENT_PAIR.sourceCommit&&
  topology.joint===SHOULDER_ADJACENT_PAIR.joint&&topology.parent===SHOULDER_ADJACENT_PAIR.parent&&
  topology.child===SHOULDER_ADJACENT_PAIR.child&&topology.jointType===SHOULDER_ADJACENT_PAIR.jointType&&
  Array.isArray(topology.originMm)&&topology.originMm.length===3&&topology.originMm.every((x,i)=>x===SHOULDER_ADJACENT_PAIR.originMm[i])&&
  Array.isArray(topology.axis)&&topology.axis.length===3&&topology.axis.every((x,i)=>x===SHOULDER_ADJACENT_PAIR.axis[i]);
 if(!sweepCertificates.has(sweep)||!Number.isFinite(sweep?.lowerBoundMm)||sweep.requiredSeparationMm!==24||sweep.wholeIntervalCovered!==true||sweep.physicalGeometryVerified!==false)throw new TypeError('A complete 24 mm sweep certificate from this module is required');
 if(!Number.isFinite(attachmentExclusionMm)||!Number.isFinite(requiredSeparationMm)||attachmentExclusionMm<0||requiredSeparationMm<=0)throw new TypeError('Finite attachment scope and positive clearance threshold are required');
 const validDomain=attachmentExclusionMm===SHOULDER_ADJACENT_PAIR.attachmentExclusionMm&&requiredSeparationMm===SHOULDER_ADJACENT_PAIR.requiredFreeBodySeparationMm;
 const evidence=sweep.geometryEvidence;
 const meshPairVerified=evidence?.sourceCommit===SHOULDER_ADJACENT_PAIR.sourceCommit&&evidence.parentLink===SHOULDER_ADJACENT_PAIR.parent&&evidence.childLink===SHOULDER_ADJACENT_PAIR.child&&evidence.attachmentExclusionMm===SHOULDER_ADJACENT_PAIR.attachmentExclusionMm;
 const topologyVerified=!!exact&&validDomain&&meshPairVerified;
 const freeBodyLowerBoundMm=sweep.lowerBoundMm;
 const status=topologyVerified&&freeBodyLowerBoundMm>=requiredSeparationMm?'candidate-clear':'blocked';
 return Object.freeze({revision:'source-pinned-shoulder-adjacent-contact-v1',pair:'link1_to_link2',topologyVerified,
  attachmentDomain:Object.freeze({childLocalAxis:'x',excludedFromFreeBodyComparisonMm:topologyVerified?attachmentExclusionMm:0,scope:'proximal attachment only'}),
  freeBodyLowerBoundMm,requiredSeparationMm,status,
  reason:!topologyVerified?'Pinned URDF topology and the unchanged 20 mm attachment scope must both match':status==='blocked'?'The remaining free-body surface lower bound is below the unchanged 24 mm requirement':null,
  physicalGeometryVerified:false,installedGeometryVerified:false});
}

/**
 * Certify a rigid shoulder-axis sweep using exact triangle-surface samples and
 * a Lipschitz angular remainder. Meshes share a frame whose shoulder axis is Z.
 * This is source-model evidence only; it cannot establish installed geometry.
 */
export function certifyShoulderMeshSweep({fixedTriangles,movingTriangles,fromRad,toRad,uncertaintyRad=0,maxStepRad=0.004,requiredSeparationMm=24,positionUncertaintyMm=0,sourceCommit=null,parentLink=null,childLink=null,attachmentExclusionMm=null}={}){
 if(!Array.isArray(fixedTriangles)||!fixedTriangles.length||!Array.isArray(movingTriangles)||!movingTriangles.length||fixedTriangles.some(t=>!finiteTriangle(t))||movingTriangles.some(t=>!finiteTriangle(t)))throw new TypeError('Nonempty finite triangle meshes are required');
 for(const [name,value] of Object.entries({fromRad,toRad,uncertaintyRad,maxStepRad,requiredSeparationMm,positionUncertaintyMm}))if(!Number.isFinite(value)||(name==='uncertaintyRad'&&value<0)||(['maxStepRad','requiredSeparationMm'].includes(name)&&value<=0)||(name==='positionUncertaintyMm'&&value<0))throw new TypeError('Sweep bounds and uncertainties must be finite with nonnegative uncertainty');
 const lo=Math.min(fromRad,toRad)-uncertaintyRad,hi=Math.max(fromRad,toRad)+uncertaintyRad,n=Math.max(1,Math.ceil((hi-lo)/maxStepRad)),step=(hi-lo)/n;
 const radius=Math.max(...movingTriangles.flat(1).map(p=>Math.hypot(p[0],p[1])));let minimum={distanceMm:Infinity,pointA:null,pointB:null,intersects:false,angleRad:null};
 for(let i=0;i<=n;i++){const angle=lo+step*i,gap=meshGap(fixedTriangles,rotatedMesh(movingTriangles,angle));if(gap.distanceMm<minimum.distanceMm)minimum={...gap,angleRad:angle};}
 const interpolationRemainderMm=radius*step/2;
 const lowerBoundMm=Math.max(0,minimum.distanceMm-interpolationRemainderMm-positionUncertaintyMm);
 const result=Object.freeze({revision:'triangle-mesh-shoulder-sweep-lipschitz-v1',axis:'shared-frame Z',angleIntervalRad:Object.freeze([lo,hi]),sampleCount:n+1,maximumStepRad:step,wholeIntervalCovered:true,minimumSampledSurfaceGapMm:minimum.distanceMm,closestSampleAngleRad:minimum.angleRad,closestPoints:Object.freeze({fixed:minimum.pointA&&Object.freeze([...minimum.pointA]),moving:minimum.pointB&&Object.freeze([...minimum.pointB])}),surfacesIntersect:minimum.intersects,rotatingMeshMaximumAxisRadiusMm:radius,interpolationRemainderMm,positionUncertaintyMm,lowerBoundMm,requiredSeparationMm,status:lowerBoundMm>=requiredSeparationMm?'candidate-clear':'blocked',geometryEvidence:Object.freeze({sourceCommit,parentLink,childLink,attachmentExclusionMm}),physicalGeometryVerified:false,installedGeometryVerified:false});
 sweepCertificates.add(result);
 return result;
}

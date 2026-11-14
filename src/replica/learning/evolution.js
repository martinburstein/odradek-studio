import {POLICY_SIZE,LEARNING_VERSION,trainingFitnessForVersion,validatePolicy} from './simulation.js';
import {checkpointFitnessVersion,FITNESS_V1,FITNESS_V2,validateFitnessVersion} from './fitness-version.js';

// A small covariance-adapting Gaussian evolution strategy. The policy is a
// quadratic target-to-joint map plus servo timing terms, not a neural network.
// Selection sees only training tasks; held-out scores cannot alter this state.
const identity=n=>Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0));
const norm=a=>Math.hypot(...a);
function random(state){state.rng|=0;state.rng=state.rng+0x6D2B79F5|0;let t=Math.imul(state.rng^state.rng>>>15,1|state.rng);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;}
function normal(state){if(state.spare!==null){const value=state.spare;state.spare=null;return value;}const radius=Math.sqrt(-2*Math.log(Math.max(1e-12,random(state)))),angle=2*Math.PI*random(state);state.spare=radius*Math.sin(angle);return radius*Math.cos(angle);}
function cholesky(matrix){
 const n=matrix.length,L=Array.from({length:n},()=>Array(n).fill(0));
 for(let i=0;i<n;i++)for(let j=0;j<=i;j++){let value=matrix[i][j];for(let k=0;k<j;k++)value-=L[i][k]*L[j][k];if(i===j){if(value< -1e-7)throw Error('Evolution covariance lost positive definiteness.');L[i][j]=Math.sqrt(Math.max(1e-12,value));}else L[i][j]=value/L[j][j];}
 return L;
}
function transform(L,z){return L.map((row,i)=>row.slice(0,i+1).reduce((sum,value,k)=>sum+value*z[k],0));}
function whiten(L,y){const result=[];for(let i=0;i<y.length;i++){let value=y[i];for(let j=0;j<i;j++)value-=L[i][j]*result[j];result[i]=value/L[i][i];}return result;}
export function createEvolution(options={}){
 const {seed=20261114,population=48,generations=240,plateauGenerations=70,initialPolicy=Array(POLICY_SIZE).fill(0),sigma=.3}=options;
 const fitnessVersion=Object.hasOwn(options,'fitnessVersion')?options.fitnessVersion:FITNESS_V1;
 validateFitnessVersion(fitnessVersion);
 if(!Number.isInteger(seed)||seed<0||seed>0xffffffff||!Number.isInteger(population)||population<12||population>128||!Number.isInteger(generations)||generations<1||generations>2000||!Number.isInteger(plateauGenerations)||plateauGenerations<10||plateauGenerations>1000||!Number.isFinite(sigma)||sigma<.005||sigma>2)throw Error('Invalid evolution budget or seed.');validatePolicy(initialPolicy);
 const n=POLICY_SIZE,mu=Math.floor(population/3),weights=Array.from({length:mu},(_,i)=>Math.log(mu+.5)-Math.log(i+1)),sum=weights.reduce((s,x)=>s+x,0);for(let i=0;i<mu;i++)weights[i]/=sum;
 const effective=1/weights.reduce((s,x)=>s+x*x,0),cs=(effective+2)/(n+effective+5),cc=(4+effective/n)/(n+4+2*effective/n),c1=2/((n+1.3)**2+effective),cmu=Math.min(1-c1,2*(effective-2+1/effective)/((n+2)**2+effective));
 return{version:LEARNING_VERSION,...(fitnessVersion===FITNESS_V2?{fitnessVersion}:{}),seed,rng:seed,spare:null,population,generations,plateauGenerations,generation:0,evaluations:0,sigma,mean:[...initialPolicy],covariance:identity(n),pathSigma:Array(n).fill(0),pathCovariance:Array(n).fill(0),weights,effective,cs,cc,c1,cmu,damping:1+2*Math.max(0,Math.sqrt((effective-1)/(n+1))-1)+cs,expectedNorm:Math.sqrt(n)*(1-1/(4*n)+1/(21*n*n)),best:null,lastImprovement:0,status:'ready',stopReason:null};
}
export function validateEvolution(state){
 if(state?.version!==LEARNING_VERSION||!Number.isInteger(state.seed)||state.seed<0||state.seed>0xffffffff||!Number.isInteger(state.rng)||!Number.isInteger(state.population)||state.population<12||state.population>128||!Number.isInteger(state.generations)||state.generations<1||state.generations>2000||!Number.isInteger(state.plateauGenerations)||state.plateauGenerations<10||state.plateauGenerations>1000||!Number.isInteger(state.generation)||state.generation<0||state.generation>state.generations||!Number.isInteger(state.evaluations)||state.evaluations<0||!Number.isFinite(state.sigma)||state.sigma<=0||state.sigma>2||!Number.isInteger(state.lastImprovement)||state.lastImprovement<0||state.lastImprovement>state.generation||!['ready','running','complete','cancelled'].includes(state.status))throw Error('Invalid evolution checkpoint.');
 checkpointFitnessVersion(state);
 if(state.spare!==null&&(!Number.isFinite(state.spare)))throw Error('Invalid evolution random state.');
 for(const key of ['effective','cs','cc','c1','cmu','damping','expectedNorm'])if(!Number.isFinite(state[key])||state[key]<=0)throw Error('Invalid evolution strategy parameter.');
 validatePolicy(state.mean);if(state.best)validatePolicy(state.best.policy);
 if(state.best&&(!Number.isFinite(state.best.loss)||state.best.loss<0||!Number.isInteger(state.best.generation)||state.best.generation<0||state.best.generation>state.generation))throw Error('Invalid retained best candidate.');
 for(const key of ['pathSigma','pathCovariance'])if(!Array.isArray(state[key])||state[key].length!==POLICY_SIZE||state[key].some(x=>!Number.isFinite(x)))throw Error('Invalid evolution path.');
 if(!Array.isArray(state.weights)||state.weights.length!==Math.floor(state.population/3)||state.weights.some(x=>!Number.isFinite(x)||x<=0)||Math.abs(state.weights.reduce((a,b)=>a+b,0)-1)>1e-6)throw Error('Invalid evolution selection weights.');
 if(!Array.isArray(state.covariance)||state.covariance.length!==POLICY_SIZE||state.covariance.some(row=>!Array.isArray(row)||row.length!==POLICY_SIZE||row.some(x=>!Number.isFinite(x)||Math.abs(x)>1e6)))throw Error('Invalid evolution covariance.');
 for(let i=0;i<POLICY_SIZE;i++)for(let j=0;j<POLICY_SIZE;j++)if(Math.abs(state.covariance[i][j]-state.covariance[j][i])>1e-6)throw Error('Evolution covariance is not symmetric.');cholesky(state.covariance);
 if(state.pending){const p=state.pending;if(p.generation!==state.generation+1||!Array.isArray(p.oldMean)||!Array.isArray(p.candidates)||p.candidates.length>state.population||p.oldMean.length!==POLICY_SIZE||p.oldMean.some(x=>!Number.isFinite(x))||p.candidates.some(c=>!Array.isArray(c.policy)||c.policy.length!==POLICY_SIZE||c.policy.some(x=>!Number.isFinite(x))||!Array.isArray(c.y)||c.y.length!==POLICY_SIZE||c.y.some(x=>!Number.isFinite(x))||!Number.isFinite(c.loss)||c.loss<0))throw Error('Invalid partial generation.');}
 return state;
}
export function initializeEvolution(state,experiment,fitness){
 const version=checkpointFitnessVersion(state);if(state.best)return state.best;
 const measure=fitness??trainingFitnessForVersion(version),measured=measure(state.mean,experiment);if(!Number.isFinite(measured.loss))throw Error('Nonfinite baseline loss.');state.evaluations++;state.best={policy:[...state.mean],...measured,generation:0};return state.best;
}
export function evolveGeneration(state,experiment,{fitness,cancelled=()=>false}={}){
 const version=checkpointFitnessVersion(state),measure=fitness??trainingFitnessForVersion(version);
 if(state.status==='complete')return null;initializeEvolution(state,experiment,measure);state.status='running';state.stopReason=null;
 const n=POLICY_SIZE,L=cholesky(state.covariance);state.pending??={generation:state.generation+1,oldMean:[...state.mean],candidates:[]};const pending=state.pending,candidates=pending.candidates;
 for(let i=candidates.length;i<state.population;i++){
  if(cancelled()){state.status='cancelled';state.stopReason='cancelled';return null;}
  const z=Array.from({length:n},()=>normal(state)),y=transform(L,z),policy=pending.oldMean.map((x,j)=>x+state.sigma*y[j]);
  let measured,failed=false;try{if(policy.some(x=>Math.abs(x)>100)){measured={loss:1e12};failed=true;}else measured=measure(policy,experiment);if(!Number.isFinite(measured.loss)||measured.loss<0)throw Error('Nonfinite or negative candidate loss.');}catch(error){measured={loss:1e12,failed:true,reason:String(error?.message??error).slice(0,240)};failed=true;}
  state.evaluations++;candidates.push({policy,y,...measured,failed});
 }
 candidates.sort((a,b)=>a.loss-b.loss);state.generation++;state.pending=null;
 const winner=candidates[0],previousBest=state.best.loss;
 if(winner.loss<state.best.loss){state.best={policy:[...winner.policy],loss:winner.loss,staticLoss:winner.staticLoss,dynamicLoss:winner.dynamicLoss,generation:state.generation};if(previousBest-winner.loss>Math.max(1e-7,previousBest*1e-5))state.lastImprovement=state.generation;}
 const step=Array(n).fill(0);for(let i=0;i<state.weights.length;i++)for(let j=0;j<n;j++)step[j]+=state.weights[i]*candidates[i].y[j];
 state.mean=pending.oldMean.map((x,j)=>x+state.sigma*step[j]);const white=whiten(L,step),sigmaFactor=Math.sqrt(state.cs*(2-state.cs)*state.effective);
 state.pathSigma=state.pathSigma.map((x,j)=>(1-state.cs)*x+sigmaFactor*white[j]);
 const h=norm(state.pathSigma)/Math.sqrt(1-(1-state.cs)**(2*state.generation))<(1.4+2/(n+1))*state.expectedNorm?1:0,covFactor=Math.sqrt(state.cc*(2-state.cc)*state.effective);
 state.pathCovariance=state.pathCovariance.map((x,j)=>(1-state.cc)*x+h*covFactor*step[j]);
 for(let i=0;i<n;i++)for(let j=0;j<=i;j++){
  let rankMu=0;for(let k=0;k<state.weights.length;k++)rankMu+=state.weights[k]*candidates[k].y[i]*candidates[k].y[j];
  const value=(1-state.c1-state.cmu+state.c1*(1-h)*state.cc*(2-state.cc))*state.covariance[i][j]+state.c1*state.pathCovariance[i]*state.pathCovariance[j]+state.cmu*rankMu;
  state.covariance[i][j]=state.covariance[j][i]=value+(i===j?1e-14:0);
 }
 state.sigma=Math.max(1e-5,Math.min(2,state.sigma*Math.exp(state.cs/state.damping*(norm(state.pathSigma)/state.expectedNorm-1))));
 if(state.generation>=state.generations){state.status='complete';state.stopReason='generation-budget';}
 else if(state.generation-state.lastImprovement>=state.plateauGenerations){state.status='complete';state.stopReason='plateau';}
 return{generation:state.generation,evaluations:state.evaluations,best:{...state.best,policy:[...state.best.policy]},winner:{loss:winner.loss,policy:[...winner.policy],failed:!!winner.failed},worst:{loss:candidates.at(-1).loss,policy:[...candidates.at(-1).policy],failed:!!candidates.at(-1).failed},failedCandidates:candidates.filter(c=>c.failed).map(c=>({loss:c.loss,reason:c.reason??'policy-out-of-bounds'})),medianLoss:candidates[Math.floor(candidates.length/2)].loss,sigma:state.sigma,improved:winner.loss<previousBest,status:state.status,stopReason:state.stopReason};
}

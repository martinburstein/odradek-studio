// Ordinary Studio startup does not initialize optional private pilot tooling.
// Submission still constructs the original implementation and all its checks.
export function lazyPilot(create){
 let instance;
 return{state(){return instance?instance.state():{job:null,initialized:false};},submit(...args){instance??=create();return instance.submit(...args);},cancel(){return instance?.cancel();},settle(){return instance?.settle?.()??Promise.resolve();}};
}

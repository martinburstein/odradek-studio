// Fitness identity is separate from the unchanged rollout/physics version.
export const FITNESS_V1='stylus-fitness-v1';
export const FITNESS_V2='stylus-fitness-approach-v2';
export const DEFAULT_FITNESS_VERSION=FITNESS_V2;
export function validateFitnessVersion(version){
 if(version!==FITNESS_V1&&version!==FITNESS_V2)throw Error('Unsupported stylus fitness version.');
 return version;
}
export function checkpointFitnessVersion(state){
 if(!state||typeof state!=='object'||Array.isArray(state))throw Error('Invalid optimizer fitness metadata.');
 return Object.hasOwn(state,'fitnessVersion')?validateFitnessVersion(state.fitnessVersion):FITNESS_V1;
}

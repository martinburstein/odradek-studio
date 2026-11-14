import {validateDesk} from '../state.js';
import {DEFAULT_TOOL,trackpadFrame,validateTool} from './geometry.js';

const DESK_KEYS=new Set(['laptopWidth','laptopDepth','laptopHeight','laptopX','laptopZ','laptopYaw','trackpadWidth','trackpadDepth','toolLength']);
const TOOL_KEYS=new Set(['frontReach','rearReach','mountPitch','lateralOffset','tapeRadius','barrelRadius','nibRadius']);
const DEG=Math.PI/180;
const MAX_SPEED=360*DEG;
const MAX_ACCELERATION=1800*DEG;
const isRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function requireKeys(value,allowed,label){
 if(!isRecord(value)||Object.keys(value).some(key=>!allowed.has(key)))throw Error(`Invalid plant ${label} overrides.`);
 for(const [key,item]of Object.entries(value))if(typeof item!=='number'||!Number.isFinite(item))throw Error(`Plant ${label}.${key} must be finite.`);
}

// Resolves explicit geometry/cap variations against a nominal experiment.
// These settings describe modeled scenarios, not measured physical tolerances.
export function resolvePlant(experiment,overrides={}){
 if(!isRecord(experiment)||!isRecord(experiment.desk)||!isRecord(experiment.tool)||!isRecord(experiment.frame))throw Error('A valid nominal experiment is required.');
 const allowed=new Set(['desk','tool','maxSpeed','maxAcceleration']);
 if(!isRecord(overrides)||Object.keys(overrides).some(key=>!allowed.has(key)))throw Error('Invalid plant overrides.');
 const deskOverrides=Object.hasOwn(overrides,'desk')?overrides.desk:{};
 requireKeys(deskOverrides,DESK_KEYS,'desk');
 const desk=validateDesk({...experiment.desk,...deskOverrides});
 const toolOverrides=Object.hasOwn(overrides,'tool')?overrides.tool:{};
 requireKeys(toolOverrides,TOOL_KEYS,'tool');
 const tool=validateTool({...DEFAULT_TOOL,...experiment.tool,...toolOverrides,...(Object.hasOwn(deskOverrides,'toolLength')&&!Object.hasOwn(toolOverrides,'frontReach')?{frontReach:desk.toolLength}:{})});
 if(tool.end!==experiment.tool.end||tool.targetTilt!==experiment.tool.targetTilt)throw Error('Plant cannot change the active stylus end or target tilt.');
 const maxSpeed=Object.hasOwn(overrides,'maxSpeed')?overrides.maxSpeed:experiment.maxSpeed,maxAcceleration=Object.hasOwn(overrides,'maxAcceleration')?overrides.maxAcceleration:experiment.maxAcceleration;
 if(!Number.isFinite(maxSpeed)||maxSpeed<=0||maxSpeed>MAX_SPEED)throw Error(`Plant maxSpeed must be greater than 0 and at most ${MAX_SPEED} rad/s.`);
 if(!Number.isFinite(maxAcceleration)||maxAcceleration<=0||maxAcceleration>MAX_ACCELERATION)throw Error(`Plant maxAcceleration must be greater than 0 and at most ${MAX_ACCELERATION} rad/s².`);
 return{desk,frame:trackpadFrame(desk),tool,maxSpeed,maxAcceleration};
}

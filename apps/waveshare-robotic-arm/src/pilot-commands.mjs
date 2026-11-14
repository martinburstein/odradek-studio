// Small scoped command language. It never opens a transport.
import {dynamicMoves} from './dynamic-moves.mjs';
export function parsePilotCommand(line){
 if(typeof line!=='string'||line.length>100||/[\r\n]/.test(line))throw Error('One command line, at most 100 characters, required');
 const words=line.trim().toUpperCase().split(/\s+/),verb=words.shift();
 if(verb==='PERFORM'){
  const name=words[0]?.toLowerCase();
  if(words.length!==1||name!=='reference-return'&&!dynamicMoves().some(m=>m.name===name))throw Error('PERFORM requires one exact reviewed catalog name or reference-return');
  return {kind:'hardware-program',name};
 }
 if(verb==='REFERENCE'){
  if(words.length!==1||!['QUALIFY','BASE','SHOULDER','ELBOW','GRIPPER'].includes(words[0]))throw Error('REFERENCE takes QUALIFY or one fixed reference joint; no target fields');
  return words[0]==='QUALIFY'?{kind:'reference',qualify:true}:{kind:'reference',joint:words[0].toLowerCase()};
 }
 if(verb==='QUALIFY'){if(words.length===1&&words[0]==='CURRENT')return {kind:'qualify',current:true};if(words.length===1&&words[0]==='RESET')return {kind:'qualify',reset:true};if(words.length)throw Error('QUALIFY takes only optional RESET or CURRENT');return {kind:'qualify'};}
 if(['M114','STATUS','M112','STOP'].includes(verb)){
  if(words.length)throw Error('Status and stop take no fields');
  return {kind:['M114','STATUS'].includes(verb)?'status':'stop'};
 }
 if(verb==='SMOOTH'){if(words.length!==1||words[0]!=='F20')throw Error('SMOOTH only takes F20 and one outward elbow stroke');return {kind:'move',direction:'down',speed:20,trajectory:true};}
 if(!['G1','DOWN','UP','WAVE'].includes(verb))throw Error('Use M114, M112, WAVE F40, DOWN F40, UP F40, or G1 E<reviewed degrees> F20|40');
 const fields={};for(const word of words){const match=/^([EF])(-?\d+(?:\.\d+)?)$/.exec(word);if(!match||fields[match[1]]!==undefined)throw Error('Only unique numeric E and F fields are supported');fields[match[1]]=Number(match[2]);}
 if(![20,40].includes(fields.F))throw Error('F must be 20 or 40 servo steps per second');
 if(verb==='WAVE'){if(fields.E!==undefined)throw Error('WAVE only takes F and uses the two reviewed endpoints');return {kind:'wave',speed:fields.F};}
 let direction=verb.toLowerCase();
 if(verb==='G1'){
  if(!Number.isFinite(fields.E))throw Error('G1 requires nominal elbow degrees E');
  const nominalTick=1024+fields.E*4096/360,tick=Math.round(nominalTick);
  if(![2389,2052].includes(tick)||Math.abs(nominalTick-tick)>.5+1e-9)throw Error('Elbow target is outside the reviewed endpoints: E119.970703125 or E90.3515625');
  direction=tick===2389?'down':'up';
 }else if(fields.E!==undefined)throw Error('DOWN and UP only take F');
 return {kind:'move',direction,speed:fields.F};
}

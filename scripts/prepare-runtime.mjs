import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const version='24.22.1',root=path.resolve(import.meta.dirname,'..'),target=path.join(root,'vendor/node');
const base=`https://nodejs.org/dist/v${version}/`;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function download(relative){const r=await fetch(base+relative,{signal:AbortSignal.timeout(180000),redirect:'error'});if(!r.ok)throw Error(`Node download ${relative}: ${r.status}`);return Buffer.from(await r.arrayBuffer());}
await fs.mkdir(target,{recursive:true});
const sums=(await download('SHASUMS256.txt')).toString();
const expected=sums.split(/\r?\n/).find(line=>line.trim().endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
if(!/^[a-f0-9]{64}$/.test(expected??''))throw Error('Official runtime checksum missing');
let binary;try{binary=await fs.readFile(path.join(target,'node.exe'));}catch{}
if(!binary||sha(binary)!==expected){binary=await download('win-x64/node.exe');if(sha(binary)!==expected)throw Error('Node runtime checksum mismatch');await fs.writeFile(path.join(target,'node.exe'),binary);}
const licenseResponse=await fetch(`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`,{signal:AbortSignal.timeout(30000),redirect:'error'});
if(!licenseResponse.ok)throw Error('Official Node license unavailable');
const license=await licenseResponse.text();if(!license.includes('Permission is hereby granted'))throw Error('Unexpected Node license');
await fs.writeFile(path.join(target,'LICENSE.txt'),license);
await fs.writeFile(path.join(target,'runtime.json'),JSON.stringify({version,platform:'win32',arch:'x64',url:base+'win-x64/node.exe',sha256:expected},null,2)+'\n');
console.log(`Bundled Node ${version} x64; SHA-256 ${expected}`);

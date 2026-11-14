import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectPublicTree} from '../scripts/verify-public.mjs';
test('public source rejects development records and machine-specific files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-public-test-'));
 try{await fs.writeFile(path.join(root,'README.md'),'Clean product documentation.');assert.equal((await inspectPublicTree(root)).ok,true);
  await fs.mkdir(path.join(root,'records'));assert.equal((await inspectPublicTree(root)).ok,false);await fs.rmdir(path.join(root,'records'));
  await fs.writeFile(path.join(root,'access.json'),'{}');assert.equal((await inspectPublicTree(root)).ok,false);await fs.unlink(path.join(root,'access.json'));
  await fs.writeFile(path.join(root,'setup.json'),JSON.stringify({path:'C:'+ '/Users/'+'marti/private-photo.png'}));assert.equal((await inspectPublicTree(root)).ok,false);await fs.unlink(path.join(root,'setup.json'));
 }finally{await fs.unlink(path.join(root,'README.md'));await fs.rmdir(root);}
});

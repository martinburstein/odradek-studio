import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import {parseLearningRun,snapshotOptions,replayEpisode} from '../src/replica/learning/run.js';
test('the public example catalog contains exact, replayable included policies without private records',async()=>{
 const root=path.resolve(import.meta.dirname,'..'),server=await createServer({configFile:path.join(root,'vite.config.js'),server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'silent'});
 try{const{bundledExamples,defaultExample}=await server.ssrLoadModule(path.join(root,'src/replica/learning/examples.js')),manifest=JSON.parse(await fs.readFile(path.join(root,'assets/learning/examples.json'),'utf8'));
  assert.equal(bundledExamples.length,4);assert.equal(defaultExample.id,'corner-after');
  for(const entry of manifest.examples){const raw=await fs.readFile(path.join(root,'assets/learning',entry.file)),run=parseLearningRun(raw.toString());assert.equal(createHash('sha256').update(raw).digest('hex'),entry.sha256);assert.equal(raw.length,entry.bytes);assert.equal(run.history.length,entry.generations);assert.equal(run.snapshots.length,entry.snapshots);assert(bundledExamples.some(example=>example.text===raw.toString()));}
  const run=parseLearningRun(defaultExample.text),options=snapshotOptions(run);assert.equal(options.length,82);assert.equal(options[0].generation,0);assert.equal(options.at(-1).generation,800);
  const before=replayEpisode(run,options[0],{taskId:'train-horizontal'}),after=replayEpisode(run,options.at(-1),{taskId:'train-horizontal'});assert.equal(before.metrics.contactFraction,0);assert.equal(after.metrics.contactFraction,1);assert(after.metrics.contactRmsError<1);
 }finally{await server.close();}
});

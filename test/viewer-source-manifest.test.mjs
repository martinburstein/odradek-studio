import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectViewerSourceManifest,compareViewerSourceManifests,verifyViewerSourceManifest,createViewerSourceManifestPlugin} from '../scripts/viewer-source-manifest.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'odradek-viewer-manifest-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const write=async(relative,text)=>{const file=path.join(root,...relative.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);};
 for(const directory of ['src/replica','assets/learning','assets/roarm','assets/setup','assets/theme'])await fs.mkdir(path.join(root,directory),{recursive:true});
 await write('package.json',JSON.stringify({engines:{node:'>=24'},devDependencies:{vite:'7.3.8'}}));
 await write('package-lock.json',JSON.stringify({packages:{'':{},'node_modules/vite':{version:'7.3.8'}}}));
 await write('provenance.json',JSON.stringify({files:[{component:'preserved',path:'source.js'}],examplePresets:{sha256:'a'.repeat(64)}}));
 await write('references/setup/source.json',JSON.stringify({id:'EXAMPLE-DESK'}));
 await write('vite.config.js','export default {};\n');
 await write('scripts/viewer-source-manifest.mjs','// fixture copy included in build inputs\n');
 for(const directory of ['src/replica','assets/learning','assets/roarm','assets/setup','assets/theme'])await write(`${directory}/entry.txt`,`${directory}\n`);
 return{root,write};
}

test('manifest is deterministic, relative, sorted, and excludes private/runtime paths',async t=>{
 const {root,write}=await fixture(t);
 await write('assets/setup/local-photo/private.jpg','fixture-secret');
 await write('assets/learning/downloads/source.zip','fixture-download');
 await write('src/replica/runtime/session.json','fixture-runtime');
 await write('src/replica/rawcamera/frame.png','fixture-frame');
 await write('src/replica/.env','fixture-secret');
 await write('src/replica/id_ed25519','fixture-secret');
 const first=await collectViewerSourceManifest({root}),second=await collectViewerSourceManifest({root});
 assert.deepEqual(second,first);
 assert.deepEqual(first.files.map(file=>file.path),[...first.files.map(file=>file.path)].sort());
 assert.ok(first.files.some(file=>file.path==='scripts/viewer-source-manifest.mjs'));
 assert.ok(first.files.some(file=>file.path==='package-lock.json'));
 assert.equal(first.preservedProvenance.sha256,first.files.find(file=>file.path==='provenance.json').sha256);
 assert.doesNotMatch(JSON.stringify(first),new RegExp(root.replaceAll('\\','\\\\')));
 assert.doesNotMatch(JSON.stringify(first),/local-photo|downloads|runtime|rawcamera|node_modules|dist|private\.jpg|frame\.png|\.env|id_ed25519/);
 assert.ok(!first.files.some(file=>file.path==='odradek-build.json'||file.path==='dist/odradek-build.json'));
});

test('verification detects source edits, additions, and removals',async t=>{
 const {root,write}=await fixture(t),initial=await collectViewerSourceManifest({root});
 await write('src/replica/entry.txt','changed\n');
 let result=await verifyViewerSourceManifest(initial,{root});
 assert.equal(result.ok,false);assert.ok(result.changed.includes('src/replica/entry.txt'));
 await write('src/replica/added.js','export {};\n');
 result=await verifyViewerSourceManifest(initial,{root});assert.ok(result.added.includes('src/replica/added.js'));
 await fs.rm(path.join(root,'assets/theme/entry.txt'));
 result=await verifyViewerSourceManifest(initial,{root});assert.ok(result.missing.includes('assets/theme/entry.txt'));
});

test('comparison rejects duplicate paths and malformed manifest entries',async t=>{
 const {root}=await fixture(t),manifest=await collectViewerSourceManifest({root}),first=manifest.files[0];
 const duplicate=compareViewerSourceManifests({...manifest,files:[...manifest.files,first]},manifest);
 assert.equal(duplicate.ok,false);assert.ok(duplicate.duplicates.includes(`expected:${first.path}`));
 const malformed=compareViewerSourceManifests({...manifest,files:[...manifest.files,{path:'../outside',bytes:-1,sha256:'bad'}]},manifest);
 assert.equal(malformed.ok,false);assert.ok(malformed.malformed.includes(`expected:files[${manifest.files.length}]`));
});

test('fixed manifest inputs reject symlinks',async t=>{
 const {root}=await fixture(t),outsideDir=await fs.mkdtemp(path.join(os.tmpdir(),'odradek-manifest-outside-'));
 t.after(()=>fs.rm(outsideDir,{recursive:true,force:true}));
 const outside=path.join(outsideDir,'provenance.json'),target=path.join(root,'provenance.json');
 await fs.writeFile(outside,'{}');await fs.rm(target);
 try{await fs.symlink(outside,target,'file');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip(`filesystem does not permit symlink fixture: ${error.code}`);return;}throw error;}
 await assert.rejects(()=>collectViewerSourceManifest({root}),/not a regular file/);
});

test('build plugin rejects mutation after buildStart and before emission',async t=>{
 const {root,write}=await fixture(t),plugin=createViewerSourceManifestPlugin({root});let emitted=false;
 await plugin.buildStart.call({});await write('assets/theme/entry.txt','edited during build\n');
 await assert.rejects(()=>plugin.generateBundle.call({emitFile(){emitted=true;}}),/inputs changed during build/);
 assert.equal(emitted,false);
});

test('build plugin emits a nonrecursive manifest without writing middleware artifacts',async t=>{
 const {root}=await fixture(t),plugin=createViewerSourceManifestPlugin({root}),emitted=[];
 await plugin.buildStart.call({});
 await plugin.generateBundle.call({emitFile(asset){emitted.push(asset);}});
 assert.equal(emitted.length,1);assert.equal(emitted[0].fileName,'odradek-build.json');
 const manifest=JSON.parse(emitted[0].source);
 assert.ok(!manifest.files.some(file=>file.path.includes('odradek-build.json')));
 assert.equal(await fs.stat(path.join(root,'dist')).then(()=>true,()=>false),false);
});


test('curated Studio manifest fingerprints the public setup metadata without a private preset archive',async t=>{
 const {root,write}=await fixture(t);await write('provenance.json',JSON.stringify({schema:2,product:'Odradek Studio',files:[]}));
 const initial=await collectViewerSourceManifest({root});assert.equal(initial.preservedProvenance.curated,true);assert.equal(initial.preservedProvenance.examplePresetsSha256,undefined);
 await write('references/setup/source.json',JSON.stringify({id:'ANOTHER-EXAMPLE'}));const changed=await collectViewerSourceManifest({root});assert.equal(compareViewerSourceManifests(initial,changed).ok,false);
});

import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..'),manifest=JSON.parse(await fs.readFile(path.join(root,'provenance.json'),'utf8'));
if(manifest.schema!==2||manifest.product!=='Odradek Studio')throw Error('Expected the curated Studio source inventory.');
for(const item of manifest.files){const file=path.resolve(root,'apps',item.component,item.path);if(!file.startsWith(path.join(root,'apps')+path.sep))throw Error('Source inventory escaped apps.');const bytes=await fs.readFile(file);if(bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error(`Curated component changed: ${item.component}/${item.path}`);}
console.log(`Verified ${manifest.files.length} curated component source files.`);

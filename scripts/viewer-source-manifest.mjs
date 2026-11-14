import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FIXED_FILES=Object.freeze(['package.json','package-lock.json','provenance.json','vite.config.js','scripts/viewer-source-manifest.mjs','references/setup/source.json']);
const SOURCE_DIRS=Object.freeze(['src/replica','assets/learning','assets/roarm','assets/setup','assets/theme']);
const EXCLUDED_SEGMENTS=new Set(['.git','.cache','.ssh','.aws','dist','node_modules','runtime','download','downloads','local-photo','photos','camera-roll','rawcamera','secrets','credentials','private']);
const HASH_RE=/^[a-f0-9]{64}$/;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const normalized=p=>p.split(path.sep).join('/');

function assertInside(root,relative){
 const absolute=path.resolve(root,relative);
 if(absolute!==root&&!absolute.startsWith(root+path.sep))throw Error(`Manifest source escaped root: ${relative}`);
 return absolute;
}
function excluded(relative){
 return relative.split('/').some(segment=>{
  const lower=segment.toLowerCase();
  return EXCLUDED_SEGMENTS.has(lower)||lower==='.env'||lower.startsWith('.env.')||['.pem','.key','.p12','.pfx'].some(ext=>lower.endsWith(ext))||['id_rsa','id_ed25519'].includes(lower);
 });
}
async function listTree(root,relative){
 const absolute=assertInside(root,relative),entries=await fs.readdir(absolute,{withFileTypes:true}),files=[];
 for(const entry of entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
  const child=normalized(path.posix.join(relative,entry.name));if(excluded(child))continue;
  const target=assertInside(root,child);
  if(entry.isSymbolicLink())throw Error(`Symlink in manifest source scope: ${child}`);
  if(entry.isDirectory())files.push(...await listTree(root,child));
  else if(entry.isFile())files.push(child);
 }
 return files;
}

async function collectPaths(root){
 for(const relative of FIXED_FILES){
  const info=await fs.lstat(assertInside(root,relative)).catch(()=>null);
  if(!info?.isFile()||info.isSymbolicLink())throw Error(`Required viewer source file is missing or not a regular file: ${relative}`);
 }
 const result=new Set(FIXED_FILES);
 for(const directory of SOURCE_DIRS){
  const target=assertInside(root,directory);
  const stat=await fs.stat(target).catch(()=>null);
  if(!stat?.isDirectory())throw Error(`Required viewer source directory is missing: ${directory}`);
  for(const file of await listTree(root,directory))result.add(file);
 }
 return [...result].sort((a,b)=>a<b?-1:a>b?1:0);
}

export async function collectViewerSourceManifest({root=ROOT}={}){
 root=path.resolve(root);
 const paths=await collectPaths(root),files=[];
 for(const relative of paths){
  const bytes=await fs.readFile(assertInside(root,relative));
  files.push({path:relative,bytes:bytes.length,sha256:sha256(bytes)});
 }
 const packageJson=JSON.parse(await fs.readFile(assertInside(root,'package.json'),'utf8'));
 const lock=JSON.parse(await fs.readFile(assertInside(root,'package-lock.json'),'utf8'));
 const viteVersion=lock.packages?.['node_modules/vite']?.version;
 if(typeof viteVersion!=='string'||!packageJson.devDependencies?.vite)throw Error('Pinned Vite toolchain metadata is missing.');
 const provenance=JSON.parse(await fs.readFile(assertInside(root,'provenance.json'),'utf8'));
 const provenanceFile=files.find(file=>file.path==='provenance.json');
 const curated=provenance.schema===2&&provenance.product==='Odradek Studio';
 if(!provenanceFile||!Array.isArray(provenance.files)||(!curated&&typeof provenance.examplePresets?.sha256!=='string'))throw Error('Preserved provenance metadata is malformed.');
 return{
  schema:'odradek-viewer-build-v1',
  toolchain:{vite:viteVersion,nodeEngine:packageJson.engines?.node??null},
  files,
  preservedProvenance:{path:'provenance.json',bytes:provenanceFile.bytes,sha256:provenanceFile.sha256,sourceCount:provenance.files.length,...(curated?{curated:true}:{examplePresetsSha256:provenance.examplePresets.sha256})}
 };
}

export function compareViewerSourceManifests(expected,actual){
 const inspect=(manifest,label)=>{
  const malformed=[],duplicates=[],seen=new Set();
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||manifest.schema!=='odradek-viewer-build-v1'||!Array.isArray(manifest.files))return{malformed:[`${label}:invalid-manifest`],duplicates};
  for(let index=0;index<manifest.files.length;index++){
   const item=manifest.files[index],file=item?.path;
   if(!item||typeof item!=='object'||Array.isArray(item)||typeof file!=='string'||!file||file.includes('\\')||file.startsWith('/')||file.split('/').some(part=>!part||part==='.'||part==='..')||!Number.isInteger(item.bytes)||item.bytes<0||typeof item.sha256!=='string'||!HASH_RE.test(item.sha256)){
    malformed.push(`${label}:files[${index}]`);continue;
   }
   if(seen.has(file))duplicates.push(`${label}:${file}`);else seen.add(file);
  }
  return{malformed,duplicates};
 };
 const expectedShape=inspect(expected,'expected'),actualShape=inspect(actual,'actual');
 const usableFiles=manifest=>Array.isArray(manifest?.files)?manifest.files.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)&&typeof item.path==='string'):[];
 const expectedFiles=new Map(usableFiles(expected).map(item=>[item.path,item])),actualFiles=new Map(usableFiles(actual).map(item=>[item.path,item]));
 const sort=values=>values.sort((a,b)=>a<b?-1:a>b?1:0);
 const missing=sort([...expectedFiles.keys()].filter(file=>!actualFiles.has(file)));
 const added=sort([...actualFiles.keys()].filter(file=>!expectedFiles.has(file)));
 const changed=sort([...expectedFiles.keys()].filter(file=>actualFiles.has(file)&&JSON.stringify(expectedFiles.get(file))!==JSON.stringify(actualFiles.get(file))));
 const metadataChanged=JSON.stringify({schema:expected?.schema,toolchain:expected?.toolchain,preservedProvenance:expected?.preservedProvenance})!==JSON.stringify({schema:actual?.schema,toolchain:actual?.toolchain,preservedProvenance:actual?.preservedProvenance});
 const malformed=[...expectedShape.malformed,...actualShape.malformed],duplicates=[...expectedShape.duplicates,...actualShape.duplicates];
 return{ok:!missing.length&&!added.length&&!changed.length&&!metadataChanged&&!malformed.length&&!duplicates.length,missing,added,changed,metadataChanged,malformed,duplicates};
}

export async function verifyViewerSourceManifest(manifest,{root=ROOT}={}){
 const actual=await collectViewerSourceManifest({root}),comparison=compareViewerSourceManifests(manifest,actual);
 return{...comparison,expected:manifest,actual};
}

export function createViewerSourceManifestPlugin({root=ROOT}={}){
 let initial;
 return{
  name:'odradek-viewer-source-manifest',
  apply:'build',
  async buildStart(){initial=await collectViewerSourceManifest({root});},
  async generateBundle(){
   if(!initial)throw Error('Viewer source manifest build snapshot was not captured.');
   const current=await collectViewerSourceManifest({root}),comparison=compareViewerSourceManifests(initial,current);
   if(!comparison.ok)throw Error(`Viewer source inputs changed during build: ${JSON.stringify({missing:comparison.missing,added:comparison.added,changed:comparison.changed,metadataChanged:comparison.metadataChanged})}`);
   this.emitFile({type:'asset',fileName:'odradek-build.json',source:JSON.stringify(initial,null,2)+'\n'});
  }
 };
}

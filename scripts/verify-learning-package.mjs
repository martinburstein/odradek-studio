import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {fork} from 'node:child_process';
import os from 'node:os';
import {verifyViewerSourceManifest} from './viewer-source-manifest.mjs';
import {parseLearningRun} from '../src/replica/learning/run.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url),asar=require('@electron/asar');
const pe=require('pe-library'),resedit=require('resedit');
const args=process.argv.slice(2),skipOfflineViewer=args.includes('--skip-offline-viewer'),candidate=path.resolve(root,args.find(value=>!value.startsWith('--'))??'release/win-unpacked');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash=async file=>sha(await fs.readFile(file));
const checks=[];
const check=(name,ok,details={})=>{checks.push({name,ok,...details});return ok;};
async function walk(directory){
 const files=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){const full=path.join(directory,entry.name);if(entry.isDirectory())files.push(...await walk(full));else if(entry.isFile())files.push(full);}return files.sort();
}
function sensitivePath(value){
 const name=value.replaceAll('\\','/');
 if(/(^|\/)(?:runtime|appdata|user-data|credentials?|secrets?|browser-profiles?|camera-roll|photos|records|research|plans|evidence|firmware-candidates)(\/|$)/i.test(name))return true;
 if(/(^|\/)(?:access\.json|movement-history(?:\.json)?|application\.log|commissioning\/motion\.json)$/i.test(name))return true;
 if(/(^|\/)(?:qualifications?|qualification-records?|calibration-records?|commissioning-data)(\/|$)/i.test(name)&&/\.(?:json|csv|db|sqlite|log)$/i.test(name))return true;
 if(/(?:qualification|calibration)[^/]*\.(?:json|csv|db|sqlite|log)$/i.test(name))return true;
 if(/(^|\/)\.env(?:$|\.)/i.test(name)&&!name.endsWith('.env.example'))return true;
 if(/\.(?:pem|p12|pfx|key)$/i.test(name))return true;
 return false;
}
function extractEmbeddedString(bundle,marker){
 const markerIndex=bundle.indexOf(marker);if(markerIndex<0)return null;
 const escaped=index=>{let slashes=0;for(let i=index-1;i>=0&&bundle[i]==='\\';i--)slashes++;return slashes%2===1;};
 let start=-1;for(let i=markerIndex;i>=0;i--)if(bundle[i]==='`'&&!escaped(i)){start=i;break;}if(start<0)return null;
 let end=-1;for(let i=start+1;i<bundle.length;i++)if(bundle[i]==='`'&&!escaped(i)){end=i;break;}if(end<0)return null;
 let decoded='';const body=bundle.slice(start+1,end);
 for(let i=0;i<body.length;i++){
  if(body[i]!=='\\'){decoded+=body[i];continue;}
  const next=body[++i];if(next===undefined)return null;
  if(next==='\n')continue;if(next==='\r'){if(body[i+1]==='\n')i++;continue;}
  const simple={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v',0:'\0','\\':'\\','"':'"',"'":"'",'`':'`'};
  if(Object.hasOwn(simple,next)){decoded+=simple[next];continue;}
  if(next==='x'){const hex=body.slice(i+1,i+3);if(!/^[a-f\d]{2}$/i.test(hex))return null;decoded+=String.fromCharCode(parseInt(hex,16));i+=2;continue;}
  if(next==='u'){
   if(body[i+1]==='{'){const close=body.indexOf('}',i+2),hex=body.slice(i+2,close);if(close<0||!/^[a-f\d]{1,6}$/i.test(hex))return null;decoded+=String.fromCodePoint(parseInt(hex,16));i=close;continue;}
   const hex=body.slice(i+1,i+5);if(!/^[a-f\d]{4}$/i.test(hex))return null;decoded+=String.fromCharCode(parseInt(hex,16));i+=4;continue;
  }
  decoded+=next;
 }
 return decoded;
}
const bytesOf=value=>Buffer.from(value);
const iconDataBytes=item=>item?.bin?bytesOf(item.bin):item?.generate?bytesOf(item.generate()):null;
const iconDimension=value=>value===0?256:value;
const normalizeVersion=value=>String(value??'').trim().replace(/^(\d+\.\d+\.\d+)\.0$/,'$1');
const normalizeLabel=value=>String(value??'').trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const normalizeFilename=value=>String(value??'').trim().replace(/\s+/g,'').toLowerCase();
function fixedVersion(ms,ls){return `${ms>>>16}.${ms&0xffff}.${ls>>>16}.${ls&0xffff}`;}
function inspectNativeExecutable(executableBytes,iconBytes){
 const executable=pe.NtExecutable.from(bytesOf(executableBytes),{ignoreCert:true}),resource=pe.NtExecutableResource.from(executable);
 const versions=resedit.Resource.VersionInfo.fromEntries(resource.entries).map(info=>{
  const strings=info.getAllLanguagesForStringValues().map(language=>({language,values:info.getStringValues(language)}));
  const fixed=info.fixedInfo;
  return{lang:info.lang,strings,fixed:{fileVersion:fixedVersion(fixed.fileVersionMS,fixed.fileVersionLS),productVersion:fixedVersion(fixed.productVersionMS,fixed.productVersionLS)}};
 });
 const reference=resedit.Data.IconFile.from(bytesOf(iconBytes)).icons.map(item=>({width:iconDimension(item.width??item.data.width),height:iconDimension(item.height??item.data.height),bitCount:item.data.bitCount??item.data.bitmapInfo?.bitCount,sha256:sha(iconDataBytes(item.data))}));
 const referenceBySize=new Map(reference.map(item=>[`${item.width}x${item.height}`,item]));
 const groups=resedit.Resource.IconGroupEntry.fromEntries(resource.entries).map(group=>{
  const items=group.getIconItemsFromEntries(resource.entries);
  const icons=group.icons.map((entry,index)=>{
   const width=iconDimension(entry.width),height=iconDimension(entry.height),item=items[index],digest=item?sha(iconDataBytes(item)):null;
   const expected=referenceBySize.get(`${width}x${height}`);
   return{width,height,bitCount:entry.bitCount,sha256:digest,sourceMatch:!!expected&&digest===expected.sha256};
  });
  return{id:group.id,lang:group.lang,icons};
 });
 return{versions,icons:{reference,groups}};
}
function evaluateNativeMetadata(inspected,{productName,version,originalFilename=''}){
 const versionBlocks=inspected.versions.flatMap(block=>block.strings.map(table=>({fixed:block.fixed,values:table.values})));
 const fieldMatches=(key,expected,normalize)=>versionBlocks.some(block=>Object.hasOwn(block.values,key)&&normalize(block.values[key])===normalize(expected));
 const expectedVersion=normalizeVersion(version);
 const metadata={
  fileDescription:fieldMatches('FileDescription',productName,normalizeLabel),
  productName:fieldMatches('ProductName',productName,normalizeLabel),
  originalFilename:fieldMatches('OriginalFilename',originalFilename,normalizeFilename),
  noElectronIdentity:versionBlocks.length>0&&versionBlocks.every(block=>normalizeLabel(block.values.FileDescription)!=='electron'&&normalizeLabel(block.values.ProductName)!=='electron'&&normalizeFilename(block.values.InternalName)!=='electron.exe'&&normalizeFilename(block.values.OriginalFilename)!=='electron.exe'),
  fileVersion:fieldMatches('FileVersion',expectedVersion,normalizeVersion)&&inspected.versions.some(block=>normalizeVersion(block.fixed.fileVersion)===expectedVersion),
  productVersion:fieldMatches('ProductVersion',expectedVersion,normalizeVersion)&&inspected.versions.some(block=>normalizeVersion(block.fixed.productVersion)===expectedVersion),
 };
 const requiredDimensions=['16x16','32x32','48x48','256x256'];
 const iconGroup=inspected.icons.groups.find(group=>requiredDimensions.every(size=>group.icons.some(icon=>`${icon.width}x${icon.height}`===size&&icon.sourceMatch))&&group.icons.every(icon=>icon.sourceMatch));
 return{metadata,icon:!!iconGroup,iconEvidence:{referenceIconCount:inspected.icons.reference.length,referenceDimensions:inspected.icons.reference.map(icon=>`${icon.width}x${icon.height}`),groups:inspected.icons.groups,matchedGroupId:iconGroup?.id??null,requiredDimensions},ok:Object.values(metadata).every(Boolean)&&!!iconGroup};
}
async function runOfflineViewer(resources,version,viewerManifest){
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'odradek-package-evidence-')),node=path.join(resources,'node','node.exe'),backend=path.join(resources,'backend','backend.mjs');
 let child,ready=null,stderr='';
 try{
  await fs.access(node);await fs.access(backend);
  child=fork(backend,[],{execPath:node,cwd:resources,windowsHide:true,silent:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'',ODRADEK_RESOURCE_ROOT:resources,ODRADEK_DATA_ROOT:temporary,ODRADEK_VIEWER_ROOT:path.join(resources,'viewer'),ODRADEK_APP_VERSION:version,ODRADEK_OFFLINE_LEARNING:'1',ODRADEK_PREVIEW_ONLY:'1',ODRADEK_EXTERNAL_OBSERVATION_URL:'http://192.0.2.1/observation',ODRADEK_TEST_PORTS:JSON.stringify({controller:0,studio:0,preview:0,appPreview:0})}});
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  ready=await new Promise((resolve,reject)=>{
   let buffered='';const timer=setTimeout(()=>reject(Error(`Offline packaged backend did not become ready: ${stderr}`)),12000);
   const fail=code=>{clearTimeout(timer);reject(Error(`Offline packaged backend exited ${code}: ${stderr}`));};child.once('exit',fail);
   child.stdout.on('data',chunk=>{buffered+=chunk.toString();const lines=buffered.split(/\r?\n/);buffered=lines.pop()??'';for(const line of lines){try{const value=JSON.parse(line);if(value.event==='ready'){clearTimeout(timer);child.off('exit',fail);resolve(value);return;}}catch{}}});
  });
  const base=ready.appPreview;if(!base?.startsWith('http://127.0.0.1:'))throw Error('Packaged backend did not report a loopback viewer.');
  const page=await fetch(`${base}/arm-manual/`,{redirect:'error',signal:AbortSignal.timeout(3000)});if(!page.ok)throw Error(`Viewer page returned ${page.status}.`);
  const html=await page.text();if(!html.includes('Odradek · Joint Manual'))throw Error('Packaged viewer page content is unexpected.');
  if(/<script[^>]+src=["']https?:\/\//i.test(html))throw Error('Viewer HTML includes an external script.');
  const workerName=viewerManifest.map(item=>path.basename(item.path)).find(name=>/^worker-[^/]+\.js$/i.test(name));
  if(!workerName)throw Error('Bundled learning worker asset is absent.');
  const response=await fetch(`${base}/assets/${workerName}`,{redirect:'error',signal:AbortSignal.timeout(3000)});
  const script=await response.text(),mime=response.headers.get('content-type')??'',csp=response.headers.get('content-security-policy')??'';
  if(!response.ok||!mime.toLowerCase().startsWith('text/javascript'))throw Error(`Worker asset response is not JavaScript (${response.status}, ${mime}).`);
  for(const directive of ["default-src 'self'","script-src 'self'","connect-src 'self'"])if(!csp.includes(directive))throw Error(`Worker asset CSP lacks ${directive}.`);
  if(!/onmessage/.test(script)||!script.length)throw Error('Bundled worker does not contain a message handler.');
  const observation=await(await fetch(`${base}/api/roarm/observation`,{redirect:'error',signal:AbortSignal.timeout(3000)})).json();
  if(observation.state!=='offline'||observation.source!==null||observation.pose!==null||observation.offlineLearning!==true)throw Error('Packaged offline observation is not fixed and offline.');
  const dataFiles=await walk(temporary);if(dataFiles.some(file=>sensitivePath(path.relative(temporary,file))))throw Error('Offline startup wrote protected application data.');
  return{ok:true,ready:{controller:ready.controller,studio:ready.studio,preview:ready.preview,offlineLearning:ready.offlineLearning},worker:{path:`viewer/assets/${workerName}`,sha256:sha(Buffer.from(script)),mime,cspSelf:true,loadedFromSameOrigin:true},dataFiles:dataFiles.map(file=>path.relative(temporary,file).replaceAll('\\','/'))};
 }finally{
  let shutdownFailure=null;
  if(child&&child.exitCode===null&&child.signalCode===null){
   try{
    child.send({type:'shutdown'});
    let timer,onExit;const exited=new Promise(resolve=>{onExit=()=>resolve(true);child.once('exit',onExit);}),timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000);});
    const clean=await Promise.race([exited,timeout]);clearTimeout(timer);child.off('exit',onExit);
    if(!clean)shutdownFailure=Error('Packaged offline backend did not shut down cleanly.');
   }catch(error){shutdownFailure=error;}
  }
  await fs.rm(temporary,{recursive:true,force:true});
  if(shutdownFailure)throw shutdownFailure;
 }
}

async function main(){
 const resources=path.join(candidate,'resources'),asarPath=path.join(resources,'app.asar'),exe=path.join(candidate,'Odradek Studio.exe'),asarEntries=asar.listPackage(asarPath,{isPack:false}).map(value=>value.replaceAll('\\','/').replace(/^\//,''));
 const sourcePackage=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')),packagedPackage=JSON.parse(asar.extractFile(asarPath,'package.json').toString('utf8'));
 const sourceAppFiles=['main.cjs','preload.cjs','workspace.cjs','supervisor.cjs','service-restart.cjs','learning-save.cjs'];
 const appMatches=[];
 for(const name of sourceAppFiles){const source=await fs.readFile(path.join(root,'desktop',name)),packaged=asar.extractFile(asarPath,`desktop/${name}`);appMatches.push({path:`desktop/${name}`,sourceSha256:sha(source),packagedSha256:sha(packaged),match:source.equals(packaged)});}
 check('asar-main-files-match-source',appMatches.every(item=>item.match),{files:appMatches});
 const sourcePackageBytes=await fs.readFile(path.join(root,'package.json')),packagedPackageBytes=asar.extractFile(asarPath,'package.json');
 check('package-version-matches-source',sourcePackage.version===packagedPackage.version&&sourcePackage.productName===packagedPackage.productName&&sourcePackage.main===packagedPackage.main,{source:sourcePackage.version,packaged:packagedPackage.version,sourceSha256:sha(sourcePackageBytes),packagedSha256:sha(packagedPackageBytes),semanticFields:['version','productName','main']});
 const backendFiles=['backend.mjs','preview-server.mjs'],backendMatches=[];
 for(const name of backendFiles){const source=await fs.readFile(path.join(root,'desktop',name)),packaged=await fs.readFile(path.join(resources,'backend',name));backendMatches.push({path:`backend/${name}`,sourceSha256:sha(source),packagedSha256:sha(packaged),match:source.equals(packaged)});}
 check('backend-modules-match-source',backendMatches.every(item=>item.match),{files:backendMatches});
 const sourceViewer=path.join(root,'dist'),packagedViewer=path.join(resources,'viewer'),sourceFiles=await walk(sourceViewer),packagedFiles=await walk(packagedViewer),sourceNames=sourceFiles.map(file=>path.relative(sourceViewer,file).replaceAll('\\','/')),packagedNames=packagedFiles.map(file=>path.relative(packagedViewer,file).replaceAll('\\','/')),viewerMatches=[];
 for(const relative of [...new Set([...sourceNames,...packagedNames])].sort()){
  const source=sourceNames.includes(relative)?await fs.readFile(path.join(sourceViewer,relative)):null,packaged=packagedNames.includes(relative)?await fs.readFile(path.join(packagedViewer,relative)):null;
  viewerMatches.push({path:relative,match:!!source&&!!packaged&&source.equals(packaged),sourceSha256:source?sha(source):null,packagedSha256:packaged?sha(packaged):null});
 }
 const viewerManifest=viewerMatches.filter(item=>item.match).map(item=>({path:item.path,sha256:item.packagedSha256}));
 check('viewer-assets-match-dist',viewerMatches.every(item=>item.match),{fileCount:viewerMatches.length,manifestSha256:sha(Buffer.from(JSON.stringify(viewerManifest))),mismatches:viewerMatches.filter(item=>!item.match)});
 try{
  const inputBytes=await fs.readFile(path.join(packagedViewer,'odradek-build.json')),inputManifest=JSON.parse(inputBytes.toString('utf8')),verification=await verifyViewerSourceManifest(inputManifest,{root});
  check('viewer-build-inputs-match-current-source',verification.ok,{schema:inputManifest.schema,fileCount:inputManifest.files?.length,sha256:sha(inputBytes),missing:verification.missing,added:verification.added,changed:verification.changed,metadataChanged:verification.metadataChanged,malformed:verification.malformed,duplicates:verification.duplicates});
 }catch(error){check('viewer-build-inputs-match-current-source',false,{error:String(error.message??error).slice(0,1000)});}
 const demoText=await fs.readFile(path.join(root,'assets','learning','stylus-example-v1.json'),'utf8'),demo=JSON.parse(demoText),bundles=await Promise.all(packagedFiles.filter(file=>/\.js$/i.test(file)).map(file=>fs.readFile(file,'utf8'))),embedded=bundles.map(bundle=>extractEmbeddedString(bundle,demo.id)).find(value=>typeof value==='string'&&value.includes(demo.id));
 let embeddedRun=null;try{if(embedded)embeddedRun=JSON.parse(embedded);}catch{}
 const demoOk=!!embeddedRun&&embeddedRun.id===demo.id&&embeddedRun.generationLimit===800&&embeddedRun.history?.at(-1)?.generation===800&&embeddedRun.snapshots?.length===82&&embedded===demoText;
 check('bundled-demo-is-82-snapshot-800-generation-run',demoOk,{id:demo.id,expected:{generations:800,snapshots:82},actual:embeddedRun?{generations:embeddedRun.history?.at(-1)?.generation,snapshots:embeddedRun.snapshots?.length}:null,sha256:embedded?sha(Buffer.from(embedded)):null});
 const exampleManifest=JSON.parse(await fs.readFile(path.join(root,'assets/learning/examples.json'),'utf8'));
 for(const entry of exampleManifest.examples){
  const text=await fs.readFile(path.join(root,'assets/learning',entry.file),'utf8'),run=parseLearningRun(text),embedded=bundles.map(bundle=>extractEmbeddedString(bundle,run.id)).find(value=>typeof value==='string'&&value.includes(run.id));
  check(`bundled-example-${entry.file}`,sha(Buffer.from(text))===entry.sha256&&Buffer.byteLength(text)===entry.bytes&&embedded===text&&run.history.length===entry.generations&&run.snapshots.length===entry.snapshots,{file:entry.file,sha256:entry.sha256,generations:run.history.length,snapshots:run.snapshots.length});
 }
 const resourceFiles=await walk(resources),asarPrivate=asarEntries.filter(sensitivePath),resourcePrivate=resourceFiles.map(file=>path.relative(resources,file).replaceAll('\\','/')).filter(sensitivePath);
 check('no-private-runtime-data-in-package',!asarPrivate.length&&!resourcePrivate.length,{asarMatches:asarPrivate,resourceMatches:resourcePrivate,resourceFileCount:resourceFiles.length});
 const provenance=JSON.parse(await fs.readFile(path.join(candidate,'resources','provenance.json'),'utf8')),provenanceArm=new Map(provenance.files.filter(item=>item.component==='waveshare-robotic-arm').map(item=>[item.path.replaceAll('\\','/'),item.sha256]));
 const testFiles=resourceFiles.map(file=>({file,relative:path.relative(resources,file).replaceAll('\\','/')})).filter(item=>/^apps\/waveshare-robotic-arm\/test\//.test(item.relative)),preservedTests=[],unexpectedTests=[];
 for(const item of testFiles){const upstreamPath=item.relative.replace(/^apps\/waveshare-robotic-arm\//,'');const hash=await fileHash(item.file);if(provenanceArm.get(upstreamPath)===hash)preservedTests.push(upstreamPath);else unexpectedTests.push({path:item.relative,sha256:hash,provenanceSha256:provenanceArm.get(upstreamPath)??null});}
 const testLibraryPatterns=[/^(?:jest|vitest|mocha|chai|nyc|c8|tap|ava|playwright|puppeteer|jsdom|happy-dom|fake-indexeddb)(?:-|$)/i,/^@testing-library\//i];
 const dependencyManifests=resourceFiles.filter(file=>/node_modules[\\/]/i.test(file)&&path.basename(file)==='package.json'),testLibraries=[];
 for(const file of dependencyManifests){try{const pkg=JSON.parse(await fs.readFile(file,'utf8'));if(testLibraryPatterns.some(pattern=>pattern.test(pkg.name??'')))testLibraries.push(pkg.name);}catch{}}
 const unexpectedAsarTests=asarEntries.filter(file=>/(^|\/)(?:test|tests|__tests__|fixtures)(\/|$)/i.test(file));
 const fixtureFiles=resourceFiles.map(file=>({file,relative:path.relative(resources,file).replaceAll('\\','/')})).filter(item=>/(^|\/)(?:fixtures?|testdata)(\/|$)/i.test(item.relative)),unprovenancedFixtures=[];
 for(const item of fixtureFiles){const upstreamPath=item.relative.replace(/^apps\/waveshare-robotic-arm\//,'');if(!provenanceArm.has(upstreamPath))unprovenancedFixtures.push(item.relative);}
 const packagedProvenance=await fs.readFile(path.join(resources,'provenance.json')),sourceProvenance=await fs.readFile(path.join(root,'provenance.json'));
 check('preserved-provenance-matches-source',packagedProvenance.equals(sourceProvenance),{sha256:sha(packagedProvenance)});
 check('only-preserved-upstream-tests-and-no-test-libraries',!unexpectedTests.length&&!unexpectedAsarTests.length&&!testLibraries.length,{preservedSourceTestCount:preservedTests.length,provenanceMatched:true,samplePaths:preservedTests.slice(0,5),unexpectedResourceTests:unexpectedTests,unexpectedAsarTests,testLibraries});
 check('no-unprovenanced-fixtures',unprovenancedFixtures.length===0,{preservedFixtureCount:fixtureFiles.length,unprovenancedFixtures});
 const binaryPaths={app:path.join(candidate,'Odradek Studio.exe'),node:path.join(resources,'node','node.exe'),asar:asarPath};
 const binaries={};for(const [name,file] of Object.entries(binaryPaths)){const stat=await fs.stat(file);binaries[name]={path:path.relative(root,file).replaceAll('\\','/'),bytes:stat.size,sha256:await fileHash(file)};}
 const expectedIconPath=sourcePackage.build?.win?.icon;if(!expectedIconPath)throw Error('The Windows application icon is not configured in package.json.');
 const nativeInspection=inspectNativeExecutable(await fs.readFile(binaryPaths.app),await fs.readFile(path.join(root,expectedIconPath)));
 const builderVersion=require('app-builder-lib/package.json').version,nativeResult=evaluateNativeMetadata(nativeInspection,{productName:sourcePackage.productName,version:sourcePackage.version,originalFilename:''});
 for(const [name,ok] of Object.entries(nativeResult.metadata))check(name==='originalFilename'?'native-executable-originalFilename-empty-per-builder':`native-executable-${name}`,ok,{expected:{productName:sourcePackage.productName,version:sourcePackage.version,originalFilename:''},policy:name==='originalFilename'?`app-builder-lib ${builderVersion} clears OriginalFilename when it sets InternalName in winPackager.js`:'',resources:nativeInspection.versions});
 check('native-executable-icon-matches-committed-ico',nativeResult.icon,nativeResult.iconEvidence);
 let runtimeInfo=null;try{runtimeInfo=JSON.parse(await fs.readFile(path.join(resources,'node','runtime.json'),'utf8'));}catch{}
 let offline=null;const verificationSkips=[];
 if(skipOfflineViewer){verificationSkips.push('packaged-offline-viewer-worker-csp');}
 else try{offline=await runOfflineViewer(resources,packagedPackage.version,viewerManifest);check('packaged-offline-viewer-worker-csp',offline.ok,offline);}
 catch(error){offline={ok:false,error:String(error.message??error)};check('packaged-offline-viewer-worker-csp',false,offline);}
 const receipt={schema:'odradek-learning-package-evidence-v2',verifiedAt:new Date().toISOString(),candidate:path.relative(root,candidate).replaceAll('\\','/'),version:sourcePackage.version,electronVersion:require('electron/package.json').version,appBuilderLibVersion:builderVersion,packagedNodeVersion:runtimeInfo?.version??null,binaries,nativeExecutable:{resourceVersions:nativeInspection.versions,metadataExpectations:{originalFilename:'empty by app-builder-lib when InternalName is supplied'},metadataChecks:nativeResult.metadata,icon:nativeResult.iconEvidence},checks,verificationSkips,offlineViewer:offline,metadataLimitations:{nativeExecutableVersionResource:'inspected with PE resource parser; strings and fixed version fields checked',nativeExecutableIcon:'embedded group dimensions and image bytes compared with configured committed ICO',codeSignature:'not inspected',electronExecutableNotLaunched:true,electronBuilderResourceEditing:{signExecutable:sourcePackage.build?.win?.signExecutable??true,signAndEditExecutable:sourcePackage.build?.win?.signAndEditExecutable??true}}};
 console.log(JSON.stringify(receipt));if(checks.some(item=>!item.ok))process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.log(JSON.stringify({schema:'odradek-learning-package-evidence-v2',candidate:path.relative(root,candidate).replaceAll('\\','/'),ok:false,error:String(error.stack??error)}));process.exitCode=1;});
export {evaluateNativeMetadata,inspectNativeExecutable,normalizeVersion};

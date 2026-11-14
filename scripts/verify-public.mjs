import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const omitted=new Set(['.git','node_modules','dist','release','vendor','.cache']);
const forbidden=new Set(['records','research','runtime','appdata','credentials','secrets','plans','evidence','firmware-candidates','camera-roll','photos']);
const privateFiles=new Set(['access.json','private-access.json','movement-history.json','application.log','camera.json','motion.json']);
export async function inspectPublicTree(directory=root){
 const failures=[],files=[];
 async function walk(relative=''){
  for(const entry of await fs.readdir(path.join(directory,relative),{withFileTypes:true})){
   const name=path.posix.join(relative,entry.name),lower=entry.name.toLowerCase();
   if(entry.isSymbolicLink()){failures.push({path:name,reason:'symbolic link'});continue;}
   if(entry.isDirectory()){if(forbidden.has(lower))failures.push({path:name,reason:'private development directory'});else if(!omitted.has(lower))await walk(name);continue;}
   if(privateFiles.has(lower)||lower.startsWith('.env')||/\.(?:pem|p12|pfx|key|heic|heif|bundle|log)$/i.test(lower))failures.push({path:name,reason:'private or machine-specific file'});
   files.push(name);
   if(/\.(?:mjs|cjs|js|json|html|css|svg|md|txt|yml|py|nsh|bbmodel)$/i.test(name)){
    const text=await fs.readFile(path.join(directory,name),'utf8');
    if(/(?:[A-Z]:[\\/]+Users[\\/]+marti(?:[\\/]|\b)|\/Users\/marti(?:\/|\b)|Setup Draft \(1\)\.png|hc-ping\.com\/[^\s"'<>]{12,}|(?:ghp|github_pat)_[A-Za-z0-9_]{30,})/i.test(text))failures.push({path:name,reason:'private path, source-photo name, or credential-like content'});
   }
  }
 }
 await walk();return{ok:failures.length===0,fileCount:files.length,failures};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const result=await inspectPublicTree();console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}

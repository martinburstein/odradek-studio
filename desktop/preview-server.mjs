import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
export async function createPreviewServer({directory,port=5274,version='0.2.0',readObservation=async()=>({state:'offline',source:null,pose:null,observedAt:null})}){
 const root=await fs.realpath(directory);
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{'Allow':'GET, HEAD'}).end();return;}
   const url=new URL(req.url,'http://127.0.0.1');
   if(url.pathname==='/api/health'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({application:'odradek-lab-preview',version,previewOnly:true}));return;}
   if(url.pathname==='/api/roarm/observation'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(await readObservation()));return;}
   let pathname=decodeURIComponent(url.pathname);
   if(pathname.split(/[\\/]/).some(part=>part==='..')){res.writeHead(403).end();return;}
   if(pathname==='/'||pathname==='/arm-manual'||pathname==='/arm-manual/')pathname='/arm-manual/index.html';
   if(!pathname.startsWith('/assets/')&&pathname!=='/arm-manual/index.html'){res.writeHead(404).end();return;}
   const file=path.resolve(root,'.'+pathname);
   if(!file.startsWith(root+path.sep)||!(await fs.realpath(file)).startsWith(root+path.sep)){res.writeHead(403).end();return;}
   const bytes=await fs.readFile(file);
   res.writeHead(200,{'content-type':types[path.extname(file)]??'application/octet-stream','cache-control':pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-store','x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors http://127.0.0.1:8790; base-uri 'none'; object-src 'none'"});
   res.end(req.method==='HEAD'?undefined:bytes);
  }catch(error){res.writeHead(error.code==='ENOENT'?404:400).end('Preview asset unavailable');}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return {url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}

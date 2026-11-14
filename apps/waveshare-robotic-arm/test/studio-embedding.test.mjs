import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createServer} from '../src/server.mjs';

function proxyPage(url,route,origin){
 return new Promise((resolve,reject)=>{
  const request=http.get(url+route,{headers:{Host:new URL(origin).host,'X-Forwarded-Proto':'https'}},response=>{
   response.resume();response.once('end',()=>resolve({status:response.statusCode,headers:response.headers}));
  });
  request.once('error',reject);
 });
}

test('only the local Studio views permit embedding, with working local session reads',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'roarm-studio-embedding-'));
 const privateOrigin='https://studio-test.example.ts.net';
 const app=await createServer({directory,port:0,privateOrigin});
 t.after(async()=>{await app.close();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true});});
 for(const view of ['manual','automatic']){
  const route=`/studio/${view}/index.html`;
  const response=await fetch(app.url+route);
  assert.equal(response.status,200);
  const html=await response.text();if(view==='manual')assert.match(html,/<button[^>]+id="open-repair"[^>]*>Review &amp; repair position<\/button>/);
  const csp=response.headers.get('content-security-policy');
  assert.match(csp,/frame-ancestors http:\/\/127\.0\.0\.1:8790;/);
  assert.doesNotMatch(csp,/frame-ancestors[^;]*(?:\*|localhost|https:)/);
  assert.match(csp,/connect-src 'self';/);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const session=await fetch(app.url+'/api/session',{headers:{Cookie:cookie}});
  assert.equal(session.status,200);
  assert.equal((await session.json()).role,'admin');
  assert.equal((await fetch(app.url+'/api/status',{headers:{Cookie:cookie,Origin:'http://127.0.0.1:8790'}})).status,403,'embedding must not allow parent-origin API requests');
  const proxied=await proxyPage(app.url,route,privateOrigin);
  assert.equal(proxied.status,200);
  assert.match(proxied.headers['content-security-policy'],/frame-ancestors 'none';/);
  assert.equal(proxied.headers['set-cookie'],undefined);
 }
 for(const route of ['/','/manual/index.html','/sync/index.html','/studio/theme.css']){
  const response=await fetch(app.url+route);
  assert.equal(response.status,200,route);
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none';/,route);
 }
 assert.equal(app.controller.connected,false);
 assert.equal(app.controller.armed,false);
});

import {isAllowedHost} from './transport.mjs';
const MAX_BYTES=2*1024*1024;
const IMAGE_TYPES=new Set(['image/jpeg','image/png','image/webp']);

export function validateCameraSource(config) {
 if(config===undefined||config===null)return null;
 if(config.verified!==true||typeof config.url!=='string')throw Error('Camera source requires an explicitly verified private snapshot URL');
 const url=new URL(config.url);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search||!isAllowedHost(url.hostname))throw Error('Camera source must use a literal private address without embedded credentials or query secrets');
 return url.href;
}

export function createCameraSource(config,{fetchImpl=fetch,timeoutMs=2500}={}) {
 const url=validateCameraSource(config);
 let busy=false;
 return {
  configured:Boolean(url),
  async snapshot({signal}={}) {
   if(!url)throw Error('Camera is not configured');
   signal?.throwIfAborted();
   if(busy)throw Error('Camera observation is already in progress');
   busy=true;
   let response;
   try{
   const deadline=AbortSignal.timeout(timeoutMs);
   response=await fetchImpl(url,{redirect:'error',signal:signal?AbortSignal.any([signal,deadline]):deadline,headers:{Accept:'image/jpeg, image/png, image/webp'}});
   if(!response.ok)throw Error('Configured camera snapshot failed');
   const type=response.headers.get('content-type')?.split(';')[0]?.toLowerCase();
   if(!IMAGE_TYPES.has(type)){await response.body?.cancel();throw Error('Camera endpoint must return a JPEG, PNG or WebP snapshot');}
   const length=Number(response.headers.get('content-length'));
   if(Number.isFinite(length)&&length>MAX_BYTES){await response.body?.cancel();throw Error('Camera image exceeds the bounded size');}
   const chunks=[];let size=0;
   if(!response.body)throw Error('Camera image is empty');
   for await(const chunk of response.body){size+=chunk.byteLength;if(size>MAX_BYTES)throw Error('Camera image exceeds the bounded size');chunks.push(Buffer.from(chunk));}
   if(!size)throw Error('Camera image is empty');
   return {bytes:Buffer.concat(chunks),type,receivedAt:new Date().toISOString()};
   }catch(error){if(response?.body&&!response.bodyUsed)await response.body.cancel().catch(()=>{});throw error;}finally{busy=false;}
  }
 };
}

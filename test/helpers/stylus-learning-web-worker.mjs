import {Worker as NodeWorker} from 'node:worker_threads';

// Runs the actual browser worker module in a node:worker_threads isolate and
// supplies only the Web Worker self/postMessage/onmessage bridge it needs.
export class StylusLearningWorkerBridge{
 constructor(moduleUrl){
  const url=moduleUrl instanceof URL?moduleUrl.href:String(moduleUrl);
  const bootstrap=`(async()=>{const {parentPort}=await import('node:worker_threads');globalThis.self={postMessage:value=>parentPort.postMessage(value)};await import(${JSON.stringify(url)});parentPort.on('message',data=>self.onmessage({data}));})().catch(error=>{throw error;});`;
  this.worker=new NodeWorker(bootstrap,{eval:true});
  this.worker.on('message',data=>this.onmessage?.({data}));
  this.worker.on('error',error=>this.onerror?.(error));
 }
 postMessage(message){this.worker.postMessage(message);}
 terminate(){return this.worker.terminate();}
}

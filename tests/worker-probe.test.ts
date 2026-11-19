import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { runWorker } from '../src/worker.ts';
import { createBatch,parseInput } from '../src/core.ts';
import type { Adapter,Actual,Batch,Identity } from '../src/types.ts';
import type { Command,Job,Report } from '../src/protocol.ts';

const prefix='abc:v1:',workerId='12345678-1234-1234-1234-123456789abc';
const identity:Identity={publisherId:'pub-1234567890123456',appId:'ca-app-pub-1234567890123456~1234567890',appName:'Probe app',evidence:[]};
const clone=<T>(value:T):T=>value===undefined?value:structuredClone(value);
const drain=async()=>{for(let i=0;i<3;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function globals(t:TestContext,values:Record<string,unknown>):void{
  for(const [key,value] of Object.entries(values)){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});
  }
}
function environment(t:TestContext,command:Command,autoAck=false){
  const dom=new JSDOM('<!doctype html><body></body>',{url:'https://admob.google.com/v2/apps/1234567890/adunits/list'});
  const nativeClose=dom.window.close.bind(dom.window);let closes=0;
  t.mock.method(dom.window,'close',()=>{closes++;});t.after(nativeClose);
  const storage=new Map<string,unknown>([[prefix+'command:'+workerId,clone(command)]]);
  const listeners=new Map<number,{key:string;callback:(key:string,old:unknown,value:unknown,remote:boolean)=>void}>();
  const intervals=new Map<number,()=>void>();const held=new Set<string>();let listenerId=0,timerId=0;
  const read=<T>(key:string,fallback?:T):T=>clone((storage.has(key)?storage.get(key):fallback) as T);
  const write=(key:string,value:unknown):void=>{
    const old=read(key);storage.set(key,clone(value));
    for(const listener of [...listeners.values()])if(listener.key===key)listener.callback(key,old,clone(value),true);
    const report=value as Report;
    if(autoAck && key===prefix+'report:'+workerId && report.assignmentId){
      const current=read<Command>(prefix+'command:'+workerId,{seq:0});
      write(prefix+'command:'+workerId,{...current,seq:current.seq+1,ack:report.id,...(report.type==='intent'?{grant:{assignmentId:report.assignmentId,expires:Date.now()+10000}}:{})} satisfies Command);
    }
  };
  globals(t,{
    window:dom.window,document:dom.window.document,
    navigator:{locks:{request(name:string,_options:unknown,callback:(lock:{name:string}|null)=>unknown){
      if(held.has(name))return Promise.resolve(callback(null));
      held.add(name);return Promise.resolve(callback({name})).finally(()=>{held.delete(name);});
    }}},
    GM_getValue:read,GM_setValue:write,GM_deleteValue:(key:string)=>storage.delete(key),
    GM_addValueChangeListener:(key:string,callback:(key:string,old:unknown,value:unknown,remote:boolean)=>void)=>{const id=++listenerId;listeners.set(id,{key,callback});return id;},
    GM_removeValueChangeListener:(id:number)=>{listeners.delete(id);},
  });
  t.mock.method(globalThis,'setInterval',((callback:()=>void)=>{const id=++timerId;intervals.set(id,callback);return id;}) as unknown as typeof setInterval);
  t.mock.method(globalThis,'clearInterval',((id:number)=>{intervals.delete(id);}) as unknown as typeof clearInterval);
  const adapter:Adapter={identify:async()=>clone(identity),home:async()=>{},lookup:async()=>({complete:true,matches:[]}),prepare:async()=>{},submit:async guard=>{guard?.();},verify:async()=>{throw new Error('probe must never verify an ad unit');},diagnostics:()=>({})};
  return{storage,listeners,intervals,held,adapter,write,read,closes:()=>closes};
}

test('startup hello skips identity reading; the second challenge identifies and close releases all diagnostic resources',async t=>{
  const f=environment(t,{seq:1,probe:{nonce:'startup',lockName:'probe-lock',identify:false}});f.held.add('probe-lock');
  let identityReads=0;f.adapter.identify=async()=>{identityReads++;return clone(identity);};
  await runWorker(workerId,f.adapter);
  const first=f.read<Report>(prefix+'report:'+workerId);
  assert.equal(first.type,'hello');assert.equal(first.probe!.nonce,'startup');assert.equal(first.probe!.locked,true);
  assert.equal(first.probe!.identity,undefined);assert.equal(first.probe!.notifications,false);assert.equal(identityReads,0);
  f.write(prefix+'command:'+workerId,{seq:2,probe:{nonce:'identity',lockName:'probe-lock',identify:true}} satisfies Command);await drain();
  const second=f.read<Report>(prefix+'report:'+workerId);
  assert.equal(identityReads,1);assert.deepEqual(second.probe!.identity,identity);assert.equal(second.probe!.notifications,true);
  f.write(prefix+'command:'+workerId,{seq:3,close:true} satisfies Command);await drain();
  assert.equal(f.read<Report>(prefix+'report:'+workerId).type,'closed');assert.equal(f.closes(),1);
  assert.equal(f.listeners.size,0);assert.equal(f.intervals.size,0);assert.equal(f.held.has('admob-batch-worker:'+workerId),false);
});

test('closing during a slow identity read prevents its late hello from recreating cleaned mailboxes',async t=>{
  const f=environment(t,{seq:1,probe:{nonce:'startup',lockName:'probe-lock',identify:false}});
  const waiting=deferred(),releaseIdentity=deferred();
  f.adapter.identify=async()=>{waiting.resolve();await releaseIdentity.promise;return clone(identity);};
  await runWorker(workerId,f.adapter);
  f.write(prefix+'command:'+workerId,{seq:2,probe:{nonce:'slow',lockName:'probe-lock',identify:true}} satisfies Command);await waiting.promise;
  f.write(prefix+'command:'+workerId,{seq:3,close:true} satisfies Command);await drain();
  assert.equal(f.read<Report>(prefix+'report:'+workerId).type,'closed');assert.equal(f.closes(),1);
  f.storage.delete(prefix+'command:'+workerId);f.storage.delete(prefix+'report:'+workerId);
  releaseIdentity.resolve();await drain();
  assert.equal(f.storage.has(prefix+'report:'+workerId),false);assert.equal(f.listeners.size,0);assert.equal(f.intervals.size,0);
});

test('a diagnostic close waits until the real job has a durable ID and terminal ACK',async t=>{
  const batch=createBatch(parseInput('Unit,60'),identity,'interstitial',1,'tabs','https://admob.google.com/','controller');batch.phase='running';
  const task=batch.tasks[0];task.assignmentId='assignment';task.workerId=workerId;
  const job:Job={batch:clone(batch),task:clone(task),assignmentId:task.assignmentId,workerId,kind:'create'};
  const f=environment(t,{seq:1,job},true);
  f.storage.set(prefix+'batch:'+identity.publisherId+':'+identity.appId+':'+batch.id,clone(batch) satisfies Batch);
  const prepared=deferred(),continueJob=deferred();let submissions=0;
  f.adapter.prepare=async()=>{prepared.resolve();await continueJob.promise;};
  f.adapter.submit=async guard=>{guard?.();submissions++;};
  f.adapter.verify=async()=>({...identity,name:task.name,unitId:'ca-app-pub-1234567890123456/1234567890',format:'interstitial',mode:'manual',floor:'60',currency:'USD',verified:true} satisfies Actual);
  const running=runWorker(workerId,f.adapter);await prepared.promise;
  f.write(prefix+'command:'+workerId,{seq:3,close:true} satisfies Command);await drain();
  assert.equal(f.closes(),0);assert.equal(f.listeners.size,1);assert.equal(f.held.has('admob-batch-worker:'+workerId),true);
  continueJob.resolve();await running;
  assert.equal(submissions,1);
  const journal=f.read<{state:string;report:Report}>(prefix+'journal:'+job.assignmentId);
  assert.equal(journal.state,'done');assert.equal(journal.report.status,'success');
  assert.equal(f.read<Report>(prefix+'report:'+workerId).type,'closed');assert.equal(f.closes(),1);
});

import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { performJob, runWorker } from '../src/worker.ts';
import { createBatch, parseInput } from '../src/core.ts';
import type { Actual, Adapter, Batch, Identity } from '../src/types.ts';
import type { Command, Job, Journal, Report } from '../src/protocol.ts';

const prefix='abc:v1:',workerId='worker-handoff';
const identity:Identity={publisherId:'pub-1234567890123456',appId:'ca-app-pub-1234567890123456~1234567890',appName:'Worker fixture',evidence:[]};
const clone=<T>(value:T):T=>value===undefined?value:structuredClone(value);
const drain=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function environment(t:TestContext){
  const dom=new JSDOM('<!doctype html><body></body>',{url:'https://admob.google.com/v2/apps/1234567890/adunits/list',pretendToBeVisual:true});
  t.after(()=>dom.window.close());
  let visibility:DocumentVisibilityState='visible',closes=0;
  Object.defineProperty(dom.window.document,'visibilityState',{configurable:true,get:()=>visibility});
  const nativeClose=dom.window.close.bind(dom.window);
  t.mock.method(dom.window,'close',()=>{closes++;});
  t.after(nativeClose);
  t.mock.method(dom.window,'focus',()=>{});
  const storage=new Map<string,unknown>(),listeners=new Map<number,{key:string;callback:()=>void}>();
  const intervals=new Map<number,()=>void>();let listenerId=0,timerId=0;
  const batch=createBatch(parseInput('ROW_A,60\nROW_B,70'),identity,'interstitial',2,'tabs','https://admob.google.com/','controller');
  batch.phase='running';
  for(const [index,task] of batch.tasks.entries()){task.assignmentId='assignment-'+index;task.workerId=workerId;task.attempts=1;}
  const jobs=batch.tasks.map(task=>({batch:clone(batch),task:clone(task),assignmentId:task.assignmentId!,workerId,kind:'create' as const}));
  const reports:Report[]=[],commands:Command[]=[];
  const state={autoAckTerminal:true,onReport:undefined as ((report:Report)=>void)|undefined};
  const read=<T>(key:string,fallback?:T):T=>clone((storage.has(key)?storage.get(key):fallback) as T);
  const write=(key:string,value:unknown):void=>{
    storage.set(key,clone(value));
    if(key===prefix+'command:'+workerId)commands.push(clone(value as Command));
    for(const listener of [...listeners.values()])if(listener.key===key)listener.callback();
    if(key!==prefix+'report:'+workerId)return;
    const report=value as Report;reports.push(clone(report));
    if(report.type==='intent' || state.autoAckTerminal && ['result','error'].includes(report.type)){
      const command=read<Command>(prefix+'command:'+workerId,{seq:0});
      write(prefix+'command:'+workerId,{...command,seq:command.seq+1,ack:report.id,...(report.type==='intent'?{grant:{assignmentId:report.assignmentId!,expires:Date.now()+10000}}:{})} satisfies Command);
    }
    state.onReport?.(clone(report));
  };
  const held=new Set<string>();
  const values={
    document:dom.window.document,window:dom.window,
    navigator:{locks:{request(name:string,_options:unknown,callback:(lock:unknown)=>unknown){
      if(held.has(name))return Promise.resolve(callback(null));
      held.add(name);return Promise.resolve(callback({name})).finally(()=>held.delete(name));
    }}},
    GM_getValue:read,GM_setValue:write,GM_deleteValue:(key:string)=>storage.delete(key),
    GM_addValueChangeListener:(key:string,callback:()=>void)=>{const id=++listenerId;listeners.set(id,{key,callback});return id;},
    GM_removeValueChangeListener:(id:number)=>listeners.delete(id),
  };
  for(const [key,value] of Object.entries(values)){
    const previous=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else Reflect.deleteProperty(globalThis,key);});
  }
  t.mock.method(globalThis,'setInterval',((callback:()=>void)=>{const id=++timerId;intervals.set(id,callback);return id;}) as unknown as typeof setInterval);
  t.mock.method(globalThis,'clearInterval',((id:number)=>intervals.delete(id)) as unknown as typeof clearInterval);
  const actual=(name:string):Actual=>({...identity,name,unitId:'ca-app-pub-1234567890123456/'+(name==='ROW_B'?'1234567891':'1234567890'),format:'interstitial',mode:'manual',floor:name==='ROW_B'?'70':'60',currency:'USD',verified:true});
  let preparations=0,submissions=0,verifications=0,currentName='ROW_A';
  const adapter:Adapter={
    identify:async()=>clone(identity),home:async()=>{},lookup:async()=>({complete:true,matches:[]}),diagnostics:()=>({}),
    prepare:async(_identity,_format,name)=>{preparations++;currentName=name;},
    submit:async guard=>{guard?.();submissions++;},
    waitForUnitId:async()=>actual(currentName).unitId,
    verify:async(_identity,_format,name)=>{verifications++;return actual(name);},
    verifyById:async(_identity,_id,name)=>{verifications++;return actual(name);},
  };
  const batchKey=prefix+'batch:'+identity.publisherId+':'+identity.appId+':'+batch.id;
  storage.set(batchKey,clone(batch));
  return {dom,batch,jobs,batchKey,adapter,actual,storage,read,write,reports,commands,state,listeners,intervals,
    visibility(value:DocumentVisibilityState){visibility=value;dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));},
    counts:()=>({preparations,submissions,verifications}),closes:()=>closes};
}

test('a command delivered with the previous terminal ACK starts without any interval tick',async t=>{
  const f=environment(t),nextStarted=deferred();
  let knownIdVerifications=0;
  const second:Job={...f.jobs[1],kind:'verify',task:{...f.jobs[1].task,actual:{...f.actual('ROW_B'),verified:false}}};
  f.adapter.verifyById=async()=>{knownIdVerifications++;nextStarted.resolve();return f.actual('ROW_B');};
  f.state.onReport=report=>{
    if(report.assignmentId===f.jobs[0].assignmentId && report.type==='result'){
      const command=f.read<Command>(prefix+'command:'+workerId);
      f.write(prefix+'command:'+workerId,{seq:command.seq+1,job:second,ack:report.id} satisfies Command);
    }
  };
  f.write(prefix+'command:'+workerId,{seq:1,job:f.jobs[0]} satisfies Command);
  await runWorker(workerId,f.adapter);await nextStarted.promise;await drain();
  assert.equal(f.counts().submissions,1);
  assert.equal(f.counts().verifications+knownIdVerifications,2);
  assert.equal(f.read<Journal>(prefix+'journal:'+second.assignmentId).report?.status,'success');
  assert.ok(f.intervals.size>0,'background intervals exist but were never invoked');
});

test('a challenge arriving during the previous hello is drained without polling',async t=>{
  const f=environment(t),secondHello=deferred();
  f.state.onReport=report=>{
    if(report.type==='hello' && report.probe?.nonce==='first')f.write(prefix+'command:'+workerId,{seq:2,probe:{nonce:'second',lockName:'probe-lock',identify:true}} satisfies Command);
    if(report.type==='hello' && report.probe?.nonce==='second')secondHello.resolve();
  };
  f.write(prefix+'command:'+workerId,{seq:1,probe:{nonce:'first',lockName:'probe-lock',identify:false}} satisfies Command);
  await runWorker(workerId,f.adapter);await secondHello.promise;
  assert.deepEqual(f.reports.filter(report=>report.type==='hello').map(report=>report.probe?.nonce),['first','second']);
  assert.equal(f.counts().submissions,0);
});

test('the exact early ID is durable before a verifying ACK can stall the emitter',async t=>{
  const f=environment(t),verifying=deferred(),release=deferred();
  const sent:Omit<Report,'id'|'at'|'workerId'>[]=[];
  const running=performJob(f.jobs[0],f.adapter,async report=>{
    sent.push(clone(report));
    if(report.stage==='verifying'){verifying.resolve();await release.promise;}
  },()=>{});
  await verifying.promise;
  const journal=f.read<Journal>(prefix+'journal:'+f.jobs[0].assignmentId);
  assert.equal(journal.state,'intent');
  assert.equal(journal.report?.stage,'created');
  assert.equal(journal.report?.actual?.unitId,f.actual('ROW_A').unitId);
  assert.equal(journal.report?.actual?.verified,false);
  assert.equal(f.counts().submissions,1);assert.equal(f.counts().verifications,0);
  release.resolve();await running;
  assert.equal(sent.at(-1)?.status,'success');
});

test('one-way stages do not require ACKs, while a terminal result remains durable until ACK',async t=>{
  const f=environment(t),terminal=deferred();f.state.autoAckTerminal=false;
  f.state.onReport=report=>{if(report.type==='result')terminal.resolve();};
  f.write(prefix+'command:'+workerId,{seq:1,job:f.jobs[0]} satisfies Command);
  const running=runWorker(workerId,f.adapter);await terminal.promise;
  const journal=f.read<Journal>(prefix+'journal:'+f.jobs[0].assignmentId);
  assert.equal(journal.state,'done');assert.equal(journal.report?.actual?.unitId,f.actual('ROW_A').unitId);
  assert.equal(journal.report?.actual?.verified,true);
  const stageIds=new Set(f.reports.filter(report=>report.type==='stage').map(report=>report.id));
  assert.ok(f.commands.every(command=>!stageIds.has(command.ack!)),'no stage ACK was supplied');
  assert.equal(f.counts().verifications,1);
  const command=f.read<Command>(prefix+'command:'+workerId);
  f.write(prefix+'command:'+workerId,{...command,seq:command.seq+1,ack:journal.report!.id} satisfies Command);
  await running;
});

test('verification errors or conflicting readback cannot erase an already captured ID',async t=>{
  for(const scenario of ['missing-error-id','different-error-id','different-result-id'])await t.test(scenario,async t=>{
    const f=environment(t),sent:Omit<Report,'id'|'at'|'workerId'>[]=[];
    f.adapter.verify=async()=>{
      if(scenario==='different-result-id')return {...f.actual('ROW_A'),unitId:f.actual('ROW_B').unitId};
      throw Object.assign(new Error('Readback stopped'),{actual:scenario==='missing-error-id'?{floor:'900'}:{...f.actual('ROW_B'),verified:false}});
    };
    await performJob(f.jobs[0],f.adapter,async report=>{sent.push(clone(report));},()=>{});
    assert.equal(sent.at(-1)?.status,'created-unverified');
    assert.equal(sent.at(-1)?.actual?.unitId,f.actual('ROW_A').unitId);
    assert.equal(sent.at(-1)?.actual?.verified,false);
    assert.equal(f.counts().submissions,1);
  });
});

test('restoring an intent journal replays its exact early ID without another create',async t=>{
  const f=environment(t),job=f.jobs[0],sent:Omit<Report,'id'|'at'|'workerId'>[]=[];
  f.storage.set(prefix+'journal:'+job.assignmentId,{
    assignmentId:job.assignmentId,taskId:job.task.id,batchId:job.batch.id,state:'intent',
    report:{id:'receipt',at:Date.now(),workerId,assignmentId:job.assignmentId,taskId:job.task.id,type:'stage',stage:'created',actual:{...f.actual('ROW_A'),verified:false}},
  } satisfies Journal);
  await performJob(job,f.adapter,async report=>{sent.push(clone(report));},()=>{});
  assert.equal(sent.at(-1)?.status,'created-unverified');
  assert.equal(sent.at(-1)?.actual?.unitId,f.actual('ROW_A').unitId);
  assert.equal(sent.at(-1)?.actual?.verified,false);
  assert.deepEqual(f.counts(),{preparations:0,submissions:0,verifications:0});
});

test('a mismatched journal or terminal report cannot be replayed as this assignment',async t=>{
  for(const fault of ['batch','terminal-worker'])await t.test(fault,async t=>{
    const f=environment(t),job=f.jobs[0];
    const journal:Journal={assignmentId:job.assignmentId,taskId:job.task.id,batchId:fault==='batch'?'other-batch':job.batch.id,state:'done',
      report:{id:'foreign',at:Date.now(),workerId:'other-worker',assignmentId:job.assignmentId,taskId:job.task.id,type:'result',status:'success',actual:f.actual('ROW_A')}};
    f.storage.set(prefix+'journal:'+job.assignmentId,clone(journal));
    await assert.rejects(performJob(job,f.adapter,async()=>{throw Error('Must not emit');},()=>{}),/归属|属于|回执/);
    assert.deepEqual(f.read(prefix+'journal:'+job.assignmentId),journal);
    assert.equal(f.counts().submissions,0);
  });
});

test('an early receipt ID for another publisher is not attached to the submitted task',async t=>{
  const f=environment(t),sent:Omit<Report,'id'|'at'|'workerId'>[]=[];
  f.adapter.waitForUnitId=async()=>'ca-app-pub-9999999999999999/1234567890';
  await performJob(f.jobs[0],f.adapter,async report=>{sent.push(clone(report));},()=>{});
  assert.equal(f.counts().submissions,1);assert.equal(f.counts().verifications,0);
  assert.equal(sent.at(-1)?.status,'uncertain');assert.equal(sent.at(-1)?.actual?.unitId,undefined);
});

test('safe close requires an owned terminal ACK and preserves a missing-ID submission',async t=>{
  for(const scenario of ['acknowledged-id','unacknowledged-id','acknowledged-unknown'])await t.test(scenario,async t=>{
    const f=environment(t),terminal=deferred();
    f.state.autoAckTerminal=scenario!=='unacknowledged-id';
    if(scenario==='acknowledged-unknown'){
      f.adapter.waitForUnitId=async()=>{throw Error('No receipt');};
      f.adapter.verify=async()=>{throw Error('No saved record');};
    }
    f.state.onReport=report=>{
      if(!['result','error'].includes(report.type))return;
      const command=f.read<Command>(prefix+'command:'+workerId);
      f.write(prefix+'command:'+workerId,{...command,seq:command.seq+1,close:true} satisfies Command);
      terminal.resolve();
    };
    f.write(prefix+'command:'+workerId,{seq:1,job:f.jobs[0]} satisfies Command);
    const running=runWorker(workerId,f.adapter);await terminal.promise;await drain();
    assert.equal(f.closes(),scenario==='acknowledged-id'?1:0);
    if(scenario==='unacknowledged-id'){
      const journal=f.read<Journal>(prefix+'journal:'+f.jobs[0].assignmentId);
      const command=f.read<Command>(prefix+'command:'+workerId);
      f.write(prefix+'command:'+workerId,{...command,seq:command.seq+1,ack:journal.report!.id} satisfies Command);
    }
    await running;await drain();
    assert.equal(f.closes(),scenario==='acknowledged-unknown'?0:1);
    assert.equal(f.counts().submissions,1);
  });
});

test('activation reports real visibility and cannot overwrite an active job report',async t=>{
  const f=environment(t),prepared=deferred(),release=deferred();f.visibility('hidden');
  f.write(prefix+'command:'+workerId,{seq:1,activate:{nonce:'activate-one'}} satisfies Command);
  await runWorker(workerId,f.adapter);
  assert.equal(f.reports.at(-1)?.activation?.visible,false);
  f.visibility('visible');
  assert.deepEqual(f.reports.at(-1)?.activation,{nonce:'activate-one',visible:true});
  f.adapter.prepare=async()=>{prepared.resolve();await release.promise;};
  f.write(prefix+'command:'+workerId,{seq:2,job:f.jobs[0]} satisfies Command);
  await prepared.promise;
  const current=f.read<Report>(prefix+'report:'+workerId);
  f.visibility('hidden');
  assert.deepEqual(f.read(prefix+'report:'+workerId),current);
  release.resolve();await drain();
});

test('foreground-required work waits for visibility and cancels on a safety event without polling',async t=>{
  for(const canceled of [false,true])await t.test(canceled?'pause':'visible',async t=>{
    const f=environment(t);f.visibility('hidden');
    const reports:Omit<Report,'id'|'at'|'workerId'>[]=[];
    const running=performJob({...f.jobs[0],requireForeground:true},f.adapter,async report=>{reports.push(clone(report));},()=>{
      if(f.read<Batch>(f.batchKey).phase!=='running')throw Error('Batch paused before prepare');
    });
    await drain();assert.equal(f.counts().preparations,0);assert.equal(f.counts().submissions,0);
    if(canceled)f.write(f.batchKey,{...f.batch,phase:'paused'} satisfies Batch);
    else f.visibility('visible');
    await running;
    assert.equal(f.counts().submissions,canceled?0:1);
    assert.equal(reports.at(-1)?.status,canceled?'failed':'success');
  });
});

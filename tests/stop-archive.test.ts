import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.ts';
import { createBatch, parseInput } from '../src/core.ts';
import type { Actual, Adapter, Batch, Identity } from '../src/types.ts';
import type { Command, Job, Journal, Report } from '../src/protocol.ts';
import type { PanelHandle } from '../src/panel.ts';

const prefix='abc:v1:';
const identity:Identity={publisherId:'pub-1234567890123456',appId:'ca-app-pub-1234567890123456~1234567890',appName:'Stop archive tests',evidence:[]};
const actual:Actual={...identity,name:'A',unitId:'ca-app-pub-1234567890123456/1234567890',format:'interstitial',mode:'manual',floor:'60',currency:'USD',verified:true};
const clone=<T>(value:T):T=>value===undefined?value:structuredClone(value);
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
type Slot=Parameters<Controller['handle']>[0];
type HistoryRecovery=Controller & {
  verifyHistory(batchId:string):Promise<void>;
  recordHistoryObservedId(batchId:string,taskId:string,unitId:string):Promise<void>;
};
function batchKey(batch:Batch){return prefix+'batch:'+batch.identity.publisherId+':'+batch.identity.appId+':'+batch.id;}
function report(job:Job,data:Omit<Report,'id'|'at'|'workerId'|'assignmentId'|'taskId'>):Report{
  return {...data,id:crypto.randomUUID(),at:Date.now(),workerId:job.workerId,assignmentId:job.assignmentId,taskId:job.task.id};
}
function environment(t:TestContext){
  const storage=new Map<string,unknown>();
  const writes:{key:string;value:unknown}[]=[];
  const listeners=new Map<number,{key:string;callback:(name:string,previous:unknown,value:unknown,remote:boolean)=>void}>();
  let listenerId=0;
  Object.assign(globalThis,{
    GM_getValue:<T>(key:string,fallback?:T):T=>clone((storage.has(key)?storage.get(key):fallback) as T),
    GM_setValue:(key:string,value:unknown)=>{
      const previous=storage.get(key);storage.set(key,clone(value));writes.push({key,value:clone(value)});
      for(const listener of [...listeners.values()])if(listener.key===key)listener.callback(key,clone(previous),clone(value),true);
    },
    GM_deleteValue:(key:string)=>{storage.delete(key);},
    GM_listValues:()=>[...storage.keys()],
    GM_addValueChangeListener:(key:string,callback:(name:string,previous:unknown,value:unknown,remote:boolean)=>void)=>{const id=++listenerId;listeners.set(id,{key,callback});return id;},
    GM_removeValueChangeListener:(id:number)=>{listeners.delete(id);},
    GM_openInTab:()=>{throw new Error('tests must not open a real page');},
  });
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{
    request:async(name:string,_options:unknown,callback:(lock:{name:string})=>unknown)=>callback({name}),
  }}});
  const oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://apps.admob.com/v2/apps/1234567890/adunits/list'}});
  t.after(()=>{
    if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');
    if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else Reflect.deleteProperty(globalThis,'location');
  });
  return {storage,writes};
}
function fixture(t:TestContext){
  const env=environment(t),calls={prepare:0,submit:0,verify:0,lookup:0};
  const adapter:Adapter={
    identify:async()=>clone(identity),home:async()=>{},diagnostics:()=>({}),
    lookup:async()=>{calls.lookup++;return {complete:true,matches:[]};},
    prepare:async(_i,_f,_n,_p,checkpoint)=>{calls.prepare++;await checkpoint();},
    submit:async()=>{calls.submit++;},verify:async()=>{calls.verify++;return clone(actual);},
    verifyById:async(_i,id,name,format,floor)=>{calls.verify++;return {...actual,unitId:id,name,format,floor};},
  };
  const controller=new Controller(adapter),updates:unknown[]=[];
  controller.identity=clone(identity);controller.panel={update:(value:unknown)=>updates.push(clone(value))} as unknown as PanelHandle;
  controller.lockRelease=()=>{};controller.lockedPublisher=identity.publisherId;
  const batch=createBatch(parseInput('A,60\nB,40'),identity,'interstitial',1,'tabs','https://apps.admob.com/',controller.id);
  batch.phase='running';batch.confirmedAt=new Date().toISOString();batch.startedAt=batch.confirmedAt;controller.batch=batch;
  const task=batch.tasks[0];Object.assign(task,{assignmentId:'old-assignment',workerId:'old-worker',attempts:1,status:'submitting',intentAt:new Date().toISOString()});
  const job:Job={batch:clone(batch),task:clone(task),assignmentId:task.assignmentId!,workerId:task.workerId!,kind:'create'};
  const slot:Slot={id:job.workerId,busy:job.assignmentId,since:Date.now(),batchId:batch.id,identity:clone(identity),probePassed:true};
  controller.slots.set(slot.id,slot);
  GM_setValue(prefix+'command:'+slot.id,{seq:3,job,grant:{assignmentId:job.assignmentId,expires:Date.now()+10000}} satisfies Command);
  GM_setValue(prefix+'journal:'+job.assignmentId,{assignmentId:job.assignmentId,taskId:task.id,batchId:batch.id,state:'intent'} satisfies Journal);
  controller.save();GM_setValue(prefix+'active:'+identity.publisherId,{appId:identity.appId,id:batch.id});
  return {...env,controller,batch,task,job,slot,adapter,calls,updates};
}
function installNewDraft(f:ReturnType<typeof fixture>){
  const next=createBatch(parseInput('NEW,80'),identity,'interstitial',1,'single','https://apps.admob.com/',f.controller.id);
  f.controller.batch=next;f.controller.save();return next;
}

test('explicit stop revokes queued grants before archiving while preserving unresolved evidence and unrelated mailboxes',async t=>{
  const f=fixture(t);f.task.actual={...actual,verified:false};f.controller.save();
  const unrelated={seq:9,grant:{assignmentId:'unrelated',expires:Date.now()+10000}} satisfies Command;
  GM_setValue(prefix+'command:unrelated',unrelated);
  const evidence=clone({assignmentId:f.task.assignmentId,workerId:f.task.workerId,intentAt:f.task.intentAt,actual:f.task.actual});f.writes.length=0;
  await f.controller.stop();
  const stopped=GM_getValue<Batch>(batchKey(f.batch));
  assert.equal(stopped.phase,'done');assert.ok(stopped.stopRequestedAt);assert.ok(stopped.completedAt);
  assert.deepEqual({assignmentId:stopped.tasks[0].assignmentId,workerId:stopped.tasks[0].workerId,intentAt:stopped.tasks[0].intentAt,actual:stopped.tasks[0].actual},evidence);
  assert.equal(stopped.tasks[0].status,'created-unverified');
  assert.equal(stopped.tasks[1].status,'stopped');
  const command=GM_getValue<Command>(prefix+'command:'+f.slot.id);
  assert.equal(command.grant,undefined);assert.ok(command.blocked);assert.equal(command.job?.assignmentId,f.job.assignmentId);
  const archivedAt=f.writes.findIndex(write=>write.key===batchKey(f.batch) && (write.value as Batch).phase==='done');
  const revokedAt=f.writes.findIndex(write=>write.key===prefix+'command:'+f.slot.id && !(write.value as Command).grant && !!(write.value as Command).blocked);
  assert.ok(revokedAt>=0 && archivedAt>revokedAt,'durable revocation precedes the done state');
  assert.deepEqual(GM_getValue(prefix+'command:unrelated'),unrelated);
  assert.notEqual(GM_getValue<{id?:string}>(prefix+'active:'+identity.publisherId,{}).id,f.batch.id);
  await assert.rejects(()=>f.controller.resume(),/停止/);assert.equal(f.calls.submit,0);
});

test('a stopped batch with an unresolved busy worker permits a new confirmed batch and its scheduler',async t=>{
  const f=fixture(t);let closes=0;f.slot.tab={closed:false,close(){closes++;this.closed=true;}};
  await f.controller.stop();const old=GM_getValue<Batch>(batchKey(f.batch));
  const config={format:'interstitial' as const,execution:'single' as const,concurrency:1,text:'NEW,80',rows:parseInput('NEW,80'),confirmedIdentity:clone(identity)};
  await f.controller.start(config);const next=f.controller.batch!;
  assert.notEqual(next.id,f.batch.id);assert.equal(next.phase,'running');
  const dispatched:string[]=[];
  t.mock.method(f.controller,'dispatch',async(slot:Slot,task:Batch['tasks'][number])=>{dispatched.push(task.id);task.assignmentId='new-assignment';task.workerId=slot.id;slot.busy='new-assignment';});
  await f.controller.tick();
  assert.deepEqual(dispatched,[next.tasks[0].id],'archived worker busy state does not occupy new capacity');
  assert.deepEqual(GM_getValue(batchKey(f.batch)),old);assert.equal(f.calls.submit,0);
  assert.equal(closes,0,'the original submitted page with no known ID remains open');assert.equal(f.slot.tab.closed,false);
});

test('a failed durable grant revocation cannot expose the batch as safely ended',async t=>{
  const f=fixture(t),persist=GM_setValue;
  t.mock.method(globalThis,'GM_setValue',(key:string,value:unknown)=>{
    if(key===prefix+'command:'+f.slot.id && !(value as Command).grant)throw new Error('grant revocation storage failed');
    persist(key,value);
  });
  await assert.rejects(()=>f.controller.stop(),/storage|存储|撤销|停止/);
  const saved=GM_getValue<Batch>(batchKey(f.batch));assert.notEqual(saved.phase,'done');assert.ok(saved.stopRequestedAt);
  assert.ok(GM_getValue<Command>(prefix+'command:'+f.slot.id).grant);
  assert.equal(f.calls.submit,0);
});

test('a stopped stale active pointer from another app of the same publisher cannot block a new batch',async t=>{
  const f=fixture(t);await f.controller.stop();
  const otherIdentity={...identity,appId:'ca-app-pub-1234567890123456~9999999999'};
  const old=createBatch(parseInput('OTHER,50'),otherIdentity,'interstitial',1,'tabs','https://apps.admob.com/',f.controller.id);
  old.phase='paused';old.stopRequestedAt='2026-11-19T11:00:00.000Z';old.confirmedAt=old.stopRequestedAt;
  const task=old.tasks[0];Object.assign(task,{status:'submitting',intentAt:old.stopRequestedAt,assignmentId:'other-app-assignment',workerId:'other-app-worker',attempts:1});
  const job:Job={batch:clone(old),task:clone(task),assignmentId:task.assignmentId!,workerId:task.workerId!,kind:'create'};
  GM_setValue(batchKey(old),old);
  GM_setValue(prefix+'command:'+job.workerId,{seq:1,job,grant:{assignmentId:job.assignmentId,expires:Date.now()+10000}} satisfies Command);
  GM_setValue(prefix+'active:'+identity.publisherId,{appId:old.identity.appId,id:old.id});
  await f.controller.start({format:'interstitial',execution:'single',concurrency:1,text:'NEW,80',rows:parseInput('NEW,80'),confirmedIdentity:clone(identity)});
  const current=f.controller.batch!,archived=GM_getValue<Batch>(batchKey(old));
  assert.equal(current.phase,'running');assert.equal(current.identity.appId,identity.appId);assert.notEqual(current.id,old.id);
  assert.equal(archived.phase,'done');assert.equal(archived.stopRequestedAt,old.stopRequestedAt);assert.equal(archived.tasks[0].status,'uncertain');
  assert.equal(archived.tasks[0].intentAt,task.intentAt);assert.equal(archived.tasks[0].assignmentId,task.assignmentId);
  assert.equal(GM_getValue<Command>(prefix+'command:'+job.workerId).grant,undefined);
  assert.equal(GM_getValue<{id:string}>(prefix+'active:'+identity.publisherId).id,current.id);assert.equal(f.calls.submit,0);
});

test('a hanging archived intent check cannot hold a fresh batch submission grant queue',async t=>{
  const f=fixture(t);delete f.task.intentAt;f.task.status='filling';
  const oldCommand=GM_getValue<Command>(prefix+'command:'+f.slot.id);delete oldCommand.grant;GM_setValue(prefix+'command:'+f.slot.id,oldCommand);f.controller.save();
  let release!:(value:Identity)=>void,identityReads=0;
  f.adapter.identify=()=>++identityReads===1?new Promise(resolve=>{release=resolve;}):Promise.resolve(clone(identity));
  const oldPending=f.controller.handle(f.slot,report(f.job,{type:'intent'}));await flush();assert.equal(identityReads,1);
  let freshPending:Promise<void>|undefined;
  try{
    await f.controller.stop();const next=installNewDraft(f);next.phase='running';next.confirmedAt=new Date().toISOString();
    const task=next.tasks[0];Object.assign(task,{assignmentId:'fresh-assignment',workerId:'fresh-worker',attempts:1,status:'filling'});
    const slot:Slot={id:task.workerId!,busy:task.assignmentId,since:Date.now(),batchId:next.id,identity:clone(identity),probePassed:true};
    f.controller.slots.set(slot.id,slot);
    const job:Job={batch:clone(next),task:clone(task),assignmentId:task.assignmentId!,workerId:slot.id,kind:'create'};
    GM_setValue(prefix+'command:'+slot.id,{seq:1,job} satisfies Command);f.controller.save();
    freshPending=f.controller.handle(slot,report(job,{type:'intent'}));await flush();
    assert.equal(GM_getValue<Command>(prefix+'command:'+slot.id).grant?.assignmentId,job.assignmentId,'fresh grant is issued before the old identity Promise resolves');
    assert.ok(task.intentAt);assert.equal(GM_getValue<Command>(prefix+'command:'+f.slot.id).grant,undefined);
  }finally{release(clone(identity));await oldPending;await freshPending;}
  assert.equal(f.calls.submit,0);
});

test('archive cleanup closes only safe probe pages and its handle failure cannot pause the new batch',async t=>{
  const f=fixture(t);f.task.status='success';f.task.actual=clone(actual);f.slot.busy=undefined;
  let failedCloses=0;f.slot.tab={closed:false,close(){failedCloses++;throw new Error('owned handle close failed');}};
  const probe:Slot={id:'old-probe',since:Date.now(),batchId:f.batch.id,tab:{closed:false,close(){this.closed=true;}}};
  f.controller.slots.set(probe.id,probe);GM_setValue(prefix+'command:'+probe.id,{seq:1} satisfies Command);
  const unrelated={seq:42,blocked:'unrelated mailbox'} satisfies Command;GM_setValue(prefix+'command:unrelated',unrelated);f.controller.save();
  await f.controller.stop();await flush();
  assert.equal(probe.tab!.closed,true);assert.equal(failedCloses,1);assert.equal(f.slot.tab.closed,false);
  assert.equal(GM_getValue(prefix+'command:'+probe.id,undefined),undefined);
  assert.ok(GM_getValue<Command>(prefix+'command:'+f.slot.id));assert.deepEqual(GM_getValue(prefix+'command:unrelated'),unrelated);
  await f.controller.start({format:'interstitial',execution:'single',concurrency:1,text:'NEW,80',rows:parseInput('NEW,80'),confirmedIdentity:clone(identity)});
  assert.equal(f.controller.batch!.phase,'running');assert.equal(f.calls.submit,0);
});

test('late archived stage and terminal reports update only the old batch and acknowledge its original worker',async t=>{
  const f=fixture(t);await f.controller.stop();const next=installNewDraft(f),before=clone(next);
  const created=report(f.job,{type:'stage',stage:'created',actual:{...actual,verified:false}});
  await f.controller.handle(f.slot,created);
  assert.equal(GM_getValue<Batch>(batchKey(f.batch)).tasks[0].actual?.unitId,actual.unitId);
  assert.deepEqual(next,before);assert.equal(f.controller.batch,next);
  const terminal=report(f.job,{type:'result',status:'success',actual:clone(actual)});
  await f.controller.handle(f.slot,terminal);
  const old=GM_getValue<Batch>(batchKey(f.batch));assert.equal(old.phase,'done');assert.ok(old.stopRequestedAt);
  assert.equal(old.tasks[0].status,'success');assert.equal(old.tasks[0].actual?.verified,true);
  assert.equal(GM_getValue<Command>(prefix+'command:'+f.slot.id).ack,terminal.id);
  assert.equal(GM_getValue<Command>(prefix+'command:'+f.slot.id).grant,undefined);
  assert.deepEqual(next,before);assert.deepEqual(GM_getValue(batchKey(next)),before);
  assert.equal(GM_getValue(prefix+'latest:'+identity.publisherId+':'+identity.appId),next.id);assert.equal(f.calls.submit,0);
});

test('late archived progress and errors cannot erase an already verified success receipt',async t=>{
  const f=fixture(t);f.task.status='success';f.task.actual=clone(actual);f.slot.busy=undefined;f.controller.save();await f.controller.stop();
  const before=clone(GM_getValue<Batch>(batchKey(f.batch)).tasks[0]);const next=installNewDraft(f),nextBefore=clone(next);
  for(const data of [
    {type:'stage',stage:'created',actual:{...actual,verified:false}},
    {type:'stage',stage:'verifying',actual:{...actual,verified:false}},
    {type:'error',status:'created-unverified',actual:{...actual,verified:false},reason:'stale page error'},
  ] satisfies Omit<Report,'id'|'at'|'workerId'|'assignmentId'|'taskId'>[]){
    await f.controller.handle(f.slot,report(f.job,data));
    const saved=GM_getValue<Batch>(batchKey(f.batch)).tasks[0];
    assert.equal(saved.status,'success');assert.deepEqual(saved.actual,before.actual);assert.equal(saved.actual?.verified,true);
    assert.equal(saved.intentAt,before.intentAt);assert.equal(saved.assignmentId,before.assignmentId);
  }
  assert.deepEqual(next,nextBefore);assert.equal(f.controller.batch,next);assert.equal(f.calls.submit,0);
});

test('stop normalizes assigned in-flight states while retaining every submission and receipt field',async t=>{
  for(const status of ['pending','filling','submitting','verifying'] as const)for(const hasId of [false,true])await t.test(status+(hasId?' with ID':' without ID'),async t=>{
    const f=fixture(t);f.task.status=status;
    if(status==='pending' || status==='filling')delete f.task.intentAt;
    if(hasId)f.task.actual={...actual,verified:false};f.controller.save();
    const evidence=clone({assignmentId:f.task.assignmentId,workerId:f.task.workerId,intentAt:f.task.intentAt,actual:f.task.actual,attempts:f.task.attempts});
    await f.controller.stop();const task=GM_getValue<Batch>(batchKey(f.batch)).tasks[0];
    assert.equal(task.status,hasId?'created-unverified':'uncertain');
    assert.deepEqual({assignmentId:task.assignmentId,workerId:task.workerId,intentAt:task.intentAt,actual:task.actual,attempts:task.attempts},evidence);
  });
});

test('stop while an intent identity check is suspended cannot issue a delayed grant',async t=>{
  const f=fixture(t);delete f.task.intentAt;f.task.status='filling';
  const command=GM_getValue<Command>(prefix+'command:'+f.slot.id);delete command.grant;GM_setValue(prefix+'command:'+f.slot.id,command);f.controller.save();
  let release!:(value:Identity)=>void,started=false;
  f.adapter.identify=()=>new Promise(resolve=>{started=true;release=resolve;});
  const pending=f.controller.handle(f.slot,report(f.job,{type:'intent'}));await flush();assert.equal(started,true);
  try{await f.controller.stop();assert.equal(f.batch.phase,'done');}
  finally{release(clone(identity));await pending;}
  const after=GM_getValue<Command>(prefix+'command:'+f.slot.id);
  assert.equal(after.grant,undefined);assert.ok(after.blocked);assert.equal(f.task.intentAt,undefined);assert.equal(f.calls.submit,0);
});

test('legacy stopped paused and stopping batches migrate to an ended archive without losing task ownership',async t=>{
  for(const phase of ['paused','stopping'] as const)await t.test(phase,async t=>{
    const f=fixture(t);f.batch.phase=phase;f.batch.stopRequestedAt='2026-11-19T10:00:00.000Z';f.controller.save();
    const original=clone(f.task),restored=new Controller(f.adapter);restored.identity=clone(identity);restored.panel=f.controller.panel;
    restored.lockRelease=()=>{};restored.lockedPublisher=identity.publisherId;await restored.load();
    assert.equal(restored.batch?.phase,'done');assert.equal(restored.batch?.stopRequestedAt,f.batch.stopRequestedAt);
    assert.equal(restored.batch?.tasks[0].status,'uncertain');
    assert.equal(restored.batch?.tasks[0].assignmentId,original.assignmentId);assert.equal(restored.batch?.tasks[0].workerId,original.workerId);assert.equal(restored.batch?.tasks[0].intentAt,original.intentAt);
    assert.equal(GM_getValue<Command>(prefix+'command:'+f.slot.id).grant,undefined);
    assert.notEqual(GM_getValue<{id?:string}>(prefix+'active:'+identity.publisherId,{}).id,f.batch.id);
    await assert.rejects(()=>restored.resume(),/停止/);assert.equal(f.calls.submit,0);
  });
});

test('historical verification uses the exact known ID without replacing the current draft or resuming stopped work',async t=>{
  const f=fixture(t);f.task.actual={...actual,verified:false};f.controller.save();await f.controller.stop();
  const next=installNewDraft(f),before=clone(next);const observed:string[]=[];
  f.adapter.verifyById=async(_i,id,name,format,floor)=>{observed.push(id);f.calls.verify++;return {...actual,unitId:id,name,format,floor};};
  await (f.controller as HistoryRecovery).verifyHistory(f.batch.id);
  const old=GM_getValue<Batch>(batchKey(f.batch));assert.equal(old.phase,'done');assert.ok(old.stopRequestedAt);assert.equal(old.tasks[0].status,'success');
  assert.deepEqual(observed,[actual.unitId]);assert.equal(old.tasks[1].status,'stopped');
  assert.equal(f.controller.batch,next);assert.deepEqual(next,before);assert.deepEqual(GM_getValue(batchKey(next)),before);
  assert.equal(GM_getValue(prefix+'latest:'+identity.publisherId+':'+identity.appId),next.id);
  assert.equal(f.calls.prepare,0);assert.equal(f.calls.submit,0);
});

test('a late successful archive receipt wins over an older in-flight history verification',async t=>{
  for(const response of ['unverified','error'] as const)await t.test(response,async t=>{
    const f=fixture(t);f.task.actual={...actual,verified:false};f.controller.save();await f.controller.stop();
    const next=installNewDraft(f),nextBefore=clone(next);
    let resolveVerification!:(value:Actual)=>void,rejectVerification!:(error:Error)=>void,entered!:()=>void;
    const verificationStarted=new Promise<void>(resolve=>{entered=resolve;});
    f.adapter.verifyById=async()=>{entered();return new Promise<Actual>((resolve,reject)=>{resolveVerification=resolve;rejectVerification=reject;});};
    const verification=(f.controller as HistoryRecovery).verifyHistory(f.batch.id).then(()=>({resolved:true}),error=>({resolved:false,error}));
    await verificationStarted;
    await f.controller.handle(f.slot,report(f.job,{type:'result',status:'success',actual:clone(actual)}));
    const successfulReceipt=clone(GM_getValue<Batch>(batchKey(f.batch)).tasks[0].actual);
    assert.equal(successfulReceipt?.verified,true);
    if(response==='error')rejectVerification(new Error('older history request failed'));else resolveVerification({...actual,verified:false});
    const outcome=await verification,saved=GM_getValue<Batch>(batchKey(f.batch)).tasks[0];
    assert.equal(f.controller.batch,next);assert.deepEqual(next,nextBefore);assert.deepEqual(GM_getValue(batchKey(next)),nextBefore);
    assert.deepEqual({resolved:outcome.resolved,status:saved.status,verified:saved.actual?.verified},{resolved:true,status:'success',verified:true});
    assert.deepEqual(saved.actual,successfulReceipt);assert.equal(f.calls.submit,0);
  });
});

test('historical unknown-ID recovery keeps uncertainty and never adopts same-name units',async t=>{
  const f=fixture(t);await f.controller.stop();const next=installNewDraft(f),before=clone(next);
  f.adapter.lookup=async()=>{f.calls.lookup++;return {complete:true,matches:[clone(actual)]};};
  await (f.controller as HistoryRecovery).verifyHistory(f.batch.id);
  const old=GM_getValue<Batch>(batchKey(f.batch));assert.equal(old.phase,'done');assert.equal(old.tasks[0].actual,undefined);assert.equal(old.tasks[0].status,'uncertain');
  assert.equal(old.tasks[0].assignmentId,f.job.assignmentId);assert.ok(old.tasks[0].intentAt);
  assert.equal(f.calls.lookup,0);assert.equal(f.calls.prepare,0);assert.equal(f.calls.submit,0);assert.equal(f.controller.batch,next);assert.deepEqual(next,before);
  assert.equal(GM_getValue(prefix+'latest:'+identity.publisherId+':'+identity.appId),next.id);
});

test('an explicitly observed historical ID is validated, verified, and retained in the stopped batch',async t=>{
  const f=fixture(t);await f.controller.stop();const next=installNewDraft(f),before=clone(next);
  await (f.controller as HistoryRecovery).recordHistoryObservedId(f.batch.id,f.task.id,actual.unitId);
  const old=GM_getValue<Batch>(batchKey(f.batch));assert.equal(old.tasks[0].actual?.unitId,actual.unitId);assert.equal(old.tasks[0].status,'success');
  assert.equal(old.phase,'done');assert.ok(old.stopRequestedAt);assert.equal(old.tasks[0].assignmentId,f.job.assignmentId);
  assert.equal(f.controller.batch,next);assert.deepEqual(next,before);assert.equal(f.calls.submit,0);
  assert.equal(GM_getValue(prefix+'latest:'+identity.publisherId+':'+identity.appId),next.id);
  await assert.rejects(()=>(f.controller as HistoryRecovery).recordHistoryObservedId(f.batch.id,f.task.id,'ca-app-pub-9999999999999999/1234567890'),/ID|发布商|匹配|核验/);
});

test('history recovery is scoped to the current publisher and app and refuses active batches',async t=>{
  for(const fault of ['wrong-publisher','wrong-app','active'] as const)await t.test(fault,async t=>{
    const f=fixture(t);await f.controller.stop();const old=GM_getValue<Batch>(batchKey(f.batch));
    if(fault==='active'){old.phase='paused';delete old.stopRequestedAt;GM_setValue(batchKey(old),old);}
    if(fault==='wrong-publisher')f.controller.identity={...identity,publisherId:'pub-9999999999999999'};
    if(fault==='wrong-app')f.controller.identity={...identity,appId:'ca-app-pub-1234567890123456~9999999999'};
    f.adapter.identify=async()=>clone(f.controller.identity!);
    await assert.rejects(()=>(f.controller as HistoryRecovery).verifyHistory(f.batch.id));
    assert.equal(f.calls.prepare,0);assert.equal(f.calls.submit,0);assert.equal(f.calls.verify,0);
  });
});

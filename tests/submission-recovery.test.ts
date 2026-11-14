import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.ts';
import { createBatch, parseInput } from '../src/core.ts';
import { serializeSubmission } from '../src/gm.ts';
import { performJob, runWorker } from '../src/worker.ts';
import type { Adapter, Batch, Identity } from '../src/types.ts';
import type { Command, Job, Journal, Report } from '../src/protocol.ts';
import type { PanelHandle } from '../src/panel.ts';

const prefix='abc:v1:';
const identity:Identity={publisherId:'pub-1234567890123456',appId:'ca-app-pub-1234567890123456~1234567890',appName:'Test',evidence:[]};
const clone=<T>(value:T):T=>value===undefined?value:structuredClone(value);
const drain=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function deferred(){let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};}

function environment(t:TestContext){
  const storage=new Map<string,unknown>();
  Object.assign(globalThis,{
    GM_getValue:<T>(key:string,fallback?:T):T=>clone((storage.has(key)?storage.get(key):fallback) as T),
    GM_setValue:(key:string,value:unknown)=>{storage.set(key,clone(value));},
    GM_deleteValue:(key:string)=>{storage.delete(key);},
    GM_addValueChangeListener:()=>0,GM_removeValueChangeListener:()=>{},
  });
  const held=new Set<string>();
  const queues=new Map<string,(()=>void)[]>();
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{
    request(name:string,options:{ifAvailable?:boolean},callback:(lock:{name:string}|null)=>unknown):Promise<unknown>{
      if(options.ifAvailable && held.has(name))return Promise.resolve(callback(null));
      return new Promise((resolve,reject)=>{
        const run=()=>{
          held.add(name);
          Promise.resolve().then(()=>callback({name})).then(resolve,reject).finally(()=>{
            held.delete(name);const next=queues.get(name)?.shift();next?.();
          });
        };
        if(held.has(name)){const queue=queues.get(name)||[];queue.push(run);queues.set(name,queue);}else run();
      });
    },
  }}});
  t.after(()=>{if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');});
  return storage;
}
function fixture(rows='A,60\nB,60'){
  const adapter:Adapter={identify:async()=>clone(identity),home:async()=>{},diagnostics:()=>({}),lookup:async()=>({complete:true,matches:[]}),
    prepare:async(_i,_f,_n,_p,checkpoint)=>checkpoint(),submit:async guard=>guard!(),verify:async()=>{throw new Error('test must provide a saved result');}};
  const controller=new Controller(adapter);controller.identity=clone(identity);controller.panel={update:()=>{}} as unknown as PanelHandle;
  controller.lockRelease=()=>{};controller.lockedPublisher=identity.publisherId;
  const batch=createBatch(parseInput(rows),identity,'interstitial',2,'tabs','https://admob.google.com/',controller.id);
  batch.phase='running';batch.confirmedAt=new Date().toISOString();batch.canaryPassed=true;controller.batch=batch;
  const jobs=batch.tasks.map((task,index)=>{
    task.assignmentId='assignment-'+index;task.workerId='worker-'+index;task.attempts=1;
    const job:Job={batch:clone(batch),task:clone(task),assignmentId:task.assignmentId,workerId:task.workerId,kind:'create'};
    const slot={id:task.workerId,busy:task.assignmentId,since:Date.now()};controller.slots.set(slot.id,slot);
    GM_setValue(prefix+'command:'+slot.id,{seq:1,job} satisfies Command);
    return {job,slot,task};
  });
  controller.save();
  const permission=(job:Job)=>(beforeClick?:boolean)=>{
    const command=GM_getValue<Command>(prefix+'command:'+job.workerId);
    const saved=GM_getValue<Batch>(prefix+controller.key());
    assert.equal(command.job?.assignmentId,job.assignmentId);
    if(saved.controllerId!==job.batch.controllerId || saved.phase!=='running')throw new Error('cancelled or replaced controller');
    if(command.blocked)throw new Error(command.blocked);
    if(beforeClick && (!command.grant || command.grant.expires<=Date.now()))throw new Error('expired grant');
  };
  return {adapter,controller,batch,jobs,permission};
}

test('a delayed granted worker cannot click alongside another worker, and verification releases the submit lock',async t=>{
  environment(t);t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const f=fixture(),firstGranted=deferred(),releaseFirst=deferred(),firstVerifying=deferred(),releaseVerification=deferred();
  const clicks:number[]=[],intents:number[]=[];
  const run=(index:number)=>{
    const {job,slot,task}=f.jobs[index];
    const adapter:Adapter={...f.adapter,
      submit:async guard=>{if(index===0){firstGranted.resolve();await releaseFirst.promise;}guard!();clicks.push(Date.now());},
      verify:async()=>{
        if(index===0){firstVerifying.resolve();await releaseVerification.promise;}
        return {...identity,name:task.name,unitId:`ca-app-pub-1234567890123456/123456789${index}`,format:'interstitial',mode:'manual',floor:'60',currency:'USD',verified:true};
      },
    };
    return performJob(job,adapter,async data=>{
      await f.controller.handle(slot,{...data,id:crypto.randomUUID(),at:Date.now(),workerId:slot.id});
      if(data.type==='intent')intents.push(Date.now());
    },f.permission(job));
  };
  const first=run(0);await firstGranted.promise;
  const second=run(1);await drain();
  t.mock.timers.tick(2500);await drain();
  assert.equal(intents.length,1,'queued workers must not consume a grant while the first page is delayed');
  assert.deepEqual(clicks,[]);
  releaseFirst.resolve();await firstVerifying.promise;await drain();
  assert.deepEqual(clicks,[102500]);
  t.mock.timers.tick(2499);await drain();assert.equal(clicks.length,1);
  t.mock.timers.tick(1);await second;
  assert.deepEqual(clicks,[102500,105000]);assert.equal(f.jobs[1].task.status,'success');
  assert.notEqual(f.jobs[0].task.status,'success','saved-result verification does not hold the submit mutex');
  releaseVerification.resolve();await first;
});

test('an unfinished click timestamp waits a complete interval from the next lock acquisition',async t=>{
  const storage=environment(t);t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const original=GM_setValue;let failFinal=true;
  t.mock.method(globalThis,'GM_setValue',(key:string,value:unknown)=>{
    if(failFinal && key===prefix+'lastClick:'+identity.publisherId && !(value as {pending:boolean}).pending)throw new Error('final clock write failed');
    original(key,value);
  });
  await serializeSubmission(identity.publisherId,async mark=>{mark();});
  assert.equal((storage.get(prefix+'lastClick:'+identity.publisherId) as {pending:boolean}).pending,true);
  failFinal=false;t.mock.timers.tick(10000);
  let clicked=false;const next=serializeSubmission(identity.publisherId,async mark=>{mark();clicked=true;});await drain();
  t.mock.timers.tick(2499);await drain();assert.equal(clicked,false);
  t.mock.timers.tick(1);await next;assert.equal(clicked,true);
  assert.deepEqual(storage.get(prefix+'lastClick:'+identity.publisherId),{at:112500,pending:false});
});

test('a post-click clock write failure still collects and persists a delayed receipt and verified result',async t=>{
  const storage=environment(t),f=fixture('A,60'),entry=f.jobs[0],waitingForId=deferred(),receiptArrived=deferred();
  const unitId='ca-app-pub-1234567890123456/1234567890';let clicks=0;
  const original=GM_setValue;
  t.mock.method(globalThis,'GM_setValue',(key:string,value:unknown)=>{
    if(key===prefix+'lastClick:'+identity.publisherId && !(value as {pending:boolean}).pending)throw new Error('post-click clock failure');
    original(key,value);
  });
  f.adapter.submit=async guard=>{guard!();clicks++;};
  f.adapter.waitForUnitId=async()=>{waitingForId.resolve();await receiptArrived.promise;return unitId;};
  f.adapter.verify=async()=>({...identity,unitId,name:'A',format:'interstitial',mode:'manual',floor:'60',currency:'USD',verified:true});
  const running=performJob(entry.job,f.adapter,async data=>{await f.controller.handle(entry.slot,{...data,id:crypto.randomUUID(),at:Date.now(),workerId:entry.slot.id});},f.permission(entry.job));
  await waitingForId.promise;
  assert.equal(clicks,1);assert.equal(entry.task.actual,undefined);assert.equal(entry.task.status,'verifying');
  assert.equal((storage.get(prefix+'lastClick:'+identity.publisherId) as {pending:boolean}).pending,true);
  receiptArrived.resolve();await running;
  assert.equal(entry.task.status,'success');
  const persisted=GM_getValue<Batch>(prefix+f.controller.key()).tasks[0];
  assert.equal(persisted.actual?.unitId,unitId);assert.equal(persisted.actual?.verified,true);
});

test('a failed durable click guard never clicks and retains the controller submit intent',async t=>{
  environment(t);const f=fixture('A,60'),entry=f.jobs[0];let clicks=0;
  const original=GM_setValue;
  t.mock.method(globalThis,'GM_setValue',(key:string,value:unknown)=>{if(key.startsWith(prefix+'lastClick:'))throw new Error('clock storage failed');original(key,value);});
  f.adapter.submit=async guard=>{guard!();clicks++;};
  await performJob(entry.job,f.adapter,async data=>{await f.controller.handle(entry.slot,{...data,id:crypto.randomUUID(),at:Date.now(),workerId:entry.slot.id});},f.permission(entry.job));
  assert.equal(clicks,0);assert.equal(entry.task.status,'uncertain');assert.ok(entry.task.intentAt);
  assert.equal(GM_getValue<Journal>(prefix+'journal:'+entry.job.assignmentId).state,'intent');
});

test('a worker queued behind another submit rechecks replacement ownership before requesting a grant',async t=>{
  environment(t);const f=fixture('A,60'),entry=f.jobs[0],locked=deferred(),release=deferred();
  const occupying=serializeSubmission(identity.publisherId,async()=>{locked.resolve();await release.promise;});await locked.promise;
  const reports:Omit<Report,'id'|'at'|'workerId'>[]=[];let clicks=0;
  f.adapter.submit=async guard=>{guard!();clicks++;};
  const queued=performJob(entry.job,f.adapter,async data=>{reports.push(data);},f.permission(entry.job));await drain();
  const saved=GM_getValue<Batch>(prefix+f.controller.key());saved.controllerId='replacement';GM_setValue(prefix+f.controller.key(),saved);
  release.resolve();await occupying;await queued;
  assert.equal(clicks,0);assert.equal(reports.some(report=>report.type==='intent'),false);
  assert.equal(reports.at(-1)!.status,'failed');
  assert.equal(GM_getValue<Journal>(prefix+'journal:'+entry.job.assignmentId).state,'filling');
});

function workerDocument(t:TestContext){
  const old=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({style:{}}),body:{append:()=>{}}}});
  t.after(()=>{if(old)Object.defineProperty(globalThis,'document',old);else Reflect.deleteProperty(globalThis,'document');});
  t.mock.method(globalThis,'setInterval',(()=>0) as unknown as typeof setInterval);
}

test('refreshing both controller and worker resolves proven unsubmitted work without executing the stale job',async t=>{
  environment(t);workerDocument(t);const f=fixture('A,60'),entry=f.jobs[0];entry.task.status='filling';f.controller.save();
  GM_setValue(prefix+'journal:'+entry.job.assignmentId,{assignmentId:entry.job.assignmentId,taskId:entry.task.id,batchId:f.batch.id,state:'filling'} satisfies Journal);
  const restored=new Controller(f.adapter);restored.identity=identity;restored.panel=f.controller.panel;restored.lockRelease=()=>{};restored.lockedPublisher=identity.publisherId;
  await restored.load();assert.equal(restored.batch!.tasks[0].status,'uncertain');
  let preparations=0,submissions=0;f.adapter.prepare=async()=>{preparations++;};f.adapter.submit=async()=>{submissions++;};
  const original=GM_setValue;
  t.mock.method(globalThis,'GM_setValue',(key:string,value:unknown)=>{original(key,value);if(key===prefix+'report:'+entry.job.workerId)void restored.tick();});
  await runWorker(entry.job.workerId,f.adapter);await drain();
  assert.equal(preparations,0);assert.equal(submissions,0);
  assert.equal(restored.batch!.tasks[0].status,'failed');assert.equal(restored.slots.get(entry.job.workerId)?.busy,undefined);
  const journal=GM_getValue<Journal>(prefix+'journal:'+entry.job.assignmentId);assert.equal(journal.state,'done');
  assert.equal(GM_getValue<Command>(prefix+'command:'+entry.job.workerId).ack,journal.report!.id);
  await restored.retry();assert.equal(restored.batch!.tasks[0].status,'pending');assert.equal(restored.batch!.tasks[0].assignmentId,undefined);
  await restored.resume();assert.equal(restored.batch!.phase,'running');
});

test('stale-owner recovery never clears an assignment without complete pre-submit proof',async t=>{
  for(const fault of ['intent','actual','grant','expired-grant','missing-journal','intent-journal','wrong-batch','wrong-task','wrong-assignment','wrong-worker'])await t.test(fault,async t=>{
    environment(t);workerDocument(t);const f=fixture('A,60'),entry=f.jobs[0];entry.task.status='uncertain';f.batch.controllerId='replacement';
    const journal:Journal={assignmentId:entry.job.assignmentId,taskId:entry.task.id,batchId:f.batch.id,state:'filling'};
    const command=GM_getValue<Command>(prefix+'command:'+entry.job.workerId);
    if(fault==='intent')entry.task.intentAt=new Date().toISOString();
    if(fault==='actual')entry.task.actual={};
    if(fault==='grant' || fault==='expired-grant')command.grant={assignmentId:entry.job.assignmentId,expires:Date.now()+(fault==='grant'?10000:-10000)};
    if(fault==='intent-journal')journal.state='intent';
    if(fault==='wrong-batch')journal.batchId='other';
    if(fault==='wrong-task')journal.taskId='other';
    if(fault==='wrong-assignment')journal.assignmentId='other';
    if(fault==='wrong-worker')entry.task.workerId='other';
    if(fault!=='missing-journal')GM_setValue(prefix+'journal:'+entry.job.assignmentId,journal);
    GM_setValue(prefix+'command:'+entry.job.workerId,command);f.controller.save();
    await runWorker(entry.job.workerId,f.adapter);
    assert.equal(GM_getValue<Report|undefined>(prefix+'report:'+entry.job.workerId,undefined),undefined);
    assert.equal(entry.task.status,'uncertain');
    if(fault!=='missing-journal')assert.deepEqual(GM_getValue(prefix+'journal:'+entry.job.assignmentId),journal);
  });
});

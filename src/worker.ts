import type { Adapter, Batch, Task } from './types.ts';
import { classifyLookup } from './core.ts';
import { get, set, sameIdentity, uuid, waitFor, lockUnavailable, listen, holdLock } from './gm.ts';
import type { Command, Job, Journal, Report } from './protocol.ts';

export async function performJob(job:Job, adapter:Adapter, emit:(r:Omit<Report,'id'|'at'|'workerId'>)=>Promise<void>, permission:(beforeClick?:boolean)=>void):Promise<void> {
  const {batch,task,assignmentId,workerId}=job;
  const journalKey='journal:'+assignmentId;
  const old=get<Journal|undefined>(journalKey,undefined);
  const report=(r:Omit<Report,'id'|'at'|'workerId'>)=>emit({...r,assignmentId,taskId:task.id});
  if(old){
    if(old.state==='done' && old.report){await report(old.report);return;}
    if(old.state==='intent') {await report({type:'result',status:'uncertain',reason:'执行页在提交意图后恢复，禁止再次点击创建；请核验真实结果'});return;}
    // A previous page instance cannot have clicked create without an intent journal.
    if(job.kind==='create') {await report({type:'error',status:'failed',reason:'执行页在填表期间恢复；已确认本分配没有提交意图，等待手动重试'});return;}
  }
  const checkIdentity=async()=>{
    const identity=await adapter.identify();
    if(!sameIdentity(identity,batch.identity))throw Object.assign(new Error('发布商或应用与批次不一致'),{fatal:true});
  };
  const checkpoint=async()=>{await permission();await checkIdentity();};
  let intent=!!task.intentAt || job.kind==='verify';
  let latestActual=task.actual;
  try{
    await checkIdentity();
    if(job.kind==='verify'){
      if(!task.actual?.unitId){
        await report({type:'result',status:'uncertain',reason:'缺少本次创建的广告位 ID，请保留原执行页或录入成功说明中的 ID 后核验'});
        return;
      }
      if(task.actual?.unitId && adapter.verifyById){
        try{
          const actual=await adapter.verifyById(batch.identity,task.actual.unitId,task.name,batch.format,task.floor,batch.mode ?? task.mode ?? 'manual');
          await report({type:'result',status:actual.verified?'success':'created-unverified',actual,reason:actual.verified?'按已知广告位 ID 核验保存配置一致':'已取得 ID，保存后配置未完整核验'});
        }catch(error){
          const e=error as Error & {actual?:Report['actual']};
          await report({type:'error',status:'created-unverified',actual:e.actual||task.actual,reason:e.message});
        }
        return;
      }
      await adapter.home();
      const found=await adapter.lookup(batch.identity,task.name);
      const classification=classifyLookup(found,batch.identity,batch.format,task.name,task.floor,batch.mode ?? task.mode ?? 'manual');
      // A missing item, or a name alone, never proves a prior submit failed or succeeded.
      const actual=classification.actual;
      const exactKnownId=!!task.actual?.unitId && actual?.unitId===task.actual.unitId;
      if(task.actual?.unitId && !exactKnownId){await report({type:'result',status:'created-unverified',actual:task.actual,reason:'同名查询结果与已取得广告位ID不一致，保留原ID等待核验'});return;}
      await report({type:'result',status:classification.status==='exists' && exactKnownId?'success':'created-unverified',actual:exactKnownId?actual:task.actual,reason:classification.status==='pending'?'暂未找到记录，不能证明创建失败；继续保留待核验':classification.reason});
      return;
    }
    await checkpoint();
    // AdMob allows duplicate ad-unit names. A same-name existing unit is not a
    // reason to reject the user's request; the new unit ID is captured after
    // submit and used as the unique verification key.
    set(journalKey,{assignmentId,taskId:task.id,batchId:batch.id,state:'filling'} satisfies Journal);
    await report({type:'stage',stage:'filling'});
    await adapter.prepare(batch.identity,batch.format,task.name,task.floor,checkpoint,batch.mode ?? task.mode ?? 'manual');
    await report({type:'stage',stage:'filling',reason:'表单已读回，等待提交许可'});
    await checkpoint();
    // The controller durably stores submitting + intent before acknowledging this message.
    intent=true;
    await report({type:'intent'});
    await checkpoint();
    set(journalKey,{assignmentId,taskId:task.id,batchId:batch.id,state:'intent'} satisfies Journal);
    intent=true;
    await adapter.submit(()=>permission(true));
    await report({type:'stage',stage:'verifying'});
    if(adapter.waitForUnitId){
      const createdId=await adapter.waitForUnitId().catch(()=>undefined);
      if(createdId){
        latestActual={unitId:createdId,publisherId:batch.identity.publisherId,appId:batch.identity.appId,name:task.name,format:batch.format,mode:batch.mode ?? task.mode ?? 'manual',floor:task.floor,currency:(batch.mode ?? task.mode ?? 'manual') === 'manual'?'USD':'',verified:false};
        // Persist the new ID as soon as it is visible; never wait for the full
        // saved-config readback to know which unit this submission created.
        await report({type:'stage',stage:'created',actual:latestActual});
      }
    }
    const actual=await adapter.verify(batch.identity,batch.format,task.name,task.floor,batch.mode ?? task.mode ?? 'manual');
    latestActual=actual;
    await report({type:'result',status:actual.verified?'success':'created-unverified',actual,reason:actual.verified?'保存后配置核验一致':'已取得广告位 ID，配置尚未全部核验'});
  }catch(error){
    const e=error as Error & {actual?:Report['actual'];fatal?:boolean};
    // Transport failures after a terminal result must not replace a durably saved ID/result.
    const completed=get<Journal|undefined>(journalKey,undefined);
    if(completed?.state==='done' && completed.report)return;
    let actual=e.actual || latestActual;
    // A delayed ACK can fail after the platform has already shown its receipt.
    // Preserve that exact task's ID before reporting the transport error.
    if(intent && !actual?.unitId && adapter.recoverCreatedId){
      try{
        const recovered=adapter.recoverCreatedId(batch.identity,task.name,batch.format);
        if(recovered && /^ca-app-pub-\d{16}\/\d{10}$/.test(recovered) && recovered.startsWith(`ca-app-${batch.identity.publisherId}/`)){
          actual={unitId:recovered,publisherId:batch.identity.publisherId,appId:batch.identity.appId,name:task.name,format:batch.format,verified:false};
        }
      }catch{/* Conflicting or absent receipts cannot certify this task. */}
    }
    const status:Task['status']=actual?.unitId?'created-unverified':intent?'uncertain':'failed';
    await report({type:'error',status,reason:e.message,actual,fatal:e.fatal});
  }
}

export async function runWorker(workerId:string, adapter:Adapter):Promise<void> {
  // The journal read/write is not an atomic mutex. Hold a real cross-page lock
  // to reject duplicated worker tabs for the lifetime of this page instance.
  await holdLock('admob-batch-worker:'+workerId);
  const cmdKey='command:'+workerId,outKey='report:'+workerId;
  const status=document.createElement('div');status.id='abc-worker-status';
  status.style.cssText='position:fixed;bottom:8px;right:8px;z-index:2147483647;padding:10px;background:#152238;color:white;font:14px sans-serif;max-width:380px';
  status.textContent='AdMob 批量执行页：等待主控。不要手动修改此页。';document.body.append(status);
  let running=false,seen='';
  let activeJob:Job|undefined;
  let notificationReceived=false;
  listen(cmdKey,()=>{notificationReceived=true;void tick();});
  async function emit(data:Omit<Report,'id'|'at'|'workerId'>):Promise<void>{
    const r:Report={...data,id:uuid(),at:Date.now(),workerId};
    if(data.assignmentId && ['result','error'].includes(data.type)){
      const prior=get<Journal|undefined>('journal:'+data.assignmentId,undefined);
      const batchId=prior?.batchId || activeJob?.batch.id;
      if(!batchId)throw new Error('终态记录缺少批次归属，已阻止覆盖');
      set('journal:'+data.assignmentId,{assignmentId:data.assignmentId,taskId:data.taskId!,batchId,state:'done',report:r} satisfies Journal);
    }
    set(outKey,r);
    status.textContent='AdMob 批量执行页：'+(data.reason || data.stage || data.type);
    await waitFor(()=>get<Command>(cmdKey,{seq:0}).ack===r.id?true:undefined,60000,cmdKey);
  }
  async function tick():Promise<void>{
    if(running)return;
    const cmd=get<Command>(cmdKey,{seq:0});
    if(cmd.probe && seen!==cmd.probe.nonce){
      running=true;seen=cmd.probe.nonce;
      try{
        let identity,error;
        try{identity=await adapter.identify();}catch(e){error=(e as Error).message;}
        set(outKey,{id:uuid(),at:Date.now(),workerId,type:'hello',probe:{nonce:cmd.probe.nonce,locked:await lockUnavailable(cmd.probe.lockName),identity,error,notifications:notificationReceived}} satisfies Report);
      }finally{running=false;}
      return;
    }
    if(!cmd.job || seen===cmd.job.assignmentId)return;
    const job=cmd.job;
    // Controller ownership must still match the persisted batch; no worker reads a shared queue.
    const batch=get<Batch|undefined>('batch:'+job.batch.identity.publisherId+':'+job.batch.identity.appId+':'+job.batch.id,undefined);
    if(!batch || batch.controllerId!==job.batch.controllerId || !['running','paused','stopping'].includes(batch.phase))return;
    seen=job.assignmentId;running=true;activeJob=job;
    try{
      await performJob(job,adapter,emit,(beforeClick)=>{
        const latest=get<Command>(cmdKey,{seq:0});
        const control=get<Batch|undefined>('batch:'+job.batch.identity.publisherId+':'+job.batch.identity.appId+':'+job.batch.id,undefined);
        if(latest.job?.assignmentId!==job.assignmentId || !control || control.controllerId!==job.batch.controllerId)throw Object.assign(new Error('任务归属已变更，停止当前执行'),{fatal:true});
        if(latest.blocked)throw new Error(latest.blocked);
        if(control.phase!=='running')throw new Error(control.phase==='stopping'?'批次已停止，未发起提交':'批次已暂停，在提交前安全停止');
        const report=get<Report|undefined>(outKey,undefined);
        if((beforeClick || report?.type==='intent') && (!latest.grant || latest.grant.assignmentId!==job.assignmentId || latest.grant.expires<=Date.now()))throw new Error('提交许可缺失或过期，未点击创建');
      });
    }catch(e){status.textContent='执行页通信中断：'+(e as Error).message+'。保持此页，返回主控恢复核验。';}
    finally{running=false;}
  }
  setInterval(()=>void tick(),1300);await tick();
}

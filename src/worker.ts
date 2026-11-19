import type { Adapter, Batch, Task } from './types.ts';
import { classifyLookup } from './core.ts';
import { get, set, sameIdentity, uuid, waitFor, lockUnavailable, listen, holdLock, serializeSubmission } from './gm.ts';
import type { Command, Job, Journal, Report } from './protocol.ts';
import { canRecoverUnsubmitted, canSubmitPrepared } from './protocol.ts';

function ownsJournal(job:Job,journal:Journal):boolean {
  return journal.assignmentId===job.assignmentId && journal.taskId===job.task.id && journal.batchId===job.batch.id;
}
function knownId(job:Job,actual:Report['actual']):boolean {
  return !!actual?.unitId && /^ca-app-pub-\d{16}\/\d{10}$/.test(actual.unitId)
    && actual.unitId.startsWith(`ca-app-${job.batch.identity.publisherId}/`);
}
function ownsReport(job:Job,report:Report):boolean {
  return report.assignmentId===job.assignmentId && report.taskId===job.task.id && report.workerId===job.workerId;
}
function persistStage(job:Job,report:Report):void {
  const key='journal:'+job.assignmentId;
  const previous=get<Journal|undefined>(key,undefined);
  if(!previous || !ownsJournal(job,previous) || !ownsReport(job,report))throw new Error('执行进度缺少匹配的持久化分配，已阻止覆盖');
  if(previous.state==='done')return;
  const priorId=previous.report?.actual?.unitId;
  if(priorId && report.actual?.unitId && priorId!==report.actual.unitId)throw new Error('本分配已取得不同广告位 ID，保留原 ID 等待核验');
  // Empty telemetry must never erase an exact receipt while the controller
  // is frozen. A terminal report replaces this proof only after it is saved.
  if(priorId && !report.actual?.unitId)return;
  set(key,{...previous,report} satisfies Journal);
}

export async function performJob(job:Job, adapter:Adapter, emit:(r:Omit<Report,'id'|'at'|'workerId'>)=>Promise<void>, permission:(beforeClick?:boolean)=>void):Promise<void> {
  const {batch,task,assignmentId,workerId}=job;
  const journalKey='journal:'+assignmentId;
  const old=get<Journal|undefined>(journalKey,undefined);
  const report=(r:Omit<Report,'id'|'at'|'workerId'>)=>emit({...r,assignmentId,taskId:task.id});
  if(old){
    if(!ownsJournal(job,old))throw new Error('持久化分配属于其他任务或批次，禁止执行或覆盖');
    if(old.state==='done' && old.report){
      if(!ownsReport(job,old.report))throw new Error('终态回执与原任务分配不匹配，禁止覆盖');
      await report(old.report);return;
    }
    if(old.state==='intent') {
      const actual=old.report && ownsReport(job,old.report) && knownId(job,old.report.actual)
        ? {...old.report.actual,verified:false} : undefined;
      await report({type:'result',status:actual?'created-unverified':'uncertain',actual,reason:'执行页在提交意图后恢复，禁止再次点击创建；请核验真实结果'});return;
    }
    // A previous page instance cannot have clicked create without an intent journal.
    if(job.kind==='create') {await report({type:'error',status:'failed',reason:'执行页在填表期间恢复；已确认本分配没有提交意图，等待手动重试'});return;}
  }
  const checkIdentity=async()=>{
    const identity=await adapter.identify();
    if(!sameIdentity(identity,batch.identity))throw Object.assign(new Error('发布商或应用与批次不一致'),{fatal:true});
  };
  const foreground=async()=>{
    if(!job.requireForeground)return;
    await permission();
    if(document.visibilityState==='visible')return;
    await new Promise<void>((resolve,reject)=>{
      let settled=false;
      const removers:(()=>void)[]=[];
      const finish=(error?:unknown)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        document.removeEventListener('visibilitychange',check);
        for(const remove of removers)remove();
        if(error)reject(error);else resolve();
      };
      const check=()=>{try{permission();if(document.visibilityState==='visible')finish();}catch(error){finish(error);}};
      const timer=setTimeout(()=>{check();if(!settled)finish(new Error('执行页未到前台，未填写或提交广告位'));},30000);
      document.addEventListener('visibilitychange',check);
      for(const key of ['command:'+workerId,'batch:'+batch.identity.publisherId+':'+batch.identity.appId+':'+batch.id]){
        try{const remove=listen(key,check);if(settled)remove();else removers.push(remove);}catch{/* Visibility and the final safety check remain mandatory. */}
      }
      check();
    });
    await permission();
  };
  const checkpoint=async()=>{await permission();await foreground();await checkIdentity();};
  let intent=!!task.intentAt || job.kind==='verify';
  let latestActual=task.actual;
  try{
    await foreground();
    await checkIdentity();
    if(job.kind==='verify'){
      if(!task.actual?.unitId){
        await report({type:'result',status:'uncertain',reason:'缺少本次创建的广告位 ID，请保留原执行页或录入成功说明中的 ID 后核验'});
        return;
      }
      if(task.actual?.unitId && adapter.verifyById){
        try{
          const actual=await adapter.verifyById(batch.identity,task.actual.unitId,task.name,batch.format,task.floor,batch.mode ?? task.mode ?? 'manual',batch.partnerBidding);
          await report({type:'result',status:actual.verified?'success':'created-unverified',actual,reason:actual.verified?'按已知广告位 ID 核验保存配置一致':'已取得 ID，保存后配置未完整核验'});
        }catch(error){
          const e=error as Error & {actual?:Report['actual']};
          await report({type:'error',status:'created-unverified',actual:e.actual||task.actual,reason:e.message});
        }
        return;
      }
      if(batch.partnerBidding === true){
        await report({type:'result',status:'created-unverified',actual:task.actual,reason:'无法按 ID 核验合作平台出价设置，保留已知 ID'});
        return;
      }
      await adapter.home(batch.identity);
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
    await adapter.prepare(batch.identity,batch.format,task.name,task.floor,checkpoint,batch.mode ?? task.mode ?? 'manual',batch.partnerBidding);
    await report({type:'stage',stage:'filling',reason:'表单已读回，等待提交许可'});
    await checkpoint();
    if(job.parallelPreparation){
      const batchKey='batch:'+batch.identity.publisherId+':'+batch.identity.appId+':'+batch.id;
      await waitFor(()=>{
        permission();
        const current=get<Batch|undefined>(batchKey,undefined);
        if(!current || current.controllerId!==batch.controllerId || current.id!==batch.id)throw new Error('任务归属已变更，停止等待首条核验');
        if(current.phase!=='running')throw new Error('批次已暂停或停止，停止等待首条核验');
        const assigned=current.tasks.find(row=>row.id===task.id && row.assignmentId===assignmentId && row.workerId===workerId);
        if(!assigned)throw new Error('任务分配已变化，停止等待首条核验');
        return canSubmitPrepared(current,assigned)?true:undefined;
      },120000,batchKey);
      await checkpoint();
    }
    await serializeSubmission(batch.identity.publisherId,async recordClick=>{
      // Waiting workers have no grant or submit intent. Recheck cancellation
      // and ownership once the preceding worker has released the submit lock.
      await checkpoint();
      // The controller durably stores submitting + intent before acknowledging this message.
      intent=true;
      await report({type:'intent'});
      await checkpoint();
      set(journalKey,{assignmentId,taskId:task.id,batchId:batch.id,state:'intent'} satisfies Journal);
      await adapter.submit(()=>{permission(true);recordClick();});
    });
    if(adapter.waitForUnitId){
      const createdId=await adapter.waitForUnitId().catch(()=>undefined);
      if(createdId){
        if(!knownId(job,{unitId:createdId}))throw new Error('创建说明返回的广告位 ID 与本发布商不符，保留提交意图等待核验');
        const mode=batch.partnerBidding?'partner-bidding':batch.mode ?? task.mode ?? 'manual';
        latestActual={unitId:createdId,publisherId:batch.identity.publisherId,appId:batch.identity.appId,name:task.name,format:batch.format,mode,partnerBidding:batch.partnerBidding===true,floor:mode==='manual'?task.floor:'',currency:mode==='manual'?'USD':'',verified:false};
        // Capture and read back the exact receipt before any verifying report
        // or ACK can block. This proof survives a controller suspension.
        persistStage(job,{id:uuid(),at:Date.now(),workerId,assignmentId,taskId:task.id,type:'stage',stage:'created',actual:latestActual});
        await report({type:'stage',stage:'created',actual:latestActual});
      }
    }
    await report({type:'stage',stage:'verifying',actual:latestActual});
    const actual=await adapter.verify(batch.identity,batch.format,task.name,task.floor,batch.mode ?? task.mode ?? 'manual',batch.partnerBidding);
    if(latestActual?.unitId && actual.unitId!==latestActual.unitId)throw Object.assign(new Error('保存后核验返回不同广告位 ID，保留原 ID 等待核验'),{actual:{...latestActual,verified:false}});
    latestActual=actual;
    await report({type:'result',status:actual.verified?'success':'created-unverified',actual,reason:actual.verified?'保存后配置核验一致':'已取得广告位 ID，配置尚未全部核验'});
  }catch(error){
    const e=error as Error & {actual?:Report['actual'];fatal?:boolean};
    // Transport failures after a terminal result must not replace a durably saved ID/result.
    const completed=get<Journal|undefined>(journalKey,undefined);
    if(completed?.state==='done' && completed.report)return;
    let actual=latestActual?.unitId
      ? e.actual?.unitId && latestActual.unitId!==e.actual.unitId
        ? {...latestActual,verified:false}
        : {...latestActual,...e.actual,unitId:latestActual.unitId,verified:false}
      : e.actual || latestActual;
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
  const release=await holdLock('admob-batch-worker:'+workerId);
  const cmdKey='command:'+workerId,outKey='report:'+workerId;
  const status=document.createElement('div');status.id='abc-worker-status';
  status.style.cssText='position:fixed;bottom:8px;right:8px;z-index:2147483647;padding:10px;background:#152238;color:white;font:14px sans-serif;max-width:380px';
  status.textContent='AdMob 批量执行页：等待主控。不要手动修改此页。';document.body.append(status);
  let running=false,seen='',closed=false;
  let activeJob:Job|undefined;
  let lastCommand:Command={seq:0};
  let poll:ReturnType<typeof setInterval>|undefined;
  let notificationReceived=false;
  let removeListener=()=>{};
  let activationNonce='';
  const visibilityChanged=()=>{
    const command=get<Command>(cmdKey,{seq:0});
    if(!closed && !running && activationNonce && command.activate?.nonce===activationNonce)publishActivation(activationNonce);
  };
  document.addEventListener?.('visibilitychange',visibilityChanged);
  try{removeListener=listen(cmdKey,()=>{notificationReceived=true;void tick();});}
  catch{/* The hello still reports notifications:false; polling permits cleanup. */}
  if(closed)removeListener();
  function readCommand():Command {
    const command=get<Command>(cmdKey,{seq:0});
    // A diagnostic-only close must not cancel a real assignment if a caller
    // accidentally addresses a busy worker. Preserve its job and later ACKs.
    if(command.close && activeJob && !canCloseActive(command)){
      const {close:_close,...updates}=command;
      lastCommand={...lastCommand,...updates,job:command.job || lastCommand.job};
    }else{
      lastCommand=command;
      if(command.close)activeJob=undefined;
    }
    return lastCommand;
  }
  function canCloseActive(command:Command):boolean {
    if(!activeJob)return true;
    if(command.job && command.job.assignmentId!==activeJob.assignmentId)return false;
    const journal=get<Journal|undefined>('journal:'+activeJob.assignmentId,undefined);
    const terminal=journal?.report;
    if(!journal || !ownsJournal(activeJob,journal) || journal.state!=='done' || !terminal
      || !['result','error'].includes(terminal.type) || terminal.assignmentId!==activeJob.assignmentId
      || terminal.taskId!==activeJob.task.id || terminal.workerId!==workerId || command.ack!==terminal.id)return false;
    // A missing-ID submission remains on its original page even if its
    // uncertain report was acknowledged. Never close away a possible receipt.
    return knownId(activeJob,terminal.actual)
      || (terminal.status==='failed' && activeJob.kind==='create' && !activeJob.task.intentAt && !activeJob.task.actual?.unitId);
  }
  function finishRunning():void {
    running=false;
    // A command may arrive while performJob/emit is still unwinding. Drain it
    // on a microtask, so background interval throttling cannot strand the job.
    if(!closed)void Promise.resolve().then(tick).catch(e=>{status.textContent='执行页通信中断：'+(e as Error).message+'。保持此页，返回主控恢复核验。';});
  }
  function closeDiagnostic(command:Command):void {
    if(closed || activeJob)return;
    closed=true;removeListener();document.removeEventListener?.('visibilitychange',visibilityChanged);if(poll!==undefined)clearInterval(poll);
    // A restored controller has no tab handle. Keep the worker lock until
    // the browser destroys the document so a close request is not proof by itself.
    if(!command.closeAfterReload)release();
    status.textContent='AdMob 执行页已安全释放。';
    try{set(outKey,{id:uuid(),at:Date.now(),workerId,type:'closed',closingSeq:command.seq} satisfies Report);}
    finally{if(typeof window!=='undefined')window.close();}
  }
  function publishControl(data:Omit<Report,'id'|'at'|'workerId'>):void {
    set(outKey,{...data,id:uuid(),at:Date.now(),workerId} satisfies Report);
  }
  function publishActivation(nonce:string):void {
    publishControl({type:'active',activation:{nonce,visible:document.visibilityState==='visible'}});
  }
  async function emit(data:Omit<Report,'id'|'at'|'workerId'>):Promise<void>{
    const r:Report={...data,id:uuid(),at:Date.now(),workerId};
    if(data.assignmentId && data.type==='stage'){
      if(!activeJob || activeJob.assignmentId!==data.assignmentId || activeJob.task.id!==data.taskId)throw new Error('执行进度与当前任务不匹配，已阻止覆盖');
      persistStage(activeJob,r);
    }
    if(data.assignmentId && ['result','error'].includes(data.type)){
      const prior=get<Journal|undefined>('journal:'+data.assignmentId,undefined);
      const batchId=prior?.batchId || activeJob?.batch.id;
      if(!batchId)throw new Error('终态记录缺少批次归属，已阻止覆盖');
      set('journal:'+data.assignmentId,{assignmentId:data.assignmentId,taskId:data.taskId!,batchId,state:'done',report:r} satisfies Journal);
    }
    set(outKey,r);
    status.textContent='AdMob 批量执行页：'+(data.reason || data.stage || data.type);
    // Stages are durable, one-way telemetry. Submission still requires the
    // explicit intent ACK/grant; terminal ACKs keep ownership and safe cleanup.
    if(data.type==='stage')return;
    await waitFor(()=>readCommand().ack===r.id?true:undefined,60000,cmdKey);
  }
  async function tick():Promise<void>{
    if(closed)return;
    const cmd=readCommand();
    if(cmd.close){closeDiagnostic(cmd);return;}
    if(running)return;
    if(cmd.activate && activationNonce!==cmd.activate.nonce){
      activationNonce=cmd.activate.nonce;
      if(document.visibilityState!=='visible')try{window.focus();}catch{/* Focus is only a request; visibility is the evidence. */}
      publishActivation(activationNonce);
      return;
    }
    if(cmd.probe && seen!==cmd.probe.nonce){
      running=true;seen=cmd.probe.nonce;
      try{
        let identity,error;
        const expected=cmd.probe.createIdentity;
        if(expected || cmd.probe.identify!==false){
          try{
            identity=expected && adapter.identifyCreatePage?await adapter.identifyCreatePage(expected):await adapter.identify();
          }catch(e){error=(e as Error).message;}
        }
        const locked=await lockUnavailable(cmd.probe.lockName);
        const latest=get<Command>(cmdKey,{seq:0});
        if(latest.close){closeDiagnostic(latest);return;}
        // A closed/retired probe must not recreate mailboxes after cleanup,
        // even when an earlier identity read finally resolves.
        if(closed || latest.probe?.nonce!==cmd.probe.nonce)return;
        set(outKey,{id:uuid(),at:Date.now(),workerId,type:'hello',probe:{nonce:cmd.probe.nonce,locked,identity,error,notifications:notificationReceived}} satisfies Report);
      }finally{finishRunning();}
      return;
    }
    if(!cmd.job || seen===cmd.job.assignmentId)return;
    const job=cmd.job;
    activationNonce='';
    // Controller ownership must still match the persisted batch; no worker reads a shared queue.
    const batch=get<Batch|undefined>('batch:'+job.batch.identity.publisherId+':'+job.batch.identity.appId+':'+job.batch.id,undefined);
    if(!batch || !['running','paused','stopping'].includes(batch.phase))return;
    if(batch.controllerId!==job.batch.controllerId){
      // The worker lock proves the old page instance has ended. A replacement
      // controller still needs a terminal response for a matching assignment
      // that durably stopped before any grant/intent; never execute the old job.
      const journal=get<Journal|undefined>('journal:'+job.assignmentId,undefined);
      if(!canRecoverUnsubmitted(job,batch,cmd,journal))return;
      seen=job.assignmentId;running=true;activeJob=job;
      try{await emit({type:'error',assignmentId:job.assignmentId,taskId:job.task.id,status:'failed',reason:'旧主控已恢复，执行页的匹配填表记录无提交意图、结果或许可；确认未提交，等待手动重试'});}
      catch(e){status.textContent='执行页通信中断：'+(e as Error).message+'。保持此页，返回主控恢复核验。';}
      finally{finishRunning();}
      return;
    }
    seen=job.assignmentId;running=true;activeJob=job;
    try{
      await performJob(job,adapter,emit,(beforeClick)=>{
        const latest=readCommand();
        const control=get<Batch|undefined>('batch:'+job.batch.identity.publisherId+':'+job.batch.identity.appId+':'+job.batch.id,undefined);
        if(latest.job?.assignmentId!==job.assignmentId || !control || control.controllerId!==job.batch.controllerId)throw Object.assign(new Error('任务归属已变更，停止当前执行'),{fatal:true});
        if(latest.blocked)throw new Error(latest.blocked);
        if(control.phase!=='running')throw new Error(control.phase==='stopping'?'批次已停止，未发起提交':'批次已暂停，在提交前安全停止');
        if(beforeClick && job.requireForeground && document.visibilityState!=='visible')throw new Error('执行页已离开前台，未点击创建');
        const report=get<Report|undefined>(outKey,undefined);
        if((beforeClick || report?.type==='intent') && (!latest.grant || latest.grant.assignmentId!==job.assignmentId || latest.grant.expires<=Date.now()))throw new Error('提交许可缺失或过期，未点击创建');
      });
    }catch(e){status.textContent='执行页通信中断：'+(e as Error).message+'。保持此页，返回主控恢复核验。';}
    finally{finishRunning();}
  }
  if(!closed)poll=setInterval(()=>void tick(),1300);await tick();
}

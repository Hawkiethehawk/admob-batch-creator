import type { Adapter, Batch, Identity, Task } from './types.ts';
import { createBatch, classifyLookup, recoverTask, transition, exportCsv, copyPairs, decimalEqual, matchesRequestedConfiguration } from './core.ts';
import { summarizeBatch } from './history.ts';
import { mountPanel, type PanelConfig, type PanelHandle } from './panel.ts';
import { get, set, uuid, holdLock, sameIdentity, waitFor, download, listen } from './gm.ts';
import type { Command, Job, Journal, Report } from './protocol.ts';
import { reportBelongs, mayRetry, canDispatch, canSubmitPrepared, needsVerification } from './protocol.ts';
import { performJob } from './worker.ts';

interface Slot {id:string;busy?:string;since:number;lastReport?:string;tab?:{close():void;closed:boolean;focus?():void;onclose?:()=>void};probePassed?:boolean;identity?:Identity;batchId?:string;removeReportListener?:()=>void;taskId?:string;closing?:boolean;directCreate?:boolean}
class WorkerCapabilityUnavailable extends Error {}
export class Controller {
  adapter:Adapter; id=uuid(); panel!:PanelHandle; identity?:Identity; batch?:Batch;
  slots=new Map<string,Slot>(); lockRelease?:()=>void; lockedPublisher=''; tickBusy=false; actionBusy=false; reportTickPending=false;
  preflightSignature=''; lastSubmit=0; lastIdentityCheck=0; errors=0; localBusy=false; private probing=false;
  private reportWork=new Map<string,{report:Report;promise:Promise<void>}>();
  private handledReports=new Set<string>();
  private grantTail:Promise<void>=Promise.resolve();
  private cleanupWork=new Map<string,Promise<void>>();
  private identityWork?:Promise<void>;
  private cleanupError?:Error;
  private archives=new Map<string,{batch:Batch;slots:Map<string,Slot>}>();
  private archiveWork=new Map<string,Promise<void>>();
  private selectedHistoryId?:string;
  constructor(adapter:Adapter){this.adapter=adapter;}
  async init():Promise<void>{
    this.panel=mountPanel({
      identify:()=>this.action(async()=>{await this.identify();if(!this.batch)await this.load();}),preflight:c=>this.action(()=>this.preflight(c)),start:c=>this.action(()=>this.start(c)),
      pause:()=>this.pause('用户暂停'),resume:()=>this.action(()=>this.resume()),stop:()=>this.stop(),
      retry:()=>this.action(()=>this.retry()),verify:()=>this.action(()=>this.verify()),
      recordObservedId:(taskId,unitId)=>this.action(()=>this.recordObservedId(taskId,unitId)),
      verifyHistory:id=>this.action(()=>this.verifyHistory(id)),
      recordHistoryObservedId:(id,taskId,unitId)=>this.action(()=>this.recordHistoryObservedId(id,taskId,unitId)),
      history:async()=>this.refreshHistory(),
      viewHistory:async id=>{this.selectedHistoryId=id;this.panel.update({historyBatch:id?this.readHistory(id):undefined});},
      degrade:async()=>{this.requireBatch();await this.pause('用户降级单页');this.batch!.execution='single';this.batch!.concurrency=1;this.save();this.notice('已降级单页。旧执行页仍保留并继续收集结果；点击继续后，后续任务在当前页处理。');},
      switchToPaged:()=>this.action(()=>this.switchToPaged()),
      export:async(filter,id)=>{const batch=id?this.readHistory(id):this.batch;if(!batch)throw new Error('没有可导出的批次');download('AdMob-'+batch.id+'-'+filter+'.csv',exportCsv(batch,filter),'text/csv;charset=utf-8');},
      copy:async id=>{const batch=id?this.readHistory(id):this.batch;if(!batch)throw new Error('没有可复制的批次');GM_setClipboard(copyPairs(batch),'text');this.notice('已复制有真实广告位 ID 的名称与 ID');},
      diagnostics:async()=>this.diagnostics(),probe:()=>this.action(()=>this.checkCrossPage(this.panel.getConfig().execution==='paged'))
    });
    this.panel.update({capabilities:'并发模式批量打开创建页，逐页核验并关闭。串行模式使用当前页。'});
    try{await this.identify();await this.load();this.refreshHistory();}catch(e){this.panel.update({identityError:(e as Error).message});}
    setInterval(()=>void this.tick().catch(e=>this.pause('调度异常：'+(e as Error).message)),1200);
    window.addEventListener('beforeunload',()=>{
      if(this.batch?.phase==='running'){this.batch.phase='paused';this.save();}
      for(const slot of this.slots.values()){
        if(slot.directCreate && slot.tab && !slot.closing && this.safeToClose(slot)){
          const command=get<Command>('command:'+slot.id,{seq:0});
          set('command:'+slot.id,{...command,seq:command.seq+1,close:true} satisfies Command);
          slot.tab.close();
        }
      }
    });
  }
  async action(fn:()=>Promise<void>):Promise<void>{
    if(this.actionBusy)throw new Error('上一操作仍在进行');
    this.actionBusy=true;this.panel.update({busy:true});
    try{await fn();}finally{this.actionBusy=false;this.panel.update({busy:false});if(this.reportTickPending)this.reportChanged();}
  }
  private reportChanged():void{
    this.reportTickPending=true;
    this.collectArchives();
    this.drainReports();
    if(this.tickBusy || this.actionBusy)return;
    this.reportTickPending=false;
    void this.tick().catch(e=>this.pause('调度异常：'+(e as Error).message));
  }
  private drainReports():Promise<void>[] {
    const immediate:Promise<void>[]=[];
    for(const slot of this.slots.values()){
      if(slot.closing)continue;
      const report=this.savedReport(slot);
      if(!report || !['stage','intent','result','error'].includes(report.type) || report.id===slot.lastReport || this.handledReports.has(report.id))continue;
      const prior=this.reportWork.get(slot.id);
      if(prior && (prior.report.id===report.id || prior.report.type!=='intent')){
        if(prior.report.type!=='intent')immediate.push(prior.promise);
        continue;
      }
      // Terminal/created telemetry may supersede a suspended intent check.
      // That intent revalidates the current durable report before any grant.
      const batch=this.batch;
      const work={report,promise:Promise.resolve()};
      this.reportWork.set(slot.id,work);
      work.promise=Promise.resolve().then(()=>this.handle(slot,report)).catch(async error=>{
        if(this.batch===batch){try{await this.pause('报告处理异常：'+(error as Error).message);}catch{/* No permission is granted after a failed durable write. */}}
      }).finally(()=>{
        if(this.reportWork.get(slot.id)===work)this.reportWork.delete(slot.id);
        try{
          const latest=this.savedReport(slot);
          if(latest && latest.id!==report.id && !this.handledReports.has(latest.id))this.reportChanged();
        }catch{/* The next storage notification or poll retries the durable read. */}
      });
      if(report.type!=='intent')immediate.push(work.promise);
    }
    return immediate;
  }
  private addSlot(slot:Slot):void{
    this.slots.get(slot.id)?.removeReportListener?.();
    this.slots.set(slot.id,slot);
    slot.removeReportListener=listen('report:'+slot.id,()=>this.reportChanged());
  }
  private removeSlot(id:string):void{
    this.slots.get(id)?.removeReportListener?.();this.slots.delete(id);
  }
  private savedReport(slot:Slot):Report|undefined{
    const assignment=slot.busy || get<Command>('command:'+slot.id,{seq:0}).job?.assignmentId;
    const task=this.batch?.tasks.find(task=>task.assignmentId===assignment && task.workerId===slot.id);
    if(task){
      const journal=get<Journal|undefined>('journal:'+assignment,undefined);
      if(journal && journal.batchId===this.batch!.id && journal.taskId===task.id
        && journal.assignmentId===assignment && journal.report && reportBelongs(journal.report,task,slot.id)
        && ['stage','result','error'].includes(journal.report.type)){
        if(journal.state==='done' && ['result','error'].includes(journal.report.type))return journal.report;
        const mailbox=get<Report|undefined>('report:'+slot.id,undefined);
        if(journal.report.actual?.unitId && !task.actual?.unitId)return journal.report;
        if(!mailbox || !reportBelongs(mailbox,task,slot.id) || journal.report.at>=mailbox.at)return journal.report;
        return mailbox;
      }
    }
    return get<Report|undefined>('report:'+slot.id,undefined);
  }
  notice(text:string):void{this.panel.update({notice:text});}
  requireBatch():void{if(!this.batch)throw new Error('当前没有批次，请填写清单后开始创建');}
  key(batch=this.batch!):string{return 'batch:'+batch.identity.publisherId+':'+batch.identity.appId+':'+batch.id;}
  private readHistory(id:string):Batch{
    if(!this.identity || !/^[\w-]{1,100}$/.test(id))throw new Error('批次或当前应用无效');
    const batch=get<Batch|undefined>('batch:'+this.identity.publisherId+':'+this.identity.appId+':'+id,undefined);
    if(!batch || batch.schema!==1 || batch.id!==id || !sameIdentity(batch.identity,this.identity))throw new Error('未找到当前发布商与应用的历史批次');
    return batch;
  }
  refreshHistory():void{
    if(!this.identity || typeof GM_listValues!=='function')return;
    const prefix='abc:v1:batch:'+this.identity.publisherId+':'+this.identity.appId+':';
    const history=GM_listValues().filter(key=>key.startsWith(prefix)).flatMap(key=>{
      try{return [summarizeBatch(this.readHistory(key.slice(prefix.length)))];}catch{return [];}
    }).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    this.panel.update({history});
  }
  save():void{if(this.batch){
    if(this.batch.phase==='done' && this.batch.startedAt && !this.batch.completedAt)this.batch.completedAt=new Date().toISOString();
    set(this.key(),this.batch);
    const latestKey='latest:'+this.batch.identity.publisherId+':'+this.batch.identity.appId;
    if(get<string|undefined>(latestKey,undefined)!==this.batch.id)set(latestKey,this.batch.id);
    this.panel.update({batch:this.batch});
  }}
  private saveArchive(batch:Batch):void{
    if(this.batch===batch)this.save();else set(this.key(batch),batch);
    if(this.selectedHistoryId===batch.id)this.panel.update({historyBatch:batch});
    this.refreshHistory();
  }
  private matchingCommand(batch:Batch,task:Task):Command|undefined{
    if(!task.workerId || !task.assignmentId)return undefined;
    const command=get<Command|undefined>('command:'+task.workerId,undefined),job=command?.job;
    return job?.batch.id===batch.id && sameIdentity(job.batch.identity,batch.identity) && job.task.id===task.id
      && job.workerId===task.workerId && job.assignmentId===task.assignmentId?command:undefined;
  }
  private archiveStopped(batch:Batch):void{
    // Persist cancellation before revoking every queued lease. A suspended
    // worker must fail its synchronous phase/grant check before any new click.
    batch.phase='stopping';
    for(const task of batch.tasks)if(task.status==='pending' && !task.assignmentId)transition(task,'stopped','用户停止');
    set(this.key(batch),batch);
    for(const task of batch.tasks){
      const command=this.matchingCommand(batch,task);if(!command)continue;
      set('command:'+task.workerId,{...command,seq:command.seq+1,grant:undefined,blocked:'批次已停止并归档；禁止继续创建或重放原分配'} satisfies Command);
    }
    for(const task of batch.tasks)if(['pending','filling','submitting','verifying'].includes(task.status)){
      if(task.actual?.unitId && ['pending','filling'].includes(task.status))transition(task,'uncertain','已取得真实 ID，转入停止批次历史核验');
      transition(task,task.actual?.unitId?'created-unverified':'uncertain','批次已停止；原分配与提交证据保留，结果转入历史核验');
    }
    batch.phase='done';batch.completedAt ??=new Date().toISOString();
    const archive=this.archives.get(batch.id) || {batch,slots:new Map<string,Slot>()};archive.batch=batch;this.archives.set(batch.id,archive);
    if(this.batch===batch)this.grantTail=Promise.resolve();
    for(const slot of [...this.slots.values()]){
      const assignment=slot.busy || get<Command>('command:'+slot.id,{seq:0}).job?.assignmentId;
      const task=batch.tasks.find(task=>task.workerId===slot.id && task.assignmentId===assignment);
      if(!task && slot.batchId!==batch.id)continue;
      this.removeSlot(slot.id);slot.batchId=batch.id;archive.slots.set(slot.id,slot);
      if(task)slot.taskId=task.id;
      if(task && ['success','exists'].includes(task.status) && task.actual?.unitId)slot.busy=undefined;
      slot.removeReportListener=listen('report:'+slot.id,()=>this.collectArchives());
    }
    for(const task of batch.tasks)if(task.workerId && task.assignmentId && !archive.slots.has(task.workerId)){
      const slot:Slot={id:task.workerId,busy:task.assignmentId,since:Date.now(),batchId:batch.id,taskId:task.id};archive.slots.set(slot.id,slot);
      slot.removeReportListener=listen('report:'+slot.id,()=>this.collectArchives());
    }
    this.saveArchive(batch);
    const active=get<{id:string;appId:string}|undefined>('active:'+batch.identity.publisherId,undefined);
    if(active?.id===batch.id && active.appId===batch.identity.appId)GM_deleteValue('abc:v1:active:'+batch.identity.publisherId);
    this.collectArchives();
    for(const slot of archive.slots.values())this.cleanupArchivedSlot(batch,slot);
  }
  private collectArchives():void{
    for(const archive of this.archives.values())for(const slot of archive.slots.values()){
      if(slot.closing || this.archiveWork.has(slot.id))continue;
      const task=archive.batch.tasks.find(task=>task.workerId===slot.id && task.id===slot.taskId)
        || archive.batch.tasks.find(task=>task.workerId===slot.id && task.assignmentId===slot.busy);
      if(!task)continue;
      const journal=get<Journal|undefined>('journal:'+task.assignmentId,undefined),mailbox=get<Report|undefined>('report:'+slot.id,undefined);
      const durable=journal?.batchId===archive.batch.id && journal.taskId===task.id && journal.assignmentId===task.assignmentId
        && journal.report && reportBelongs(journal.report,task,slot.id)?journal.report:undefined;
      const report=durable && (journal?.state==='done' || !mailbox || !reportBelongs(mailbox,task,slot.id) || durable.at>=mailbox.at)?durable:mailbox;
      if(!report || !reportBelongs(report,task,slot.id) || !['stage','result','error'].includes(report.type) || slot.lastReport===report.id || this.handledReports.has(report.id))continue;
      const work=Promise.resolve().then(()=>this.handleArchived(archive.batch,slot,task,report)).catch(()=>{/* Durable evidence and original page remain available for history recovery. */})
        .finally(()=>{this.archiveWork.delete(slot.id);});
      this.archiveWork.set(slot.id,work);
    }
  }
  private async handleArchived(batch:Batch,slot:Slot,task:Task,report:Report):Promise<void>{
    if(!batch.stopRequestedAt || batch.phase!=='done' || !reportBelongs(report,task,slot.id))return;
    const command=this.matchingCommand(batch,task);
    // Preserve exact owned receipts even if a revoked mailbox no longer exists.
    const mismatch=!!task.actual?.unitId && !!report.actual?.unitId && task.actual.unitId!==report.actual.unitId;
    if(!['success','exists'].includes(task.status) && !mismatch && report.actual?.unitId && new RegExp(`^ca-app-${batch.identity.publisherId}/\\d{10}$`).test(report.actual.unitId))task.actual={...task.actual,...report.actual};
    const terminal=['result','error'].includes(report.type);
    if(terminal && !['success','exists'].includes(task.status)){
      let status=report.status || 'uncertain';
      if(mismatch)status='created-unverified';
      if(task.intentAt && status==='failed')status=task.actual?.unitId?'created-unverified':'uncertain';
      if(status==='success' && (task.actual?.format!==batch.format || !sameIdentity(task.actual as Identity,batch.identity)
        || !matchesRequestedConfiguration(task.actual,task.floor,batch.mode,batch.partnerBidding)))status='created-unverified';
      if(['success','exists'].includes(status) && ['submitting','uncertain','created-unverified'].includes(task.status))transition(task,'verifying','收集停止批次的迟到核验结果');
      if(status==='created-unverified' && ['pending','filling'].includes(task.status))transition(task,'uncertain','停止批次取得真实 ID，配置待核验');
      transition(task,status,mismatch?'迟到报告 ID 与原 ID 不同，保留原 ID':report.reason || '收集停止批次的迟到结果');
    }
    this.saveArchive(batch);
    // Archived progress is one-way. Only a terminal report for the still exact
    // command may be acknowledged; never reconstruct a revoked/reused mailbox.
    if(terminal && command){command.grant=undefined;command.ack=report.id;command.seq++;set('command:'+slot.id,command);slot.busy=undefined;}
    slot.lastReport=report.id;this.handledReports.add(report.id);
    if(terminal)this.cleanupArchivedSlot(batch,slot);
  }
  private cleanupArchivedSlot(batch:Batch,slot:Slot):void{
    if(!slot.tab || slot.busy || slot.closing)return;
    const command=get<Command>('command:'+slot.id,{seq:0}),task=batch.tasks.find(task=>task.workerId===slot.id && (task.id===slot.taskId || task.assignmentId===command.job?.assignmentId));
    if(task && !task.actual?.unitId && (task.intentAt || command.grant || !['failed','stopped'].includes(task.status)))return;
    if(command.job && (!task || command.job.batch.id!==batch.id || !sameIdentity(command.job.batch.identity,batch.identity)
      || (!task.actual?.unitId && (task.intentAt || command.grant || !['failed','stopped'].includes(task.status)))))return;
    // Cleanup is isolated from current-batch capacity and failures. An unknown
    // submitted receipt is kept on its exact original page indefinitely.
    slot.closing=true;
    void Promise.resolve().then(async()=>{
      set('command:'+slot.id,{...command,seq:command.seq+1,close:true} satisfies Command);
      await this.closeKnownTab(slot);slot.removeReportListener?.();this.archives.get(batch.id)?.slots.delete(slot.id);
      const latest=get<Command>('command:'+slot.id,{seq:0});
      if(!latest.job || latest.job.batch.id===batch.id && latest.job.assignmentId===command.job?.assignmentId){GM_deleteValue('abc:v1:command:'+slot.id);GM_deleteValue('abc:v1:report:'+slot.id);}
    }).catch(()=>{slot.closing=false;});
  }
  async identify():Promise<void>{
    let identity:Identity;
    try{identity=await this.adapter.identify();}
    catch(error){this.preflightSignature='';this.panel.update({identityError:(error as Error).message,ready:false});throw error;}
    if(this.batch && !sameIdentity(identity,this.batch.identity) && this.batch.phase!=='done')await this.pause('主控账号或应用已切换；批次保留在原账号和应用');
    this.identity=identity;this.panel.update({identity,identityError:''});
  }
  async acquire():Promise<void>{
    if(!this.identity)throw new Error('先识别当前账号和应用');
    if(this.batch && !['draft','done'].includes(this.batch.phase) && !sameIdentity(this.identity,this.batch.identity))throw new Error('原批次尚未结束，请返回其原发布商和应用；保留原账号主控锁及执行归属');
    if(this.lockRelease && this.lockedPublisher===this.identity.publisherId)return;
    if(this.lockRelease){this.lockRelease();this.lockRelease=undefined;this.lockedPublisher='';}
    this.lockRelease=await holdLock('admob-batch-controller:'+this.identity.publisherId);
    this.lockedPublisher=this.identity.publisherId;
    const probeKey='storage-probe:'+this.id;set(probeKey,{nonce:this.id});
    if(get<{nonce:string}>(probeKey,{nonce:''}).nonce!==this.id)throw new Error('GM 持久化检查失败');
    GM_deleteValue('abc:v1:'+probeKey);
  }
  async load():Promise<void>{
    if(!this.identity)return;
    const id=get<string|undefined>('latest:'+this.identity.publisherId+':'+this.identity.appId,undefined);
    if(!id)return;
    const batch=get<Batch|undefined>('batch:'+this.identity.publisherId+':'+this.identity.appId+':'+id,undefined);
    if(!batch || batch.schema!==1)return;
    // Do not write another live controller's state during a read-only restore.
    await this.acquire();this.batch=batch;batch.controllerId=this.id;
    if(batch.phase!=='done')batch.phase=batch.stopRequestedAt?'stopping':batch.confirmedAt?'paused':'draft';
    for(const task of batch.tasks){
      if(batch.partnerBidding===true)task.partnerBidding=true;
      const remote=!!task.workerId && !task.workerId.startsWith('single:');
      if(batch.phase!=='done' && batch.execution==='single' && task.status==='uncertain' && !task.intentAt && !task.actual
        && task.assignmentId && task.workerId?.startsWith('single:') && task.workerId!=='single:'+this.id){
        const journal=get<Journal|undefined>('journal:'+task.assignmentId,undefined);
        const command=get<Command|undefined>('command:'+task.workerId,undefined);
        if(journal?.state==='filling' && journal.assignmentId===task.assignmentId && journal.taskId===task.id && journal.batchId===batch.id && !command?.grant){
          // The prior local page instance has ended; matching durable evidence
          // proves it never reached the intent journal or received a grant.
          transition(task,'failed','旧单页实例已结束，匹配的填表记录无提交意图、结果或许可；确认未提交，可手动重试');
        }
      }
      if(!batch.stopRequestedAt && batch.phase!=='done' && remote && task.status==='filling')transition(task,'uncertain','主控已刷新，等待原执行页报告');
      else if(!batch.stopRequestedAt && ['filling','submitting','verifying'].includes(task.status))recoverTask(task);
      const journal=task.assignmentId?get<Journal|undefined>('journal:'+task.assignmentId,undefined):undefined;
      const completed=journal?.state==='done' && journal.batchId===batch.id && journal.taskId===task.id
        && journal.assignmentId===task.assignmentId && !!journal.report && reportBelongs(journal.report,task,task.workerId || '')
        && ['result','error'].includes(journal.report.type);
      if(batch.phase!=='done' && task.assignmentId && task.workerId && !['success','exists','stopped','conflict'].includes(task.status)
        && (remote || completed)){
        this.addSlot({id:task.workerId,busy:task.assignmentId,since:Date.now()});
      }
    }
    if(batch.stopRequestedAt){this.archiveStopped(batch);this.notice('已恢复已停止批次；未决结果及已知 ID 保留在历史中，可填写新清单。');return;}
    this.save();
    for(const slot of this.slots.values()){
      const report=this.savedReport(slot);
      if(report && ['result','error'].includes(report.type))await this.handle(slot,report);
    }
    this.notice(batch.phase==='draft'?'已恢复未确认草稿。检查清单后点击开始创建，将自动检查执行条件。':batch.phase==='done'?'已恢复已结束批次，可查看历史结果或填写新清单。':'已恢复历史批次并暂停。提交过或结果不确定的任务只允许先核验；点击继续才会派发尚未提交的任务。');
  }
  signature(config:PanelConfig):string{return JSON.stringify([config.format,config.partnerBidding?'disabled':config.mode ?? 'manual',config.partnerBidding ?? false,config.concurrency,config.execution,config.rows,this.identity?.publisherId,this.identity?.appId]);}
  private checkConfirmedIdentity(config:PanelConfig):void{
    if(!config.confirmedIdentity || !this.identity || !sameIdentity(config.confirmedIdentity,this.identity)){
      this.preflightSignature='';this.panel.update({ready:false});
      throw new Error('当前账号或应用与已确认的预览不一致，请核对当前页面并重新确认创建预览');
    }
  }
  private workerUrl(identity:Identity,id:string,destination:'list'|'create'):string{
    const url=new URL(typeof location==='undefined'?this.batch!.sourceUrl:location.href);
    url.pathname='/v2/apps/'+identity.appId.split('~')[1]+'/adunits/'+destination;
    url.search='';url.hash='';url.searchParams.set('__admob_batch_worker',id);
    return url.href;
  }
  private waitForProbe(slot:Slot,nonce:string,timeout=25000):Promise<Report>{
    return waitFor(()=>{
      const reply=get<Report|undefined>('report:'+slot.id,undefined);
      return reply?.workerId===slot.id && reply.type==='hello' && reply.probe?.nonce===nonce?reply:undefined;
    },timeout,'report:'+slot.id);
  }
  private async openCreatePages(identity:Identity,taskIds:readonly (string|undefined)[],batch?:Batch):Promise<Slot[]>{
    if(!taskIds.length)return [];
    const phase=batch?.phase;
    const nonce=uuid(),lockName='admob-batch-probe:'+nonce;
    const release=await holdLock(lockName);
    const slots:Slot[]=[];
    const checkBatch=()=>{
      if(batch && (this.batch!==batch || batch.phase!==phase || batch.stopRequestedAt))throw new Error('批次已变化，停止打开创建页');
    };
    try{
      if(typeof document!=='undefined' && document.getElementById('abc-panel-host')?.hasAttribute('data-manual-tabs'))throw new WorkerCapabilityUnavailable('当前环境无法自动打开创建页');
      this.notice(`正在批量打开 ${taskIds.length} 个广告单元创建页…`);
      // Request every tab in one turn. The first task is frontmost after
      // launch, and format readiness is checked on each page before dispatch.
      for(const taskId of [...taskIds].reverse()){
        checkBatch();
        const slot:Slot={id:uuid(),since:Date.now(),identity,batchId:batch?.id,taskId,directCreate:true};
        slots.push(slot);
        set('command:'+slot.id,{seq:1,probe:{nonce,lockName,identify:false}} satisfies Command);
        slot.tab=GM_openInTab(this.workerUrl(identity,slot.id,'create'),{active:true,insert:true,setParent:true});
        if(!slot.tab || typeof slot.tab.focus!=='function')throw new WorkerCapabilityUnavailable('浏览器无法切换到批量打开的创建页');
        this.addSlot(slot);
      }
      const replies=await Promise.allSettled(slots.map(slot=>this.waitForProbe(slot,nonce,5000)));
      for(const [index,reply] of replies.entries()){
        checkBatch();
        const slot=slots[index];
        let hello=reply.status==='fulfilled'?reply.value:get<Report|undefined>('report:'+slot.id,undefined);
        if(hello?.workerId!==slot.id || hello.type!=='hello' || hello.probe?.nonce!==nonce){
          // Chromium may defer loading a background tab until it is selected.
          slot.tab!.focus!();
          hello=await this.waitForProbe(slot,nonce,20000).catch(()=>{
            throw new WorkerCapabilityUnavailable('创建页启动超时，未提交广告位');
          });
        }
        if(!hello.probe?.locked)throw new WorkerCapabilityUnavailable('创建页跨页锁检查未通过');
        slot.lastReport=hello.id;slot.probePassed=true;
      }
      checkBatch();
      return slots.reverse();
    }catch(error){
      await Promise.allSettled(slots.map(slot=>this.closeProbe(slot)));
      throw error;
    }finally{release();}
  }
  private async warmPaged():Promise<void>{
    const batch=this.batch!;
    const opened=new Set([...this.slots.values()].filter(slot=>slot.batchId===batch.id && slot.probePassed && !slot.closing && !slot.tab?.closed).map(slot=>slot.taskId));
    const tasks=batch.tasks.filter(task=>task.status==='pending' && !task.assignmentId && !task.intentAt && !task.actual?.unitId && !opened.has(task.id));
    await this.openCreatePages(batch.identity,tasks.map(task=>task.id),batch);
  }
  async activatePagedSlot(slot:Slot):Promise<void>{
    if(!slot.tab || typeof slot.tab.focus!=='function' || slot.tab.closed)throw new Error('创建页缺少可用的前台切换句柄，未提交任务');
    const nonce=uuid(),command=get<Command>('command:'+slot.id,{seq:0});
    set('command:'+slot.id,{...command,seq:command.seq+1,activate:{nonce}} satisfies Command);
    slot.tab.focus();
    const report=await waitFor(()=>{const value=get<Report|undefined>('report:'+slot.id,undefined);return value?.workerId===slot.id && value.type==='active' && value.activation?.nonce===nonce && value.activation.visible?value:undefined;},10000,'report:'+slot.id);
    if(report.activation?.error)throw new Error('执行页前台切换失败：'+report.activation.error);
    if(slot.directCreate && slot.identity){
      const challenge=uuid(),lockName='admob-batch-probe:'+challenge;
      const release=await holdLock(lockName);
      try{
        set('command:'+slot.id,{seq:command.seq+2,probe:{nonce:challenge,lockName,createIdentity:slot.identity}} satisfies Command);
        const reply=await this.waitForProbe(slot,challenge);
        if(reply.probe?.error)throw new Error('创建页检查失败：'+reply.probe.error);
        if(!reply.probe?.locked || !reply.probe.notifications || !reply.probe.identity || !sameIdentity(reply.probe.identity,slot.identity))throw new Error('创建页的账号、应用或跨页通信检查未通过');
        slot.lastReport=reply.id;
      }finally{release();}
    }
  }
  private safeToClose(slot:Slot):boolean{
    if(slot.busy || slot.id.startsWith('single:'))return false;
    const command=get<Command>('command:'+slot.id,{seq:0});
    if(!command.job)return true;
    const job=command.job,batch=get<Batch|undefined>('batch:'+job.batch.identity.publisherId+':'+job.batch.identity.appId+':'+job.batch.id,undefined);
    const task=batch?.tasks.find(row=>row.id===job.task.id && row.assignmentId===job.assignmentId && row.workerId===slot.id);
    if(!task)return false;
    if(task.actual?.unitId)return true;
    if(task.intentAt || command.grant || !['failed','stopped'].includes(task.status))return false;
    const journal=get<Journal|undefined>('journal:'+job.assignmentId,undefined);
    return !!command.blocked || !!(journal?.state==='done' && journal.batchId===batch!.id && journal.taskId===task.id && journal.assignmentId===job.assignmentId
      && journal.report && reportBelongs(journal.report,task,slot.id) && journal.report.type==='error' && !journal.report.actual?.unitId);
  }
  private async closeKnownTab(slot:Slot):Promise<void>{
    if(!slot.tab)throw new Error('无法确认执行页的自有关闭句柄，保留该页及任务记录');
    const tab=slot.tab,previous=tab.onclose;
    await new Promise<void>((resolve,reject)=>{
      let settled=false;
      const finish=(error?:Error)=>{if(settled)return;settled=true;clearInterval(poll);clearTimeout(timer);tab.onclose=previous;error?reject(error):resolve();};
      const check=()=>{if(tab.closed)finish();};
      const poll=setInterval(check,250),timer=setTimeout(()=>{if(tab.closed)finish();else finish(new Error('执行页尚未确认关闭，已停止开启下一页'));},10000);
      tab.onclose=()=>{try{previous?.();}finally{check();}};
      try{tab.close();check();}catch(error){finish(error as Error);}
    });
  }
  private scheduleCleanup(slot:Slot):void{
    if(this.cleanupError || slot.closing || this.cleanupWork.has(slot.id) || !this.safeToClose(slot))return;
    const batch=this.batch;slot.closing=true;
    const work=Promise.resolve().then(async()=>{
      const command=get<Command>('command:'+slot.id,{seq:0});
      if(slot.tab){
        set('command:'+slot.id,{...command,seq:command.seq+1,close:true} satisfies Command);
        await this.closeKnownTab(slot);
      }else{
        const seq=command.closeAfterReload?command.seq:command.seq+1;
        if(!command.closeAfterReload)set('command:'+slot.id,{...command,seq,close:true,closeAfterReload:true} satisfies Command);
        await waitFor(()=>{
          const report=get<Report|undefined>('report:'+slot.id,undefined);
          return report?.workerId===slot.id && report.type==='closed' && report.closingSeq===seq?report:undefined;
        },10000,'report:'+slot.id);
        await navigator.locks.request('admob-batch-worker:'+slot.id,{signal:AbortSignal.timeout(10000)},()=>{});
      }
      this.removeSlot(slot.id);GM_deleteValue('abc:v1:command:'+slot.id);GM_deleteValue('abc:v1:report:'+slot.id);
    }).catch(async error=>{
      slot.closing=false;this.cleanupError=error as Error;
      if(this.batch===batch){try{await this.pause('执行页清理未完成：'+(error as Error).message);}catch{/* The page and evidence are retained. */}}
    }).finally(()=>{this.cleanupWork.delete(slot.id);this.reportChanged();});
    this.cleanupWork.set(slot.id,work);
  }
  private cleanupIdlePages():void{
    for(const slot of [...this.slots.values()].reverse()){
      if(!slot.busy && !slot.id.startsWith('single:') && (slot.tab || this.batch?.execution==='paged' && get<Command>('command:'+slot.id,{seq:0}).job)){
        this.scheduleCleanup(slot);
      }
    }
  }
  async switchToPaged():Promise<void>{
    this.requireBatch();await this.identify();await this.acquire();
    if(this.batch!.phase!=='paused' || this.localBusy || [...this.slots.values()].some(slot=>!!slot.busy)
      || this.batch!.tasks.some(task=>needsVerification(task) && !['success','exists'].includes(task.status)))throw new Error('请先收齐并核验已有提交结果，再切换逐页创建；原任务不会重新创建。');
    this.cleanupIdlePages();await Promise.all(this.cleanupWork.values());if(this.cleanupError)throw this.cleanupError;
    this.batch!.execution='paged';this.batch!.concurrency=1;this.preflightSignature='';this.save();
    this.notice('已改为并发；继续后批量打开创建页，再逐页创建、核验并关闭。');
  }
  private async warmPool(target:number):Promise<void>{
    const existing=new Set(this.slots.keys());
    const ready=[...this.slots.values()].filter(slot=>!slot.busy && slot.probePassed && !slot.tab?.closed && slot.batchId===this.batch?.id && slot.identity && this.identity && sameIdentity(slot.identity,this.identity)).length;
    try{
      for(let index=ready;index<target;index++){
        this.notice(`正在预热执行页 ${index+1}/${target}：检查跨页锁、通知及账号（不提交）…`);
        await this.probe(true,false,`预热执行页 ${index+1}/${target}`);
      }
    }catch(error){
      // A failed warm-up has not dispatched jobs. Dispose the pages created
      // by this attempt, including pages opened through the manual link.
      for(const slot of [...this.slots.values()])if(!existing.has(slot.id) && !slot.busy)await this.closeProbe(slot);
      throw error;
    }
  }
  async preflight(config:PanelConfig):Promise<void>{
    if(this.batch?.phase==='paused'){
      // Re-check the persisted batch without replacing tasks, assignments or IDs.
      // Floors and USD are already fixed by the batch; no separate confirmation is needed.
      await this.identify();await this.acquire();
      const unresolved=this.batch.tasks.filter(t=>needsVerification(t) && !['success','exists'].includes(t.status)).length;
      if(!unresolved && this.batch.execution==='tabs'){
        const pending=this.batch.tasks.filter(task=>task.status==='pending' && !task.assignmentId).length;
        await this.warmPool(Math.min(this.batch.concurrency,pending));
      }
      if(!unresolved && this.batch.execution==='paged')await this.warmPaged();
      this.panel.update({ready:false,checks:[
        {label:'已重新核对批次原发布商和应用，主控锁有效',ok:true},
        {label:'保留原清单、已知 ID、提交意图和执行归属；本次不提交',ok:true},
        {label:unresolved?`${unresolved} 条提交结果或配置待核验，请先点击“核验结果不确定项”`:'没有待核验的提交结果',ok:unresolved===0},
        {label:this.batch.partnerBidding?'按批次合作平台出价设置创建并核验，无需填写底价':this.batch.mode==='manual'?'底价按已确定的逐行金额与整批 USD 使用，无需单独确认':'按批次已确定的底价模式创建，无需填写金额',ok:true},
      ]});
      this.notice('暂停批次检查完成。'+(unresolved?'请先核验已有提交，核验通过后再继续。':'点击继续执行尚未提交的任务，按批次底价模式保存并核验。'));
      return;
    }
    if(this.batch && this.batch.phase!=='done' && this.batch.phase!=='draft')throw new Error('请先处理当前批次；不能覆盖未完成批次');
    if(!config.rows.length || config.rows.some(r=>r.errors.length))throw new Error('请先修正创建清单中的全部行级错误');
    const requestedMode=config.partnerBidding?'disabled':config.mode ?? 'manual';
    this.preflightSignature='';this.panel.update({ready:false});
    this.cleanupIdlePages();await Promise.all(this.cleanupWork.values());if(this.cleanupError)throw this.cleanupError;
    for(const [id,slot] of this.slots)if(!slot.busy && !slot.tab)this.removeSlot(id);
    this.notice('预检：确认当前账号、主控锁和输入…');
    await this.identify();
    if(config.confirmedIdentity)this.checkConfirmedIdentity(config);
    await this.acquire();
    const active=get<{appId:string;id:string}|undefined>('active:'+this.identity!.publisherId,undefined);
    if(active && active.id!==this.batch?.id){
      const old=get<Batch|undefined>('batch:'+this.identity!.publisherId+':'+active.appId+':'+active.id,undefined);
      if(old?.stopRequestedAt)this.archiveStopped(old);
      else if(old && old.phase!=='done')throw new Error('此发布商还有未完成批次，请进入原应用恢复：'+active.appId);
    }
    let canaryEvidence:Batch['canaryEvidence'];
    const previous=this.batch;
    if(config.execution==='tabs' && previous?.phase==='done' && sameIdentity(previous.identity,this.identity!) && previous.format===config.format && previous.mode===requestedMode && (previous.partnerBidding ?? false)===(config.partnerBidding ?? false) && this.adapter.verifyById){
      const sample=previous.tasks.find(task=>task.status==='success' && task.actual?.verified===true
        && sameIdentity(task.actual as Identity,this.identity!) && task.actual.format===config.format
        && task.actual.name===task.name && matchesRequestedConfiguration(task.actual,task.floor,previous.mode,previous.partnerBidding)
        && new RegExp(`^ca-app-${this.identity!.publisherId}/\\d{10}$`).test(task.actual.unitId||''));
      if(sample){
        this.notice('预检：按 ID 只读复核历史成功样本，确认后让新清单直接并发…');
        try{
        const actual=await this.adapter.verifyById(this.identity!,sample.actual!.unitId!,sample.name,config.format,sample.floor,previous.mode,previous.partnerBidding);
        if(!actual.verified || !sameIdentity(actual,this.identity!) || actual.unitId!==sample.actual!.unitId
          || actual.name!==sample.name || actual.format!==config.format || !matchesRequestedConfiguration(actual,sample.floor,previous.mode,previous.partnerBidding))throw new Error('历史样本配置已变化');
        canaryEvidence={sourceBatchId:previous.id,unitId:actual.unitId,verifiedAt:new Date().toISOString()};
        }catch{
          // Deleted, inaccessible or changed historical units are not prerequisites for new work.
          // Re-identify below; without a valid sample this batch validates its own first row.
          await this.adapter.home(previous.identity);await this.identify();await this.acquire();
          if(!sameIdentity(previous.identity,this.identity!))throw new Error('历史样本检查期间账号或应用发生变化，已停止');
          this.notice('历史样本不可用，本批先核验首条再扩展并发。');
        }
      }
    }
    const batch=createBatch(config.rows,this.identity!,config.format,config.concurrency,config.execution,location.href,this.id,requestedMode,config.partnerBidding ?? false);
    if(canaryEvidence){batch.canaryPassed=true;batch.canaryEvidence=canaryEvidence;}
    this.batch=batch;
    for(const task of batch.tasks){
      // AdMob permits duplicate names. The preflight must not search the list
      // or block on same-name/config/filter results: each row is a create
      // request, and the new ID is captured after submit.
      transition(task,'pending','AdMob 允许重名；预检不查询同名，创建后立即记录新广告位 ID');
    }
    // The synchronous preflight loop cannot submit; persist every row/log together.
    this.save();
    this.refreshHistory();
    if(config.execution==='tabs'){
      // Warm distinct pages before dispatch so opening and probing a cold page
      // cannot hold up collection of another worker's submitted result.
      await this.warmPool(batch.concurrency);
    }else if(config.execution==='paged')await this.warmPaged();
    this.preflightSignature=this.signature(config);
    const pending=batch.tasks.filter(t=>t.status==='pending').length;
    const blocked=batch.tasks.filter(t=>['uncertain','conflict'].includes(t.status)).length;
    this.panel.update({ready:pending>0,checks:[{label:'已固定发布商及应用',ok:true},{label:'创建清单有效',ok:true},{label:'AdMob 允许重名；检查不查询同名、不阻止创建',ok:true},{label:blocked?`${blocked} 行冲突/待核验，不会提交`:'无冲突或待核验项',ok:blocked===0},{label:batch.partnerBidding?'按合作平台出价设置创建，保存后核验此设置':batch.mode==='manual'?'底价按已确定的逐行金额与整批 USD 使用，执行时自动填写和读回':'按所选底价模式创建，保存后核验模式',ok:true},{label:canaryEvidence?'历史成功样本已按 ID 复核，新清单可直接并发；每行仍独立保存后核验':batch.execution==='tabs'?'先并行准备表单，首条核验通过后放行其他提交':'按行创建并核验',ok:true},{label:batch.execution==='tabs'?`${batch.concurrency} 个执行页已完成前台启动，跨页互斥、通知及账号检查均通过`:batch.execution==='paged'?`${pending} 个任务页已预开并通过检查；逐页切到前台，核验并确认关闭后进入下一页`:'单页执行；已取得账号主控锁',ok:true}]});
    this.notice('执行条件检查通过。待创建 '+pending+' 条；AdMob 允许重名，每行创建后立即记录新 ID，并核验保存后的'+(batch.partnerBidding?'合作平台出价设置。':'底价模式及配置。'));
  }
  async checkCrossPage(checkFocus=false):Promise<void>{
    if(this.batch && ['running','stopping'].includes(this.batch.phase) || [...this.slots.values()].some(slot=>!!slot.busy))throw new Error('当前批次仍在执行或收集结果，暂不进行独立跨页检查；不会中断已有任务。');
    const hadLock=!!this.lockRelease;
    this.notice('跨页检查 1/3：正在识别当前账号和应用（不创建广告位）…');
    try{
      const identity=await this.adapter.identify();
      if(this.batch && this.batch.phase!=='done' && !sameIdentity(identity,this.batch.identity))throw new Error('当前应用与未结束批次不一致；请回到原应用后检查，原批次保持不变。');
      this.identity=identity;this.panel.update({identity,identityError:''});
      this.notice('跨页检查 1/3：正在检查主控锁和 GM 存取…');
      await this.acquire();
      if(checkFocus){
        const probes=await this.openCreatePages(identity,[undefined,undefined]);
        try{
          for(const slot of probes)await this.activatePagedSlot(slot);
        }finally{
          const closed:boolean[]=[];
          for(const slot of probes.reverse())closed.push(await this.closeProbe(slot));
          if(closed.includes(false))throw new Error('部分诊断执行页尚未确认关闭');
        }
        this.notice('跨页检查通过：已批量打开两个创建页，均完成前台核对和关闭。');
      }else await this.probe(true,true,'跨页检查');
    }catch(error){this.notice('跨页检查失败：'+(error as Error).message);throw error;}
    finally{
      if(!hadLock && this.lockRelease){this.lockRelease();this.lockRelease=undefined;this.lockedPublisher='';}
    }
  }
  private async closeProbe(slot:Slot):Promise<boolean>{
    // Only a read-only probe may be discarded. Never clear a real assignment.
    if(slot.busy)return false;
    let mayClean=false;
    try{
      const command=get<Command>('command:'+slot.id,{seq:0});
      if(command.job)return false;
      set('command:'+slot.id,{seq:command.seq+1,close:true} satisfies Command);
      // GM may return a handle without delivering its page. The connected page
      // can instead be the user's manual fallback, so let it acknowledge close
      // before deleting the command, even when an automatic handle exists.
      const disconnected=slot.lastReport?await waitFor(()=>get<Report|undefined>('report:'+slot.id,undefined)?.type==='closed'?true:undefined,1500,'report:'+slot.id).catch(()=>false):false;
      if(slot.tab){await this.closeKnownTab(slot);mayClean=true;return true;}
      mayClean=disconnected;return disconnected;
    }catch{
      // Even a storage readback fault must not leave a known diagnostic tab.
      try{if(slot.tab){await this.closeKnownTab(slot);mayClean=true;return true;}}catch{/* Retain unconfirmed closure evidence. */}
      if(slot.tab && !slot.tab.closed){this.cleanupError=new Error('执行页未确认关闭，保留其归属并停止后续开页');if(!this.slots.has(slot.id))this.addSlot(slot);}
      return false;
    }
    finally{
      if(mayClean){
        try{this.removeSlot(slot.id);}catch{this.slots.delete(slot.id);}
        for(const key of ['command:','report:'])try{GM_deleteValue('abc:v1:'+key+slot.id);}catch{/* Cleanup must not replace the diagnostic result. */}
      }
    }
  }
  async probe(forceNew=false,diagnostic=false,label='执行页连接',taskId?:string):Promise<Slot>{
    if(!this.identity)throw new Error('未识别账号');
    const reusable=[...this.slots.values()].find(s=>!s.busy && s.probePassed && !s.tab?.closed && s.identity && sameIdentity(s.identity,this.identity!) && s.batchId===this.batch?.id);
    if(reusable && !forceNew && !diagnostic)return reusable;
    if(this.probing)throw new Error('执行页连接检查仍在进行，请等待本次结果。');
    this.probing=true;
    const identity=structuredClone(this.identity);
    const nonce=uuid(),lockName='admob-batch-probe:'+nonce;
    let release=()=>{},started=false,passed=false,stage='启动';
    const slot:Slot={id:uuid(),since:Date.now(),identity,batchId:diagnostic?undefined:this.batch?.id,taskId};
    try{
      release=await holdLock(lockName);
      if(!diagnostic)this.addSlot(slot);
      // Keep the current origin for Web Locks and open the identified app's
      // canonical list, rather than a stale create/detail URL from an old batch.
      const url=this.workerUrl(identity,slot.id,'list');
      started=true;set('command:'+slot.id,{seq:1,probe:{nonce,lockName,identify:false}} satisfies Command);
      const startupTimeout=25000;
      this.panel.update({workerUrl:diagnostic?url:''});
      let automatic=true;
      this.notice(diagnostic?`${label} 2/3：已请求前台打开执行页，等待启动回应。也可点击“打开执行页”手动连接（不提交）…`:`${label} 2/3：正在前台打开执行页并自动检查。保持所选并行模式；当前不提交广告位。`);
      try{
        if(typeof document!=='undefined' && document.getElementById('abc-panel-host')?.hasAttribute('data-manual-tabs'))automatic=false;
        else slot.tab=GM_openInTab(url,{active:true,insert:true,setParent:true});
      }catch{automatic=false;}
      if(!automatic){
        if(!diagnostic)throw new WorkerCapabilityUnavailable('并行启动失败：当前环境未能自动打开执行页，已保留并行配置且未提交。可选择串行模式后重新确认。');
        this.notice(`${label} 2/3：自动打开不可用，请点击“打开执行页”；连接后继续检查，25 秒内等待手动连接，不提交广告位。`);
      }
      const openedAt=Date.now();let remaining=-1;
      const first=await waitFor(()=>{
        const r=get<Report|undefined>('report:'+slot.id,undefined);
        if(r?.workerId===slot.id && r.type==='hello' && r.probe?.nonce===nonce)return r;
        const elapsed=Date.now()-openedAt,seconds=Math.max(0,Math.ceil((startupTimeout-elapsed)/1000));
        if(elapsed>=3000 && seconds!==remaining){remaining=seconds;this.notice(diagnostic?`${label} 2/3：${automatic?'自动打开尚未收到执行页回应':'等待手动打开执行页'}。请点击“打开执行页”，保持新页加载；还可等待 ${seconds} 秒。当前未提交广告位。`:`${label} 2/3：前台执行页尚未回应，还可等待 ${seconds} 秒；未派发创建任务，保持并行配置。`);}
        return undefined;
      },startupTimeout,'report:'+slot.id);
      slot.lastReport=first.id;
      if(first.probe?.error)throw /超时|timeout/i.test(first.probe.error)?new WorkerCapabilityUnavailable('执行页账号识别超时：'+first.probe.error):new Error('执行页已连接，但账号识别失败：'+first.probe.error);
      // The initial command predates the worker listener. A second challenge
      // verifies an actual remote GM value-change notification after startup.
      stage='通知及身份';
      this.notice(`${label} 3/3：执行页已回应，正在检查跨页锁、GM 通知和同一账号/应用（不提交）…`);
      const challenge=uuid();
      set('command:'+slot.id,{seq:2,probe:{nonce:challenge,lockName,identify:true}} satisfies Command);
      const report=await this.waitForProbe(slot,challenge);
      if(report.probe?.identity && !sameIdentity(report.probe.identity,identity) || !this.identity || !sameIdentity(this.identity,identity))throw new Error('执行页账号或应用检查失败：与本次主控身份不一致，未派发任何新任务。');
      if(report.probe?.error)throw /超时|timeout/i.test(report.probe.error)?new WorkerCapabilityUnavailable('执行页账号识别超时：'+report.probe.error):new Error('执行页账号识别失败：'+report.probe.error);
      if(!report.probe?.locked)throw new WorkerCapabilityUnavailable('跨页锁能力检查未通过');
      if(!report.probe.notifications)throw new WorkerCapabilityUnavailable('GM 通知能力检查未通过');
      if(!report.probe.identity)throw new WorkerCapabilityUnavailable('执行页未完成账号身份读取');
      slot.probePassed=true;slot.lastReport=report.id;passed=true;
      this.notice(diagnostic?'跨页检查通过：执行页连接、跨页锁、GM 通知和账号均正常；未创建广告位，正在清理诊断页。':`${label}通过：连接、跨页锁、GM 通知和账号均正常；尚未提交广告位。`);return slot;
    }catch(error){
      const message=(error as Error).message;
      const timedOut=message.includes('跨页通信等待超时');
      const detail=timedOut?(stage==='启动'?(diagnostic?'执行页启动超时：25 秒内未收到新页回应。自动开页未建立连接；可重新检查并在等待期间点击“打开执行页”，或改为单页模式。':'并行启动超时：前台开页后 25 秒内未收到执行页回应；已保留并行配置，未提交广告位。可选择串行模式后重新确认。'):'通知及账号检查超时：执行页已启动，但 25 秒内未完成 GM 通知和身份回读'):message;
      this.notice(`${label}失败：${detail}`);throw timedOut || error instanceof WorkerCapabilityUnavailable?new WorkerCapabilityUnavailable(detail):new Error(detail);
    }finally{
      let disconnected=false;
      try{
        if(started && (diagnostic || !passed))disconnected=await this.closeProbe(slot);
        else if(!passed)this.removeSlot(slot.id);
      }finally{
        this.probing=false;try{release();}finally{this.panel.update({workerUrl:''});}
      }
      if(diagnostic && passed)this.notice('跨页检查通过：执行页连接、跨页锁、GM 通知和账号均正常；未创建广告位。'+(disconnected?'诊断连接已释放。':'已请求关闭诊断页；如页面仍打开，可手动关闭。'));
    }
  }
  async start(config:PanelConfig):Promise<void>{
    const requestedAt=new Date().toISOString();
    if(this.batch && !['draft','done'].includes(this.batch.phase))throw new Error('当前批次尚未结束，请使用暂停、继续或停止');
    // The confirmation belongs to the identity the user saw, never whichever
    // application happens to be selected when asynchronous preflight finishes.
    this.checkConfirmedIdentity(config);
    if(!this.batch || this.batch.phase!=='draft' || this.preflightSignature!==this.signature(config))await this.preflight(config);
    this.requireBatch();await this.identify();this.checkConfirmedIdentity(config);await this.acquire();
    if(this.batch!.phase!=='draft' || this.preflightSignature!==this.signature(config))throw new Error('输入或账号已变化，请检查清单后重新点击开始创建');
    this.batch!.startedAt=requestedAt;delete this.batch!.completedAt;
    this.batch!.confirmedAt=new Date().toISOString();this.batch!.phase='running';set('active:'+this.batch!.identity.publisherId,{appId:this.batch!.identity.appId,id:this.batch!.id});this.save();
    this.refreshHistory();
    this.notice(this.batch!.execution==='paged'?'并发批次已开始。创建页已批量打开，插件将逐页核对、创建、核验并关闭。':this.batch!.execution==='single'?'批次已开始，在当前页逐条创建并核验。':this.batch!.canaryEvidence?'并行批次已开始。历史成功样本已重新核验，各页准备和核验并发，提交按账号间隔执行。':'并行批次已开始。各执行页同时准备表单，首条保存后核验通过后自动放行其他提交。');
  }
  async pause(reason:string):Promise<void>{
    if(this.batch?.phase==='draft'){this.preflightSignature='';this.panel.update({ready:false});}
    if(this.batch?.phase==='running'){this.batch.phase='paused';this.save();}
    this.notice(reason+'。停止派发，已提交任务继续收集结果。');
  }
  async stop():Promise<void>{
    this.requireBatch();const batch=this.batch!;batch.stopRequestedAt ??=new Date().toISOString();batch.phase='stopping';
    this.preflightSignature='';this.panel.update({ready:false});
    this.save();this.archiveStopped(batch);
    this.notice('批次已停止并归档，可填写新清单。未决结果、已知 ID 和原执行页保留，可在历史中只读核验。');
  }
  async resume():Promise<void>{
    this.requireBatch();await this.identify();await this.acquire();
    if(this.batch!.stopRequestedAt)throw new Error('批次已停止；先核验已提交结果，或明确点击重试尚未提交的失败项');
    if(!this.batch!.confirmedAt)throw new Error('草稿尚未确认开始；检查清单后点击开始创建');
    if(!sameIdentity(this.identity!,this.batch!.identity))throw new Error('请回到批次原发布商与原应用');
    if(this.batch!.phase==='stopping')throw new Error('批次已停止；仅可核验已有提交或重试明确失败项');
    if(this.batch!.phase!=='paused')throw new Error('只有已暂停且已确认的批次可以继续');
    const unresolved=this.batch!.tasks.filter(t=>needsVerification(t) && !['success','exists'].includes(t.status));
    if(unresolved.length)throw new Error(`还有 ${unresolved.length} 条提交结果或配置待核验；请先点击“核验结果不确定项”，核验通过后再继续`);
    await Promise.all(this.cleanupWork.values());
    if(this.cleanupError){this.cleanupError=undefined;this.cleanupIdlePages();await Promise.all(this.cleanupWork.values());if(this.cleanupError)throw this.cleanupError;}
    if(this.batch!.execution==='paged')await this.warmPaged();
    this.batch!.phase='running';this.errors=0;this.save();
    this.notice('批次已继续。执行尚未提交的任务，按批次底价模式保存并核验，页面明确冲突时会报告。');
  }
  async retry():Promise<void>{
    this.requireBatch();
    if(this.batch!.stopRequestedAt)throw new Error('已停止批次仅可在历史中核验或导出；请填写新清单创建新批次');
    if(this.batch!.phase==='running')throw new Error('请先暂停后重试明确失败项');
    if([...this.slots.values()].some(slot=>slot.busy))throw new Error('旧执行页尚未收齐结果，请先保留原页并完成收集或核验');
    let count=0;
    for(const t of this.batch!.tasks)if(mayRetry(t)){t.assignmentId=undefined;t.workerId=undefined;transition(t,'pending','用户重试：尚无提交意图');count++;}
    if(count>0){delete this.batch!.stopRequestedAt;delete this.batch!.completedAt;this.batch!.phase='paused';}
    this.save();this.notice('已准备 '+count+' 条安全重试项（最多三次，按尝试次数退避）；'+(count>0?'点击继续后执行。':'保持原批次状态。'));
  }
  async recordObservedId(taskId:string,unitId:string):Promise<void>{
    this.requireBatch();
    if(this.batch!.phase!=='paused')throw new Error('请先暂停批次，再录入已观察到的广告位 ID');
    const task=this.batch!.tasks.find(task=>task.id===taskId);
    if(!task || !task.intentAt || !needsVerification(task) || !['uncertain','created-unverified','submitting','verifying'].includes(task.status))throw new Error('只有已有提交意图且结果待核验的任务可录入已观察 ID');
    const observed=unitId.trim();
    if(!/^ca-app-pub-\d{16}\/\d{10}$/.test(observed) || !observed.startsWith(`ca-app-${this.batch!.identity.publisherId}/`))throw new Error('广告位 ID 格式无效或与批次发布商不匹配');
    if(task.actual?.unitId && task.actual.unitId!==observed)throw new Error('已知广告位 ID 与录入值不同；保留原 ID，禁止覆盖');
    task.actual={...task.actual,unitId:observed,publisherId:this.batch!.identity.publisherId,appId:this.batch!.identity.appId,verified:false};
    transition(task,'created-unverified','已记录用户观察到的广告位 ID；保存后配置待核验');
    this.save();
    await this.verify();
  }
  private async stoppedHistory(id:string):Promise<Batch>{
    if(this.localBusy || this.batch && ['running','stopping'].includes(this.batch.phase))throw new Error('当前批次仍在执行，请暂停并收齐结果后再核验历史');
    await this.identify();await this.acquire();
    const stored=this.readHistory(id);
    if(stored.phase!=='done' || !stored.stopRequestedAt)throw new Error('仅可只读恢复已停止的历史批次');
    const batch=this.batch?.id===id?this.batch:this.archives.get(id)?.batch || stored;
    if(!this.archives.has(id)){
      const archive={batch,slots:new Map<string,Slot>()};this.archives.set(id,archive);
      for(const task of batch.tasks)if(task.workerId && task.assignmentId){
        const slot:Slot={id:task.workerId,busy:task.assignmentId,since:Date.now(),batchId:id,taskId:task.id};archive.slots.set(slot.id,slot);
        slot.removeReportListener=listen('report:'+slot.id,()=>this.collectArchives());
      }
    }
    this.collectArchives();await Promise.all(this.archiveWork.values());
    return batch;
  }
  async recordHistoryObservedId(id:string,taskId:string,unitId:string):Promise<void>{
    const batch=await this.stoppedHistory(id),task=batch.tasks.find(task=>task.id===taskId),observed=unitId.trim();
    if(!task || !task.intentAt || !needsVerification(task) || ['success','exists'].includes(task.status))throw new Error('只有已有提交意图且结果待核验的历史任务可录入 ID');
    if(!/^ca-app-pub-\d{16}\/\d{10}$/.test(observed) || !observed.startsWith(`ca-app-${batch.identity.publisherId}/`))throw new Error('广告位 ID 格式无效或与历史批次发布商不匹配');
    if(task.actual?.unitId && task.actual.unitId!==observed)throw new Error('已知广告位 ID 与录入值不同；保留原 ID，禁止覆盖');
    task.actual={...task.actual,unitId:observed,publisherId:batch.identity.publisherId,appId:batch.identity.appId,verified:false};
    transition(task,'created-unverified','已记录历史任务观察到的广告位 ID，等待只读核验');this.saveArchive(batch);
    await this.verifyStoppedHistory(batch);
  }
  async verifyHistory(id:string):Promise<void>{await this.verifyStoppedHistory(await this.stoppedHistory(id));}
  private async verifyStoppedHistory(batch:Batch):Promise<void>{
    if(this.localBusy)throw new Error('当前页面仍在收集执行结果，请稍后核验历史');
    this.localBusy=true;
    try{
      for(const task of batch.tasks.filter(task=>needsVerification(task) && !['success','exists'].includes(task.status))){
        const knownId=task.actual?.unitId;
        if(!knownId){this.saveArchive(batch);continue;}
        if(!new RegExp(`^ca-app-${batch.identity.publisherId}/\\d{10}$`).test(knownId))continue;
        if(!this.adapter.verifyById){task.reason='历史任务需要按已知 ID 核验，当前页面暂不支持；原记录保留';this.saveArchive(batch);continue;}
        transition(task,'verifying','只读核验已停止历史批次的真实 ID');
        try{
          const actual=await this.adapter.verifyById(batch.identity,knownId,task.name,batch.format,task.floor,batch.mode,batch.partnerBidding);
          if(['success','exists'].includes(task.status))continue;
          if(actual.unitId!==knownId){transition(task,'created-unverified','详情返回不同 ID，保留历史原 ID，禁止重新创建');}
          else{
            task.actual=actual;
            const verified=actual.verified && sameIdentity(actual,batch.identity) && actual.format===batch.format
              && matchesRequestedConfiguration(actual,task.floor,batch.mode,batch.partnerBidding);
            transition(task,verified?'success':'created-unverified',verified?'历史批次已按真实 ID 核验保存配置':'历史真实 ID 配置尚未完整核验');
          }
        }catch(error){if(!['success','exists'].includes(task.status))transition(task,'created-unverified','历史只读核验失败：'+(error as Error).message+'；保留原 ID，禁止重新创建');}
        this.saveArchive(batch);
      }
      await this.adapter.home(batch.identity);await this.identify();
      this.notice('历史只读核验结束；已停止批次保持归档，原未决结果及 ID 保留，不会恢复创建。');
    }finally{this.localBusy=false;this.saveArchive(batch);}
  }
  async verify():Promise<void>{
    this.requireBatch();await this.identify();await this.acquire();
    if(this.batch!.phase==='running')await this.pause('核验不确定结果');
    const tasks=this.batch!.tasks.filter(t=>needsVerification(t) && !['success','exists'].includes(t.status));
    if(!tasks.length){this.notice('没有待核验的提交');return;}
    // Read-only verification can run locally without reopening or resubmitting a create form.
    if(this.localBusy)throw new Error('单页执行仍在收集结果，请稍后核验');
    this.localBusy=true;
    try{for(const task of tasks){
      if(task.status!=='verifying')transition(task,'verifying','只读核验平台真实结果');
      try{
      // A receipt on the controller page can belong to an older same-name
      // unit. Only an assigned worker report or an explicitly recorded ID
      // establishes which unit to verify; page contents alone cannot do so.
      const knownId=task.actual?.unitId;
      if(knownId && this.adapter.verifyById){
        const actual=await this.adapter.verifyById(this.batch!.identity,knownId,task.name,this.batch!.format,task.floor,this.batch!.mode,this.batch!.partnerBidding);
        if(actual.unitId!==knownId){
          transition(task,'created-unverified','保存详情返回的 ID 与已知 ID 不一致；保留原 ID，禁止重新创建');
          this.save();continue;
        }
        task.actual=actual;
        if(actual.verified && sameIdentity(actual,this.batch!.identity) && actual.format===this.batch!.format
          && matchesRequestedConfiguration(actual,task.floor,this.batch!.mode,this.batch!.partnerBidding)){
          transition(task,'success','已按已知 ID 核验保存配置');
          this.batch!.canaryPassed=true;
          if(task.workerId){const slot=this.slots.get(task.workerId);if(slot){const command=get<Command>('command:'+slot.id,{seq:0});set('command:'+slot.id,{seq:command.seq+1,blocked:'此任务已由主控完成只读核验，原创建分配已撤销'} satisfies Command);slot.busy=undefined;slot.probePassed=false;}}
        }else transition(task,'created-unverified','已取得 ID，保存后配置未完整核验');
        this.save();continue;
      }
      if(!knownId){
        transition(task,'uncertain','缺少本次创建的广告位 ID，请保留原执行页或录入成功说明中的 ID 后核验');
        this.save();continue;
      }
      if(this.batch!.partnerBidding === true){
        transition(task,'created-unverified','无法按 ID 核验合作平台出价设置，保留已知 ID');
        this.save();continue;
      }
      const lookup=await this.adapter.lookup(this.batch!.identity,task.name);
      const c=classifyLookup(lookup,this.batch!.identity,this.batch!.format,task.name,task.floor,this.batch!.mode);
      if(c.status==='exists'){
        const prior=task.actual?.unitId;
        if(prior && c.actual?.unitId!==prior){transition(task,'created-unverified','同名条目 ID 与已取得 ID 不符，保留原记录等待人工核验');this.save();continue;}
        task.actual=c.actual;transition(task,prior?'success':'exists',prior?'已按已知 ID 核验保存配置':'发现同名同配置广告位；无法判定是否本批创建，记录为已存在');
        if(prior)this.batch!.canaryPassed=true;
        // Revoke a prior create assignment before releasing the local slot.
        // A frozen worker must observe this revocation at its next checkpoint.
        if(task.workerId){const slot=this.slots.get(task.workerId);if(slot){const command=get<Command>('command:'+slot.id,{seq:0});set('command:'+slot.id,{seq:command.seq+1,blocked:'此任务已由主控完成只读核验，原创建分配已撤销'} satisfies Command);slot.busy=undefined;slot.probePassed=false;}}
      }else{
        // Absence in a list is not negative acknowledgement from the server.
        task.reason=c.status==='pending'?'当前列表尚未出现记录，不能证明创建失败；禁止自动重建':c.reason;
        transition(task,task.actual?.unitId?'created-unverified':'uncertain',task.reason);
      }
      this.save();
      }catch(error){
        if(task.status==='verifying')transition(task,task.actual?.unitId?'created-unverified':'uncertain','只读核验失败：'+(error as Error).message+'；禁止自动重新创建');
        this.save();
        if((error as {fatal?:boolean}).fatal)break;
      }
    }await this.adapter.home(this.batch!.identity);await this.identify();
    const remaining=this.batch!.tasks.filter(t=>needsVerification(t) && !['success','exists'].includes(t.status)).length;
    this.notice(remaining?`只读核验结束，仍有 ${remaining} 条结果或配置待核验；保留已知 ID，禁止重新创建。`:'只读核验通过。批次保持暂停，点击继续才会执行尚未提交的任务。');
    }finally{this.localBusy=false;this.save();}
  }
  async dispatch(slot:Slot,task:Task):Promise<void>{
    const batch=this.batch!;
    if(!batch.tasks.includes(task))throw new Error('任务不属于当前批次，禁止派发。');
    if(task.status!=='pending' || task.assignmentId || task.intentAt || task.actual?.unitId)throw new Error('任务已有归属、提交意图或真实 ID，禁止派发新的创建任务。');
    task.workerId=slot.id;task.assignmentId=uuid();task.attempts++;slot.busy=task.assignmentId;slot.since=Date.now();
    const job:Job={batch:{id:batch.id,identity:structuredClone(batch.identity),format:batch.format,mode:batch.mode,partnerBidding:batch.partnerBidding,controllerId:batch.controllerId,phase:batch.phase},task:structuredClone(task),assignmentId:task.assignmentId,workerId:slot.id,kind:'create',parallelPreparation:batch.execution==='tabs' && batch.concurrency>1,requireForeground:batch.execution==='paged'};
    this.save();
    const priorCommand=get<Command>('command:'+slot.id,{seq:0});
    // The previous terminal ACK must survive immediate slot reuse: a frozen
    // or throttled worker may not have observed it before this new assignment.
    set('command:'+slot.id,{seq:priorCommand.seq+1,job,ack:priorCommand.ack} satisfies Command);
    if(batch.execution==='single'){
      this.localBusy=true;
      void performJob(job,this.adapter,async data=>{
        await this.handle(slot,{...data,id:uuid(),at:Date.now(),workerId:slot.id});
      },(beforeClick)=>{
        if(this.batch?.phase!=='running')throw new Error('任务已暂停或停止，在提交前安全停下');
        const control=get<Batch|undefined>(this.key(batch),undefined);
        const command=get<Command>('command:'+slot.id,{seq:0});
        if(!control || control.controllerId!==job.batch.controllerId || command.job?.assignmentId!==job.assignmentId)throw new Error('任务归属已变更，停止当前执行');
        if(control.phase!=='running')throw new Error('任务已暂停或停止，在提交前安全停下');
        if(command.blocked)throw new Error(command.blocked);
        if((beforeClick || task.intentAt) && (!command.grant || command.grant.assignmentId!==job.assignmentId || command.grant.expires<=Date.now()))throw new Error('提交许可已过期，未点击创建');
      }).catch(e=>this.pause('单页通信或存储异常：'+(e as Error).message)).finally(()=>{this.localBusy=false;});
    }
  }
  private intentContext(batch:Batch,task:Task,slot:Slot,r:Report):{command:Command;persisted:Batch;task:Task}|undefined{
    if(this.batch!==batch || !batch.tasks.includes(task) || !reportBelongs(r,task,slot.id))return undefined;
    const persisted=get<Batch|undefined>(this.key(batch),undefined),command=get<Command>('command:'+slot.id,{seq:0});
    const saved=persisted?.tasks.find(row=>row.id===task.id && row.assignmentId===r.assignmentId && row.workerId===slot.id);
    if(!persisted || !saved || persisted.controllerId!==this.id || batch.controllerId!==this.id
      || command.job?.batch.id!==batch.id || command.job.batch.controllerId!==this.id
      || command.job.assignmentId!==r.assignmentId || command.job.workerId!==slot.id || command.job.task.id!==task.id)return undefined;
    return {command,persisted,task:saved};
  }
  private supersededIntent(slot:Slot,task:Task,r:Report):boolean{
    const journal=get<Journal|undefined>('journal:'+r.assignmentId,undefined);
    if(journal?.state==='done' && journal.report && reportBelongs(journal.report,task,slot.id) && ['result','error'].includes(journal.report.type))return true;
    const current=get<Report|undefined>('report:'+slot.id,undefined);
    return !!current && current.id!==r.id && reportBelongs(current,task,slot.id) && current.at>=r.at;
  }
  private async handleIntent(batch:Batch,task:Task,slot:Slot,r:Report):Promise<void>{
    let unlock!:()=>void;const previous=this.grantTail;
    this.grantTail=new Promise<void>(resolve=>{unlock=resolve;});
    await previous;
    try{
      const reason=():string=>{
        const context=this.intentContext(batch,task,slot,r);
        if(!context)return '任务归属已变化';
        if(this.supersededIntent(slot,task,r))return '执行页已报告后续结果';
        if(!Number.isFinite(r.at) || r.at>Date.now()+1000 || Date.now()-r.at>10000)return '提交意图已过期，拒绝迟到的提交许可';
        if(Date.now()-slot.since>120000 || !['pending','filling'].includes(task.status) || !['pending','filling'].includes(context.task.status))return '执行分配已超时或不再等待提交';
        if(batch.phase!=='running' || context.persisted.phase!=='running')return '批次已暂停或停止，主控拒绝提交许可';
        if(task.intentAt || context.task.intentAt || task.actual?.unitId || context.task.actual?.unitId || context.command.grant)return '本分配已有提交意图、许可或真实 ID，禁止重复许可';
        if(!canSubmitPrepared(context.persisted,context.task))return '首条保存后核验尚未通过，当前任务没有提交许可';
        return '';
      };
      let blocked=reason();
      if(!blocked){
        const last=Math.max(this.lastSubmit,get<number>('lastSubmit:'+batch.identity.publisherId,0));
        const delay=Math.max(0,2500-(Date.now()-last));
        if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
        blocked=reason();
      }
      if(!blocked){
        try{
          const current=await this.adapter.identify();blocked=reason();
          if(!blocked && !sameIdentity(current,batch.identity)){await this.pause('主控账号或应用发生变化');blocked='主控账号或应用发生变化，拒绝提交许可';}
        }catch(error){
          blocked=reason() || '主控无法确认当前账号：'+(error as Error).message;
          if(this.batch===batch){await this.pause(blocked);}
        }
      }
      const context=this.intentContext(batch,task,slot,r);
      if(!context || this.supersededIntent(slot,task,r)){this.handledReports.add(r.id);return;}
      const command=context.command;
      if(command.ack===r.id){this.handledReports.add(r.id);slot.lastReport=r.id;return;}
      blocked=blocked || reason();
      if(blocked)command.blocked=blocked;
      else{
        task.intentAt=new Date().toISOString();transition(task,'submitting','提交意图已持久化');this.save();
        command.blocked=undefined;command.grant={assignmentId:task.assignmentId!,expires:Date.now()+10000};
        this.lastSubmit=Date.now();set('lastSubmit:'+batch.identity.publisherId,this.lastSubmit);slot.since=Date.now();
      }
      command.ack=r.id;command.seq++;set('command:'+slot.id,command);slot.lastReport=r.id;this.handledReports.add(r.id);
    }finally{unlock();}
  }
  private provenUnsubmitted(slot:Slot,task:Task,r:Report,command:Command):boolean{
    if(!this.batch || task.intentAt || task.actual?.unitId || r.actual?.unitId || command.grant)return false;
    const context=this.intentContext(this.batch,task,slot,r);
    const journal=get<Journal|undefined>('journal:'+r.assignmentId,undefined);
    return !!context && !context.task.intentAt && !context.task.actual?.unitId
      && journal?.state==='done' && journal.batchId===this.batch.id && journal.taskId===task.id && journal.assignmentId===r.assignmentId
      && journal.report?.id===r.id && journal.report.type==='error' && reportBelongs(journal.report,task,slot.id) && !journal.report.actual?.unitId;
  }
  async handle(slot:Slot,r:Report):Promise<void>{
    const archived=[...this.archives.values()].find(archive=>archive.batch.tasks.some(task=>reportBelongs(r,task,slot.id)));
    if(archived){const task=archived.batch.tasks.find(task=>reportBelongs(r,task,slot.id))!;if(['stage','result','error'].includes(r.type))await this.handleArchived(archived.batch,slot,task,r);return;}
    const task=this.batch?.tasks.find(t=>t.assignmentId===r.assignmentId);
    if(!task || !reportBelongs(r,task,slot.id) || slot.lastReport===r.id || this.handledReports.has(r.id))return;
    const cmd=get<Command>('command:'+slot.id,{seq:0});
    if(cmd.ack===r.id){
      slot.lastReport=r.id;
      this.handledReports.add(r.id);
      if(['result','error'].includes(r.type) && slot.busy===r.assignmentId)slot.busy=undefined;
      return;
    }
    if(['success','exists'].includes(task.status)){
      // A stale frozen page may report after the controller has independently
      // verified and revoked its assignment. Acknowledge without replacing proof.
      cmd.ack=r.id;cmd.seq++;set('command:'+slot.id,cmd);slot.lastReport=r.id;this.handledReports.add(r.id);if(slot.busy===r.assignmentId)slot.busy=undefined;return;
    }
    if(r.type==='intent'){
      await this.handleIntent(this.batch!,task,slot,r);return;
    }
    slot.since=Math.max(slot.since,Math.min(Date.now(),r.at));
    if(r.type==='stage'){
      if(r.actual?.unitId && !task.actual?.unitId)task.actual={...task.actual,...r.actual};
      if(r.stage==='filling' && (task.status==='pending' || (task.status==='filling' && r.reason)))transition(task,'filling',r.reason || '');
      if(r.stage==='verifying' && ['submitting','uncertain','created-unverified'].includes(task.status))transition(task,'verifying');
    }else if(r.type==='result' || r.type==='error'){
      const idMismatch=!!task.actual?.unitId && !!r.actual?.unitId && task.actual.unitId!==r.actual.unitId;
      if(r.actual?.unitId && !idMismatch)task.actual={...task.actual,...r.actual};
      let status=r.status || 'uncertain';
      if(idMismatch)status='created-unverified';
      // The worker cannot click without a durably acknowledged controller
      // intent. An explicit denial with no grant is positive pre-submit evidence.
      if(r.type==='error' && status==='uncertain' && !task.intentAt && !task.actual?.unitId && !cmd.grant && (cmd.blocked || this.provenUnsubmitted(slot,task,r,cmd)))status='failed';
      if(task.intentAt && status==='failed')status=task.actual?.unitId?'created-unverified':'uncertain';
      if(status==='success' && (task.actual?.format!==this.batch!.format || !sameIdentity(task.actual as Identity,this.batch!.identity)
        || !matchesRequestedConfiguration(task.actual,task.floor,this.batch!.mode,this.batch!.partnerBidding)))status='created-unverified';
      if(['success','exists'].includes(status) && ['submitting','uncertain','created-unverified'].includes(task.status))transition(task,'verifying','收集保存后的核验结果');
      if(status==='created-unverified' && ['pending','filling'].includes(task.status))transition(task,'uncertain','取得ID，配置待核验');
      transition(task,status,idMismatch?'执行页返回的ID与已取得ID不符；保留原ID等待核验':r.reason || '执行页已返回');slot.busy=undefined;
      if(status==='success'){this.batch!.canaryPassed=true;this.errors=0;}
      else if(status==='exists')this.errors=0;
      else if(['uncertain','created-unverified'].includes(status)){await this.pause('存在提交结果或配置不确定项，先核验再继续');}
      else if(status==='failed')this.errors++;
      if(r.fatal || this.errors>=2)await this.pause(r.fatal?'登录、账号、权限、币种或公共页面结构异常':'连续两条失败，已暂停；可核验后改为单页重试');
    }
    this.save();cmd.ack=r.id;cmd.seq++;set('command:'+slot.id,cmd);slot.lastReport=r.id;this.handledReports.add(r.id);
    if(this.batch!.execution==='paged' && ['result','error'].includes(r.type) && !slot.busy)this.scheduleCleanup(slot);
  }
  async tick():Promise<void>{
    if(this.tickBusy || this.actionBusy || !this.batch)return;
    this.tickBusy=true;
    try{
      await Promise.all(this.drainReports());
      this.collectArchives();
      for(const slot of this.slots.values()){
        if(slot.closing)continue;
        if(slot.busy && Date.now()-slot.since>120000){
          const t=this.batch.tasks.find(t=>t.assignmentId===slot.busy);
          if(t && ['pending','filling','submitting','verifying'].includes(t.status)){
            transition(t,t.actual?.unitId?'created-unverified':'uncertain','执行页长时间无结果，可能被后台冻结；保留归属，不重派');
            await this.pause('执行页超时，保留原执行页并先核验');this.save();
          }
        }
      }
      if(this.batch.stopRequestedAt && this.batch.phase!=='done')this.archiveStopped(this.batch);
      if(this.batch.phase==='done'){this.cleanupIdlePages();return;}
      if(this.batch.phase==='paused'
        && !this.batch.tasks.some(t=>['pending','filling','submitting','verifying','uncertain','created-unverified'].includes(t.status))
        && ![...this.slots.values()].some(s=>s.busy)){
        this.cleanupIdlePages();if(this.cleanupWork.size || this.cleanupError)return;
        this.batch.phase='done';this.save();this.notice('批次执行结束，请核对并导出结果。');
      }
      if(this.batch.phase!=='running')return;
      if(this.cleanupError)return;
      if(Date.now()-this.lastIdentityCheck>5000 && !this.localBusy){
        this.lastIdentityCheck=Date.now();
        if(!this.identityWork){
          const batch=this.batch;
          this.identityWork=this.adapter.identify().then(async identity=>{
            if(this.batch!==batch)return;
            if(!sameIdentity(identity,batch.identity)){await this.pause('主控账号或应用发生变化');return;}
            this.identity=identity;this.panel.update({identity,identityError:''});
          }).catch(async error=>{if(this.batch===batch)await this.pause('当前身份无法确认：'+(error as Error).message);}).finally(()=>{this.identityWork=undefined;});
        }
      }
      const dispatchBatch=this.batch;
      while(this.batch===dispatchBatch && dispatchBatch.phase==='running' && !this.localBusy){
        if(dispatchBatch.execution==='paged' && this.cleanupWork.size)break;
        const busy=[...this.slots.values()].filter(slot=>!!slot.busy).length;
        if(!canDispatch(dispatchBatch,busy))break;
        const task=dispatchBatch.tasks.find(t=>t.status==='pending' && !t.assignmentId && !t.intentAt && !t.actual?.unitId && Date.now()-Date.parse(t.logs.at(-1)?.at || dispatchBatch.createdAt)>Math.max(0,t.attempts-1)*3000);
        if(!task)break;
          let slot=[...this.slots.values()].find(s=>!s.busy && !s.closing && (this.batch!.execution==='single'?s.id==='single:'+this.id:(s.probePassed && s.batchId===this.batch!.id && !!s.identity && sameIdentity(s.identity,this.batch!.identity) && (dispatchBatch.execution!=='paged' || s.taskId===task.id))) && !s.tab?.closed);
          if(!slot){
            if(this.batch.execution==='single'){slot={id:'single:'+this.id,since:Date.now()};this.addSlot(slot);}
            else{
              // Cold startup must not hold the report collector while another
              // assigned worker waits for its stage or submission ACK.
              if(busy>0)break;
              try{
                if(dispatchBatch.execution==='paged'){await this.warmPaged();slot=[...this.slots.values()].find(candidate=>candidate.taskId===task.id && candidate.probePassed && !candidate.closing && !candidate.tab?.closed);if(!slot)throw new Error('未找到本行已预开的执行页');}
                else slot=await this.probe();
              }
              catch(error){
                if(this.batch!==dispatchBatch || dispatchBatch.phase!=='running')return;
                throw error;
              }
            }
          }
          if(dispatchBatch.execution==='paged')await this.activatePagedSlot(slot);
          if(this.batch!==dispatchBatch || dispatchBatch.phase!=='running' || !dispatchBatch.tasks.includes(task)){
            if(!slot.busy)await this.closeProbe(slot);
            return;
          }
          if(!this.localBusy && task.status==='pending' && !task.assignmentId)await this.dispatch(slot,task);
      }
      if(!this.batch.tasks.some(t=>['pending','filling','submitting','verifying'].includes(t.status)) && ![...this.slots.values()].some(s=>s.busy)){
        this.cleanupIdlePages();if(this.cleanupWork.size || this.cleanupError)return;
        this.batch.phase=this.batch.tasks.some(t=>['uncertain','created-unverified'].includes(t.status))?'paused':'done';this.save();
        this.notice(this.batch.phase==='done'?'批次执行结束，请核对并导出结果。':'存在待核验结果，禁止自动重建。');
      }
    }catch(error){this.reportTickPending=false;throw error;}
    finally{this.tickBusy=false;if(this.reportTickPending)this.reportChanged();}
  }
  diagnostics():void{
    // Export only an allowlist. No raw DOM, account IDs, names, URLs, input values or logs.
    const data={schema:1,at:new Date().toISOString(),userAgent:navigator.userAgent,origin:location.origin,capabilities:{webLocks:!!navigator.locks,gmStorage:typeof GM_getValue==='function',gmNotifications:typeof GM_addValueChangeListener==='function',gmTabs:typeof GM_openInTab==='function'},phase:this.batch?.phase,counts:this.batch?.tasks.reduce<Record<string,number>>((a,t)=>(a[t.status]=(a[t.status]||0)+1,a),{}),workers:[...this.slots.values()].map(s=>({busy:!!s.busy,probePassed:!!s.probePassed,closed:s.tab?.closed})),page:this.adapter.diagnostics()};
    download('AdMob-脱敏诊断-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',JSON.stringify(data,null,2),'application/json;charset=utf-8');
  }
}

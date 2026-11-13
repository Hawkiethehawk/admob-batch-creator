import type { Adapter, Batch, Identity, Task } from './types.ts';
import { createBatch, classifyLookup, recoverTask, transition, exportCsv, copyPairs, decimalEqual, matchesFloor } from './core.ts';
import { summarizeBatch } from './history.ts';
import { mountPanel, type PanelConfig, type PanelHandle } from './panel.ts';
import { get, set, uuid, holdLock, sameIdentity, waitFor, download, listen } from './gm.ts';
import type { Command, Job, Journal, Report } from './protocol.ts';
import { reportBelongs, mayRetry, canDispatch, needsVerification } from './protocol.ts';
import { performJob } from './worker.ts';

interface Slot {id:string;busy?:string;since:number;lastReport?:string;tab?:{close():void;closed:boolean};probePassed?:boolean;identity?:Identity;batchId?:string;removeReportListener?:()=>void}
export class Controller {
  adapter:Adapter; id=uuid(); panel!:PanelHandle; identity?:Identity; batch?:Batch;
  slots=new Map<string,Slot>(); lockRelease?:()=>void; lockedPublisher=''; tickBusy=false; actionBusy=false; reportTickPending=false;
  preflightSignature=''; lastSubmit=0; lastIdentityCheck=0; errors=0; localBusy=false;
  constructor(adapter:Adapter){this.adapter=adapter;}
  async init():Promise<void>{
    this.panel=mountPanel({
      identify:()=>this.action(async()=>{await this.identify();if(!this.batch)await this.load();}),preflight:c=>this.action(()=>this.preflight(c)),start:c=>this.action(()=>this.start(c)),
      pause:()=>this.pause('用户暂停'),resume:()=>this.action(()=>this.resume()),stop:()=>this.stop(),
      retry:()=>this.action(()=>this.retry()),verify:()=>this.action(()=>this.verify()),
      recordObservedId:(taskId,unitId)=>this.action(()=>this.recordObservedId(taskId,unitId)),
      history:async()=>this.refreshHistory(),
      viewHistory:async id=>{this.panel.update({historyBatch:id?this.readHistory(id):undefined});},
      degrade:async()=>{this.requireBatch();await this.pause('用户降级单页');this.batch!.execution='single';this.batch!.concurrency=1;this.save();this.notice('已降级单页。旧执行页仍保留并继续收集结果；点击继续后，后续任务在当前页处理。');},
      export:async(filter,id)=>{const batch=id?this.readHistory(id):this.batch;if(!batch)throw new Error('没有可导出的批次');download('AdMob-'+batch.id+'-'+filter+'.csv',exportCsv(batch,filter),'text/csv;charset=utf-8');},
      copy:async id=>{const batch=id?this.readHistory(id):this.batch;if(!batch)throw new Error('没有可复制的批次');GM_setClipboard(copyPairs(batch),'text');this.notice('已复制有真实广告位 ID 的名称与 ID');},
      diagnostics:async()=>this.diagnostics(),probe:()=>this.action(async()=>{await this.identify();await this.acquire();await this.probe();})
    });
    this.panel.update({capabilities:'支持 1～5 个普通执行页。有已核验的历史样本时直接并发，否则首条核验后继续并发。'});
    try{await this.identify();await this.load();this.refreshHistory();}catch(e){this.panel.update({identityError:(e as Error).message});}
    setInterval(()=>void this.tick().catch(e=>this.pause('调度异常：'+(e as Error).message)),1200);
    window.addEventListener('beforeunload',()=>{if(this.batch?.phase==='running'){this.batch.phase='paused';this.save();}});
  }
  async action(fn:()=>Promise<void>):Promise<void>{
    if(this.actionBusy)throw new Error('上一操作仍在进行');
    this.actionBusy=true;this.panel.update({busy:true});
    try{await fn();}finally{this.actionBusy=false;this.panel.update({busy:false});if(this.reportTickPending)this.reportChanged();}
  }
  private reportChanged():void{
    this.reportTickPending=true;
    if(this.tickBusy || this.actionBusy)return;
    this.reportTickPending=false;
    void this.tick().catch(e=>this.pause('调度异常：'+(e as Error).message));
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
      if(journal?.state==='done' && journal.batchId===this.batch!.id && journal.taskId===task.id
        && journal.assignmentId===assignment && journal.report && reportBelongs(journal.report,task,slot.id)
        && ['result','error'].includes(journal.report.type))return journal.report;
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
  async identify():Promise<void>{
    const identity=await this.adapter.identify();
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
      if(batch.phase!=='done' && remote && task.status==='filling')transition(task,'uncertain','主控已刷新，等待原执行页报告');
      else if(['filling','submitting','verifying'].includes(task.status))recoverTask(task);
      const journal=task.assignmentId?get<Journal|undefined>('journal:'+task.assignmentId,undefined):undefined;
      const completed=journal?.state==='done' && journal.batchId===batch.id && journal.taskId===task.id
        && journal.assignmentId===task.assignmentId && !!journal.report && reportBelongs(journal.report,task,task.workerId || '')
        && ['result','error'].includes(journal.report.type);
      if(batch.phase!=='done' && task.assignmentId && task.workerId && !['success','exists','stopped','conflict'].includes(task.status)
        && (remote || completed)){
        this.addSlot({id:task.workerId,busy:task.assignmentId,since:Date.now()});
      }
    }
    this.save();
    for(const slot of this.slots.values()){
      const report=this.savedReport(slot);
      if(report && ['result','error'].includes(report.type))await this.handle(slot,report);
    }
    this.notice(batch.phase==='draft'?'已恢复未确认草稿。检查清单后点击开始创建，将自动检查执行条件。':batch.phase==='done'?'已恢复已结束批次，可查看历史结果或填写新清单。':'已恢复历史批次并暂停。提交过或结果不确定的任务只允许先核验；点击继续才会派发尚未提交的任务。');
  }
  signature(config:PanelConfig):string{return JSON.stringify([config.format,config.mode ?? 'manual',config.concurrency,config.execution,config.rows,this.identity?.publisherId,this.identity?.appId]);}
  private async warmPool(target:number):Promise<void>{
    const ready=[...this.slots.values()].filter(slot=>!slot.busy && slot.probePassed && !slot.tab?.closed && slot.batchId===this.batch?.id && slot.identity && this.identity && sameIdentity(slot.identity,this.identity)).length;
    for(let index=ready;index<target;index++){
      this.notice(`正在预热执行页 ${index+1}/${target}：检查跨页锁、通知及账号（不提交）…`);
      await this.probe(true);
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
      this.panel.update({ready:false,checks:[
        {label:'已重新核对批次原发布商和应用，主控锁有效',ok:true},
        {label:'保留原清单、已知 ID、提交意图和执行归属；本次不提交',ok:true},
        {label:unresolved?`${unresolved} 条提交结果或配置待核验，请先点击“核验结果不确定项”`:'没有待核验的提交结果',ok:unresolved===0},
        {label:this.batch.mode==='manual'?'底价按已确定的逐行金额与整批 USD 使用，无需单独确认':'按批次已确定的底价模式创建，无需填写金额',ok:true},
      ]});
      this.notice('暂停批次检查完成。'+(unresolved?'请先核验已有提交，核验通过后再继续。':'点击继续执行尚未提交的任务，按批次底价模式保存并核验。'));
      return;
    }
    if(this.batch && this.batch.phase!=='done' && this.batch.phase!=='draft')throw new Error('请先处理当前批次；不能覆盖未完成批次');
    if(!config.rows.length || config.rows.some(r=>r.errors.length))throw new Error('请先修正创建清单中的全部行级错误');
    this.preflightSignature='';this.panel.update({ready:false});
    for(const [id,slot] of this.slots)if(!slot.busy){this.removeSlot(id);slot.tab?.close();}
    this.notice('预检：确认当前账号、主控锁和输入…');
    await this.identify();await this.acquire();
    const active=get<{appId:string;id:string}|undefined>('active:'+this.identity!.publisherId,undefined);
    if(active && active.id!==this.batch?.id){
      const old=get<Batch|undefined>('batch:'+this.identity!.publisherId+':'+active.appId+':'+active.id,undefined);
      if(old && old.phase!=='done')throw new Error('此发布商还有未完成批次，请进入原应用恢复：'+active.appId);
    }
    let canaryEvidence:Batch['canaryEvidence'];
    const previous=this.batch;
    if(config.execution==='tabs' && previous?.phase==='done' && sameIdentity(previous.identity,this.identity!) && previous.format===config.format && previous.mode===(config.mode ?? 'manual') && this.adapter.verifyById){
      const sample=previous.tasks.find(task=>task.status==='success' && task.actual?.verified===true
        && sameIdentity(task.actual as Identity,this.identity!) && task.actual.format===config.format
        && task.actual.name===task.name && matchesFloor(task.actual,task.floor,previous.mode)
        && new RegExp(`^ca-app-${this.identity!.publisherId}/\\d{10}$`).test(task.actual.unitId||''));
      if(sample){
        this.notice('预检：按 ID 只读复核历史成功样本，确认后让新清单直接并发…');
        try{
        const actual=await this.adapter.verifyById(this.identity!,sample.actual!.unitId!,sample.name,config.format,sample.floor,previous.mode);
        if(!actual.verified || !sameIdentity(actual,this.identity!) || actual.unitId!==sample.actual!.unitId
          || actual.name!==sample.name || actual.format!==config.format || !matchesFloor(actual,sample.floor,previous.mode))throw new Error('历史样本配置已变化');
        canaryEvidence={sourceBatchId:previous.id,unitId:actual.unitId,verifiedAt:new Date().toISOString()};
        }catch{
          // Deleted, inaccessible or changed historical units are not prerequisites for new work.
          // Re-identify below; without a valid sample this batch validates its own first row.
          await this.adapter.home();await this.identify();await this.acquire();
          if(!sameIdentity(previous.identity,this.identity!))throw new Error('历史样本检查期间账号或应用发生变化，已停止');
          this.notice('历史样本不可用，本批先核验首条再扩展并发。');
        }
      }
    }
    const batch=createBatch(config.rows,this.identity!,config.format,config.concurrency,config.execution,location.href,this.id,config.mode ?? 'manual');
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
    }
    this.preflightSignature=this.signature(config);
    const pending=batch.tasks.filter(t=>t.status==='pending').length;
    const blocked=batch.tasks.filter(t=>['uncertain','conflict'].includes(t.status)).length;
    this.panel.update({ready:pending>0,checks:[{label:'已固定发布商及应用',ok:true},{label:'创建清单有效',ok:true},{label:'AdMob 允许重名；检查不查询同名、不阻止创建',ok:true},{label:blocked?`${blocked} 行冲突/待核验，不会提交`:'无冲突或待核验项',ok:blocked===0},{label:batch.mode==='manual'?'底价按已确定的逐行金额与整批 USD 使用，执行时自动填写和读回':'按所选底价模式创建，保存后核验模式',ok:true},{label:canaryEvidence?'历史成功样本已按 ID 复核，新清单可直接并发；每行仍独立保存后核验':'本批先核验首条，再扩展并发',ok:true},{label:config.execution==='tabs'?`${batch.concurrency} 个执行页已预热，跨页互斥、通知及账号检查均通过`:'单页执行；已取得账号主控锁',ok:true}]});
    this.notice('执行条件检查通过。待创建 '+pending+' 条；AdMob 允许重名，每行创建后立即记录新 ID，并核验保存后的底价模式及配置。');
  }
  async probe(forceNew=false):Promise<Slot>{
    if(!this.identity)throw new Error('未识别账号');
    const reusable=[...this.slots.values()].find(s=>!s.busy && s.probePassed && !s.tab?.closed && s.identity && sameIdentity(s.identity,this.identity!) && s.batchId===this.batch?.id);
    if(reusable && !forceNew)return reusable;
    const nonce=uuid(),lockName='admob-batch-probe:'+nonce;
    const release=await holdLock(lockName);
    const slot:Slot={id:uuid(),since:Date.now(),identity:this.identity,batchId:this.batch?.id};
    try{
      this.addSlot(slot);
      const url=new URL(this.batch?.sourceUrl || location.href);url.searchParams.set('__admob_batch_worker',slot.id);
      set('command:'+slot.id,{seq:1,probe:{nonce,lockName}} satisfies Command);
      this.panel.update({workerUrl:url.href});
      try{if(typeof document==='undefined'||!document.getElementById('abc-panel-host')?.hasAttribute('data-manual-tabs'))slot.tab=GM_openInTab(url.href,{active:false,insert:true,setParent:true});}
      catch{this.notice('自动打开执行页未完成，请点击“打开执行页”；连接后继续检测，不会提交广告位。');}
      await waitFor(()=>{const r=get<Report|undefined>('report:'+slot.id,undefined);return r?.probe?.nonce===nonce?r:undefined;},25000,'report:'+slot.id);
      // The initial command predates the worker listener. A second challenge
      // verifies an actual remote GM value-change notification after startup.
      const challenge=uuid();
      set('command:'+slot.id,{seq:2,probe:{nonce:challenge,lockName}} satisfies Command);
      const report=await waitFor(()=>{const r=get<Report|undefined>('report:'+slot.id,undefined);return r?.probe?.nonce===challenge?r:undefined;},15000,'report:'+slot.id);
      if(!report.probe?.locked || !report.probe.notifications || !report.probe.identity || !sameIdentity(report.probe.identity,this.identity))throw new Error(report.probe?.error || '跨页锁作用域、GM通知或登录账号检查未通过；请改为单页模式。');
      slot.probePassed=true;slot.lastReport=report.id;this.notice('当前会话跨页能力检查通过；尚未创建任何广告位。');return slot;
    }catch(error){
      // This page has only performed the read-only probe and has no job.
      this.removeSlot(slot.id);slot.tab?.close();throw error;
    }finally{release();this.panel.update({workerUrl:''});}
  }
  async start(config:PanelConfig):Promise<void>{
    const requestedAt=new Date().toISOString();
    if(this.batch && !['draft','done'].includes(this.batch.phase))throw new Error('当前批次尚未结束，请使用暂停、继续或停止');
    if(!this.batch || this.batch.phase!=='draft' || this.preflightSignature!==this.signature(config))await this.preflight(config);
    this.requireBatch();await this.identify();await this.acquire();
    if(this.batch!.phase!=='draft' || this.preflightSignature!==this.signature(config))throw new Error('输入或账号已变化，请检查清单后重新点击开始创建');
    this.batch!.startedAt=requestedAt;delete this.batch!.completedAt;
    this.batch!.confirmedAt=new Date().toISOString();this.batch!.phase='running';set('active:'+this.batch!.identity.publisherId,{appId:this.batch!.identity.appId,id:this.batch!.id});this.save();
    this.refreshHistory();
    this.notice(this.batch!.canaryEvidence?'批次已开始。历史成功样本已重新核验，按所选并发派发新清单，每条仍独立核验保存配置。':'批次已开始。先执行一条并核验，通过后再增加并发。');
  }
  async pause(reason:string):Promise<void>{
    if(this.batch?.phase==='draft'){this.preflightSignature='';this.panel.update({ready:false});}
    if(this.batch?.phase==='running'){this.batch.phase='paused';this.save();}
    this.notice(reason+'。停止派发，已提交任务继续收集结果。');
  }
  async stop():Promise<void>{
    this.requireBatch();this.batch!.stopRequestedAt=new Date().toISOString();this.batch!.phase='stopping';
    this.preflightSignature='';this.panel.update({ready:false});
    for(const task of this.batch!.tasks)if(task.status==='pending' && !task.assignmentId)transition(task,'stopped','用户停止');
    this.save();this.notice('已停止新建；执行页保持打开，已提交任务继续核验。');
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
    this.batch!.phase='running';this.errors=0;this.save();
    this.notice('批次已继续。执行尚未提交的任务，按批次底价模式保存并核验，页面明确冲突时会报告。');
  }
  async retry():Promise<void>{
    this.requireBatch();
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
      let knownId=task.actual?.unitId;
      if(!knownId && task.intentAt && this.adapter.recoverCreatedId){
        // Recover only this task's real success receipt before any lookup can
        // navigate away. Persist the ID while it is still unverified.
        const recovered=this.adapter.recoverCreatedId(this.batch!.identity,task.name,this.batch!.format);
        if(recovered){
          if(!/^ca-app-pub-\d{16}\/\d{10}$/.test(recovered) || !recovered.startsWith(`ca-app-${this.batch!.identity.publisherId}/`))throw new Error('成功说明中的广告位 ID 与批次发布商不匹配，保留待核验');
          task.actual={...task.actual,unitId:recovered,publisherId:this.batch!.identity.publisherId,appId:this.batch!.identity.appId,name:task.name,format:this.batch!.format,verified:false};
          this.save();knownId=recovered;
        }
      }
      if(knownId && this.adapter.verifyById){
        const actual=await this.adapter.verifyById(this.batch!.identity,knownId,task.name,this.batch!.format,task.floor,this.batch!.mode);
        if(actual.unitId!==knownId){
          transition(task,'created-unverified','保存详情返回的 ID 与已知 ID 不一致；保留原 ID，禁止重新创建');
          this.save();continue;
        }
        task.actual=actual;
        if(actual.verified && sameIdentity(actual,this.batch!.identity) && actual.format===this.batch!.format){
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
    }await this.adapter.home();await this.identify();
    const remaining=this.batch!.tasks.filter(t=>needsVerification(t) && !['success','exists'].includes(t.status)).length;
    this.notice(remaining?`只读核验结束，仍有 ${remaining} 条结果或配置待核验；保留已知 ID，禁止重新创建。`:'只读核验通过。批次保持暂停，点击继续才会执行尚未提交的任务。');
    }finally{this.localBusy=false;this.save();}
  }
  async dispatch(slot:Slot,task:Task):Promise<void>{
    const batch=this.batch!;
    task.workerId=slot.id;task.assignmentId=uuid();task.attempts++;slot.busy=task.assignmentId;slot.since=Date.now();
    const job:Job={batch:{id:batch.id,identity:structuredClone(batch.identity),format:batch.format,mode:batch.mode,controllerId:batch.controllerId,phase:batch.phase},task:structuredClone(task),assignmentId:task.assignmentId,workerId:slot.id,kind:'create'};
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
  async handle(slot:Slot,r:Report):Promise<void>{
    const task=this.batch?.tasks.find(t=>t.assignmentId===r.assignmentId);
    if(!task || !reportBelongs(r,task,slot.id) || slot.lastReport===r.id)return;
    const cmd=get<Command>('command:'+slot.id,{seq:0});
    if(cmd.ack===r.id){
      slot.lastReport=r.id;
      if(['result','error'].includes(r.type) && slot.busy===r.assignmentId)slot.busy=undefined;
      return;
    }
    if(['success','exists'].includes(task.status)){
      // A stale frozen page may report after the controller has independently
      // verified and revoked its assignment. Acknowledge without replacing proof.
      cmd.ack=r.id;cmd.seq++;set('command:'+slot.id,cmd);slot.lastReport=r.id;if(slot.busy===r.assignmentId)slot.busy=undefined;return;
    }
    if(r.type==='intent'){
      const previous=Math.max(this.lastSubmit,get<number>('lastSubmit:'+this.batch!.identity.publisherId,0));
      const delay=Math.max(0,2500-(Date.now()-previous));
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      cmd.grant=undefined;cmd.blocked=undefined;
      try{const current=await this.adapter.identify();if(!sameIdentity(current,this.batch!.identity))await this.pause('主控账号或应用发生变化');}
      catch(error){await this.pause('主控无法确认当前账号：'+(error as Error).message);}
      if(this.batch!.phase!=='running')cmd.blocked='批次已暂停或停止，主控拒绝提交许可';
      else if(task.intentAt)cmd.blocked='本分配已有提交意图，禁止重复许可';
      else{task.intentAt=new Date().toISOString();transition(task,'submitting','提交意图已持久化');this.save();cmd.grant={assignmentId:task.assignmentId!,expires:Date.now()+10000};this.lastSubmit=Date.now();set('lastSubmit:'+this.batch!.identity.publisherId,this.lastSubmit);}
    }else if(r.type==='stage'){
      if(r.stage==='created' && r.actual?.unitId && !task.actual?.unitId)task.actual={...task.actual,...r.actual};
      if(r.stage==='filling' && (task.status==='pending' || (task.status==='filling' && r.reason)))transition(task,'filling',r.reason || '');
      if(r.stage==='verifying' && ['submitting','uncertain','created-unverified'].includes(task.status))transition(task,'verifying');
    }else if(r.type==='result' || r.type==='error'){
      const idMismatch=!!task.actual?.unitId && !!r.actual?.unitId && task.actual.unitId!==r.actual.unitId;
      if(r.actual?.unitId && !idMismatch)task.actual={...task.actual,...r.actual};
      let status=r.status || 'uncertain';
      if(idMismatch)status='created-unverified';
      // The worker cannot click without a durably acknowledged controller
      // intent. An explicit denial with no grant is positive pre-submit evidence.
      if(r.type==='error' && status==='uncertain' && !task.intentAt && !task.actual?.unitId && cmd.blocked && !cmd.grant)status='failed';
      if(task.intentAt && status==='failed')status=task.actual?.unitId?'created-unverified':'uncertain';
      if(status==='success' && (task.actual?.format!==this.batch!.format || !sameIdentity(task.actual as Identity,this.batch!.identity)))status='created-unverified';
      if(['success','exists'].includes(status) && ['submitting','uncertain','created-unverified'].includes(task.status))transition(task,'verifying','收集保存后的核验结果');
      if(status==='created-unverified' && ['pending','filling'].includes(task.status))transition(task,'uncertain','取得ID，配置待核验');
      transition(task,status,idMismatch?'执行页返回的ID与已取得ID不符；保留原ID等待核验':r.reason || '执行页已返回');slot.busy=undefined;
      if(status==='success'){this.batch!.canaryPassed=true;this.errors=0;}
      else if(status==='exists')this.errors=0;
      else if(['uncertain','created-unverified'].includes(status)){await this.pause('存在提交结果或配置不确定项，先核验再继续');}
      else if(status==='failed')this.errors++;
      if(r.fatal || this.errors>=2)await this.pause(r.fatal?'登录、账号、权限、币种或公共页面结构异常':'连续两条失败，已暂停；可核验后改为单页重试');
    }
    this.save();cmd.ack=r.id;cmd.seq++;set('command:'+slot.id,cmd);slot.lastReport=r.id;
  }
  async tick():Promise<void>{
    if(this.tickBusy || this.actionBusy || !this.batch)return;
    this.tickBusy=true;
    try{
      for(const slot of this.slots.values()){
        const r=this.savedReport(slot);
        if(r && r.id!==slot.lastReport && r.type!=='hello')await this.handle(slot,r);
        if(slot.busy && Date.now()-slot.since>120000){
          const t=this.batch.tasks.find(t=>t.assignmentId===slot.busy);
          if(t && ['pending','filling','submitting','verifying'].includes(t.status)){
            transition(t,t.actual?.unitId?'created-unverified':'uncertain','执行页长时间无结果，可能被后台冻结；保留归属，不重派');
            await this.pause('执行页超时，保留原执行页并先核验');this.save();
          }
        }
      }
      if(this.batch.phase==='stopping' && ![...this.slots.values()].some(s=>s.busy)){
        const unresolved=this.batch.tasks.some(t=>
          (!['success','exists'].includes(t.status) && !!t.intentAt)
          || ['created-unverified','submitting','verifying'].includes(t.status));
        // A preflight-only uncertain row has never been submitted. Preserve its
        // exact evidence/status without trapping a cancelled draft forever.
        this.batch.phase=unresolved?'paused':'done';this.save();
      }
      if(this.batch.phase==='paused'
        && !this.batch.tasks.some(t=>['pending','filling','submitting','verifying','uncertain','created-unverified'].includes(t.status))
        && ![...this.slots.values()].some(s=>s.busy)){
        this.batch.phase='done';this.save();this.notice('批次执行结束，请核对并导出结果。');
      }
      if(this.batch.phase!=='running')return;
      if(Date.now()-this.lastIdentityCheck>5000 && !this.localBusy){
        this.lastIdentityCheck=Date.now();
        try{await this.identify();}catch(e){await this.pause('当前身份无法确认：'+(e as Error).message);return;}
      }
      const busy=[...this.slots.values()].filter(s=>s.busy).length;
      if(canDispatch(this.batch,busy)){
        const task=this.batch.tasks.find(t=>t.status==='pending' && !t.assignmentId && Date.now()-Date.parse(t.logs.at(-1)?.at || this.batch!.createdAt)>Math.max(0,t.attempts-1)*3000);
        if(task){
          let slot=[...this.slots.values()].find(s=>!s.busy && (this.batch!.execution==='single'?s.id==='single:'+this.id:(s.probePassed && s.batchId===this.batch!.id && !!s.identity && sameIdentity(s.identity,this.batch!.identity))) && !s.tab?.closed);
          if(!slot){
            if(this.batch.execution==='single'){slot={id:'single:'+this.id,since:Date.now()};this.addSlot(slot);}
            else slot=await this.probe();
          }
          if(this.batch.phase==='running' && task.status==='pending' && !task.assignmentId)await this.dispatch(slot,task);
        }
      }
      if(!this.batch.tasks.some(t=>['pending','filling','submitting','verifying'].includes(t.status)) && ![...this.slots.values()].some(s=>s.busy)){
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

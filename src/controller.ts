import type { Adapter, Batch, Identity, Task } from './types.ts';
import { createBatch, classifyLookup, recoverTask, transition, exportCsv, copyPairs } from './core.ts';
import { mountPanel, type PanelConfig, type PanelHandle } from './panel.ts';
import { get, set, uuid, holdLock, sameIdentity, waitFor, download, listen } from './gm.ts';
import type { Command, Job, Report } from './protocol.ts';
import { reportBelongs, mayRetry, canDispatch, needsVerification } from './protocol.ts';
import { performJob } from './worker.ts';

interface Slot {id:string;busy?:string;since:number;lastReport?:string;tab?:{close():void;closed:boolean};probePassed?:boolean;identity?:Identity;batchId?:string}
export class Controller {
  adapter:Adapter; id=uuid(); panel!:PanelHandle; identity?:Identity; batch?:Batch;
  slots=new Map<string,Slot>(); lockRelease?:()=>void; lockedPublisher=''; tickBusy=false; actionBusy=false;
  preflightSignature=''; lastSubmit=0; lastIdentityCheck=0; errors=0; localBusy=false;
  constructor(adapter:Adapter){this.adapter=adapter;}
  async init():Promise<void>{
    this.panel=mountPanel({
      identify:()=>this.action(async()=>{await this.identify();if(!this.batch)await this.load();}),preflight:c=>this.action(()=>this.preflight(c)),start:c=>this.action(()=>this.start(c)),
      pause:()=>this.pause('用户暂停'),resume:()=>this.action(()=>this.resume()),stop:()=>this.stop(),
      retry:()=>this.action(()=>this.retry()),verify:()=>this.action(()=>this.verify()),
      degrade:async()=>{this.requireBatch();await this.pause('用户降级单页');this.batch!.execution='single';this.batch!.concurrency=1;this.save();this.notice('已降级单页。旧执行页仍保留并继续收集结果；点击继续后，后续任务在当前页处理。');},
      export:async filter=>{this.requireBatch();download('AdMob-'+this.batch!.id+'-'+filter+'.csv',exportCsv(this.batch!,filter),'text/csv;charset=utf-8');},
      copy:async()=>{this.requireBatch();GM_setClipboard(copyPairs(this.batch!),'text');this.notice('已复制有真实广告位 ID 的名称与 ID');},
      diagnostics:async()=>this.diagnostics(),probe:()=>this.action(async()=>{await this.identify();await this.acquire();await this.probe();})
    });
    this.panel.update({capabilities:'多页模式需通过 GM 存储、通知、同会话身份及 Web Locks 跨页检查。真实 AdMob / Tampermonkey 流程尚未验收。'});
    try{await this.identify();await this.load();}catch(e){this.panel.update({identityError:(e as Error).message});}
    setInterval(()=>void this.tick().catch(e=>this.pause('调度异常：'+(e as Error).message)),1200);
    window.addEventListener('beforeunload',()=>{if(this.batch?.phase==='running'){this.batch.phase='paused';this.save();}});
  }
  async action(fn:()=>Promise<void>):Promise<void>{
    if(this.actionBusy)throw new Error('上一操作仍在进行');
    this.actionBusy=true;this.panel.update({busy:true});
    try{await fn();}finally{this.actionBusy=false;this.panel.update({busy:false});}
  }
  notice(text:string):void{this.panel.update({notice:text});}
  requireBatch():void{if(!this.batch)throw new Error('当前没有批次，请先预检');}
  key(batch=this.batch!):string{return 'batch:'+batch.identity.publisherId+':'+batch.identity.appId+':'+batch.id;}
  save():void{if(this.batch){set(this.key(),this.batch);set('latest:'+this.batch.identity.publisherId+':'+this.batch.identity.appId,this.batch.id);this.panel.update({batch:this.batch});}}
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
      if(['filling','submitting','verifying'].includes(task.status))recoverTask(task);
      if(batch.phase!=='done' && task.assignmentId && task.workerId && !['success','exists','conflict','failed','stopped'].includes(task.status)){
        this.slots.set(task.workerId,{id:task.workerId,busy:task.assignmentId,since:Date.now()});
      }
    }
    this.save();this.notice(batch.phase==='draft'?'已恢复未确认草稿。请重新预检，检查清单后点击开始创建。':'已恢复历史批次并暂停。提交过或结果不确定的任务只允许先核验；点击继续才会派发尚未提交的任务。');
  }
  signature(config:PanelConfig):string{return JSON.stringify([config.format,config.concurrency,config.execution,config.rows,this.identity?.publisherId,this.identity?.appId]);}
  async preflight(config:PanelConfig):Promise<void>{
    if(this.batch && this.batch.phase!=='done' && this.batch.phase!=='draft')throw new Error('请先处理当前批次；不能覆盖未完成批次');
    if(!config.rows.length || config.rows.some(r=>r.errors.length))throw new Error('请先修正两列输入中的全部行级错误');
    for(const [id,slot] of this.slots)if(!slot.busy){slot.tab?.close();this.slots.delete(id);}
    await this.identify();await this.acquire();
    const active=get<{appId:string;id:string}|undefined>('active:'+this.identity!.publisherId,undefined);
    if(active && active.id!==this.batch?.id){
      const old=get<Batch|undefined>('batch:'+this.identity!.publisherId+':'+active.appId+':'+active.id,undefined);
      if(old && old.phase!=='done')throw new Error('此发布商还有未完成批次，请进入原应用恢复：'+active.appId);
    }
    const batch=createBatch(config.rows,this.identity!,config.format,config.concurrency,config.execution,location.href,this.id);
    this.batch=batch;this.save();
    for(const task of batch.tasks){
      this.notice('预检查重：'+task.name);
      const lookup=await this.adapter.lookup(batch.identity,task.name);
      const classification=classifyLookup(lookup,batch.identity,batch.format,task.name,task.floor);
      task.actual=classification.actual;transition(task,classification.status,classification.reason);this.save();
    }
    await this.adapter.home();await this.identify();
    if(config.execution==='tabs')await this.probe();
    this.preflightSignature=this.signature(config);
    const pending=batch.tasks.filter(t=>t.status==='pending').length;
    this.panel.update({ready:pending>0,checks:[{label:'已固定发布商及应用',ok:true},{label:'两列输入有效',ok:true},{label:'已完成已有广告单元查重；不完整项单独阻止创建',ok:true},{label:'执行时逐条核验真实 USD、格式、手动底价和金额',ok:true},{label:config.execution==='tabs'?'跨页互斥、通知及账号检查已通过':'单页执行；已取得账号主控锁',ok:true}]});
    this.notice('预检不创建广告位。待创建 '+pending+' 条；冲突与待核验项不会提交。实际表单的币种、金额限制会在提交前再次检查。');
  }
  async probe():Promise<Slot>{
    if(!this.identity)throw new Error('未识别账号');
    const reusable=[...this.slots.values()].find(s=>!s.busy && s.probePassed && !s.tab?.closed && s.identity && sameIdentity(s.identity,this.identity!) && s.batchId===this.batch?.id);
    if(reusable)return reusable;
    const nonce=uuid(),lockName='admob-batch-probe:'+nonce;
    const release=await holdLock(lockName);
    const slot:Slot={id:uuid(),since:Date.now(),identity:this.identity,batchId:this.batch?.id};this.slots.set(slot.id,slot);
    const url=new URL(this.batch?.sourceUrl || location.href);url.searchParams.set('__admob_batch_worker',slot.id);
    set('command:'+slot.id,{seq:1,probe:{nonce,lockName}} satisfies Command);
    slot.tab=GM_openInTab(url.href,{active:false,insert:true,setParent:true});
    try{
      await waitFor(()=>{const r=get<Report|undefined>('report:'+slot.id,undefined);return r?.probe?.nonce===nonce?r:undefined;},25000);
      // The initial command predates the worker listener. A second challenge
      // verifies an actual remote GM value-change notification after startup.
      const challenge=uuid();
      set('command:'+slot.id,{seq:2,probe:{nonce:challenge,lockName}} satisfies Command);
      const report=await waitFor(()=>{const r=get<Report|undefined>('report:'+slot.id,undefined);return r?.probe?.nonce===challenge?r:undefined;},15000);
      if(!report.probe?.locked || !report.probe.notifications || !report.probe.identity || !sameIdentity(report.probe.identity,this.identity))throw new Error(report.probe?.error || '跨页锁作用域、GM通知或登录账号检查未通过；请改为单页模式。');
      slot.probePassed=true;slot.lastReport=report.id;this.notice('当前会话跨页能力检查通过；尚未创建任何广告位。');return slot;
    }catch(error){
      // This page has only performed the read-only probe and has no job.
      slot.tab?.close();this.slots.delete(slot.id);throw error;
    }finally{release();}
  }
  async start(config:PanelConfig):Promise<void>{
    this.requireBatch();await this.identify();await this.acquire();
    if(this.batch!.phase!=='draft' || this.preflightSignature!==this.signature(config))throw new Error('输入或账号已变化，请重新预检');
    this.batch!.confirmedAt=new Date().toISOString();this.batch!.phase='running';set('active:'+this.batch!.identity.publisherId,{appId:this.batch!.identity.appId,id:this.batch!.id});this.save();
    this.notice('批次已开始。先执行一条并核验，通过后再增加并发。');
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
    if(!this.batch!.confirmedAt)throw new Error('草稿尚未确认开始；请重新预检，检查清单后点击开始创建');
    if(!sameIdentity(this.identity!,this.batch!.identity))throw new Error('请回到批次原发布商与原应用');
    if(this.batch!.phase==='stopping')throw new Error('批次已停止；仅可核验已有提交或重试明确失败项');
    this.batch!.phase='running';this.errors=0;this.save();
  }
  async retry():Promise<void>{
    this.requireBatch();
    if(this.batch!.phase==='running')throw new Error('请先暂停后重试明确失败项');
    if([...this.slots.values()].some(slot=>slot.busy))throw new Error('旧执行页尚未收齐结果，请先保留原页并完成收集或核验');
    let count=0;
    for(const t of this.batch!.tasks)if(mayRetry(t)){t.assignmentId=undefined;t.workerId=undefined;transition(t,'pending','用户重试：尚无提交意图');count++;}
    if(count>0){delete this.batch!.stopRequestedAt;this.batch!.phase='paused';}
    this.save();this.notice('已准备 '+count+' 条安全重试项（最多三次，按尝试次数退避）；'+(count>0?'点击继续后执行。':'保持原批次状态。'));
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
      const lookup=await this.adapter.lookup(this.batch!.identity,task.name);
      const c=classifyLookup(lookup,this.batch!.identity,this.batch!.format,task.name,task.floor);
      if(c.status==='exists'){
        const prior=task.actual?.unitId;
        if(prior && c.actual?.unitId!==prior){transition(task,'created-unverified','同名条目 ID 与已取得 ID 不符，保留原记录等待人工核验');this.save();continue;}
        task.actual=c.actual;transition(task,prior?'success':'exists',prior?'已按已知 ID 核验保存配置':'发现同名同配置广告位；无法判定是否本批创建，记录为已存在');
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
    }await this.adapter.home();}finally{this.localBusy=false;this.save();}
  }
  async dispatch(slot:Slot,task:Task):Promise<void>{
    const batch=this.batch!;
    task.workerId=slot.id;task.assignmentId=uuid();task.attempts++;slot.busy=task.assignmentId;slot.since=Date.now();
    const job:Job={batch:structuredClone(batch),task:structuredClone(task),assignmentId:task.assignmentId,workerId:slot.id,kind:'create'};
    this.save();
    const priorCommand=get<Command>('command:'+slot.id,{seq:0});
    // The previous terminal ACK must survive immediate slot reuse: a frozen
    // or throttled worker may not have observed it before this new assignment.
    set('command:'+slot.id,{seq:priorCommand.seq+1,job,ack:priorCommand.ack} satisfies Command);
    if(batch.execution==='single'){
      this.localBusy=true;
      void performJob(job,this.adapter,async data=>{
        await this.handle(slot,{...data,id:uuid(),at:Date.now(),workerId:slot.id});
      },async()=>{
        if(this.batch?.phase!=='running')throw new Error('任务已暂停或停止，在提交前安全停下');
        const command=get<Command>('command:'+slot.id,{seq:0});
        if(command.blocked)throw new Error(command.blocked);
        if(task.intentAt && (!command.grant || command.grant.expires<Date.now()))throw new Error('提交许可已过期，未点击创建');
      }).catch(e=>this.pause('单页通信或存储异常：'+(e as Error).message)).finally(()=>{this.localBusy=false;});
    }
  }
  async handle(slot:Slot,r:Report):Promise<void>{
    const task=this.batch?.tasks.find(t=>t.assignmentId===r.assignmentId);
    if(!task || !reportBelongs(r,task,slot.id) || slot.lastReport===r.id)return;
    const cmd=get<Command>('command:'+slot.id,{seq:0});
    if(cmd.ack===r.id){slot.lastReport=r.id;return;}
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
      if(r.stage==='filling' && task.status==='pending')transition(task,'filling');
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
        const r=get<Report|undefined>('report:'+slot.id,undefined);
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
      if(this.batch.phase!=='running')return;
      if(Date.now()-this.lastIdentityCheck>5000 && !this.localBusy){
        this.lastIdentityCheck=Date.now();
        try{await this.identify();}catch(e){await this.pause('当前身份无法确认：'+(e as Error).message);return;}
      }
      const busy=[...this.slots.values()].filter(s=>s.busy).length;
      if(canDispatch(this.batch,busy)){
        const task=this.batch.tasks.find(t=>t.status==='pending' && !t.assignmentId && Date.now()-Date.parse(t.logs.at(-1)?.at || this.batch!.createdAt)>Math.max(0,t.attempts-1)*3000);
        if(task){
          let slot=[...this.slots.values()].find(s=>!s.busy && (this.batch!.execution==='single'?s.id.startsWith('single:'):(s.probePassed && s.batchId===this.batch!.id && !!s.identity && sameIdentity(s.identity,this.batch!.identity))) && !s.tab?.closed);
          if(!slot){
            if(this.batch.execution==='single'){slot={id:'single:'+this.id,since:Date.now()};this.slots.set(slot.id,slot);}
            else slot=await this.probe();
          }
          if(this.batch.phase==='running' && task.status==='pending' && !task.assignmentId)await this.dispatch(slot,task);
        }
      }
      if(!this.batch.tasks.some(t=>['pending','filling','submitting','verifying'].includes(t.status)) && ![...this.slots.values()].some(s=>s.busy)){
        this.batch.phase=this.batch.tasks.some(t=>['uncertain','created-unverified'].includes(t.status))?'paused':'done';this.save();
        this.notice(this.batch.phase==='done'?'批次执行结束，请核对并导出结果。':'存在待核验结果，禁止自动重建。');
      }
    }finally{this.tickBusy=false;}
  }
  diagnostics():void{
    // Export only an allowlist. No raw DOM, account IDs, names, URLs, input values or logs.
    const data={schema:1,at:new Date().toISOString(),userAgent:navigator.userAgent,origin:location.origin,capabilities:{webLocks:!!navigator.locks,gmStorage:typeof GM_getValue==='function',gmNotifications:typeof GM_addValueChangeListener==='function',gmTabs:typeof GM_openInTab==='function'},phase:this.batch?.phase,counts:this.batch?.tasks.reduce<Record<string,number>>((a,t)=>(a[t.status]=(a[t.status]||0)+1,a),{}),workers:[...this.slots.values()].map(s=>({busy:!!s.busy,probePassed:!!s.probePassed,closed:s.tab?.closed})),page:this.adapter.diagnostics()};
    download('AdMob-脱敏诊断-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',JSON.stringify(data,null,2),'application/json;charset=utf-8');
  }
}

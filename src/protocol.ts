import type { Actual, Batch, Task } from './types.ts';
// A command needs one task and its ownership context, never every task/log in the batch.
export type WorkerBatch = Pick<Batch,'id'|'identity'|'format'|'partnerBidding'|'controllerId'|'phase'> & {mode?:Batch['mode']};
export interface Job { batch:WorkerBatch; task:Task; assignmentId:string; workerId:string; kind:'create'|'verify'; parallelPreparation?:boolean;requireForeground?:boolean }
export interface Command { seq:number; probe?:{nonce:string;lockName:string;identify?:boolean;createIdentity?:Batch['identity']}; close?:boolean; job?:Job; ack?:string; grant?:{assignmentId:string;expires:number}; blocked?:string;
  activate?:{nonce:string};
  closeAfterReload?:boolean;
}
export interface Report { id:string; workerId:string; at:number; type:'hello'|'closed'|'active'|'stage'|'intent'|'result'|'error'; assignmentId?:string; taskId?:string; stage?:'filling'|'verifying'|'created'; status?:Task['status']; reason?:string; actual?:Partial<Actual>; fatal?:boolean; probe?:{nonce:string;locked:boolean;identity?:Batch['identity'];error?:string;notifications:boolean};
  activation?:{nonce:string;visible:boolean;error?:string};
  closingSeq?:number;
}
export interface Journal { assignmentId:string; taskId:string; batchId:string; state:'filling'|'intent'|'done'; report?:Report }
export function reportBelongs(report:Report,task:Task,workerId:string):boolean {
  return !!report.assignmentId && task.workerId===workerId && report.workerId===workerId && report.assignmentId===task.assignmentId && report.taskId===task.id;
}
export function mayRetry(task:Task):boolean { return task.status==='failed' && !task.intentAt && !task.actual?.unitId && task.attempts<3; }
export function needsVerification(task:Task):boolean {return !!task.intentAt || ['uncertain','created-unverified','submitting','verifying'].includes(task.status);}
export function safeFailure(task:Task,hasId:boolean):Task['status'] {return hasId?'created-unverified':needsVerification(task)?'uncertain':'failed';}
export function canDispatch(batch:Batch,busy:number):boolean {
  return batch.phase==='running' && busy<(batch.execution==='tabs'?batch.concurrency:1);
}
export function canSubmitPrepared(batch:Batch|undefined,task:Task):boolean {
  if(!batch || batch.phase!=='running' || !batch.tasks.some(row=>row.id===task.id && row.assignmentId===task.assignmentId && row.workerId===task.workerId))return false;
  if(batch.execution!=='tabs' || batch.canaryPassed)return true;
  // Preparing distinct pages may overlap. Until a saved result is verified,
  // only the first still-active row may request a submission intent/lease.
  const first=batch.tasks.find(row=>!['success','exists','failed','conflict','stopped'].includes(row.status));
  return first?.id===task.id;
}
export function canRecoverUnsubmitted(job:Job,batch:Batch,command:Command,journal:Journal|undefined):boolean {
  const task=batch.tasks.find(task=>task.id===job.task.id);
  return job.kind==='create' && batch.id===job.batch.id
    && batch.identity.publisherId===job.batch.identity.publisherId && batch.identity.appId===job.batch.identity.appId
    && command.job?.assignmentId===job.assignmentId && command.job.workerId===job.workerId
    && !!task && task.assignmentId===job.assignmentId && task.workerId===job.workerId
    && ['pending','filling','uncertain'].includes(task.status) && !task.intentAt && !task.actual && !command.grant
    && journal?.state==='filling' && journal.assignmentId===job.assignmentId
    && journal.taskId===task.id && journal.batchId===batch.id;
}

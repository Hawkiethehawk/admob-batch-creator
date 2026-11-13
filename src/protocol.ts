import type { Actual, Batch, Task } from './types.ts';
// A command needs one task and its ownership context, never every task/log in the batch.
export type WorkerBatch = Pick<Batch,'id'|'identity'|'format'|'controllerId'|'phase'> & {mode?:Batch['mode']};
export interface Job { batch:WorkerBatch; task:Task; assignmentId:string; workerId:string; kind:'create'|'verify' }
export interface Command { seq:number; probe?:{nonce:string;lockName:string}; job?:Job; ack?:string; grant?:{assignmentId:string;expires:number}; blocked?:string }
export interface Report { id:string; workerId:string; at:number; type:'hello'|'stage'|'intent'|'result'|'error'; assignmentId?:string; taskId?:string; stage?:'filling'|'verifying'|'created'; status?:Task['status']; reason?:string; actual?:Partial<Actual>; fatal?:boolean; probe?:{nonce:string;locked:boolean;identity?:Batch['identity'];error?:string;notifications:boolean} }
export interface Journal { assignmentId:string; taskId:string; batchId:string; state:'filling'|'intent'|'done'; report?:Report }
export function reportBelongs(report:Report,task:Task,workerId:string):boolean {
  return !!report.assignmentId && task.workerId===workerId && report.workerId===workerId && report.assignmentId===task.assignmentId && report.taskId===task.id;
}
export function mayRetry(task:Task):boolean { return task.status==='failed' && !task.intentAt && !task.actual?.unitId && task.attempts<3; }
export function needsVerification(task:Task):boolean {return !!task.intentAt || ['uncertain','created-unverified','submitting','verifying'].includes(task.status);}
export function safeFailure(task:Task,hasId:boolean):Task['status'] {return hasId?'created-unverified':needsVerification(task)?'uncertain':'failed';}
export function canDispatch(batch:Batch,busy:number):boolean {
  return batch.phase==='running' && busy<(batch.canaryPassed?batch.concurrency:1);
}

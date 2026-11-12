export type AdFormat = 'interstitial' | 'app-open';
export type Status = 'pending' | 'filling' | 'submitting' | 'verifying' | 'success' | 'failed' | 'uncertain' | 'created-unverified' | 'exists' | 'conflict' | 'stopped';
export interface Identity { publisherId: string; appId: string; appName: string; currency?: string; evidence: string[] }
export interface InputRow { line: number; name: string; floor: string; errors: string[] }
export interface Actual { unitId: string; publisherId: string; appId: string; name: string; format: AdFormat; mode: string; floor: string; currency: string; verified: boolean }
export interface Task { id: string; line: number; name: string; floor: string; status: Status; reason: string; assignmentId?: string; workerId?: string; intentAt?: string; actual?: Partial<Actual>; finishedAt?: string; attempts: number; logs: {at:string;step:string;message:string}[] }
export interface Batch { schema: 1; id: string; identity: Identity; format: AdFormat; mode: 'manual'; currency: 'USD'; concurrency: number; execution: 'tabs' | 'single'; sourceUrl: string; phase: 'draft' | 'running' | 'paused' | 'stopping' | 'done'; tasks: Task[]; createdAt: string; confirmedAt?:string; stopRequestedAt?:string; canaryPassed: boolean; controllerId: string }
export interface Lookup { complete: boolean; matches: Partial<Actual>[]; reason?: string }
export interface Adapter {
  identify(): Promise<Identity>;
  lookup(identity: Identity, name: string): Promise<Lookup>;
  prepare(identity: Identity, format: AdFormat, name: string, floor: string, checkpoint: () => Promise<void>): Promise<void>;
  submit(): Promise<void>;
  verify(identity: Identity, format: AdFormat, name: string, floor: string): Promise<Actual>;
  home(): Promise<void>;
  diagnostics(): unknown;
}
export const STATUS_ZH: Record<Status,string> = {pending:'待执行',filling:'填表中',submitting:'提交中',verifying:'核验中',success:'成功',failed:'明确失败',uncertain:'结果不确定','created-unverified':'已创建但配置待核验',exists:'已存在',conflict:'冲突',stopped:'已停止'};
export const FORMAT_ZH: Record<AdFormat,string> = {interstitial:'插页式','app-open':'开屏'};

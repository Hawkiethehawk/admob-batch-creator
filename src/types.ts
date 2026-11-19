export type AdFormat = 'banner' | 'interstitial' | 'rewarded-interstitial' | 'rewarded' | 'native' | 'app-open';
export type FloorMode = 'manual' | 'auto' | 'disabled';
export type ExecutionMode = 'paged' | 'single' | 'tabs';
export type Status = 'pending' | 'filling' | 'submitting' | 'verifying' | 'success' | 'failed' | 'uncertain' | 'created-unverified' | 'exists' | 'conflict' | 'stopped';
export interface Identity { publisherId: string; appId: string; appName: string; currency?: string; evidence: string[] }
export interface InputRow { line: number; name: string; floor: string; errors: string[] }
export interface Actual { unitId: string; publisherId: string; appId: string; name: string; format: AdFormat; mode: string; floor: string; currency: string; partnerBidding?: boolean; verified: boolean }
export interface Task { id: string; line: number; name: string; floor: string; mode?: FloorMode; partnerBidding?: boolean; status: Status; reason: string; assignmentId?: string; workerId?: string; intentAt?: string; actual?: Partial<Actual>; finishedAt?: string; attempts: number; logs: {at:string;step:string;message:string}[] }
export interface Batch { schema: 1; id: string; identity: Identity; format: AdFormat; mode: FloorMode; partnerBidding?: boolean; currency: 'USD'; concurrency: number; execution: ExecutionMode; sourceUrl: string; phase: 'draft' | 'running' | 'paused' | 'stopping' | 'done'; tasks: Task[]; createdAt: string; confirmedAt?:string; startedAt?:string; completedAt?:string; stopRequestedAt?:string; canaryPassed: boolean; canaryEvidence?:{sourceBatchId:string;unitId:string;verifiedAt:string}; controllerId: string }
export interface Lookup { complete: boolean; matches: Partial<Actual>[]; reason?: string }
export interface Adapter {
  identify(): Promise<Identity>;
  identifyCreatePage?(expected: Identity): Promise<Identity>;
  lookup(identity: Identity, name: string): Promise<Lookup>;
  prepare(identity: Identity, format: AdFormat, name: string, floor: string, checkpoint: () => Promise<void>, mode?: FloorMode, partnerBidding?: boolean): Promise<void>;
  submit(beforeClick?: () => void): Promise<void>;
  verify(identity: Identity, format: AdFormat, name: string, floor: string, mode?: FloorMode, partnerBidding?: boolean): Promise<Actual>;
  verifyById?(identity: Identity, unitId: string, name: string, format: AdFormat, floor: string, mode?: FloorMode, partnerBidding?: boolean): Promise<Actual>;
  recoverCreatedId?(identity: Identity, name: string, format: AdFormat): string | undefined;
  waitForUnitId?(): Promise<string>;
  home(expected?: Identity): Promise<void>;
  diagnostics(): unknown;
}
export const STATUS_ZH: Record<Status,string> = {pending:'待执行',filling:'填表中',submitting:'提交中',verifying:'核验中',success:'成功',failed:'明确失败',uncertain:'结果不确定','created-unverified':'已创建但配置待核验',exists:'已存在',conflict:'冲突',stopped:'已停止'};
export const FORMAT_ZH: Record<AdFormat,string> = {interstitial:'插页式','app-open':'开屏',native:'信息流（原生高级广告）',banner:'横幅',rewarded:'激励广告','rewarded-interstitial':'插页式激励广告'};
const standardMedia = ['文字、图片和富媒体', '视频'] as const;
export const MEDIA_DEFAULTS: Record<AdFormat, readonly string[]> = {
  banner: standardMedia, interstitial: standardMedia, 'app-open': standardMedia,
  native: ['图片', '视频'], rewarded: ['视频', '广告连播', '互动式'], 'rewarded-interstitial': ['视频', '互动式'],
};
export const REWARD_DEFAULT = { amount: '1', item: 'Reward' } as const;
export const MODE_ZH: Record<FloorMode,string> = {manual:'人工指定底价',auto:'由 Google 优化',disabled:'已停用'};

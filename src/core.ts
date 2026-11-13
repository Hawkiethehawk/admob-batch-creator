import type { Actual, AdFormat, Batch, FloorMode, Identity, InputRow, Lookup, Status, Task } from './types.ts';
import { FORMAT_ZH, MODE_ZH, STATUS_ZH } from './types.ts';
import { summarizeBatch, batchElapsed } from './history.ts';

/** Money is kept as decimal text throughout; no Number conversion or rounding. */
export function normalizeDecimal(value: string): string {
  const input = String(value).trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(input)) {
    throw new Error('底价须为非负十进制数字；不要包含货币符号、千分位、指数或逗号小数点');
  }
  const [whole, fraction = ''] = input.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const digits = fraction.replace(/0+$/, '');
  return digits ? `${integer}.${digits}` : integer;
}

export function decimalEqual(left: string, right: string): boolean {
  try { return normalizeDecimal(left) === normalizeDecimal(right); } catch { return false; }
}

function compareDecimal(left: string, right: string): number {
  const [a, af = ''] = normalizeDecimal(left).split('.');
  const [b, bf = ''] = normalizeDecimal(right).split('.');
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  if (a !== b) return a > b ? 1 : -1;
  const length = Math.max(af.length, bf.length);
  const av = af.padEnd(length, '0');
  const bv = bf.padEnd(length, '0');
  return av === bv ? 0 : av > bv ? 1 : -1;
}

export interface FloorConstraints { min?: string; max?: string; step?: string; required?: boolean }
// AdMob's documented AdUnit.displayName limit, not a claim about a tested live form.
export const MAX_NAME_LENGTH = 80;
/** Pass constraints read from the real amount input. Missing rules are not invented. */
export function validateFloorAgainstInput(value: string, constraints: FloorConstraints = {}): string[] {
  let amount: string;
  try { amount = normalizeDecimal(value); } catch (error) { return [(error as Error).message]; }
  const errors: string[] = [];
  const rules: Record<string, string | undefined> = { min: constraints.min, max: constraints.max, step: constraints.step };
  for (const key of ['min', 'max'] as const) {
    const rule = rules[key];
    if (rule === undefined || rule === '') continue;
    try {
      const comparison = compareDecimal(amount, rule);
      if (key === 'min' && comparison < 0) errors.push(`底价小于页面最小值 ${rule}`);
      if (key === 'max' && comparison > 0) errors.push(`底价大于页面最大值 ${rule}`);
    } catch { errors.push(`无法解释页面的 ${key} 金额限制，阻止提交`); }
  }
  if (constraints.step && constraints.step !== 'any') {
    try {
      const step = normalizeDecimal(constraints.step);
      if (step === '0') throw new Error('invalid step');
      const base = constraints.min ? normalizeDecimal(constraints.min) : '0';
      const scale = Math.max(...[amount, step, base].map((v) => v.split('.')[1]?.length ?? 0));
      const fixed = (v: string) => { const [whole, fraction = ''] = v.split('.'); return BigInt(whole + fraction.padEnd(scale, '0')); };
      if ((fixed(amount) - fixed(base)) % fixed(step) !== 0n) errors.push(`底价不符合页面精度/步长 ${constraints.step}`);
    } catch { errors.push('无法解释页面的金额步长限制，阻止提交'); }
  }
  return errors;
}

interface CsvRecord { line: number; fields: string[]; errors: string[] }
function detectDelimiter(text: string): string {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && char === '\t') return '\t';
    else if (!quoted && (char === '\r' || char === '\n')) {
      if (text.slice(0, index).trim()) break;
    }
  }
  return ',';
}

function readRecords(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let field = '', fields: string[] = [], errors: string[] = [];
  let quoted = false, closed = false, line = 1, recordLine = 1;
  const finish = () => {
    fields.push(field);
    if (fields.some((v) => v.trim() !== '') || errors.length) records.push({ line: recordLine, fields, errors });
    field = ''; fields = []; errors = []; closed = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; closed = true; }
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && text[index + 1] === '\n') index += 1;
        field += '\n'; line += 1;
      } else field += char;
      continue;
    }
    if (char === delimiter) { fields.push(field); field = ''; closed = false; }
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      finish(); line += 1; recordLine = line;
    } else if (char === '"') {
      if (field === '' && !closed) quoted = true;
      else { errors.push('引号位置无效；含分隔符的字段请用双引号包围'); field += char; }
    } else if (closed) {
      errors.push('闭合引号后出现多余字符'); field += char;
    } else field += char;
  }
  if (quoted) errors.push('字段双引号未闭合');
  finish();
  return records;
}

export function parseInput(text: string, options: { maxNameLength?: number; mode?: FloorMode } = {}): InputRow[] {
  const manual = !options.mode || options.mode === 'manual';
  const maxNameLength = Math.min(MAX_NAME_LENGTH, options.maxNameLength ?? MAX_NAME_LENGTH);
  if (!Number.isInteger(maxNameLength) || maxNameLength < 1) throw new Error('名称长度限制无效');
  const cleaned = text.replace(/^\uFEFF/, '');
  const records = readRecords(cleaned, detectDelimiter(cleaned));
  const headerName = /^(广告位名称|广告单元名称|名称|ad\s*unit\s*name)$/i;
  const headerFloor = /^(底价|底价usd|底价[（(]usd\s*[/／]\s*千次展示[）)]|floor(?:\s*usd)?)$/i;
  if (records[0]?.fields.length === 2 && headerName.test(records[0].fields[0].trim()) && headerFloor.test(records[0].fields[1].trim()) && !records[0].errors.length) records.shift();
  else if (!manual && records[0]?.fields.length === 1 && headerName.test(records[0].fields[0].trim()) && !records[0].errors.length) records.shift();
  const rows: InputRow[] = records.map((record) => {
    const [name = '', rawFloor = ''] = record.fields;
    const errors = [...new Set(record.errors)];
    if (record.fields.length !== 2 && (manual || record.fields.length !== 1)) errors.push(`应为${manual ? '两列' : '名称一列或名称、底价两列'}，实际为 ${record.fields.length} 列`);
    if (!name.trim()) errors.push('广告位名称不能为空');
    if (name !== name.trim()) errors.push('名称前后存在空白，请明确修正');
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(name)) errors.push('名称包含不支持的控制字符');
    if (name.length > maxNameLength) errors.push(`名称超过限制 ${maxNameLength} 个字符，未截断`);
    let floor = rawFloor;
    if (manual) {
      if (!rawFloor.trim()) errors.push('缺失底价');
      else { try { floor = normalizeDecimal(rawFloor); } catch (error) { errors.push((error as Error).message); } }
    }
    return { line: record.line, name, floor, errors };
  });
  // AdMob permits duplicate ad-unit names. Each row is an independent create
  // request; the new unit ID, not the name, distinguishes the result.
  return rows;
}

export interface LookupClassification { status: 'pending' | 'exists' | 'conflict' | 'uncertain'; reason: string; actual?: Partial<Actual> }
export function matchesFloor(actual: Partial<Actual>, floor: string, mode: FloorMode = 'manual'): boolean {
  return actual.mode === mode && (mode !== 'manual' || (actual.currency === 'USD' && actual.floor !== undefined && decimalEqual(actual.floor, floor)));
}
export function classifyLookup(lookup: Lookup, identity: Identity, format: AdFormat, name: string, floor: string, mode: FloorMode = 'manual'): LookupClassification {
  if (!lookup.complete) return { status: 'uncertain', reason: lookup.reason || '已有广告位读取不完整，不能判定不存在' };
  const matches = lookup.matches.filter((match) => match.name === name);
  if (matches.length === 0) return { status: 'pending', reason: '已完整检查，未发现同名广告位' };
  if (matches.length > 1) return { status: 'uncertain', reason: '存在多个同名广告位，需人工核验' };
  const actual = matches[0];
  if (actual.publisherId !== identity.publisherId || actual.appId !== identity.appId) return { status: 'uncertain', reason: '同名结果所属发布商或应用无法确认', actual };
  if (!actual.unitId || !/^ca-app-pub-\d{16}\/\d{10}$/.test(actual.unitId) || !actual.unitId.startsWith(`ca-app-${identity.publisherId}/`)) return { status: 'uncertain', reason: '未获得可核对的真实广告位 ID', actual };
  if (actual.format && actual.format !== format) return { status: 'conflict', reason: '同名广告位的广告格式不同', actual };
  if (actual.mode && actual.mode !== mode) return { status: 'conflict', reason: '同名广告位的底价模式不同', actual };
  if (mode === 'manual' && actual.currency && actual.currency !== 'USD') return { status: 'conflict', reason: '同名广告位底价币种不是 USD', actual };
  if (mode === 'manual' && actual.floor !== undefined && !decimalEqual(actual.floor, floor)) return { status: 'conflict', reason: '同名广告位底价金额不同或无法解释', actual };
  if (!actual.verified || actual.format !== format || !matchesFloor(actual, floor, mode)) return { status: 'uncertain', reason: '同名广告位配置未完整核验', actual };
  return { status: 'exists', reason: '已有同名、同格式、同底价配置广告位，跳过创建', actual };
}

const ALLOWED: Record<Status, Status[]> = {
  pending: ['filling', 'exists', 'conflict', 'uncertain', 'failed', 'stopped'],
  filling: ['submitting', 'pending', 'failed', 'stopped', 'uncertain', 'exists', 'conflict'],
  submitting: ['verifying', 'uncertain', 'created-unverified'],
  verifying: ['success', 'exists', 'uncertain', 'created-unverified', 'conflict'],
  success: [], exists: [], conflict: ['verifying'],
  failed: ['pending', 'stopped', 'verifying'],
  uncertain: ['verifying', 'created-unverified', 'failed'],
  'created-unverified': ['verifying'], stopped: ['pending', 'verifying'],
};
const FINAL = new Set<Status>(['success', 'failed', 'created-unverified', 'exists', 'conflict', 'stopped', 'uncertain']);

export function transition(task: Task, status: Status, reason = ''): Task {
  if (task.status !== status && !ALLOWED[task.status].includes(status)) throw new Error(`不允许的任务状态转换：${task.status} → ${status}`);
  if (task.intentAt && ['pending', 'filling', 'failed', 'stopped'].includes(status)) throw new Error('已有提交意图，必须核验，不能重新创建或断言失败');
  if (status === 'submitting' && (!task.assignmentId || !task.workerId || !task.intentAt)) throw new Error('提交前必须持久化提交意图与任务归属');
  if (status === 'success') {
    const actual = task.actual;
    if (!actual?.verified || !actual.unitId || !/^ca-app-pub-\d{16}\/\d{10}$/.test(actual.unitId)
      || !actual.publisherId || !actual.appId || !actual.unitId.startsWith(`ca-app-${actual.publisherId}/`)
      || !actual.appId.startsWith(`ca-app-${actual.publisherId}~`) || actual.name !== task.name
      || !actual.format || !matchesFloor(actual, task.floor, task.mode ?? 'manual')) {
      throw new Error('实际保存配置与广告位 ID 尚未完整核验，不能标记成功');
    }
  }
  task.status = status;
  task.reason = reason;
  const now = new Date().toISOString();
  task.logs.push({ at: now, step: status, message: reason });
  if (FINAL.has(status)) task.finishedAt = now;
  else delete task.finishedAt;
  return task;
}

export function recoverTask(task: Task): Task {
  if (task.intentAt && !['success', 'exists', 'created-unverified', 'conflict'].includes(task.status)) {
    task.status = task.actual?.unitId ? 'created-unverified' : 'uncertain';
    task.reason = '检测到历史提交意图，先核验平台真实结果，禁止重新提交';
  } else if (task.status === 'submitting' || task.status === 'verifying') {
    task.status = task.actual?.unitId ? 'created-unverified' : 'uncertain';
    task.reason = '中断时处于提交或核验阶段，结果待核验';
  } else if (task.status === 'filling') {
    task.status = 'failed';
    task.reason = '填表阶段中断，尚无提交意图；可由用户重试';
  }
  // Ownership is retained: a frozen worker must never make its task eligible elsewhere.
  return task;
}

function newId(): string { return globalThis.crypto.randomUUID(); }
export function createBatch(rows: InputRow[], identity: Identity, format: AdFormat, concurrency: number, execution: 'tabs' | 'single', sourceUrl: string, controllerId: string, mode: FloorMode = 'manual'): Batch {
  if (!['manual', 'auto', 'disabled'].includes(mode)) throw new Error('不支持的底价模式');
  if (!Array.isArray(rows) || !rows.length) throw new Error('请输入至少一条广告位');
  for (const row of rows) {
    if (!row || !Array.isArray(row.errors) || row.errors.length) throw new Error('输入存在行级错误，请先修正');
    if (typeof row.name !== 'string' || !row.name.trim() || row.name !== row.name.trim() || row.name.length > MAX_NAME_LENGTH || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(row.name)) throw new Error(`第 ${row.line} 行广告位名称无效或超过 ${MAX_NAME_LENGTH} 个字符`);
    if (!Number.isSafeInteger(row.line) || row.line < 1) throw new Error('输入原始行号无效');
    // Duplicate names are allowed by AdMob; do not reject the row here.
    if (typeof row.floor !== 'string') throw new Error(`第 ${row.line} 行底价须为十进制字符串`);
    if (mode === 'manual') normalizeDecimal(row.floor);
  }
  if (!/^pub-\d{16}$/.test(identity.publisherId) || !/^ca-app-pub-\d{16}~\d{10}$/.test(identity.appId) || !identity.appId.startsWith(`ca-app-${identity.publisherId}~`)) throw new Error('发布商 ID 或应用 ID 无效或不匹配');
  if (![1, 2, 3, 4, 5].includes(concurrency)) throw new Error('并发数必须为 1、2、3、4 或 5');
  if (!['interstitial', 'app-open', 'native'].includes(format)) throw new Error('不支持的广告格式');
  if (!['tabs', 'single'].includes(execution)) throw new Error('不支持的执行模式');
  if (typeof controllerId !== 'string' || !controllerId.trim()) throw new Error('主控标识不能为空');
  return {
    schema: 1, id: newId(), identity: structuredClone(identity), format, mode, currency: 'USD', concurrency: execution === 'single' ? 1 : concurrency,
    execution, sourceUrl, phase: 'draft', createdAt: new Date().toISOString(), canaryPassed: false, controllerId,
    tasks: rows.map((row) => ({ id: newId(), line: row.line, name: row.name, mode, floor: mode === 'manual' ? normalizeDecimal(row.floor) : '', status: 'pending', reason: '', attempts: 0, logs: [] })),
  };
}

function spreadsheetText(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[\s\u0000-\u001F]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return text;
}
function csvCell(value: unknown): string {
  return `"${spreadsheetText(value).replace(/"/g, '""')}"`;
}
export function exportCsv(batch: Batch, filter: 'all' | 'success' | 'exceptions' = 'all'): string {
  const success = new Set<Status>(['success', 'exists']);
  const tasks = batch.tasks.filter((task) => filter === 'all' || (filter === 'success' ? success.has(task.status) : !success.has(task.status)));
  const records: unknown[][] = [[ '原始行号', '发布商ID', '应用名称', 'App ID', '广告位名称', '广告格式', '请求底价模式', '请求底价USD', '实际底价模式', '实际底价', '实际币种', '广告位ID', '状态', '原因', '完成时间', '批次ID', '批次开始时间', '批次结束时间', '批次总耗时' ]];
  const timing = summarizeBatch(batch);
  for (const task of tasks) records.push([task.line, batch.identity.publisherId, batch.identity.appName, batch.identity.appId, task.name, FORMAT_ZH[batch.format], MODE_ZH[batch.mode ?? 'manual'], task.floor, task.actual?.mode, task.actual?.floor, task.actual?.currency, task.actual?.unitId, STATUS_ZH[task.status], task.reason, task.finishedAt, batch.id, timing.startedAt, timing.completedAt, batchElapsed(timing)]);
  return `\uFEFF${records.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function copyPairs(batch: Batch): string {
  // Spreadsheet quoting preserves embedded separators and refuses formula execution.
  const cell = (value: string) => { const text = spreadsheetText(value); return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
  return batch.tasks.filter((task) => task.actual?.unitId).map((task) => `${cell(task.name)}\t${cell(task.actual!.unitId!)}`).join('\r\n');
}

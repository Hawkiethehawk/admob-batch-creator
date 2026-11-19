import { normalizeDecimal, parseInput } from './core.ts';
import { FORMAT_ZH, MEDIA_DEFAULTS, MODE_ZH, REWARD_DEFAULT, STATUS_ZH } from './types.ts';
import type { AdFormat, Batch, ExecutionMode, FloorMode, Identity, InputRow } from './types.ts';
import { batchElapsed, summarizeBatch } from './history.ts';
import type { BatchSummary } from './history.ts';
import { needsVerification } from './protocol.ts';

export interface PanelConfig {
  format: AdFormat;
  mode?: FloorMode;
  partnerBidding?: boolean;
  concurrency: number;
  execution: ExecutionMode;
  text: string;
  rows: InputRow[];
  confirmedIdentity?: Pick<Identity, 'publisherId' | 'appId'>;
}
export interface PanelActions {
  identify(): Promise<void>;
  preflight(config: PanelConfig): Promise<void>;
  start(config: PanelConfig): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  retry(): Promise<void>;
  verify(): Promise<void>;
  verifyHistory?(batchId: string): Promise<void>;
  recordObservedId?(taskId: string, unitId: string): Promise<void>;
  recordHistoryObservedId?(batchId: string, taskId: string, unitId: string): Promise<void>;
  degrade(): Promise<void>;
  switchToPaged?(): Promise<void>;
  export(filter: 'all' | 'success' | 'exceptions', batchId?: string): Promise<void>;
  copy(batchId?: string): Promise<void>;
  history?(): Promise<void>;
  viewHistory?(batchId: string): Promise<void>;
  diagnostics(): Promise<void>;
  probe(): Promise<void>;
}
export interface PanelState {
  identity?: Identity;
  identityError?: string;
  batch?: Batch;
  notice?: string;
  checks?: { label: string; ok: boolean }[];
  ready?: boolean;
  busy?: boolean;
  capabilities?: string;
  workerUrl?: string;
  history?: BatchSummary[];
  historyBatch?: Batch;
}
export interface PanelHandle {
  update(state: Partial<PanelState>): void;
  getConfig(): PanelConfig;
  destroy(): void;
}

const STYLE = `
:host{all:initial;color-scheme:light;font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:13px;line-height:1.5;color:#192331}
*{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer;border:1px solid #c3cddd;border-radius:6px;background:#fff;color:#253751;padding:6px 10px;min-height:32px}button:hover:not(:disabled){background:#eef4ff;border-color:#6d8cb8}button:disabled{opacity:.45;cursor:not-allowed}button.primary{background:#155db4;color:white;border-color:#155db4}button.danger{color:#b42318}input,select,textarea{border:1px solid #c3cddd;border-radius:5px;background:#fff;color:#192331;padding:6px;max-width:100%}input:disabled,select:disabled,textarea:disabled{background:#edf1f5;color:#667386}input[type=checkbox]{width:16px;height:16px;margin:0;flex-shrink:0}input:focus-visible,button:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #2a71ca;outline-offset:2px}h2,h3,p{margin:0}h2{font-size:15px}h3{font-size:13px;margin-bottom:7px}section{padding:12px 14px;border-bottom:1px solid #e1e7ef}.shell{position:fixed;right:16px;top:72px;z-index:2147483647;width:min(650px,calc(100vw - 32px));max-height:calc(100vh - 88px);border:1px solid #bac9dc;border-radius:10px;background:white;box-shadow:0 8px 36px #12263f33;overflow:hidden}.head{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f1f6fc;border-bottom:1px solid #d5e1ef}.head h2{flex:1}.head small{font-size:11px;font-weight:normal;color:#526884}.body{overflow:auto;max-height:calc(100vh - 145px);overscroll-behavior:contain}.shell.collapsed{width:260px}.shell.collapsed .body{display:none}.row,.actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.config{display:grid;grid-template-columns:1fr 1fr;gap:9px}.field{display:flex;flex-direction:column;gap:4px}.field.full{grid-column:1/-1}.field select{width:100%}.muted{color:#596b80;font-size:12px}.warning{color:#865300;background:#fff8df;border:1px solid #f0dea0;border-radius:6px;padding:8px;margin-top:8px}.notice{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf4ff;color:#244f84;border-radius:6px;padding:8px;margin-bottom:8px}.notice:empty{display:none}.identity{display:grid;grid-template-columns:102px 1fr;gap:4px 10px;margin:8px 0}.identity dt{color:#566a83}.identity dd{margin:0;overflow-wrap:anywhere;font-family:inherit}.identity dd.code{font-family:ui-monospace,Consolas,monospace}.identity-state{white-space:pre-wrap;color:#865300}.table-scroll{overflow:auto;margin:8px 0;max-height:260px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d9e1eb;padding:5px;vertical-align:middle}th{background:#f1f5fa;text-align:center;font-weight:600;position:sticky;top:0;z-index:1}.input-table th:nth-child(1){width:42px}.input-table th:nth-child(2){width:47%}.input-table th:nth-child(3){width:125px}.input-table td:first-child,.input-table td:last-child{text-align:center}.input-table input{width:100%;min-width:100px;padding:5px}.input-table input[aria-invalid=true]{border-color:#d14438;background:#fff8f7}.input-table .error-row td{text-align:left;color:#a52c22;background:#fff6f3}.input-table .error-row[hidden]{display:none}.input-table .error-row td span{font-weight:600}.result-table{min-width:670px}.result-table td:nth-child(1),.result-table td:nth-child(3),.result-table td:nth-child(4),.result-table td:nth-child(5){text-align:center}.result-table td:nth-child(2),.result-table td:last-child{text-align:left;white-space:normal;overflow-wrap:anywhere}.result-table td:nth-child(6){text-align:center;font-family:ui-monospace,Consolas,monospace}.badge{display:inline-block;border-radius:4px;padding:2px 5px;background:#edf1f6;color:#40516b;white-space:nowrap}.badge.good{background:#e5f5ec;color:#17633d}.badge.bad{background:#fff0e9;color:#9c3d19}.checks{list-style:none;padding:0;margin:7px 0}.checks li{display:flex;gap:6px;margin:4px 0;align-items:flex-start}.check-ok{color:#17633d}.check-bad{color:#a34122}.confirm{display:flex;gap:8px;align-items:flex-start;margin:10px 0}.confirm input{margin-top:3px}.log{max-height:180px;overflow:auto;background:#f5f7fa;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;border-radius:5px}.log:empty::before{content:"暂无执行日志";color:#627188}.summary{font-size:12px;color:#4e6581;margin:6px 0}.paste{width:100%;min-height:80px;resize:vertical;font-family:ui-monospace,Consolas,"Microsoft YaHei",monospace}.spacer{margin-top:9px}summary{cursor:pointer;color:#385c88}.file{max-width:245px;font-size:12px}.empty{text-align:center;padding:16px;color:#63768e}.footer{font-size:11px;color:#627188;padding:8px 14px}.mode-note{min-height:18px}.batch-meta{overflow-wrap:anywhere}.error-cell{max-width:220px}@media(max-width:560px){.shell{right:8px;top:40px;width:calc(100vw - 16px);max-height:calc(100vh - 48px)}.body{max-height:calc(100vh - 105px)}.config{grid-template-columns:1fr}.identity{grid-template-columns:88px 1fr}.head small{display:none}}
`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const PREVIEW_STYLE = `
.prefix-switch,.bidding-option{display:inline-flex;align-items:center;gap:7px;cursor:pointer}
.input-table input[readonly]{background:#f1f5fa;color:#324c6b}
.creation-preview{width:min(790px,calc(100vw - 32px));max-height:calc(100vh - 48px);padding:18px 20px;border:1px solid #bac9dc;border-radius:10px;color:#192331;background:white;box-shadow:0 12px 44px #12263f44}
.creation-preview::backdrop{background:#12263f80}
.creation-preview .table-scroll{max-height:min(45vh,380px);margin:12px 0}
.creation-preview td{overflow-wrap:anywhere}
.creation-preview th:first-child{min-width:140px}
.preview-actions{justify-content:flex-end}
.run-feedback{position:sticky;top:0;z-index:3;padding:8px 14px;background:white;border-bottom:1px solid #d5e1ef}
.run-feedback .notice{margin:0}
.run-feedback a{display:inline-block;margin-top:6px;padding:5px 9px;color:#155db4;border:1px solid #bac9dc;border-radius:5px}
.run-feedback a[hidden]{display:none}
`;
function option(value: string, label: string): HTMLOptionElement {
  const node = element('option', label); node.value = value; return node;
}
function csvCell(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function safeLogText(value: string): string {
  return value
    .replace(/\b(cookie|set-cookie|authorization)["']?\s*[:=：][^\r\n]*/gi, '$1: [凭证已隐藏]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [凭证已隐藏]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|token|password|passwd|secret)["']?\s*[:=：]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[凭证已隐藏]')
    .replace(/(密码|口令)\s*[:=：]\s*[^\s,;]+/g, '$1=[凭证已隐藏]');
}
function elapsedText(from: number, to: number): string {
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? `${((to - from) / 1000).toFixed(3)} 秒` : '未知';
}
function logStepLabel(step: string): string {
  return Object.prototype.hasOwnProperty.call(STATUS_ZH, step) ? STATUS_ZH[step as keyof typeof STATUS_ZH] : `其他步骤（${safeLogText(step)}）`;
}

export function mountPanel(actions: PanelActions): PanelHandle {
  if (document.getElementById('abc-panel-host')) throw new Error('AdMob Batch Creator 面板已存在');
  const host = element('div'); host.id = 'abc-panel-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(element('style', STYLE + PREVIEW_STYLE));
  const shell = element('aside', undefined, 'shell'); shell.setAttribute('aria-label', 'AdMob 批量创建广告位');
  const head = element('header', undefined, 'head');
  const title = element('h2', 'AdMob Batch Creator'); title.append(element('small', ' · 批量广告单元'));
  const collapse = element('button', '收起'); collapse.type = 'button'; collapse.setAttribute('aria-expanded', 'true');
  head.append(title, collapse); shell.append(head);
  const body = element('div', undefined, 'body'); body.id = 'abc-panel-body'; collapse.setAttribute('aria-controls', body.id); shell.append(body);
  shadow.append(shell); document.documentElement.append(host);

  const state: PanelState = { ready: false, checks: [], busy: false };
  let localBusy = false;
  let inputRows: InputRow[] = [];
  let pendingPreview: PanelConfig | undefined;
  let renderedBatch = '';
  let restoredBatchId = '';
  let lastBatchPhase = '';
  let editorBatchId = '';
  const clearedStoppedEditors = new Set<string>();
  const updateObservedInputs: (() => void)[] = [];
  const editableControls: (HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] = [];
  const buttons: Record<string, HTMLButtonElement> = {};
  const feedback = element('div', undefined, 'run-feedback'); feedback.hidden = true;
  const notice = element('div', '', 'notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  feedback.append(notice); body.append(feedback);
  const section = (heading: string): HTMLElement => { const n = element('section'); n.append(element('h3', heading)); body.append(n); return n; };
  const accountSection = section('当前页面');
  const identityList = element('dl', undefined, 'identity');
  const identityValues: Record<string, HTMLElement> = {};
  for (const [key, label] of [['publisherId', '发布商 ID'], ['appName', '当前应用'], ['appId', 'AdMob App ID']]) {
    const value = element('dd', '未识别', key === 'publisherId' || key === 'appId' ? 'code' : '');
    identityValues[key] = value; identityList.append(element('dt', label), value);
  }
  const identityStatus = element('p', '请进入目标应用，再识别当前账号。', 'identity-state');
  const capabilities = element('p', '', 'muted spacer');
  accountSection.append(identityList, identityStatus);

  async function invoke(run: () => Promise<void>): Promise<void> {
    if (localBusy) return;
    localBusy = true; updateControls();
    try { await run(); }
    catch (error) { state.notice = error instanceof Error ? error.message : String(error); renderNotice(); }
    finally { localBusy = false; updateControls(); }
  }
  function button(key: string, label: string, callback: () => Promise<void>, className = ''): HTMLButtonElement {
    const b = element('button', label, className); b.type = 'button'; buttons[key] = b;
    b.dataset.action = key;
    b.addEventListener('click', () => { if (!b.disabled) void invoke(callback); }); return b;
  }
  const accountActions = element('div', undefined, 'actions spacer');
  const workerLink=element('a','打开执行页');workerLink.dataset.action='open-worker';workerLink.target='_blank';workerLink.rel='noopener';workerLink.hidden=true;
  accountActions.append(button('identify', '重新识别', actions.identify), button('probe', '检测跨页能力', actions.probe), button('diagnostics', '导出脱敏诊断', actions.diagnostics));
  feedback.append(workerLink);
  accountSection.append(accountActions, capabilities);
  accountSection.append(element('p', '按所选底价模式创建，每条取得新 ID 后自动核验保存配置。', 'muted spacer'));

  const settings = section('整批设置'); const config = element('div', undefined, 'config');
  const format = element('select'); format.setAttribute('aria-label', '广告格式');
  for (const value of ['interstitial', 'app-open', 'banner', 'native', 'rewarded', 'rewarded-interstitial'] as const) {
    format.append(option(value, value === 'interstitial' ? '插页式 / 插屏' : FORMAT_ZH[value]));
  }
  const mode = element('select'); mode.setAttribute('aria-label', '底价模式');
  for (const value of ['manual', 'auto', 'disabled'] as const) mode.append(option(value, MODE_ZH[value]));
  mode.value = 'manual';
  const partnerBidding = element('input'); partnerBidding.type = 'checkbox'; partnerBidding.setAttribute('aria-label', '合作平台出价');
  const biddingLabel = element('label', undefined, 'bidding-option spacer'); biddingLabel.append(partnerBidding, element('span', '合作平台出价'));
  partnerBidding.addEventListener('change', () => {
    if (partnerBidding.checked) applyPrefix.checked = false;
    invalidate(); renderRows();
  });
  const execution = element('select'); execution.setAttribute('aria-label', '执行方式'); execution.append(option('paged', '并发'), option('single', '串行（当前页逐条执行）'));
  const controls: [string, HTMLElement][] = [['广告格式', format], ['底价模式', mode], ['执行方式', execution]];
  for (const [labelText, control] of controls) { const label = element('label', undefined, 'field'); label.append(element('span', labelText), control); config.append(label); }
  editableControls.push(format, mode, execution, partnerBidding); settings.append(config, biddingLabel);
  const modeNote = element('p', '', 'muted spacer mode-note'); settings.append(modeNote);
  const biddingNote = element('p', '', 'muted spacer'); settings.append(biddingNote);
  execution.addEventListener('change', () => invalidate());
  format.addEventListener('change', () => {
    if (format.value === 'rewarded-interstitial') partnerBidding.checked = false;
    invalidate(); renderRows();
  });

  mode.addEventListener('change', () => {
    if (mode.value !== 'manual') applyPrefix.checked = false;
    invalidate(); renderRows();
  });
  const inputSection = element('section'); body.append(inputSection);
  const add = element('button', '增加一行'); add.type = 'button'; add.addEventListener('click', () => {
    inputRows.push({ line: Math.max(0, ...inputRows.map(r => r.line)) + 1, name: '', floor: '', errors: [] });
    invalidate(); renderRows();
    const row = rowNodes.at(-1);
    (applyPrefix.checked ? row?.floor : row?.name)?.focus();
  });
  editableControls.push(add);
  const prefixRow = element('div', undefined, 'actions spacer');
  const prefix = element('input'); prefix.type = 'text'; prefix.placeholder = '例如 admob_int_'; prefix.setAttribute('aria-label', '名称前缀');
  const applyPrefix = element('input'); applyPrefix.type = 'checkbox'; applyPrefix.setAttribute('role', 'switch'); applyPrefix.setAttribute('aria-label', '批量应用前缀');
  const prefixLabel = element('label', undefined, 'prefix-switch'); prefixLabel.append(applyPrefix, element('span', '批量应用前缀'));
  applyPrefix.addEventListener('change', () => { invalidate(); validateRows(); });
  prefix.addEventListener('input', () => { invalidate(); validateRows(); });
  prefixRow.append(prefixLabel, prefix); inputSection.append(prefixRow);
  const inputSummary = element('p', '暂无广告位。', 'summary'); inputSummary.setAttribute('aria-live', 'polite'); inputSection.append(inputSummary);
  const inputScroll = element('div', undefined, 'table-scroll'); const inputTable = element('table', undefined, 'input-table'); inputTable.setAttribute('aria-label', '广告位名称与底价清单');
  const inputHead = element('thead'); const inputHeadRow = element('tr');
  for (const name of ['原行', '广告位名称', '底价（USD / 千次）', '操作']) inputHeadRow.append(element('th', name));
  inputHead.append(inputHeadRow); const inputTbody = element('tbody'); inputTable.append(inputHead, inputTbody); inputScroll.append(inputTable); inputSection.append(inputScroll);
  inputSection.append(add);

  const runSection = section('执行任务');
  const checklist = element('ul', undefined, 'checks'); runSection.append(checklist);
  const runActions = element('div', undefined, 'actions');
  runActions.append(button('start', '开始创建', async () => openPreview(), 'primary'), button('pause', '暂停', actions.pause), button('resume', '继续', actions.resume), button('stop', '停止', actions.stop, 'danger'));
  const preview = element('dialog', undefined, 'creation-preview'); preview.setAttribute('role', 'dialog'); preview.setAttribute('aria-modal', 'true');
  const previewTitle = element('h2', '创建预览'); previewTitle.id = 'abc-preview-title'; preview.setAttribute('aria-labelledby', previewTitle.id);
  const previewApp = element('dl', undefined, 'identity');
  const previewTable = element('table'); previewTable.setAttribute('aria-label', '即将创建的广告单元');
  const previewHead = element('thead'); const previewHeadRow = element('tr');
  for (const label of ['广告位名称', '格式', '广告类型', '频次上限', '底价', '合作平台出价']) previewHeadRow.append(element('th', label));
  previewHead.append(previewHeadRow);
  const previewRows = element('tbody'); previewTable.append(previewHead, previewRows);
  const previewScroll = element('div', undefined, 'table-scroll'); previewScroll.tabIndex = 0; previewScroll.append(previewTable);
  const previewActions = element('div', undefined, 'actions preview-actions');
  const cancelPreview = element('button', '取消'); cancelPreview.type = 'button'; cancelPreview.dataset.action = 'cancel-preview'; cancelPreview.autofocus = true;
  cancelPreview.addEventListener('click', closePreview);
  preview.addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
  previewActions.append(cancelPreview, button('confirm-create', '确认创建', confirmPreview, 'primary'));
  preview.append(previewTitle, previewApp, previewScroll, previewActions); shadow.append(preview);
  const recoveryActions = element('div', undefined, 'actions spacer');
  recoveryActions.append(button('retry', '重试明确失败项', actions.retry), button('verify', '核验结果不确定项', async () => {
    const archive = displayedArchive();
    if (archive && actions.verifyHistory) await actions.verifyHistory(archive.id);
    else await actions.verify();
  }), button('degrade', '降级为单页', actions.degrade));
  if (actions.switchToPaged) recoveryActions.append(button('switch-to-paged', '改为并发', actions.switchToPaged));
  buttons.degrade.title = '停止增加执行标签页，保留旧执行页并继续收集其结果；后续任务在当前页执行';
  runSection.append(runActions, recoveryActions);
  const resumeHint = element('p', '', 'muted spacer'); resumeHint.setAttribute('aria-live', 'polite'); runSection.append(resumeHint);

  const resultSection = section('结果');
  const historyRow = element('div', undefined, 'actions');
  const historySelect = element('select'); historySelect.setAttribute('aria-label', '任务批次'); historySelect.append(option('', '当前任务'));
  historySelect.addEventListener('change', () => { closePreview(); if (actions.viewHistory) void invoke(() => actions.viewHistory!(historySelect.value)); });
  historyRow.append(element('span', '历史结果'), historySelect);
  if (actions.history) historyRow.append(button('history', '刷新历史', actions.history));
  resultSection.append(historyRow);
  const batchMeta = element('p', '暂无批次', 'muted batch-meta'); const resultSummary = element('p', '', 'summary');
  const batchTiming = element('p', '', 'summary batch-timing');
  const resultScroll = element('div', undefined, 'table-scroll'); const resultTable = element('table', undefined, 'result-table'); resultTable.setAttribute('aria-label', '广告单元创建结果');
  const resultHead = element('thead'); const resultHeadRow = element('tr');
  for (const name of ['原行', '广告位名称', '请求底价 / 模式', '实际底价 / 模式', '状态', '广告位 ID', '原因']) resultHeadRow.append(element('th', name));
  resultHead.append(resultHeadRow); const resultTbody = element('tbody'); resultTable.append(resultHead, resultTbody); resultScroll.append(resultTable);
  const exports = element('div', undefined, 'actions spacer');
  exports.append(button('export-all', '导出全部', () => actions.export('all', historySelect.value || undefined)), button('export-success', '导出成功', () => actions.export('success', historySelect.value || undefined)), button('export-exceptions', '导出异常', () => actions.export('exceptions', historySelect.value || undefined)), button('copy', '复制“名称 + ID”', () => actions.copy(historySelect.value || undefined)));
  resultSection.append(batchMeta, batchTiming, resultSummary, resultScroll, exports);
  const logsDetails = element('details'); logsDetails.append(element('summary', '查看执行日志'));
  const logs = element('div', '', 'log spacer'); logsDetails.append(logs); resultSection.append(logsDetails);
  body.append(element('div', '记录仅保存在当前浏览器配置。停止不会删除已创建的广告单元。', 'footer'));

  const rowNodes: { name: HTMLInputElement; floor: HTMLInputElement; error: HTMLElement; errorRow: HTMLTableRowElement; remove: HTMLButtonElement }[] = [];
  function restoreDraftInput(batch: Batch | undefined): void {
    if (!batch || batch.phase === 'done' || inputRows.length || restoredBatchId === batch.id) return;
    // A refreshed controller restores the persisted draft but the editor was
    // empty, leaving preflight disabled and the draft impossible to re-check.
    inputRows = batch.tasks.map(task => ({ line: task.line, name: task.name, floor: task.floor, errors: [] }));
    restoredBatchId = batch.id;
    editorBatchId = batch.id;
    renderRows();
  }
  function stoppedArchive(batch: Batch | undefined): boolean { return batch?.phase === 'done' && !!batch.stopRequestedAt; }
  function displayedArchive(): Batch | undefined {
    const batch = historySelect.value ? state.historyBatch : state.batch;
    return stoppedArchive(batch) ? batch : undefined;
  }
  function retireStoppedEditor(batch: Batch): void {
    if (!stoppedArchive(batch) || clearedStoppedEditors.has(batch.id)) return;
    clearedStoppedEditors.add(batch.id);
    const rows = reviewedRows();
    const matches = rows.length > 0 && rows.length === batch.tasks.length
      && rows.every((row, index) => row.name === batch.tasks[index].name && row.floor === batch.tasks[index].floor);
    if (editorBatchId !== batch.id && !matches) return;
    // Retire only this batch's editor once. Repeated archive verification or
    // history updates must not discard a separately entered new draft.
    inputRows = []; editorBatchId = ''; applyPrefix.checked = false;
    state.ready = false; state.checks = []; closePreview(); renderRows();
  }
  function reviewedRows(): InputRow[] {
    const automaticNames = applyPrefix.checked && manualFloor();
    const prefixText = prefix.value.trim();
    const names = new Map<string, number>();
    const rows = inputRows.map(row => {
      let name = row.name;
      if (automaticNames) {
        let suffix = '';
        try { suffix = normalizeDecimal(row.floor); } catch { /* The amount error is shown on the row. */ }
        name = prefixText && suffix ? prefixText + suffix : '';
      }
      // The synthetic header keeps literal ad-unit names from being interpreted as headers.
      const floor = partnerBidding.checked ? '' : row.floor;
      const parsed = parseInput(`广告位名称,底价USD\r\n${csvCell(name)},${csvCell(floor)}`, { mode: requestedMode() })[0];
      const errors = parsed?.errors ?? ['广告位名称不能为空'];
      if (automaticNames && !prefixText) errors.push('请输入名称前缀');
      if (automaticNames && name) names.set(name, (names.get(name) ?? 0) + 1);
      return { line: row.line, name, floor: parsed?.floor ?? floor, errors };
    });
    for (const row of rows) if ((names.get(row.name) ?? 0) > 1) row.errors.push('按底价生成的广告位名称重复');
    return rows;
  }
  function validateRows(): void {
    const rows = reviewedRows();
    const errors = rows.filter(row => row.errors.length).length;
    inputSummary.textContent = rows.length ? `${rows.length} 个广告位${errors ? `，${errors} 行待修正` : ''}` : '暂无广告位。';
    rowNodes.forEach((nodes, index) => {
      const row = rows[index];
      inputRows[index].errors = row.errors;
      nodes.name.readOnly = applyPrefix.checked;
      if (nodes.name.value !== row.name) nodes.name.value = row.name;
      nodes.error.textContent = row.errors.join('；');
      nodes.errorRow.hidden = !row.errors.length;
      nodes.name.setAttribute('aria-invalid', String(row.errors.some(error => /名称|重复|列数|解析/.test(error))));
      nodes.floor.setAttribute('aria-invalid', String(row.errors.some(error => /底价|金额|数字|十进制|列数|解析/.test(error))));
    });
    updateControls();
  }
  function renderRows(): void {
    inputTbody.replaceChildren(); rowNodes.length = 0;
    inputHeadRow.cells[2].hidden = !manualFloor();
    for (const [index, row] of inputRows.entries()) {
      const tr = element('tr'); const number = element('td', String(row.line));
      const nameCell = element('td'); const nameInput = element('input'); nameInput.type = 'text'; nameInput.value = row.name; nameInput.setAttribute('aria-label', `第 ${row.line} 行广告位名称`);
      const floorCell = element('td'); const floorInput = element('input'); floorInput.type = 'text'; floorInput.inputMode = 'decimal'; floorInput.value = row.floor; floorInput.setAttribute('aria-label', `第 ${row.line} 行底价 USD`);
      floorCell.hidden = !manualFloor();
      nameCell.append(nameInput); floorCell.append(floorInput);
      const operation = element('td'); const remove = element('button', '删除'); remove.type = 'button'; remove.setAttribute('aria-label', `删除第 ${row.line} 行`);
      remove.addEventListener('click', () => { inputRows.splice(index, 1); invalidate(); renderRows(); }); operation.append(remove);
      tr.append(number, nameCell, floorCell, operation);
      const errorRow = element('tr', undefined, 'error-row'); const error = element('td'); error.colSpan = 4; errorRow.append(error);
      inputTbody.append(tr, errorRow); rowNodes.push({ name: nameInput, floor: floorInput, error, errorRow, remove });
      nameInput.addEventListener('input', () => {
        if (!applyPrefix.checked) row.name = nameInput.value;
        invalidate(); validateRows();
      });
      floorInput.addEventListener('input', () => { row.floor = floorInput.value; invalidate(); validateRows(); });
    }
    validateRows();
  }
  function requestedMode(): FloorMode { return partnerBidding.checked ? 'disabled' : mode.value as FloorMode; }
  function manualFloor(): boolean { return requestedMode() === 'manual'; }
  function getConfig(): PanelConfig {
    const rows = reviewedRows();
    const text = rows.map(row => `${csvCell(row.name)},${csvCell(row.floor)}`).join('\r\n');
    return { format: format.value as AdFormat, mode: requestedMode(), partnerBidding: partnerBidding.checked, concurrency: 1, execution: execution.value as ExecutionMode, text, rows };
  }
  function displayedIdentity(): PanelConfig['confirmedIdentity'] {
    const identity = state.identity;
    if (state.identityError || !identity || !/^pub-\d{16}$/.test(identity.publisherId)
      || !/^ca-app-pub-\d{16}~\d{10}$/.test(identity.appId) || !identity.appId.startsWith(`ca-app-${identity.publisherId}~`)) return undefined;
    return { publisherId: identity.publisherId, appId: identity.appId };
  }
  function openPreview(): void {
    const identity = displayedIdentity();
    const config = getConfig();
    if (!identity || !config.rows.length || config.rows.some(row => row.errors.length) || isFrozen() || historySelect.value) return;
    pendingPreview = { ...config, confirmedIdentity: identity };
    previewApp.replaceChildren();
    for (const [label, value] of [
      ['应用', state.identity!.appName],
      ['AdMob App ID', identity.appId], ['发布商 ID', identity.publisherId],
    ]) previewApp.append(element('dt', label), element('dd', value));
    const floorMode = config.mode ?? 'manual';
    previewRows.replaceChildren(...config.rows.map(row => {
      const tr = element('tr');
      const floor = config.partnerBidding ? '不适用' : floorMode === 'manual' ? `${row.floor} USD / 千次` : MODE_ZH[floorMode];
      const reward = config.format === 'rewarded' || config.format === 'rewarded-interstitial';
      const formatLabel = FORMAT_ZH[config.format] + (reward ? `（${REWARD_DEFAULT.amount} ${REWARD_DEFAULT.item}）` : '');
      const media = config.partnerBidding ? '不适用' : MEDIA_DEFAULTS[config.format].join(' + ');
      const frequency = config.partnerBidding || config.format === 'banner' || config.format === 'native' ? '不适用' : '已停用';
      for (const value of [row.name, formatLabel, media, frequency, floor, config.partnerBidding ? '已勾选' : '未勾选']) tr.append(element('td', value));
      return tr;
    }));
    if (typeof preview.showModal === 'function') preview.showModal();
    else preview.setAttribute('open', '');
    updateControls();
    cancelPreview.focus();
  }
  function closePreview(): void {
    pendingPreview = undefined;
    if (!preview.open) return;
    if (typeof preview.close === 'function') preview.close();
    else preview.removeAttribute('open');
    updateControls();
    if (!buttons.start.disabled) buttons.start.focus();
  }
  async function confirmPreview(): Promise<void> {
    const confirmed = pendingPreview;
    if (!confirmed || !preview.open || isFrozen() || historySelect.value || state.busy) return;
    const current = { ...getConfig(), confirmedIdentity: displayedIdentity() };
    closePreview();
    if (JSON.stringify(current) !== JSON.stringify(confirmed)) throw new Error('应用或广告位设置发生变化，请重新预览');
    await actions.start(confirmed);
  }
  function invalidate(): void { state.ready = false; state.checks = []; closePreview(); renderChecks(); updateControls(); }
  function isFrozen(): boolean { return !!state.batch && ['running', 'paused', 'stopping'].includes(state.batch.phase); }
  function isBusy(): boolean { return localBusy || !!state.busy; }
  function updateControls(): void {
    const busy = isBusy(), viewingHistory = !!historySelect.value, frozen = isFrozen() || viewingHistory, batch = state.batch;
    const locked = busy || frozen || !!pendingPreview;
    editableControls.forEach(control => { control.disabled = locked; });
    mode.disabled = locked || partnerBidding.checked || applyPrefix.checked;
    partnerBidding.disabled = locked || format.value === 'rewarded-interstitial';
    biddingNote.textContent = format.value === 'rewarded-interstitial' ? '插页式激励广告不支持合作平台出价。' : partnerBidding.checked ? '合作平台出价不设置底价。' : '';
    modeNote.textContent = execution.value === 'single' ? '在当前页逐条创建和核验。' : '按任务数量批量打开创建页，再逐页创建、核验和关闭。';
    applyPrefix.disabled = locked || !manualFloor();
    prefix.disabled = locked || !manualFloor();
    rowNodes.forEach(nodes => { nodes.name.disabled = locked; nodes.floor.disabled = locked; nodes.remove.disabled = locked; });
    const identity = displayedIdentity();
    Object.values(buttons).forEach(b => { b.disabled = busy || !!pendingPreview; });
    buttons['confirm-create'].disabled = busy || frozen || !pendingPreview || !identity;
    historySelect.disabled = busy || !!pendingPreview;
    const valid = inputRows.length > 0 && inputRows.every(row => !row.errors.length);
    buttons.start.disabled = locked || !valid || !identity;
    buttons.pause.disabled = busy || batch?.phase !== 'running';
    const unresolved = batch?.tasks.filter(t => needsVerification(t) && !['success', 'exists'].includes(t.status)).length ?? 0;
    const resumable = !viewingHistory && batch?.phase === 'paused' && !!batch.confirmedAt && !batch.stopRequestedAt;
    const resumeBlocked = resumable && unresolved > 0;
    buttons.resume.disabled = busy || batch?.phase !== 'paused' || !batch.confirmedAt || !!batch.stopRequestedAt || resumeBlocked;
    buttons.resume.title = resumeBlocked ? `还有 ${unresolved} 条提交结果或配置待核验，请先核验` : '';
    resumeHint.textContent = resumeBlocked ? `还有 ${unresolved} 条提交结果或配置待核验。请先点击“核验结果不确定项”，核验通过后再继续；只读预检和核验均不提交广告位。` : '';
    resumeHint.hidden = !resumeBlocked;
    buttons.stop.disabled = busy || !batch || !['draft', 'running', 'paused', 'stopping'].includes(batch.phase);
    buttons.retry.disabled = busy || !batch || !!batch.stopRequestedAt || batch.phase === 'running' || batch.phase === 'stopping' || !batch.tasks.some(t => t.status === 'failed' && !t.intentAt && !t.actual?.unitId && t.attempts < 3);
    buttons.verify.disabled = busy || !batch || batch.phase === 'running' || !batch.tasks.some(t => ['uncertain', 'created-unverified', 'submitting', 'verifying'].includes(t.status));
    buttons.degrade.disabled = busy || !batch || batch.execution !== 'tabs' || !['running', 'paused'].includes(batch.phase);
    if (buttons['switch-to-paged']) buttons['switch-to-paged'].disabled = busy || viewingHistory || batch?.execution !== 'tabs' || batch.phase !== 'paused' || unresolved > 0;
    for (const key of ['pause','resume','stop','retry','degrade']) if(viewingHistory)buttons[key].disabled=true;
    if (viewingHistory || stoppedArchive(batch)) {
      const archive = displayedArchive();
      buttons.verify.disabled = busy || !actions.verifyHistory || !archive || batch?.phase === 'running' || batch?.phase === 'stopping'
        || !archive.tasks.some(task => needsVerification(task) && !['success', 'exists'].includes(task.status));
    }
    for (const update of updateObservedInputs) update();
    for (const key of ['export-all', 'export-success', 'export-exceptions', 'copy']) buttons[key].disabled = busy || !(viewingHistory ? state.historyBatch : batch);
  }
  function renderNotice(): void {
    notice.textContent = state.notice ?? '';
    let valid=false;
    if(state.workerUrl)try{const url=new URL(state.workerUrl);valid=url.protocol==='https:'&&['admob.google.com','apps.admob.com'].includes(url.hostname)&&/^[\w-]{20,80}$/.test(url.searchParams.get('__admob_batch_worker')||'');}catch{}
    workerLink.hidden=!valid;
    feedback.hidden = !state.notice && !valid;
    if(valid)workerLink.href=state.workerUrl!;else workerLink.removeAttribute('href');
  }
  function renderIdentity(): void {
    for (const key of ['publisherId', 'appName', 'appId'] as const) identityValues[key].textContent = state.identity?.[key] || '未识别';
    identityStatus.textContent = state.identityError || (state.identity ? '账号与应用已识别；提交前仍会逐页重新核对。' : '请进入目标应用，再识别当前账号。');
    capabilities.textContent = state.capabilities || '';
  }
  function renderChecks(): void {
    checklist.replaceChildren();
    for (const check of state.checks ?? []) {
      const li = element('li', undefined, check.ok ? 'check-ok' : 'check-bad');
      li.append(element('span', check.ok ? '✓' : '✕'), element('span', check.label)); checklist.append(li);
    }
    if (!state.checks?.length) checklist.append(element('li', '确认预览后检查账号和执行页，再创建广告位。', 'muted'));
  }
  function renderHistory(): void {
    const selected = historySelect.value;
    const rows = new Map((state.history ?? []).map(batch => [batch.id, batch]));
    if(state.batch) rows.set(state.batch.id, summarizeBatch(state.batch));
    historySelect.replaceChildren(option('', '当前任务'));
    for(const batch of [...rows.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))) {
      if(batch.id === state.batch?.id)continue;
      historySelect.append(option(batch.id, `${batch.startedAt ? localTime(batch.startedAt) : '开始时间未知'} · ${FORMAT_ZH[batch.format]} · ${batch.succeeded}/${batch.total} 成功 · ${batch.id}`));
    }
    if([...historySelect.options].some(item=>item.value===selected))historySelect.value=selected;
  }
  function localTime(value?: string): string { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知'; }
  function renderTiming(): void {
    const batch = historySelect.value ? state.historyBatch : state.batch;
    if(!batch){batchTiming.textContent='';return;}
    const summary = summarizeBatch(batch);
    batchTiming.textContent=`开始：${localTime(summary.startedAt)} · 结束：${localTime(summary.completedAt)} · 总耗时：${batchElapsed(summary)}（含检查、等待与暂停）`;
  }
  function renderResults(): void {
    const batch = historySelect.value ? state.historyBatch : state.batch;
    const signature = batch ? JSON.stringify(batch) : '';
    if (signature === renderedBatch) return; renderedBatch = signature;
    updateObservedInputs.length = 0;
    resultTbody.replaceChildren();
    if (!batch) { batchMeta.textContent = '暂无批次'; resultSummary.textContent = ''; logs.textContent = ''; return; }
    const executionLabel = { paged: '并发', single: '串行', tabs: '旧版并行' }[batch.execution];
    const phaseLabel = stoppedArchive(batch) ? '已停止' : ({ draft: '待开始', running: '执行中', paused: '已暂停', stopping: '停止中，正在收集结果', done: '已结束' })[batch.phase];
    batchMeta.textContent = `批次 ${batch.id} · ${FORMAT_ZH[batch.format]} · ${phaseLabel} · ${executionLabel}`;
    const counts = new Map<string, number>();
    for (const task of batch.tasks) {
      counts.set(STATUS_ZH[task.status], (counts.get(STATUS_ZH[task.status]) ?? 0) + 1);
      const tr = element('tr');
      const actual = task.actual;
      const badge = element('span', STATUS_ZH[task.status], `badge ${['success', 'exists'].includes(task.status) ? 'good' : ['failed', 'uncertain', 'created-unverified', 'conflict'].includes(task.status) ? 'bad' : ''}`);
      const status = element('td'); status.append(badge);
      const requested = batch.partnerBidding ? '不适用（合作平台出价）' : batch.mode === 'manual' ? task.floor : MODE_ZH[batch.mode];
      const saved = actual?.mode === 'partner-bidding' ? '不适用（合作平台出价）'
        : actual?.mode && actual.mode !== 'manual' ? MODE_ZH[actual.mode as FloorMode] ?? '未读取'
        : actual?.floor ? `${actual.floor} ${actual.currency || '币种未确认'}` : '未读取';
      tr.append(element('td', String(task.line)), element('td', task.name), element('td', requested), element('td', saved), status, element('td', actual?.unitId || '—'), element('td', task.reason || '—', 'error-cell'));
      const archived = stoppedArchive(batch);
      const canRecord = archived ? !!actions.recordHistoryObservedId : !historySelect.value && !!actions.recordObservedId && batch.phase === 'paused';
      if (canRecord && task.intentAt && needsVerification(task) && !['success', 'exists'].includes(task.status) && !actual?.unitId) {
        const cell=tr.cells[5];
        const id=element('input');id.placeholder='成功说明中的广告位 ID';id.setAttribute('aria-label',`${task.name} 已观察到的广告位 ID`);
        const record=element('button','记录 ID 并核验');record.type='button';record.dataset.action='record-observed-id';record.dataset.taskId=task.id;
        if(archived)record.dataset.batchId=batch.id;
        const update=()=>{
          const blocked=localBusy||!!state.busy||(archived && ['running','stopping'].includes(state.batch?.phase || ''));
          id.disabled=blocked;
          record.disabled=blocked||!new RegExp(`^ca-app-${batch.identity.publisherId}/\\d{10}$`).test(id.value.trim());
        };
        updateObservedInputs.push(update);
        id.addEventListener('input',update);update();
        record.addEventListener('click',()=>{
          if(record.disabled)return;
          const unitId=id.value.trim();
          void invoke(async()=>{
            if(archived)await actions.recordHistoryObservedId!(batch.id,task.id,unitId);
            else await actions.recordObservedId!(task.id,unitId);
          });
        });
        cell.append(id,record);
      }
      resultTbody.append(tr);
    }
    resultSummary.textContent = `共 ${batch.tasks.length} 行 · ${[...counts].map(([label, count]) => `${label} ${count}`).join(' · ')}`;
    const createdAt = Date.parse(batch.createdAt);
    const entries = batch.tasks.flatMap(task => task.logs.map((log, index) => ({ ...log, name: task.name, line: task.line, interval: elapsedText(index ? Date.parse(task.logs[index - 1].at) : createdAt, Date.parse(log.at)), elapsed: elapsedText(createdAt, Date.parse(log.at)) })));
    entries.sort((a, b) => a.at.localeCompare(b.at));
    logs.textContent = entries.slice(-150).map(log => `${safeLogText(log.at)} [${log.line} ${safeLogText(log.name)}] ${logStepLabel(log.step)} · 累计耗时 ${log.elapsed} / 本行上步间隔 ${log.interval}${log.message ? ` · ${safeLogText(log.message)}` : ''}`).join('\n');
  }
  collapse.addEventListener('click', () => {
    const collapsed = shell.classList.toggle('collapsed'); collapse.textContent = collapsed ? '展开' : '收起'; collapse.setAttribute('aria-expanded', String(!collapsed));
  });
  renderRows(); renderChecks(); renderIdentity(); updateControls();
  const panelView = host.ownerDocument.defaultView!;
  const timingTimer = panelView.setInterval(renderTiming, 1000);
  return {
    getConfig,
    update(patch) {
      const previousIdentity = state.identity;
      if (patch.identityError || ('identity' in patch && (
        patch.identity?.publisherId !== previousIdentity?.publisherId || patch.identity?.appId !== previousIdentity?.appId
        || patch.identity?.appName !== previousIdentity?.appName
      ))) closePreview();
      if(patch.batch){
        const phase=`${patch.batch.id}:${patch.batch.phase}`;
        if (phase !== lastBatchPhase) closePreview();
        lastBatchPhase=phase;
      }
      Object.assign(state, patch);
      if (patch.batch && (isFrozen() || patch.batch.phase === 'draft')) {
        const previouslyManual = manualFloor();
        format.value = patch.batch.format; mode.value = patch.batch.mode ?? 'manual'; execution.value = patch.batch.execution === 'single' ? 'single' : 'paged';
        partnerBidding.checked = patch.batch.partnerBidding === true;
        if (!manualFloor()) applyPrefix.checked = false;
        if (previouslyManual !== manualFloor()) renderRows();
      }
      if (patch.batch) {
        const batch = patch.batch;
        retireStoppedEditor(batch);
        restoreDraftInput(batch);
        if (!stoppedArchive(batch) && ['draft', 'running', 'paused', 'stopping'].includes(batch.phase)) {
          const rows=reviewedRows();
          if(rows.length===batch.tasks.length && rows.every((row,index)=>row.name===batch.tasks[index].name && row.floor===batch.tasks[index].floor))editorBatchId=batch.id;
        }
      }
      renderHistory(); renderIdentity(); renderNotice(); renderChecks(); renderResults(); renderTiming(); updateControls();
    },
    destroy() { panelView.clearInterval(timingTimer); host.remove(); },
  };
}

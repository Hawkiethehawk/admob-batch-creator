import { parseInput } from './core.ts';
import { FORMAT_ZH, STATUS_ZH } from './types.ts';
import type { AdFormat, Batch, Identity, InputRow } from './types.ts';

export interface PanelConfig {
  format: AdFormat;
  concurrency: number;
  execution: 'tabs' | 'single';
  text: string;
  rows: InputRow[];
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
  degrade(): Promise<void>;
  export(filter: 'all' | 'success' | 'exceptions'): Promise<void>;
  copy(): Promise<void>;
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
  shadow.append(element('style', STYLE));
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
  let sourceDirty = false;
  const sourceIssues = new WeakMap<InputRow, string[]>();
  let renderedBatch = '';
  const editableControls: (HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] = [];
  const buttons: Record<string, HTMLButtonElement> = {};
  const notice = element('div', '', 'notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const section = (heading: string): HTMLElement => { const n = element('section'); n.append(element('h3', heading)); body.append(n); return n; };
  const accountSection = section('当前页面'); accountSection.prepend(notice);
  const identityList = element('dl', undefined, 'identity');
  const identityValues: Record<string, HTMLElement> = {};
  for (const [key, label] of [['publisherId', '发布商 ID'], ['appName', '当前应用'], ['appId', 'AdMob App ID'], ['currency', '底价字段币种']]) {
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
    b.addEventListener('click', () => { void invoke(callback); }); return b;
  }
  const accountActions = element('div', undefined, 'actions spacer');
  accountActions.append(button('identify', '重新识别', actions.identify), button('probe', '检测跨页能力', actions.probe), button('diagnostics', '导出脱敏诊断', actions.diagnostics));
  accountSection.append(accountActions, capabilities);
  accountSection.append(element('p', '真实 AdMob 与 HubVPS 流程尚未验收。未知页面或币种不明时会阻止提交。', 'warning'));

  const settings = section('整批设置'); const config = element('div', undefined, 'config');
  const format = element('select'); format.setAttribute('aria-label', '广告格式'); format.append(option('interstitial', '插页式 / 插屏'), option('app-open', '开屏'));
  const mode = element('input'); mode.value = '手动设定底价'; mode.readOnly = true; mode.setAttribute('aria-label', '底价模式');
  const currency = element('input'); currency.value = 'USD / 千次展示'; currency.readOnly = true; currency.setAttribute('aria-label', '请求底价币种');
  const concurrency = element('select'); concurrency.setAttribute('aria-label', '并发数'); concurrency.append(option('1', '1 个执行页'), option('2', '2 个执行页（默认）'), option('3', '3 个执行页')); concurrency.value = '2';
  const execution = element('select'); execution.setAttribute('aria-label', '执行方式'); execution.append(option('tabs', '主控 + 执行标签页'), option('single', '单页模式（当前页执行）'));
  const controls: [string, HTMLElement][] = [['广告格式', format], ['底价模式', mode], ['请求币种', currency], ['并发数', concurrency], ['执行方式', execution]];
  for (const [labelText, control] of controls) { const label = element('label', undefined, 'field'); label.append(element('span', labelText), control); config.append(label); }
  editableControls.push(format, concurrency, execution); settings.append(config);
  const modeNote = element('p', '先核验首条，再扩展并发；这是插件配置，并非 AdMob 官方额度。', 'muted spacer mode-note'); settings.append(modeNote);
  for (const control of [format, concurrency, execution]) control.addEventListener('change', () => {
    invalidate();
    concurrency.disabled = execution.value === 'single' || isFrozen() || isBusy();
    modeNote.textContent = execution.value === 'single' ? '单页模式只操作当前页面；仍需可靠的主控互斥。' : '先核验首条，再扩展并发；这是插件配置，并非 AdMob 官方额度。';
  });

  const inputSection = section('两列清单');
  const pasteLabel = element('label', undefined, 'field'); pasteLabel.append(element('span', '粘贴 Excel 两列、TSV 或 CSV'));
  const paste = element('textarea', undefined, 'paste'); paste.placeholder = '广告位名称,底价USD\nUS_NEW_INT_60,60\nUS_NEW_INT_40,40'; paste.setAttribute('aria-label', 'CSV 或 TSV 输入'); pasteLabel.append(paste); inputSection.append(pasteLabel); editableControls.push(paste);
  const inputActions = element('div', undefined, 'actions spacer');
  const parseButton = element('button', '解析到清单'); parseButton.type = 'button';
  parseButton.addEventListener('click', () => { inputRows = parsedRows(paste.value); sourceDirty = false; invalidate(); renderRows(); });
  paste.addEventListener('input', () => { sourceDirty = true; invalidate(); validateRows(); });
  const file = element('input', undefined, 'file'); file.type = 'file'; file.accept = '.csv,.tsv,text/csv,text/tab-separated-values'; file.setAttribute('aria-label', '导入 CSV 或 TSV');
  file.addEventListener('change', () => { const selected = file.files?.[0]; if (!selected) return; void invoke(async () => { paste.value = await selected.text(); inputRows = parsedRows(paste.value); sourceDirty = false; invalidate(); renderRows(); file.value = ''; }); });
  const add = element('button', '增加一行'); add.type = 'button'; add.addEventListener('click', () => {
    inputRows.push({ line: Math.max(0, ...inputRows.map(r => r.line)) + 1, name: '', floor: '', errors: [] });
    invalidate(); renderRows(); rowNodes.at(-1)?.name.focus();
  });
  editableControls.push(parseButton, file, add); inputActions.append(parseButton, file, add); inputSection.append(inputActions);
  const inputSummary = element('p', '尚未导入清单。', 'summary'); inputSummary.setAttribute('aria-live', 'polite'); inputSection.append(inputSummary);
  const inputScroll = element('div', undefined, 'table-scroll'); const inputTable = element('table', undefined, 'input-table'); inputTable.setAttribute('aria-label', '广告位名称与底价清单');
  const inputHead = element('thead'); const inputHeadRow = element('tr');
  for (const name of ['原行', '广告位名称', '底价（USD / 千次）', '操作']) inputHeadRow.append(element('th', name));
  inputHead.append(inputHeadRow); const inputTbody = element('tbody'); inputTable.append(inputHead, inputTbody); inputScroll.append(inputTable); inputSection.append(inputScroll);
  inputSection.append(element('p', '输入 60 表示 60 美元。仅接受明确的十进制金额；不会自动换汇、截断名称或添加后缀。', 'muted'));

  const runSection = section('预检与执行');
  const checklist = element('ul', undefined, 'checks'); runSection.append(checklist);
  const confirmLabel = element('label', undefined, 'confirm'); const confirm = element('input'); confirm.type = 'checkbox';
  confirmLabel.append(confirm, element('span', '我已核对当前发布商、应用、广告格式和两列清单；点击“开始创建”确认整个批次。')); runSection.append(confirmLabel);
  confirm.addEventListener('change', updateControls);
  const runActions = element('div', undefined, 'actions');
  runActions.append(button('preflight', '预检（不提交）', () => actions.preflight(getConfig())), button('start', '开始创建', () => actions.start(getConfig()), 'primary'), button('pause', '暂停', actions.pause), button('resume', '继续', actions.resume), button('stop', '停止', actions.stop, 'danger'));
  const recoveryActions = element('div', undefined, 'actions spacer');
  recoveryActions.append(button('retry', '重试明确失败项', actions.retry), button('verify', '核验结果不确定项', actions.verify), button('degrade', '降级为单页', actions.degrade));
  buttons.degrade.title = '停止增加执行标签页，保留旧执行页并继续收集其结果；后续任务在当前页执行';
  runSection.append(runActions, recoveryActions);

  const resultSection = section('结果');
  const batchMeta = element('p', '暂无批次', 'muted batch-meta'); const resultSummary = element('p', '', 'summary');
  const resultScroll = element('div', undefined, 'table-scroll'); const resultTable = element('table', undefined, 'result-table'); resultTable.setAttribute('aria-label', '广告单元创建结果');
  const resultHead = element('thead'); const resultHeadRow = element('tr');
  for (const name of ['原行', '广告位名称', '请求 USD', '实际底价 / 币种', '状态', '广告位 ID', '原因']) resultHeadRow.append(element('th', name));
  resultHead.append(resultHeadRow); const resultTbody = element('tbody'); resultTable.append(resultHead, resultTbody); resultScroll.append(resultTable);
  const exports = element('div', undefined, 'actions spacer');
  exports.append(button('export-all', '导出全部', () => actions.export('all')), button('export-success', '导出成功', () => actions.export('success')), button('export-exceptions', '导出异常', () => actions.export('exceptions')), button('copy', '复制“名称 + ID”', actions.copy));
  resultSection.append(batchMeta, resultSummary, resultScroll, exports);
  const logsDetails = element('details'); logsDetails.append(element('summary', '查看执行日志'));
  const logs = element('div', '', 'log spacer'); logsDetails.append(logs); resultSection.append(logsDetails);
  body.append(element('div', '记录仅保存在当前浏览器配置。停止不会删除已创建的广告单元。', 'footer'));

  const rowNodes: { name: HTMLInputElement; floor: HTMLInputElement; error: HTMLElement; errorRow: HTMLTableRowElement; remove: HTMLButtonElement }[] = [];
  function parsedRows(text: string): InputRow[] {
    const rows = parseInput(text);
    for (const row of rows) sourceIssues.set(row, row.errors.filter(error => /两列|引号/.test(error)));
    return rows;
  }
  function serializeRows(): string { return inputRows.map(row => `${csvCell(row.name)},${csvCell(row.floor)}`).join('\r\n'); }
  function validateRows(): void {
    // The synthetic header prevents an ad-unit name from being mistaken for an input header.
    const occurrences = new Map<string, number>();
    for (const row of inputRows) occurrences.set(row.name, (occurrences.get(row.name) ?? 0) + 1);
    inputRows.forEach(row => {
      const parsed = parseInput(`广告位名称,底价USD\r\n${csvCell(row.name)},${csvCell(row.floor)}`)[0];
      row.errors = [...(parsed?.errors ?? ['广告位名称不能为空', '缺失底价']), ...(sourceIssues.get(row) ?? []).map(error => `${error}；请修正粘贴区并重新解析`)];
      if (row.name && (occurrences.get(row.name) ?? 0) > 1) row.errors.push('输入清单中存在重复名称，请逐行处理');
    });
    const errors = inputRows.filter(row => row.errors.length).length;
    inputSummary.textContent = sourceDirty ? '粘贴区已改动，请先点击“解析到清单”。' : inputRows.length ? `共 ${inputRows.length} 行 · ${errors ? `${errors} 行有错误` : '输入格式通过，尚需后台预检'}` : '尚未导入清单。';
    rowNodes.forEach((nodes, index) => {
      const row = inputRows[index]; if (!row) return;
      nodes.error.textContent = `原始第 ${row.line} 行：${row.errors.join('；')}`;
      nodes.errorRow.hidden = !row.errors.length;
      nodes.name.setAttribute('aria-invalid', String(row.errors.some(error => /名称|重复|列数|解析/.test(error))));
      nodes.floor.setAttribute('aria-invalid', String(row.errors.some(error => /底价|金额|数字|十进制|列数|解析/.test(error))));
    });
    updateControls();
  }
  function renderRows(): void {
    inputTbody.replaceChildren(); rowNodes.length = 0;
    for (const [index, row] of inputRows.entries()) {
      const tr = element('tr'); const number = element('td', String(row.line));
      const nameCell = element('td'); const nameInput = element('input'); nameInput.type = 'text'; nameInput.value = row.name; nameInput.setAttribute('aria-label', `第 ${row.line} 行广告位名称`);
      const floorCell = element('td'); const floorInput = element('input'); floorInput.type = 'text'; floorInput.inputMode = 'decimal'; floorInput.value = row.floor; floorInput.setAttribute('aria-label', `第 ${row.line} 行底价 USD`);
      nameCell.append(nameInput); floorCell.append(floorInput);
      const operation = element('td'); const remove = element('button', '删除'); remove.type = 'button'; remove.setAttribute('aria-label', `删除第 ${row.line} 行`);
      remove.addEventListener('click', () => { inputRows.splice(index, 1); invalidate(); renderRows(); }); operation.append(remove);
      tr.append(number, nameCell, floorCell, operation);
      const errorRow = element('tr', undefined, 'error-row'); const error = element('td'); error.colSpan = 4; errorRow.append(error);
      inputTbody.append(tr, errorRow); rowNodes.push({ name: nameInput, floor: floorInput, error, errorRow, remove });
      for (const [input, field] of [[nameInput, 'name'], [floorInput, 'floor']] as const) {
        input.addEventListener('input', () => { row[field] = input.value; invalidate(); validateRows(); });
        input.addEventListener('paste', event => {
          const text = event.clipboardData?.getData('text/plain'); if (!text || !/[\t\r\n]/.test(text)) return;
          event.preventDefault(); const pasted = parsedRows(text);
          if (!pasted.length) return;
          const nextLine = Math.max(0, ...inputRows.map(item => item.line)) + 1;
          const mapped = pasted.map((item, offset) => { item.line = inputRows[index + offset]?.line ?? nextLine + offset; return item; });
          inputRows.splice(index, mapped.length, ...mapped); invalidate(); renderRows();
        });
      }
    }
    validateRows();
  }
  function getConfig(): PanelConfig {
    validateRows();
    return { format: format.value as AdFormat, concurrency: execution.value === 'single' ? 1 : Number(concurrency.value), execution: execution.value as 'tabs' | 'single', text: serializeRows(), rows: structuredClone(inputRows) };
  }
  function invalidate(): void { state.ready = false; state.checks = []; confirm.checked = false; renderChecks(); updateControls(); }
  function isFrozen(): boolean { return !!state.batch && ['running', 'paused', 'stopping'].includes(state.batch.phase); }
  function isBusy(): boolean { return localBusy || !!state.busy; }
  function updateControls(): void {
    const busy = isBusy(), frozen = isFrozen(), batch = state.batch;
    editableControls.forEach(control => { control.disabled = busy || frozen; });
    concurrency.disabled = busy || frozen || execution.value === 'single';
    rowNodes.forEach(nodes => { nodes.name.disabled = busy || frozen; nodes.floor.disabled = busy || frozen; nodes.remove.disabled = busy || frozen; });
    confirm.disabled = busy || frozen;
    Object.values(buttons).forEach(b => { b.disabled = busy; });
    const valid = !sourceDirty && inputRows.length > 0 && inputRows.every(row => !row.errors.length);
    buttons.preflight.disabled = busy || frozen || !valid;
    buttons.start.disabled = busy || frozen || (!!batch && batch.phase !== 'draft') || !!batch?.stopRequestedAt || !valid || !state.ready || !confirm.checked;
    buttons.pause.disabled = busy || batch?.phase !== 'running';
    buttons.resume.disabled = busy || batch?.phase !== 'paused' || !batch.confirmedAt || !!batch.stopRequestedAt;
    buttons.stop.disabled = busy || !batch || !['draft', 'running', 'paused', 'stopping'].includes(batch.phase);
    buttons.retry.disabled = busy || !batch || batch.phase === 'running' || batch.phase === 'stopping' || !batch.tasks.some(t => t.status === 'failed' && !t.intentAt && !t.actual?.unitId && t.attempts < 3);
    buttons.verify.disabled = busy || !batch || batch.phase === 'running' || !batch.tasks.some(t => ['uncertain', 'created-unverified', 'submitting', 'verifying'].includes(t.status));
    buttons.degrade.disabled = busy || !batch || batch.execution !== 'tabs' || !['running', 'paused'].includes(batch.phase);
    for (const key of ['export-all', 'export-success', 'export-exceptions', 'copy']) buttons[key].disabled = busy || !batch;
  }
  function renderNotice(): void { notice.textContent = state.notice ?? ''; }
  function renderIdentity(): void {
    for (const key of ['publisherId', 'appName', 'appId'] as const) identityValues[key].textContent = state.identity?.[key] || '未识别';
    identityValues.currency.textContent = state.identity?.currency || '尚未在真实底价字段确认';
    identityStatus.textContent = state.identityError || (state.identity ? '账号与应用已识别；提交前仍会逐页重新核对。' : '请进入目标应用，再识别当前账号。');
    capabilities.textContent = state.capabilities || '';
  }
  function renderChecks(): void {
    checklist.replaceChildren();
    for (const check of state.checks ?? []) {
      const li = element('li', undefined, check.ok ? 'check-ok' : 'check-bad');
      li.append(element('span', check.ok ? '✓' : '✕'), element('span', check.label)); checklist.append(li);
    }
    if (!state.checks?.length) checklist.append(element('li', '先导入清单并运行预检。预检不点击创建。', 'muted'));
  }
  function renderResults(): void {
    const batch = state.batch;
    const signature = batch ? JSON.stringify(batch) : '';
    if (signature === renderedBatch) return; renderedBatch = signature;
    resultTbody.replaceChildren();
    if (!batch) { batchMeta.textContent = '暂无批次'; resultSummary.textContent = ''; logs.textContent = ''; return; }
    batchMeta.textContent = `批次 ${batch.id} · ${FORMAT_ZH[batch.format]} · ${({ draft: '待开始', running: '执行中', paused: '已暂停', stopping: '停止中，正在收集结果', done: '已结束' })[batch.phase]} · ${batch.execution === 'single' ? '单页模式' : `并发 ${batch.concurrency}`}`;
    const counts = new Map<string, number>();
    for (const task of batch.tasks) {
      counts.set(STATUS_ZH[task.status], (counts.get(STATUS_ZH[task.status]) ?? 0) + 1);
      const tr = element('tr');
      const actual = task.actual;
      const badge = element('span', STATUS_ZH[task.status], `badge ${['success', 'exists'].includes(task.status) ? 'good' : ['failed', 'uncertain', 'created-unverified', 'conflict'].includes(task.status) ? 'bad' : ''}`);
      const status = element('td'); status.append(badge);
      tr.append(element('td', String(task.line)), element('td', task.name), element('td', task.floor), element('td', actual?.floor ? `${actual.floor} ${actual.currency || '币种未确认'}` : '未读取'), status, element('td', actual?.unitId || '—'), element('td', task.reason || '—', 'error-cell'));
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
  return {
    getConfig,
    update(patch) {
      Object.assign(state, patch);
      if (patch.batch && isFrozen()) {
        format.value = patch.batch.format; concurrency.value = String(patch.batch.concurrency); execution.value = patch.batch.execution;
      }
      renderIdentity(); renderNotice(); renderChecks(); renderResults(); updateControls();
    },
    destroy() { host.remove(); },
  };
}

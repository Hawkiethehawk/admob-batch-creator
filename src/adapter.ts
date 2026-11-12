import type { Actual, Adapter, AdFormat, Identity, Lookup } from './types.ts';
import { decimalEqual, normalizeDecimal } from './core.ts';

/** These are semantic candidates, not a claim that a live AdMob revision was tested. */
export const ZH = {
  publisher: ['发布商 ID', '发布商ID', 'Publisher ID'],
  appId: ['应用 ID', '应用ID', 'AdMob 应用 ID', 'AdMob App ID'],
  appName: ['应用名称', '当前应用'],
  units: ['广告单元'], add: ['添加广告单元'], create: ['创建广告单元'],
  name: ['广告单元名称'], advanced: ['高级设置'], manual: ['手动设定底价'],
  floor: ['全局底价', '有效每千次展示费用底价', '全局有效每千次展示费用底价'],
  format: ['广告格式'], unitId: ['广告单元 ID', '广告单元ID'],
  mode: ['底价模式', '有效每千次展示费用底价模式'],
  amount: ['全局底价', '全局有效每千次展示费用底价'],
  currency: ['底价币种', '币种'],
  interstitial: ['插页式', '插屏'], 'app-open': ['开屏'],
  next: ['下一页'], first: ['第一页', '首页'],
};
export class AdapterError extends Error {
  code: string; fatal: boolean; actual?: Partial<Actual>;
  constructor(code: string, message: string, fatal = true, actual?: Partial<Actual>) {
    super(message); this.name = 'AdapterError'; this.code = code; this.fatal = fatal; this.actual = actual;
  }
}
const txt = (e: Element | null): string => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
const compact = (s: string): string => s.replace(/[：:\s]/g, '');
const sameLabel = (s: string, labels: string[]): boolean => labels.some(x => compact(s) === compact(x));
const publisherRx = /^pub-\d{16}$/;
const appRx = /^ca-app-pub-\d{16}~\d{10}$/;
const unitRx = /^ca-app-pub-\d{16}\/\d{10}$/;

export function visible(e: Element): boolean {
  if (!e.isConnected || e.closest('[hidden],[aria-hidden="true"],inert')) return false;
  const view = e.ownerDocument.defaultView;
  for (let node: Element | null = e; node; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  }
  return true;
}
function elements(scope: ParentNode, selector: string): Element[] { return [...scope.querySelectorAll(selector)].filter(visible); }
function one<T extends Element>(candidates: T[], step: string): T {
  const deduped = [...new Set(candidates)];
  if (deduped.length !== 1) throw new AdapterError('STRUCTURE', `${step}：找到 ${deduped.length} 个候选控件，已停止，需适配当前页面`);
  return deduped[0];
}
function enabled(e: Element): boolean { return !e.hasAttribute('disabled') && e.getAttribute('aria-disabled') !== 'true'; }
function accessibleName(e: Element): string {
  const refs = e.getAttribute('aria-labelledby')?.split(/\s+/).map(id => txt(e.ownerDocument.getElementById(id))).join(' ');
  return e.getAttribute('aria-label')?.trim() || refs || (e as HTMLInputElement).labels?.[0]?.textContent?.trim() || txt(e);
}
function controls(scope: ParentNode, labels: string[], selector = 'button,[role="button"],a'): Element[] {
  return elements(scope, selector).filter(e => sameLabel(accessibleName(e), labels));
}
function click(e: Element, step: string): void {
  if (!visible(e) || !enabled(e)) throw new AdapterError('STRUCTURE', `${step}：控件不可见或不可操作`);
  (e as HTMLElement).click();
}
function labelledInputs(scope: ParentNode, labels: string[]): HTMLInputElement[] {
  return elements(scope, 'input:not([type="hidden"]),textarea').filter(e => sameLabel(accessibleName(e), labels)) as HTMLInputElement[];
}
/** Read only explicitly associated key/value structures. Never scrape all IDs in body. */
export function readField(scope: ParentNode, labels: string[]): string | undefined {
  const values: string[] = [];
  for (const e of elements(scope, 'dt,th,label,[role="rowheader"]')) {
    if (!sameLabel(txt(e), labels)) continue;
    if (e.tagName === 'DT' && e.nextElementSibling?.tagName === 'DD') values.push(txt(e.nextElementSibling));
    if (e.tagName === 'TH' || e.getAttribute('role') === 'rowheader') {
      const row = e.closest('tr,[role="row"]');
      const cells = row ? elements(row, 'td,[role="cell"]') : [];
      if (cells.length === 1) values.push(txt(cells[0]));
    }
    if (e.tagName === 'LABEL') {
      const target = (e as HTMLLabelElement).control;
      if (target && visible(target) && (target.hasAttribute('readonly') || target.tagName === 'OUTPUT')) values.push((target as HTMLInputElement).value || txt(target));
    }
  }
  for (const e of elements(scope, '[aria-label],output')) {
    if (!sameLabel(e.getAttribute('aria-label') || '', labels)) continue;
    if (/^(INPUT|TEXTAREA)$/.test(e.tagName) && !e.hasAttribute('readonly')) continue;
    values.push((e as HTMLInputElement).value || txt(e));
  }
  const distinct = [...new Set(values.map(x => x.trim()).filter(Boolean))];
  if (distinct.length > 1) throw new AdapterError('IDENTITY', `字段“${labels[0]}”出现多个不同值，无法确认当前上下文`);
  return distinct[0];
}
export function currencyOf(input: HTMLInputElement): string {
  const contexts = [accessibleName(input)];
  for (const attr of ['aria-describedby', 'aria-labelledby']) {
    for (const id of (input.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) contexts.push(txt(input.ownerDocument.getElementById(id)));
  }
  const parent = input.parentElement;
  const local = input.closest('label') || (parent && !/^(BODY|HTML|FORM|MAIN|SECTION|FIELDSET)$/.test(parent.tagName) && parent.querySelectorAll('input').length === 1 && txt(parent).length < 240 ? parent : null);
  if (local) contexts.push(txt(local));
  const text = contexts.join(' ');
  if (/\b(?:CNY|RMB|EUR|GBP|HKD|CAD|AUD|SGD|JPY|TWD)\b|人民币|欧元|港元|加元|澳元|新加坡元|日元|英镑|CN¥|HK\$|CA\$|A\$/i.test(text)) throw new AdapterError('CURRENCY', '底价输入控件的币种不是 USD 或包含冲突币种');
  if (/\bUSD\b|US\$|美元/i.test(text)) return 'USD';
  throw new AdapterError('CURRENCY', '无法从底价输入控件的关联标签确认 USD；单独的 $ 不足以确认美元');
}
function scaled(s: string, scale: number): bigint {
  const [whole, fraction = ''] = s.split('.'); return BigInt(whole + fraction.padEnd(scale, '0'));
}
export function checkConstraints(input: HTMLInputElement, value: string): void {
  const normalized = normalizeDecimal(value);
  const min = input.getAttribute('min'); const max = input.getAttribute('max'); const step = input.getAttribute('step');
  const candidates = [normalized, min, max, step === 'any' ? null : step].filter((x): x is string => !!x).map(normalizeDecimal);
  const scale = Math.max(0, ...candidates.map(x => (x.split('.')[1] || '').length));
  const actual = scaled(normalized, scale);
  if (min && actual < scaled(normalizeDecimal(min), scale)) throw new AdapterError('ROW', `底价小于页面允许的最小值 ${min}`, false);
  if (max && actual > scaled(normalizeDecimal(max), scale)) throw new AdapterError('ROW', `底价大于页面允许的最大值 ${max}`, false);
  // Number inputs default to step=1 if absent, per HTML; text fields have no inferred precision limit.
  const actualStep = step || (input.type === 'number' ? '1' : 'any');
  if (actualStep !== 'any') {
    const stepScale = Math.max(scale, (actualStep.split('.')[1] || '').length);
    const stepInteger = scaled(normalizeDecimal(actualStep), stepScale);
    if (stepInteger <= 0n || (scaled(normalized, stepScale) - scaled(min ? normalizeDecimal(min) : '0', stepScale)) % stepInteger !== 0n) throw new AdapterError('ROW', `底价不符合页面的小数精度/步长 ${actualStep}`, false);
  }
}
function setInput(input: HTMLInputElement, value: string): void {
  if (!enabled(input) || input.readOnly) throw new AdapterError('STRUCTURE', '输入控件不可编辑');
  const win = input.ownerDocument.defaultView!;
  const proto = input.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  input.dispatchEvent(new win.Event('blur', { bubbles: true }));
  if (input.value !== value) throw new AdapterError('ROW', '页面未接受输入值，未执行提交', false);
}
function formatFrom(s: string | undefined): AdFormat | undefined {
  if (!s) return undefined;
  if (sameLabel(s, ZH.interstitial)) return 'interstitial';
  if (sameLabel(s, ZH['app-open'])) return 'app-open';
  return undefined;
}
function required(s: string | undefined, message: string): string { if (!s) throw new AdapterError('STRUCTURE', message); return s; }
function bodyScope(doc: Document): ParentNode { return doc; }
function activeFilters(table:Element): boolean {
  const region = table.closest('main,[role="main"]') || table.closest('[role="region"],section') || table.parentElement!;
  const fields=elements(region,'input,select,[role="combobox"],[role="searchbox"]');
  for(const field of fields){
    const label=accessibleName(field);
    if(/每页|每次显示|行数/.test(label)) continue;
    const isSearch=(field as HTMLInputElement).type==='search' || field.getAttribute('role')==='searchbox' || /搜索|筛选/.test(label);
    const isSelection=field.tagName==='SELECT' || field.getAttribute('role')==='combobox';
    const value=(field as HTMLInputElement).value || field.getAttribute('aria-valuetext') || (isSelection ? txt(field.querySelector('[aria-selected="true"],option:checked')) : '');
    if(value?.trim() && (isSearch || isSelection) && !/^(全部|所有|所有广告单元|全部广告单元|所有状态)$/.test(value.trim())) return true;
  }
  return elements(region,'button,[role="button"]').some(e=>/清除(?:所有)?筛选|移除筛选条件|删除筛选条件/.test(accessibleName(e)) && enabled(e));
}

export class AdMobAdapter implements Adapter {
  doc: Document; timeout: number; prepared?: {identity: Identity;format: AdFormat;name:string;floor:string;form:Element}; submitted = false;
  sourceListLink?: string;
  constructor(doc: Document = document, timeout = 15_000) { this.doc = doc; this.timeout = timeout; }
  async wait<T>(fn: () => T | undefined | false, step: string): Promise<T> {
    const initial = fn(); if (initial) return initial;
    return new Promise((resolve, reject) => {
      const finish = (err?: unknown, value?: T) => { observer.disconnect(); clearTimeout(timer); err ? reject(err) : resolve(value!); };
      const observer = new this.doc.defaultView!.MutationObserver(() => { try { const value = fn(); if (value) finish(undefined, value); } catch (err) { finish(err); } });
      observer.observe(this.doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(new AdapterError('TIMEOUT', `${step}：等待页面条件超时，未确认结果`)), this.timeout);
    });
  }
  async identify(): Promise<Identity> {
    const location = this.doc.location;
    if (location && /accounts\.google\.com$/.test(location.hostname)) throw new AdapterError('LOGIN', '登录已失效，请在原浏览器恢复登录');
    const scope = bodyScope(this.doc);
    const publisherId = required(readField(scope, ZH.publisher), '当前页面没有可核对的发布商 ID；请进入包含账号和目标应用信息的页面并导出诊断');
    const appId = required(readField(scope, ZH.appId), '当前页面没有可核对的 AdMob App ID；请进入目标应用，不能使用历史缓存');
    const appName = required(readField(scope, ZH.appName), '当前页面没有明确标注的当前应用名称');
    if (!publisherRx.test(publisherId) || !appRx.test(appId) || !appId.startsWith(`ca-app-${publisherId}~`)) throw new AdapterError('IDENTITY', '发布商 ID 与 App ID 无效或不属于同一发布商');
    const floorInputs = labelledInputs(scope, ZH.floor);
    let currency: string | undefined;
    if (floorInputs.length === 1) { try { currency = currencyOf(floorInputs[0]); } catch { currency = '无法确认 USD'; } }
    return { publisherId, appId, appName, currency, evidence: ['当前页面显式发布商ID字段', '当前页面显式应用ID和应用名称字段'] };
  }
  async assertIdentity(identity: Identity): Promise<void> {
    const current = await this.identify();
    if (current.publisherId !== identity.publisherId || current.appId !== identity.appId) throw new AdapterError('IDENTITY', '当前发布商或应用与批次不一致，整批暂停');
  }
  list(): Element | undefined {
    const tables = elements(this.doc, 'table,[role="table"],[role="grid"]').filter(e => sameLabel(accessibleName(e), ZH.units) || (e.querySelector('caption') && sameLabel(txt(e.querySelector('caption')), ZH.units)));
    if (tables.length > 1) throw new AdapterError('STRUCTURE', '当前页面存在多个广告单元列表');
    return tables[0];
  }
  async home(): Promise<void> {
    if (this.list()) return;
    const links = controls(this.doc, ZH.units, 'a[href]');
    const link = one(links, '返回目标应用广告单元');
    this.sourceListLink = (link as HTMLAnchorElement).href;
    click(link, '广告单元');
    await this.wait(() => this.list(), '等待广告单元列表');
  }
  async lookup(identity: Identity, name: string): Promise<Lookup> {
    await this.assertIdentity(identity); await this.home();
    // Every query starts at the first page. Remaining on the last page from a
    // previous lookup must never be mistaken for the application's full list.
    {
      const table = requiredElement(this.list(), '未识别到广告单元表格');
      const region = table.closest('[role="region"],section') || table.parentElement!;
      const first = controls(region, ZH.first);
      if (first.length > 1) return {complete:false,matches:[],reason:'列表首页控件不唯一'};
      if (first.length === 1 && enabled(first[0])) {
        const previous = txt(table);
        click(first[0],'返回列表第一页');
        await this.wait(()=> {const fresh=this.list(); return fresh && txt(fresh)!==previous;},'等待列表第一页');
      }
    }
    const seen = new Set<string>(); const matches: Partial<Actual>[] = []; let counted = 0; let total: number | undefined;
    for (let pages = 0; pages < 200; pages++) {
      await this.assertIdentity(identity);
      const table = requiredElement(this.list(), '未识别到广告单元表格');
      const region = table.closest('[role="region"],section') || table.parentElement!;
      if (activeFilters(table)) return { complete: false, matches, reason: '广告单元列表包含搜索或筛选，无法确认全部同名结果' };
      const totalMatch = txt(region).match(/共\s*(\d+)\s*(?:个|条)?\s*广告单元/);
      if (totalMatch) total = Number(totalMatch[1]);
      const headers = elements(table, 'thead th,[role="columnheader"]').map(txt);
      const nameIndex = headers.findIndex(h => sameLabel(h, ZH.name));
      if (nameIndex < 0) return { complete: false, matches, reason: '列表缺少明确的广告单元名称列' };
      const rows = elements(table, 'tbody tr,[role="row"]').filter(r => r.querySelector('td,[role="cell"]'));
      const signature = rows.map(txt).join('\n');
      if (seen.has(signature)) return { complete: false, matches, reason: '列表分页重复或未更新' };
      seen.add(signature); counted += rows.length;
      for (const row of rows) {
        const cells = elements(row, 'td,[role="cell"]');
        if (txt(cells[nameIndex]) !== name) continue;
        const get = (labels: string[]) => { const i = headers.findIndex(h => sameLabel(h, labels)); return i >= 0 ? txt(cells[i]) : undefined; };
        const unitId = get(ZH.unitId); const format = formatFrom(get(ZH.format));
        const mode = get(ZH.mode); const floorRaw = get(ZH.amount); const currencyRaw = get(ZH.currency);
        let floor: string | undefined; try { if (floorRaw) floor = normalizeDecimal(floorRaw); } catch { /* incomplete evidence */ }
        const currency = currencyRaw && /^(USD|US\$|美元)$/i.test(currencyRaw) ? 'USD' : currencyRaw;
        const actual: Partial<Actual> = { publisherId:identity.publisherId, appId:identity.appId, name, unitId, format, mode:mode === '手动设定底价' ? 'manual' : mode, floor, currency, verified: !!unitId && unitRx.test(unitId) && !!format && mode === '手动设定底价' && !!floor && currency === 'USD' };
        matches.push(actual);
      }
      if (total !== undefined && counted === total) return { complete: true, matches };
      if (total !== undefined && counted > total) return { complete:false,matches,reason:'列表总数与已读取行数不一致' };
      const next = controls(region, ZH.next);
      if (next.length !== 1 || !enabled(next[0])) return {complete:false,matches,reason:'缺少可核对的列表总数，不能证明分页/筛选结果完整'};
      const previous = signature;
      click(next[0], '下一页');
      await this.wait(() => { const fresh = this.list(); return fresh && elements(fresh, 'tbody tr,[role="row"]').filter(r => r.querySelector('td,[role="cell"]')).map(txt).join('\n') !== previous; }, '等待下一页列表');
    }
    return { complete:false,matches,reason:'超过分页安全上限，结果不完整' };
  }
  activeForm(): Element | undefined {
    const names = labelledInputs(this.doc, ZH.name);
    if (!names.length) return undefined;
    const name = one(names, '定位广告单元名称');
    return name.closest('[role="dialog"],form') || name.closest('main,[role="main"]') || undefined;
  }
  async prepare(identity: Identity, format: AdFormat, name: string, floor: string, checkpoint: () => Promise<void>): Promise<void> {
    this.prepared = undefined; this.submitted = false;
    await checkpoint(); await this.assertIdentity(identity);
    if (!this.activeForm()) {
      await this.home(); click(one(controls(this.doc, ZH.add), '添加广告单元'), '添加广告单元');
      await this.wait(() => elements(this.doc, '[role="group"],[role="region"],article,fieldset').some(e => sameLabel(accessibleName(e), ZH[format]) || elements(e,'h1,h2,h3,h4,legend').some(h => sameLabel(txt(h),ZH[format]))), '等待广告格式卡片');
      const cards = elements(this.doc, '[role="group"],[role="region"],article,fieldset').filter(e => sameLabel(accessibleName(e), ZH[format]) || elements(e,'h1,h2,h3,h4,legend').some(h => sameLabel(txt(h),ZH[format])));
      const leafCards = cards.filter(e => !cards.some(other => other !== e && e.contains(other)));
      const card = one(leafCards, '定位准确广告格式卡片');
      if (/激励/.test(accessibleName(card))) throw new AdapterError('STRUCTURE', '定位到了激励广告格式，已停止');
      click(one(controls(card, ['选择']), `选择${ZH[format][0]}`), `选择${ZH[format][0]}`);
    }
    const form = await this.wait(() => this.activeForm(), '等待创建表单');
    await checkpoint(); await this.assertIdentity(identity);
    const declaredFormat = readField(form, ZH.format) || txt(one(elements(form,'h1,h2,h3').filter(e=> ZH[format].some(f => txt(e) === `创建${f}广告单元`)), '确认创建表单广告格式'));
    if (!formatFrom(declaredFormat) && !ZH[format].some(f => declaredFormat === `创建${f}广告单元`)) throw new AdapterError('STRUCTURE', '创建表单未明确确认请求广告格式');
    if (formatFrom(declaredFormat) && formatFrom(declaredFormat) !== format) throw new AdapterError('STRUCTURE', '创建表单格式与批次不一致');
    const nameInput = one(labelledInputs(form, ZH.name), '广告单元名称');
    if (nameInput.maxLength >= 0 && name.length > nameInput.maxLength) throw new AdapterError('ROW', `名称超过当前页面上限 ${nameInput.maxLength}，未截断`, false);
    setInput(nameInput, name);
    const advanced = controls(form, ZH.advanced);
    if (advanced.length === 1 && advanced[0].getAttribute('aria-expanded') === 'false') click(advanced[0], '展开高级设置');
    const manual = await this.wait(() => { const list = controls(form, ZH.manual, 'input[type="radio"],[role="radio"]'); return list.length ? one(list,'手动设定底价') : undefined; }, '等待手动底价选项');
    await checkpoint(); click(manual, '主动选择手动设定底价');
    await this.wait(() => (manual as HTMLInputElement).checked || manual.getAttribute('aria-checked') === 'true', '回读手动底价模式');
    const floorInput = await this.wait(() => { const list = labelledInputs(form, ZH.floor); return list.length ? one(list,'全局底价输入框') : undefined; }, '等待全局底价输入框');
    const floorRegion = floorInput.closest('fieldset,[role="group"],[role="region"]');
    if (!floorRegion || !/全局|有效每千次展示费用底价/.test(accessibleName(floorRegion) + txt(floorRegion.querySelector('legend')))) throw new AdapterError('STRUCTURE', '无法确认底价字段属于广告单元的全局底价区域');
    if (/针对特定国家|针对特定地区|国家\/地区|中介组|瀑布流/.test(accessibleName(floorRegion))) throw new AdapterError('STRUCTURE', '底价字段可能属于国家/地区或中介组设置，未提交');
    currencyOf(floorInput); checkConstraints(floorInput, floor); setInput(floorInput, normalizeDecimal(floor));
    if (!decimalEqual(floorInput.value, floor) || nameInput.value !== name || !((manual as HTMLInputElement).checked || manual.getAttribute('aria-checked') === 'true')) throw new AdapterError('STRUCTURE', '名称、模式或底价回读不一致');
    currencyOf(floorInput);
    if (!floorInput.checkValidity() || !nameInput.checkValidity()) throw new AdapterError('ROW', '输入不满足当前 AdMob 表单校验规则', false);
    one(controls(form, ZH.create), '创建广告单元提交按钮');
    await checkpoint(); await this.assertIdentity(identity);
    this.prepared = { identity,format,name,floor,form };
  }
  async submit(): Promise<void> {
    const state = this.prepared;
    if (!state || this.submitted) throw new AdapterError('SUBMIT_GUARD','当前表单未通过准备或已经执行过提交');
    await this.assertIdentity(state.identity);
    const form = this.activeForm();
    if (!form || form !== state.form) throw new AdapterError('STRUCTURE', '提交前表单被替换，需重新预检');
    const nameInput = one(labelledInputs(form, ZH.name), '提交前名称');
    const floorInput = one(labelledInputs(form, ZH.floor), '提交前底价');
    const manual = one(controls(form, ZH.manual, 'input[type="radio"],[role="radio"]'), '提交前模式');
    if (nameInput.value !== state.name || !decimalEqual(floorInput.value,state.floor) || !((manual as HTMLInputElement).checked || manual.getAttribute('aria-checked') === 'true')) throw new AdapterError('STRUCTURE','提交前字段发生变化');
    const declaredFormat = readField(form, ZH.format) || elements(form,'h1,h2,h3').map(txt).find(s=>ZH[state.format].some(f=>s === `创建${f}广告单元`));
    if (formatFrom(declaredFormat) !== state.format && !ZH[state.format].some(f=>declaredFormat === `创建${f}广告单元`)) throw new AdapterError('STRUCTURE','提交前广告格式发生变化或无法确认');
    currencyOf(floorInput); checkConstraints(floorInput,state.floor);
    if (!floorInput.checkValidity() || !nameInput.checkValidity()) throw new AdapterError('ROW','提交前表单校验未通过',false);
    this.submitted = true; // Set before click: errors after click may still mean the server received it.
    click(one(controls(form, ZH.create), '唯一创建按钮'), '创建广告单元');
  }
  async verify(identity: Identity, format: AdFormat, name: string, floor: string): Promise<Actual> {
    await this.assertIdentity(identity);
    const unitId = await this.wait(() => { const value = readField(this.doc, ZH.unitId); return value && unitRx.test(value) ? value : undefined; }, '等待真实广告单元 ID');
    const partial: Partial<Actual> = { unitId, publisherId:identity.publisherId, appId:identity.appId, verified:false };
    try {
      if (!unitId.startsWith(`ca-app-${identity.publisherId}/`)) throw new AdapterError('IDENTITY','广告单元ID所属发布商不一致');
      // A creation confirmation often contains an ID only. Follow a genuine detail link, never infer its URL.
      const detailLinks = elements(this.doc,'a[href]').filter(e => sameLabel(accessibleName(e), ['查看广告单元','广告单元设置','查看设置']) || accessibleName(e) === name);
      if (!readField(this.doc, ZH.mode) && detailLinks.length === 1) { click(detailLinks[0], '打开保存后的广告单元配置'); await this.wait(() => readField(this.doc, ZH.mode), '等待已保存底价模式'); }
      await this.assertIdentity(identity);
      const detailUnitId=readField(this.doc,ZH.unitId);
      if(detailUnitId!==unitId) throw new AdapterError('VERIFY','保存后详情的广告单元ID与最初取得的ID不一致，不能合并两个单元的配置');
      // An editable create form is not proof of saved server configuration.
      if (this.activeForm()) throw new AdapterError('VERIFY','仍停留在可编辑创建表单，不能作为已保存配置证据');
      const savedName = readField(this.doc, ZH.name); const savedFormat = formatFrom(readField(this.doc, ZH.format));
      const modeRaw = readField(this.doc, ZH.mode); const amountRaw = readField(this.doc, ZH.amount); const currencyRaw = readField(this.doc, ZH.currency);
      Object.assign(partial,{name:savedName,format:savedFormat,mode:modeRaw === '手动设定底价' ? 'manual' : modeRaw,floor:amountRaw,currency:currencyRaw});
      if (!savedName || !savedFormat || !modeRaw || !amountRaw || !currencyRaw) throw new AdapterError('VERIFY','已取得ID，但保存后页面缺少名称、格式、全局手动底价或币种字段');
      const savedFloor = normalizeDecimal(amountRaw);
      const savedCurrency = /^(USD|US\$|美元)$/i.test(currencyRaw) ? 'USD' : currencyRaw;
      Object.assign(partial,{floor:savedFloor,currency:savedCurrency});
      if (savedName !== name || savedFormat !== format || modeRaw !== '手动设定底价' || !decimalEqual(savedFloor,floor) || savedCurrency !== 'USD') throw new AdapterError('VERIFY','已创建，但保存后配置与请求不一致');
      return {...partial,verified:true} as Actual;
    } catch (err) {
      if (err instanceof AdapterError) { err.actual = partial; throw err; }
      throw new AdapterError('VERIFY','已取得ID，但保存后的配置无法可靠读取',true,partial);
    }
  }
  diagnostics(): unknown {
    const redact = (s:string) => s.replace(/ca-app-pub-\d{16}[~/]\d+/g,'[已隐去广告ID]').replace(/pub-\d+/g,'[已隐去发布商ID]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[已隐去邮箱]');
    const knownLabels = Object.values(ZH).flat();
    const numericAttr = (e:Element,key:string) => { const s=e.getAttribute(key); return s && /^(?:\d+(?:\.\d+)?|any)$/.test(s) ? s : undefined; };
    const safeLabel = (s:string) => knownLabels.find(x=>compact(x) === compact(s)) || (s.includes('USD') ? '[关联标签含USD]' : s.includes('US$') ? '[关联标签含US$]' : s.includes('美元') ? '[关联标签含美元]' : s.includes('$') ? '[关联标签仅含$]' : '[未在诊断白名单中的文字]');
    const items = elements(this.doc,'input:not([type="hidden"]),textarea,button,[role="button"],[role="radio"],dt,th,legend').slice(0,300).map(e=>({
      tag:e.tagName.toLowerCase(),role:['button','radio','textbox','spinbutton','rowheader','columnheader'].includes(e.getAttribute('role') || '') ? e.getAttribute('role') : undefined,label:safeLabel(redact(accessibleName(e))),
      type:e.tagName === 'INPUT' ? (e as HTMLInputElement).type : undefined,
      disabled:!enabled(e), min:numericAttr(e,'min'),max:numericAttr(e,'max'),step:numericAttr(e,'step'),maxLength:numericAttr(e,'maxlength'),
    }));
    return {adapter:'semantic-candidate-unverified-live',time:new Date().toISOString(),origin:this.doc.location?.origin,controls:items,omitted:'不导出URL路径、查询参数、DOM HTML、输入值、账号ID、应用名、Cookie、Token、密码或任意页面正文'};
  }
}
function requiredElement(e: Element | undefined, message: string): Element { if (!e) throw new AdapterError('STRUCTURE',message); return e; }

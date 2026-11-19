import type { Actual, Adapter, AdFormat, FloorMode, Identity, Lookup } from './types.ts';
import { MEDIA_DEFAULTS, REWARD_DEFAULT } from './types.ts';
import { decimalEqual, normalizeDecimal, matchesFloor } from './core.ts';

/**
 * These labels come from the live Chinese AdMob pages observed on
 * Chromium 126 (HubVPS), 2026-11-13:
 * - ad unit grid: role=grid aria-label="广告单元", rows role=row,
 *   cells ess-cell[essfield=...], footer "第 A - B 行，共 N 行"
 * - create flow: section.ad-format-card, material-button.select-button
 * - manual floor radio: "人工指定底价", not "手动设定底价"
 * - floor control: manual-ecpm-floor-input, label "输入全球有效每千次展示费用底价",
 *   currency prefix "US$" in span.leading-text
 * - saved detail: div.header[aria-label=...] with aria-describedby -> .panel-description
 */
export const ZH = {
  gridLabel: ['广告单元'],
  publisher: ['发布商 ID', '发布商ID'],
  appId: ['应用 ID', '应用ID', 'AdMob 应用 ID'],
  appName: ['应用名称', '当前应用'],
  units: ['广告单元'],
  add: ['添加广告单元'],
  create: ['创建广告单元'],
  name: ['广告单元名称', '输入广告单元名称'],
  advanced: ['高级设置'],
  manual: ['人工指定底价'],
  auto: ['由 Google 优化', 'Google 优化'],
  disabled: ['已停用'],
  floorGroup: ['有效每千次展示费用底价'],
  floor: ['输入全球有效每千次展示费用底价', '全局底价', '全球底价'],
  format: ['广告格式'],
  unitId: ['广告单元 ID', '广告单元ID'],
  mode: ['底价模式'],
  amount: ['全局底价'],
  currency: ['底价币种', '币种'],
  banner: ['横幅广告', '横幅'],
  interstitial: ['插页式广告', '插页式', '插屏'],
  rewarded: ['激励广告', '激励'],
  'rewarded-interstitial': ['插页式激励广告', '激励插页式广告', '插页式激励', '激励插页式'],
  'app-open': ['开屏广告', '开屏'],
  native: ['原生高级广告', '原生广告', '原生'],
  next: ['转到下一页', '下一页'],
  first: ['转到首页', '第一页'],
  back: ['返回', '转到广告单元列表'],
};
const FORMAT_LABELS: Record<AdFormat, string[]> = {
  banner: ZH.banner, interstitial: ZH.interstitial, rewarded: ZH.rewarded,
  'rewarded-interstitial': ZH['rewarded-interstitial'], 'app-open': ZH['app-open'], native: ZH.native,
};
const FORMAT_PAGE: Record<AdFormat, string> = {
  banner: '横幅广告', interstitial: '插页式广告', rewarded: '激励广告',
  'rewarded-interstitial': '插页式激励广告', 'app-open': '开屏广告', native: '原生高级广告',
};
const PUBLISHER_RX = /^pub-\d{16}$/;
const APP_RX = /^ca-app-pub-(\d{16})~(\d{10})$/;
const UNIT_RX = /^ca-app-pub-(\d{16})\/(\d{10})$/;
const ANY_APP_RX = /ca-app-pub-\d{16}~\d{10}/;
const ANY_UNIT_RX = /ca-app-pub-\d{16}\/\d{10}/;
const SESSION_IDENTITY = 'abc:live-identity:';
const DEFAULT_MEDIA_TYPES = MEDIA_DEFAULTS.interstitial;
const PARTNER_BIDDING_LABEL = '我目前在另一中介平台（而非 AdMob）上将此广告单元用于实时出价。';

export class AdapterError extends Error {
  code: string; fatal: boolean; actual?: Partial<Actual>;
  constructor(code: string, message: string, fatal = true, actual?: Partial<Actual>) {
    super(message); this.name = 'AdapterError'; this.code = code; this.fatal = fatal; this.actual = actual;
  }
}
const txt = (e: Node | null | undefined): string => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
function fieldText(element: Element | null | undefined, preserveWhitespace = false): string {
  if (!element) return '';
  const copy = element.cloneNode(true) as Element;
  // Icon ligatures are UI decoration, but the same text can be part of a
  // legitimate name. Remove only explicit icon nodes, never name substrings.
  for (const icon of copy.querySelectorAll('help-tooltip-icon, material-icon, .material-icons, .material-icons-extended')) icon.remove();
  const value = copy.textContent || '';
  return (preserveWhitespace ? value : value.replace(/\s+/g, ' ')).trim();
}
const compact = (s: string): string => s.replace(/[：:\s]/g, '');
const sameLabel = (s: string, labels: string[]): boolean => labels.some((x) => compact(s) === compact(x));
const containsLabel = (s: string, labels: string[]): boolean => labels.some((x) => compact(s).includes(compact(x)));

function displayedDecimal(value: string): string | undefined {
  if (!/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return undefined;
  return normalizeDecimal(value.replace(/,/g, ''));
}
function inputMatchesValue(input: HTMLInputElement, expected: string): boolean {
  if (input.value === expected || decimalEqual(input.value, expected)) return true;
  // AdMob formats the native manual-money input after input/change/blur.
  // Only its displayed value may contain grouping; expected input stays strict.
  const displayed = input.tagName === 'INPUT' && input.closest('manual-ecpm-floor-input')
    ? displayedDecimal(input.value) : undefined;
  return displayed !== undefined && decimalEqual(displayed, expected);
}

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
function enabled(e: Element): boolean {
  return !e.hasAttribute('disabled') && e.getAttribute('aria-disabled') !== 'true' && !e.classList.contains('is-disabled');
}
function accessibleName(e: Element): string {
  const refs = e.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => txt(e.ownerDocument.getElementById(id))).join(' ');
  return (e.getAttribute('aria-label') || refs || (e as HTMLInputElement).labels?.[0]?.textContent || txt(e)).trim();
}
function byAria(scope: ParentNode, label: string, selector = '[aria-label]'): Element[] {
  return elements(scope, selector).filter((e) => sameLabel(accessibleName(e), [label]));
}
function click(e: Element, step: string): void {
  if (!visible(e) || !enabled(e)) throw new AdapterError('STRUCTURE', `${step}：控件不可见或不可操作`);
  (e as HTMLElement).click();
}
function labelledInputs(scope: ParentNode, labels: string[]): HTMLInputElement[] {
  return elements(scope, 'input:not([type="hidden"]),textarea').filter((e) => containsLabel(accessibleName(e), labels)) as HTMLInputElement[];
}
function required<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null || value === '') throw new AdapterError('STRUCTURE', message);
  return value;
}

/** Read only explicitly associated key/value structures. */
export function readField(scope: ParentNode, labels: string[]): string | undefined {
  const values: string[] = [];
  for (const e of elements(scope, 'dt,th,label,[role="rowheader"]')) {
    if (!sameLabel(txt(e), labels)) continue;
    if (e.tagName === 'DT' && e.nextElementSibling?.tagName === 'DD') values.push(txt(e.nextElementSibling));
    if ((e.tagName === 'TH' || e.getAttribute('role') === 'rowheader')) {
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
  const distinct = [...new Set(values.map((x) => x.trim()).filter(Boolean))];
  if (distinct.length > 1) throw new AdapterError('IDENTITY', `字段“${labels[0]}”出现多个不同值，无法确认当前上下文`);
  return distinct[0];
}

const OTHER_CURRENCY = /\b(?:CNY|RMB|EUR|GBP|HKD|CAD|AUD|NZD|SGD|JPY|TWD|KRW|INR|BRL|MXN|CHF|SEK|NOK|DKK|PLN|TRY|RUB|ZAR)\b|人民币|欧元|港元|加元|澳元|新加坡元|日元|英镑|韩元|印度卢比|雷亚尔|比索|瑞士法郎|CN¥|HK\$|CA\$|A\$|[¥￥€£₩₹₽]/i;

/**
 * The user has fixed the batch currency to USD. A "$" or an absent currency
 * prefix follows that configuration; it is not presented as observed US$.
 * Explicit other/conflicting currencies still stop the automated operation.
 */
export function currencyOf(input: HTMLInputElement): string {
  const container = input.closest('manual-ecpm-floor-input') || input.closest('material-input') || input.closest('label') || input.parentElement;
  const local = container ? container : input;
  const text = [accessibleName(input), txt(local)].join(' ');
  if (OTHER_CURRENCY.test(text)) throw new AdapterError('CURRENCY', '底价输入控件的币种不是 USD 或包含冲突币种');
  return 'USD';
}
function scaled(s: string, scale: number): bigint {
  const [whole, fraction = ''] = s.split('.'); return BigInt(whole + fraction.padEnd(scale, '0'));
}
export function checkConstraints(input: HTMLInputElement, value: string): void {
  const normalized = normalizeDecimal(value);
  const min = input.getAttribute('min'); const max = input.getAttribute('max'); const step = input.getAttribute('step');
  const candidates = [normalized, min, max, step === 'any' ? null : step].filter((x): x is string => !!x).map(normalizeDecimal);
  const scale = Math.max(0, ...candidates.map((x) => (x.split('.')[1] || '').length));
  const actual = scaled(normalized, scale);
  if (min && actual < scaled(normalizeDecimal(min), scale)) throw new AdapterError('ROW', `底价小于页面允许的最小值 ${min}`, false);
  if (max && actual > scaled(normalizeDecimal(max), scale)) throw new AdapterError('ROW', `底价大于页面允许的最大值 ${max}`, false);
  const actualStep = step || (input.type === 'number' ? '1' : 'any');
  if (actualStep !== 'any') {
    const stepScale = Math.max(scale, (actualStep.split('.')[1] || '').length);
    const stepInteger = scaled(normalizeDecimal(actualStep), stepScale);
    if (stepInteger <= 0n || (scaled(normalized, stepScale) - scaled(min ? normalizeDecimal(min) : '0', stepScale)) % stepInteger !== 0n) throw new AdapterError('ROW', `底价不符合页面的小数精度/步长 ${actualStep}`, false);
  }
}

function formatFrom(s: string | undefined): AdFormat | undefined {
  if (!s) return undefined;
  const value = s.trim();
  return (Object.keys(FORMAT_LABELS) as AdFormat[]).find(format => FORMAT_LABELS[format].includes(value));
}
function formatFromCell(s: string | undefined): AdFormat | undefined {
  if (!s) return undefined;
  const exact = formatFrom(s);
  if (exact) return exact;
  // Longer names must consume their complete label first: 插页式激励广告
  // is neither an ordinary interstitial nor a rewarded-only ad unit.
  const labels = (Object.entries(FORMAT_LABELS) as [AdFormat, string[]][])
    .flatMap(([format, aliases]) => aliases.filter(label => label.length > 2).map(label => ({ format, label })))
    .sort((a, b) => b.label.length - a.label.length);
  let remaining = s;
  const matches = new Set<AdFormat>();
  for (const { format, label } of labels) {
    if (!remaining.includes(label)) continue;
    matches.add(format);
    remaining = remaining.replaceAll(label, ' ');
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}
function routeAppId(doc: Document): string | undefined {
  const match = doc.location?.pathname.match(/\/v2\/apps\/(\d{10})(?:\/|$)/);
  return match?.[1];
}
function appNameFromPage(doc: Document): string {
  // AdMob marks the active app's sidebar entry with class "selected"; its
  // aria-label is explicit even though the collapsed sidebar clones are
  // aria-hidden. Do not use visibility here: the label is the selection state.
  // The live builds are not consistent about curly vs straight quotes, so the
  // app-specific suffix is the delimiter, not a fixed quote character.
  const extract = (label: string): string => {
    const match = label.match(/(.+?)(?:中的广告单元|的应用设置|应用概览|的屏蔽控制功能)/);
    return match ? match[1].replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, '').trim() : '';
  };
  const selected: string[] = [];
  for (const el of doc.querySelectorAll('material-list-item.selected[aria-label], material-list-item[aria-selected="true"][aria-label]')) {
    const label = el.getAttribute('aria-label') || '';
    if (!/中的广告单元|的应用设置|应用概览|的屏蔽控制功能/.test(label)) continue;
    const name = extract(label);
    if (name) selected.push(name);
  }
  const selectedNames = [...new Set(selected.filter(Boolean))];
  if (selectedNames.length === 1) return selectedNames[0];
  if (selectedNames.length > 1) throw new AdapterError('IDENTITY', '侧栏出现多个选中的应用，无法确认当前应用');
  const primary: string[] = [];
  for (const el of doc.querySelectorAll('span.primary-label')) {
    const value = fieldText(el, true);
    if (value && !/^(AdMob|首页|应用|报告|中介|广告系列|政策中心)$/.test(value)) primary.push(value);
  }
  const primaryNames = [...new Set(primary.filter(Boolean))];
  if (primaryNames.length === 1) return primaryNames[0];
  if (primaryNames.length > 1) throw new AdapterError('IDENTITY', '页面出现多个不同应用名称，无法确认当前应用');
  const labelled: string[] = [];
  for (const el of doc.querySelectorAll('material-list-item[aria-label], [role="link"][aria-label]')) {
    const label = el.getAttribute('aria-label') || '';
    if (!/应用设置|应用概览|广告单元/.test(label)) continue;
    const name = extract(label);
    if (name) labelled.push(name);
  }
  const labelledNames = [...new Set(labelled.filter(Boolean))];
  if (labelledNames.length > 1) throw new AdapterError('IDENTITY', '页面出现多个不同应用名称，无法确认当前应用');
  return labelledNames[0] || '';
}
function appIdText(doc: Document): string | undefined {
  const values: string[] = [];
  for (const el of elements(doc, 'span.copy-chip-text, [aria-label], output, p, div')) {
    if (el.childElementCount > 0) continue;
    const value = txt(el);
    if (ANY_APP_RX.test(value) && value.length <= 80) values.push(value);
  }
  const distinct = [...new Set(values)];
  if (distinct.length > 1) throw new AdapterError('IDENTITY', '页面出现多个不同 App ID，无法确认当前应用');
  return distinct[0];
}
function firstUnit(doc: Document): string | undefined {
  for (const el of elements(doc, 'a[href*="/adunits/"], ad-unit-with-id-cell, .ad-unit-id-container, div.panel-description')) {
    const match = (el.getAttribute('href') || txt(el)).match(ANY_UNIT_RX);
    if (match) return match[0];
  }
  return undefined;
}
function listHref(doc: Document): string | undefined {
  for (const el of elements(doc, 'material-list-item[href],a[href]')) {
    const href = el.getAttribute('href') || '';
    if (/\/v2\/apps\/\d{10}\/adunits\/list$/.test(href)) return href;
  }
  return undefined;
}

export class AdMobAdapter implements Adapter {
  doc: Document; timeout: number;
  private openingIdentity?: Identity;
  prepared?: { identity: Identity; format: AdFormat; name: string; floor: string; mode: FloorMode; partnerBidding: boolean; partnerControlPresent: boolean; nameInput: HTMLInputElement; floorInput?: HTMLInputElement; form: Element };
  submitted = false;
  constructor(doc: Document = document, timeout = 20_000) { this.doc = doc; this.timeout = timeout; }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.doc.defaultView!.setTimeout(resolve, ms));
  }

  async wait<T>(fn: () => T | undefined | false, step: string, timeout = this.timeout): Promise<T> {
    const initial = fn(); if (initial) return initial;
    const view = this.doc.defaultView!;
    return new Promise((resolve, reject) => {
      let timer = 0; let poll = 0; let settled = false;
      const finish = (err?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        // Page and userscript sandboxes can have independent timer IDs. Pair
        // cleanup with the same window that created these timers.
        observer.disconnect(); view.clearTimeout(timer); view.clearInterval(poll);
        err ? reject(err) : resolve(value!);
      };
      const observer = new view.MutationObserver(() => {
        if (settled) return;
        try { const value = fn(); if (value) finish(undefined, value); } catch (err) { finish(err); }
      });
      observer.observe(this.doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      // A delayed SPA route can finish without a DOM mutation in the observed
      // document; polling is a recovery path, not a substitute for conditions.
      poll = view.setInterval(() => {
        if (settled) return;
        try { const value = fn(); if (value) finish(undefined, value); } catch (err) { finish(err); }
      }, 250) as unknown as number;
      timer = view.setTimeout(() => finish(new AdapterError('TIMEOUT', `${step}：等待页面条件超时，未确认结果`)), timeout) as unknown as number;
    });
  }

  private identityFromSession(app: string): Identity | undefined {
    try {
      const raw = this.doc.defaultView?.sessionStorage.getItem(SESSION_IDENTITY + app);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Identity;
      if (!parsed?.publisherId || !parsed?.appId || !parsed?.appName) return undefined;
      return parsed;
    } catch { return undefined; }
  }
  private saveIdentity(identity: Identity, app: string): void {
    try { this.doc.defaultView?.sessionStorage.setItem(SESSION_IDENTITY + app, JSON.stringify(identity)); } catch { /* storage unavailable is not fatal */ }
  }
  async identify(): Promise<Identity> {
    const loc = this.doc.location;
    if (loc && /accounts\.google\.com$/.test(loc.hostname)) throw new AdapterError('LOGIN', '登录已失效，请在原浏览器恢复登录');
    const app = routeAppId(this.doc);
    if (!app) throw new AdapterError('IDENTITY', '当前 URL 中没有可确认的应用路由；请进入目标应用的广告单元页面');
    // The AdMob shell is an SPA: at document-idle the app header, sidebar and
    // grid may not have rendered yet. Wait for one identity source instead of
    // failing immediately and requiring a manual re-identify.
    const snapshot = await this.wait(() => {
      const appName = appNameFromPage(this.doc);
      if (!appName) return undefined;
      const appIdTextValue = appIdText(this.doc);
      const unit = firstUnit(this.doc);
      const cached = (this.onCreateRoute() ? this.openingIdentity : undefined) ?? this.identityFromSession(app);
      const cacheUsable = !!cached && cached.appName === appName && cached.appId.endsWith(`~${app}`);
      if (!appIdTextValue && !unit && !cacheUsable) return undefined;
      return { appName, appIdTextValue, unit, cached: cacheUsable ? cached : undefined };
    }, '等待当前应用身份');
    const { appName, appIdTextValue, unit, cached } = snapshot;
    let publisherId: string | undefined;
    let appId: string | undefined;
    if (appIdTextValue) {
      const match = appIdTextValue.match(APP_RX);
      if (!match || match[2] !== app) throw new AdapterError('IDENTITY', '当前 App ID 与当前应用路由不一致');
      publisherId = `pub-${match[1]}`; appId = appIdTextValue;
    } else if (unit) {
      const unitMatch = unit.match(UNIT_RX);
      if (unitMatch) { publisherId = `pub-${unitMatch[1]}`; appId = `ca-app-pub-${unitMatch[1]}~${app}`; }
    } else if (cached) {
      publisherId = cached.publisherId; appId = cached.appId;
    }
    if (!publisherId || !appId || !PUBLISHER_RX.test(publisherId) || !appId.startsWith(`ca-app-${publisherId}~`)) {
      throw new AdapterError('IDENTITY', '当前页面没有可核对的发布商 ID 或广告位 ID；请回广告单元列表重新识别');
    }
    if (!appId.endsWith(`~${app}`)) throw new AdapterError('IDENTITY', 'App ID 与当前应用路由不一致');
    const identity: Identity = {
      publisherId, appId, appName,
      currency: 'USD',
      evidence: [
        `当前应用路由 ${app}`,
        `当前页面应用名称「${appName}」`,
        appIdTextValue ? '应用设置页显式 App ID' : unit ? '广告位 ID 的发布商前缀与当前应用路由' : '已核对的应用路由、页面应用名称与同一执行页的身份记录',
        '底价币种采用用户已确定的批次 USD 配置，不代表页面字段实测币种',
      ],
    };
    this.saveIdentity(identity, app);
    return identity;
  }

  async identifyCreatePage(expected: Identity): Promise<Identity> {
    const app = this.targetListApp(expected);
    await this.wait(() => {
      if (!this.onCreateRoute() || routeAppId(this.doc) !== app) throw new AdapterError('IDENTITY', '执行页未进入目标应用的创建页');
      const name = appNameFromPage(this.doc);
      if (!name || !this.formatCards().length) return undefined;
      if (name !== expected.appName) throw new AdapterError('IDENTITY', '创建页应用名称与主控不一致');
      return true;
    }, '等待目标应用的广告格式选择页');
    // The format picker has no publisher ID. Bind its observed app to the
    // confirmed controller identity. Any ID rendered on the page takes priority.
    this.openingIdentity = expected;
    try {
      const actual = await this.identify();
      if (actual.appId !== expected.appId || actual.publisherId !== expected.publisherId) throw new AdapterError('IDENTITY', '创建页身份与主控不一致');
      return actual;
    } finally { this.openingIdentity = undefined; }
  }

  async assertIdentity(identity: Identity): Promise<void> {
    const current = await this.identify();
    if (current.publisherId !== identity.publisherId || current.appId !== identity.appId) throw new AdapterError('IDENTITY', '当前发布商或应用与批次不一致，整批暂停');
  }

  grid(): Element | undefined {
    const grids = elements(this.doc, 'div.ess-table-canvas[role="grid"], [role="grid"]').filter((e) => /广告单元/.test(e.getAttribute('aria-label') || ''));
    if (grids.length > 1) throw new AdapterError('STRUCTURE', '当前页面存在多个广告单元列表');
    return grids[0];
  }
  private onListRoute(): boolean { return /\/adunits\/list\/?$/.test(this.doc.defaultView?.location.pathname || ''); }
  private onCreateRoute(): boolean { return /^\/v2\/apps\/\d{10}\/adunits\/create\/?$/.test(this.doc.location.pathname); }
  private canRouteWithinDocument(): boolean {
    return this.doc.location.protocol === 'https:' && ['admob.google.com', 'apps.admob.com'].includes(this.doc.location.hostname);
  }
  private async routeWithinDocument(path: string, ready: () => boolean, step: string, timeout = 4000, replace = false): Promise<void> {
    if (!this.canRouteWithinDocument() || !/^\/v2\/apps\/\d{10}\/adunits\/(?:list|\d{10}\/edit)$/.test(path)) {
      throw new AdapterError('STRUCTURE', '不能导航到未经核对的应用或广告单元路径');
    }
    const view = this.doc.defaultView!;
    // This is the platform's observed SPA history path: no document reload,
    // worker restart, iframe or new submission is involved.
    if (view.location.pathname !== path) {
      if (replace) view.history.replaceState(view.history.state, '', path);
      else view.history.pushState(view.history.state, '', path);
    }
    view.dispatchEvent(new view.PopStateEvent('popstate', { state: view.history.state }));
    await this.wait(() => view.location.pathname === path && ready(), step, timeout);
  }
  private targetListApp(expected?: Identity): string {
    const current = routeAppId(this.doc);
    const requested = expected?.appId.match(APP_RX);
    if (expected && (!requested || !PUBLISHER_RX.test(expected.publisherId) || `pub-${requested[1]}` !== expected.publisherId)) {
      throw new AdapterError('IDENTITY', '目标应用或发布商 ID 无效，未导航');
    }
    const app = requested?.[2] || current;
    if (!app) throw new AdapterError('IDENTITY', '无法确认目标应用，不能从应用总览猜测返回路径');
    if (current && current !== app) throw new AdapterError('IDENTITY', '当前页面是其他应用，未切换应用或执行提交');
    return app;
  }
  private listReady(app: string): boolean {
    if (!this.onListRoute() || routeAppId(this.doc) !== app || !this.grid()) return false;
    // AdMob retains the prior list behind editors. The URL and that old grid
    // alone must not certify a completed SPA transition.
    if (elements(this.doc, 'format-creator, .instructions-container .instructions').length
      || elements(this.doc, 'h1,h2').some(heading => /^(创建|修改)广告单元/.test(fieldText(heading)))
      || elements(this.doc, 'div.header[aria-label="广告单元 ID"], [role="heading"][aria-label="广告单元 ID"]').length) return false;
    const add = elements(this.doc, 'material-button,button,[role="button"]').filter(control =>
      sameLabel(accessibleName(control), ZH.add) || sameLabel(fieldText(control), ZH.add));
    // A usable list with competing Add actions must fail before navigation
    // can rerender away the ambiguity and accidentally authorize a choice.
    if (add.length > 1) one(add, '添加广告单元入口');
    return !!this.searchInput() && add.length === 1;
  }
  async home(expected?: Identity): Promise<void> {
    await this.backToList(expected);
    if (expected) await this.assertIdentity(expected);
    const search = this.searchInput();
    if (search?.value.trim()) {
      await this.setInput(search, '', '清空广告单元搜索');
      await this.wait(() => !(this.searchInput()?.value.trim()), '等待清空广告单元搜索', 10000).catch(() => undefined);
    }
  }

  private footerText(): string {
    const grid = this.grid();
    const scopes = [grid?.closest('main,[role="main"]'), grid?.parentElement, this.doc.body];
    for (const scope of scopes) {
      const found = txt(scope).match(/第\s*\d+\s*-\s*\d+\s*行[，,]\s*共\s*\d+\s*行/)?.[0];
      if (found) return found;
    }
    return '';
  }
  private pageInfo(): { start: number; end: number; total: number } | undefined {
    const match = this.footerText().match(/第\s*(\d+)\s*-\s*(\d+)\s*行[，,]\s*共\s*(\d+)\s*行/);
    return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : undefined;
  }
  private searchInput(): HTMLInputElement | undefined {
    const grid = this.grid();
    const scopes = [grid?.closest('main,[role="main"]'), this.doc];
    for (const scope of scopes) {
      if (!scope) continue;
      const input = elements(scope, 'input').find((e) => /广告单元名称/.test(accessibleName(e)) || /广告单元名称/.test((e as HTMLInputElement).placeholder || ''));
      if (input) return input as HTMLInputElement;
    }
    return undefined;
  }
  private searchValue(): string { return this.searchInput()?.value.trim() || ''; }
  private rows(): Element[] {
    const grid = this.grid();
    if (!grid) return [];
    return elements(grid, 'div.particle-table-row[role="row"]').filter((row) => row.querySelector('ess-cell[essfield="ad-unit-with-id-info"]'));
  }
  private rowInfo(row: Element): { name: string; unitId: string; format?: AdFormat; href?: string } | undefined {
    const cell = row.querySelector('ess-cell[essfield="ad-unit-with-id-info"]');
    const link = cell?.querySelector('a[href*="/adunits/"]') as HTMLAnchorElement | null;
    const name = fieldText(link, true) || fieldText(cell?.querySelector('ad-unit-with-id-cell')?.firstElementChild, true);
    const unitId = txt(cell).match(ANY_UNIT_RX)?.[0];
    const formatText = txt(row.querySelector('ess-cell[essfield="ad-unit-format"]'));
    if (!name || !unitId) return undefined;
    return { name, unitId, format: formatFromCell(formatText), href: link?.href };
  }
  private async waitPageChange(previous: string, step: string): Promise<void> {
    await this.wait(() => {
      const rows = this.rows();
      return rows.length && rows.map(txt).join('\n') !== previous;
    }, step);
  }

  private savedField(label: string): string | undefined {
    const values: string[] = [];
    const readableReferencedDescription = (element: Element): boolean => {
      // The observed saved editor marks its displayed summaries aria-hidden
      // to avoid duplicate announcements; a visible header explicitly points
      // to them with aria-describedby. This exception applies only to that
      // description's own aria-hidden, never to controls or hidden ancestors.
      if (!element.isConnected || !element.matches('.panel-description') || element.closest('[hidden],inert')) return false;
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (node !== element && node.getAttribute('aria-hidden') === 'true') return false;
        const style = element.ownerDocument.defaultView?.getComputedStyle(node);
        if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
      }
      return true;
    };
    const add = (element: Element | null | undefined, explicitlyReferenced = false): void => {
      if (!element || !(visible(element) || (explicitlyReferenced && readableReferencedDescription(element)))) return;
      const value = fieldText(element, label === '广告单元名称');
      if (!value) return;
      if (label === '广告单元 ID') {
        const ids = [...new Set(value.match(/ca-app-pub-\d{16}\/\d{10}/g) || [])];
        values.push(...ids);
      } else values.push(value);
    };
    for (const header of elements(this.doc, 'div.header[aria-label], [role="heading"][aria-label]')) {
      if (!sameLabel(header.getAttribute('aria-label') || '', [label])) continue;
      for (const id of (header.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)) {
        const value = this.doc.getElementById(id);
        add(value, true);
      }
      const description = header.querySelector('.panel-description');
      add(description);
    }
    // The live saved-value editor uses label containers (.panel-name /
    // .collapsed-title) with the value in the same header or following sibling.
    // Never read an arbitrary enclosing panel or the whole document: AdMob
    // retains the old list behind editors, including other units' IDs/floors.
    const labels = elements(this.doc, '.panel-name, .collapsed-title, [class*="panel-title"], div.header')
      .filter((e) => sameLabel(txt(e), [label]));
    for (const e of labels) {
      const candidates: (Element | null | undefined)[] = [
        e.closest('div.header')?.querySelector('.panel-description'),
        e.nextElementSibling?.matches('.panel-description') ? e.nextElementSibling : undefined,
        e.parentElement?.nextElementSibling?.matches('.panel-description') ? e.parentElement.nextElementSibling : undefined,
      ];
      candidates.forEach(candidate => add(candidate));
    }
    const distinct = [...new Set(values)];
    if (distinct.length > 1) throw new AdapterError('VERIFY', `保存后字段“${label}”出现多个不同值，不能确认同一广告单元的配置`);
    return distinct[0];
  }
  private savedFloor(raw: string | undefined): { mode: string; floor?: string; currency: string; verified: boolean } {
    if (!raw) return { mode: 'unknown', currency: 'unknown', verified: false };
    if (/已停用/.test(raw) && !/人工指定底价|Google\s*优化|动态底价/.test(raw)) return { mode: 'disabled', currency: '', verified: true };
    if (/Google\s*优化|动态底价/.test(raw) && !/已停用|人工指定底价|全球底价设为/.test(raw)) return { mode: 'auto', currency: '', verified: true };
    // Saved summaries may group thousands ("$1,000.00"). Capture the whole
    // numeric token before validating so malformed grouping cannot verify as
    // a valid prefix such as 1 or 10. User-entered decimals remain strict.
    const amount = raw.match(/[+-]?[\d.,][\d.,\s]*(?:[eE][+-]?\d+)?/)?.[0].trim();
    const floor = amount ? displayedDecimal(amount) : undefined;
    const manual = /全球底价设为|人工指定底价/.test(raw);
    // USD comes from the user-confirmed batch configuration. No session token
    // or separate form visit is needed to interpret AdMob's "$" summary.
    const currency = OTHER_CURRENCY.test(raw) ? 'other' : 'USD';
    const verified = manual && !!floor && currency === 'USD';
    return { mode: manual ? 'manual' : 'unknown', floor, currency, verified };
  }

  private async findRowLink(href: string): Promise<Element> {
    const first = elements(this.doc, '[aria-label="转到首页"], [aria-label="转到第一页"]').filter(enabled);
    if (first.length === 1) {
      const previous = this.rows().map(txt).join('\n');
      click(first[0], '返回列表第一页');
      await this.waitPageChange(previous, '等待列表第一页');
    }
    for (let pages = 0; pages < 200; pages++) {
      const links = elements(this.doc, 'a[href]').filter((e) => (e as HTMLAnchorElement).href === href);
      if (links.length === 1) return links[0];
      if (links.length > 1) throw new AdapterError('STRUCTURE', '广告单元详情入口不唯一，已停止');
      const next = elements(this.doc, '[aria-label="转到下一页"], [aria-label="下一页"]');
      if (next.length !== 1 || !enabled(next[0])) break;
      const previous = this.rows().map(txt).join('\n');
      click(next[0], '查找广告单元详情');
      await this.waitPageChange(previous, '等待下一页列表');
    }
    throw new AdapterError('STRUCTURE', '列表中找不到已记录的广告单元详情入口');
  }
  private async readUnitDetail(identity: Identity, href: string, expected: { name: string; unitId: string; format?: AdFormat }): Promise<Partial<Actual>> {
    click(await this.findRowLink(href), '打开广告单元详情');
    await this.wait(() => !this.onListRoute() && !this.activeForm() && this.savedField('广告单元 ID'), '等待广告单元详情');
    await this.assertIdentity(identity);
    const unitId = this.savedField('广告单元 ID');
    const name = this.savedField('广告单元名称');
    const formatText = this.savedField('广告格式');
    const floorText = this.savedField('有效每千次展示费用底价');
    const parsed = this.savedFloor(floorText);
    const actual: Partial<Actual> = {
      publisherId: identity.publisherId, appId: identity.appId,
      name, unitId: unitId || expected.unitId,
      format: formatFrom(formatText), mode: parsed.mode,
      floor: parsed.floor, currency: parsed.currency,
      verified: false,
    };
    if (!unitId || unitId !== expected.unitId) throw new AdapterError('VERIFY', '详情页广告位 ID 与列表不一致，不能合并两个单元的配置', true, actual);
    if (!name || name !== expected.name) throw new AdapterError('VERIFY', '详情页名称缺失或与列表不一致', true, actual);
    if (!actual.format || actual.format !== expected.format) throw new AdapterError('VERIFY', '详情页格式缺失或与列表不一致', true, actual);
    actual.verified = parsed.verified;
    await this.backToList(identity);
    return actual;
  }
  private async backToList(expected?: Identity): Promise<void> {
    const view = this.doc.defaultView!;
    const app = this.targetListApp(expected);
    const waitForList = async (): Promise<void> => {
      // AdMob can switch to /list before mounting its grid, including after a
      // successful history return. Missing sidebar links do not negate that
      // in-progress navigation. Retain the known list route while it loads.
      try { await this.wait(() => this.listReady(app), '等待广告单元列表内容就绪'); }
      catch (error) {
        if (this.listReady(app)) return;
        if (!this.onListRoute() || routeAppId(this.doc) !== app) throw error;
        try { await this.wait(() => this.listReady(app), '等待已返回的广告单元列表内容就绪'); }
        catch (finalError) { if (this.listReady(app)) return; throw finalError; }
      }
    };
    if (this.listReady(app)) return;
    if (this.canRouteWithinDocument()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Returning to a known application is independent of history depth.
          // A delayed/background route gets one new SPA signal, not another
          // history Back or a page reload which could lose the worker.
          await this.routeWithinDocument(`/v2/apps/${app}/adunits/list`, () => this.listReady(app), '打开目标应用广告单元列表', this.timeout, true);
          return;
        } catch (error) {
          // Timers can become runnable together after a browser interruption.
          // Observe current DOM before treating that queued deadline as final.
          if (this.listReady(app)) return;
          if (!this.onListRoute() || routeAppId(this.doc) !== app
            || !(error instanceof AdapterError) || error.code !== 'TIMEOUT' || attempt === 1) throw error;
        }
      }
    }
    if (this.onListRoute()) { await waitForList(); return; }
    // Finish only an explicitly observed creation receipt. Never use a
    // generic create-form back/submit button as a completion action.
    if (this.creationReceipt()) {
      const complete = elements(this.doc, 'material-button,button,[role="button"],a[href]').filter(control =>
        enabled(control) && ['完成', '返回广告单元列表', '转到广告单元列表'].some(label =>
          sameLabel(accessibleName(control), [label]) || sameLabel(fieldText(control), [label])));
      if (complete.length > 1) throw new AdapterError('STRUCTURE', '创建完成后的返回入口不唯一，未操作');
      if (complete.length === 1) {
        click(complete[0], '完成并返回广告单元列表');
        try { await waitForList(); return; } catch { /* observed history remains a fallback */ }
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      // The create route keeps the previous list grid mounted behind the
      // editor, so grid presence alone is not evidence that the list is the
      // active route. Require the list URL before reading pagination.
      this.targetListApp(expected);
      if (this.onListRoute()) { await waitForList(); return; }
      const previous = view.location.href;
      let popped = false;
      const returned = (): void => { popped = true; };
      view.addEventListener('popstate', returned);
      try {
        view.history.back();
        await this.wait(() => popped || this.onListRoute() || view.location.href !== previous, '等待返回广告单元列表路由');
      } catch { /* try another history step or the observed list link */ }
      finally { view.removeEventListener('popstate', returned); }
      const current = routeAppId(this.doc);
      if (current !== app) throw new AdapterError('IDENTITY', '返回路径已离开目标应用，停止历史回退');
      if (this.onListRoute()) { await waitForList(); return; }
      const link = elements(this.doc, 'material-list-item[href],a[href]').find(control => {
        try { const url = new URL(control.getAttribute('href')!, this.doc.location.href); return url.origin === view.location.origin && url.pathname === `/v2/apps/${app}/adunits/list`; }
        catch { return false; }
      });
      if (link) {
        click(link, '返回广告单元列表');
        await waitForList();
        return;
      }
    }
    throw new AdapterError('STRUCTURE', '无法返回广告单元列表；未提交任何变更');
  }

  private async awaitSearchRows(value: string, timeout = 15000): Promise<{ rows: Element[]; page?: { start: number; end: number; total: number } }> {
    try { this.grid()?.scrollIntoView({ block: 'start', inline: 'nearest' }); } catch { /* scroll is best effort */ }
    const rendered = await this.wait(() => {
      if (this.searchInput()?.value.trim() !== value) return undefined;
      const rows = this.rows(); const page = this.pageInfo();
      return rows.length > 0 || (page && page.total === 0) ? true : undefined;
    }, '等待筛选结果行', timeout).catch(() => false);
    if (!rendered) {
      try { this.grid()?.scrollIntoView({ block: 'start', inline: 'nearest' }); } catch { /* best effort */ }
      await this.sleep(700);
    }
    return { rows: this.rows(), page: this.pageInfo() };
  }
  async lookup(identity: Identity, name: string): Promise<Lookup> {
    await this.assertIdentity(identity);
    await this.home(identity);
    if (!this.onListRoute() || !this.grid()) return { complete: false, matches: [], reason: '无法返回广告单元列表，未提交任何变更' };
    // The grid can render before the footer/pagination controls. Wait for the
    // explicit total before claiming anything about list completeness.
    await this.wait(() => this.pageInfo(), '等待广告单元列表总数', 15000).catch(() => undefined);
    // The live table only renders a subset of a 48-row page; filtering by the
    // exact name narrows the result set so every matching row is rendered and
    // the footer total describes the checked subset.
    const search = this.searchInput();
    if (!search) return { complete: false, matches: [], reason: '未找到广告单元搜索框，无法完成同名查重' };
    await this.setInput(search, name, '按名称搜索广告单元');
    const filtered = await this.awaitSearchRows(name);
    if (this.searchInput()?.value.trim() !== name) return { complete: false, matches: [], reason: '广告单元搜索条件未生效，不能证明查重完整' };
    if (filtered.page?.total === 0) return { complete: true, matches: [] };
    if (!filtered.rows.length) return { complete: false, matches: [], reason: `按名称搜索返回 ${filtered.page?.total ?? '?'} 条，但当前未渲染出广告单元行；AdMob 允许重名，不阻止创建` };
    // The real Chinese pagination exposes only previous/next/end buttons; the
    // "转到首页" aria-label belongs to the site breadcrumb, not the table.
    // Walk backwards until previous is disabled so a cached last page cannot be
    // mistaken for a complete scan.
    let resetClicks = 0;
    for (let guard = 0; guard < 200; guard++) {
      const back = elements(this.doc, '[aria-label="转到上一页"], [aria-label="上一页"]').filter(enabled);
      if (back.length > 1) return { complete: false, matches: [], reason: '列表上一页控件不唯一' };
      if (back.length === 0) break;
      const previous = this.rows().map(txt).join('\n');
      click(back[0], '返回列表上一页');
      resetClicks++;
      await this.waitPageChange(previous, '等待列表上一页');
      await this.wait(() => this.pageInfo(), '等待分页总数', 5000).catch(() => undefined);
    }
    const resetPage = this.pageInfo();
    if (resetPage && resetPage.start !== 1) return { complete: false, matches: [], reason: '无法返回广告单元列表第一页，不能证明查重完整' };
    const matches: { match: Partial<Actual>; href?: string }[] = [];
    const seen = new Set<string>();
    let counted = 0; let total: number | undefined;
    for (let pages = 0; pages < 200; pages++) {
      await this.assertIdentity(identity);
      const rows = this.rows();
      const page = this.pageInfo();
      if (page && page.total === 0) return { complete: true, matches: [] };
      if (!rows.length && !page) return { complete: false, matches: [], reason: '列表为空但未声明总行数，不能证明完整' };
      const signature = rows.map(txt).join('\n');
      if (seen.has(signature)) return { complete: false, matches: matches.map((x) => x.match), reason: '列表分页重复或未更新' };
      seen.add(signature); counted += rows.length;
      const info = this.pageInfo();
      if (info) total = info.total;
      for (const row of rows) {
        const infoRow = this.rowInfo(row);
        if (!infoRow || infoRow.name !== name) continue;
        matches.push({ href: infoRow.href, match: { publisherId: identity.publisherId, appId: identity.appId, name, unitId: infoRow.unitId, format: infoRow.format, mode: 'manual', floor: undefined, currency: 'unknown', verified: false } });
      }
      if (total !== undefined && counted >= total) break;
      const next = elements(this.doc, '[aria-label="转到下一页"], [aria-label="下一页"]');
      if (next.length !== 1 || !enabled(next[0])) return { complete: false, matches: matches.map((x) => x.match), reason: `缺少可核对的列表总数或下一页控件，不能证明分页完整（路由 ${this.doc.defaultView?.location.pathname || '?'}，回退 ${resetClicks} 次至第 ${resetPage?.start ?? '?'} 页，本页 ${rows.length} 行，累计 ${counted}/${total ?? '?'}，下一页 ${next.length}/${next[0] ? enabled(next[0]) : '?'}）` };
      const previous = signature;
      click(next[0], '下一页');
      await this.waitPageChange(previous, '等待下一页列表');
      await this.wait(() => this.pageInfo(), '等待分页总数', 5000).catch(() => undefined);
    }
    if (total === undefined) return { complete: false, matches: matches.map((x) => x.match), reason: '列表没有声明总行数，不能证明结果完整' };
    if (counted !== total) return { complete: false, matches: matches.map((x) => x.match), reason: '列表总数与已读取行数不一致' };
    // Enrich same-name rows by reading the read-only detail page. The list
    // itself does not show floor/mode/currency.
    const detailed: Partial<Actual>[] = [];
    for (const found of matches) {
      if (!found.href) { detailed.push({ ...found.match, verified: false }); continue; }
      try {
        detailed.push(await this.readUnitDetail(identity, found.href, { name, unitId: found.match.unitId!, format: found.match.format }));
      } catch (error) {
        if (error instanceof AdapterError && error.code === 'VERIFY') { detailed.push({ ...found.match, ...error.actual, verified: false }); continue; }
        return { complete: false, matches: detailed, reason: (error as Error).message };
      }
    }
    return { complete: true, matches: detailed };
  }

  activeForm(): Element | undefined {
    // The shell heading can arrive after preparation. Keep the validated real
    // creator as the same form identity before and after that shell update.
    const roots = elements(this.doc, 'format-creator');
    if (roots.length) {
      if (!/\/adunits\/create\/?$/.test(this.doc.location.pathname)) return undefined;
      const formats = elements(this.doc, 'div.format-label');
      if (formats.length !== 1 || !formatFrom(txt(formats[0]))) return undefined;
      const creators = roots.filter(root =>
        elements(root, 'ad-unit-form').length === 1
        && labelledInputs(root, ['输入广告单元名称', '广告单元名称']).length === 1
        && elements(root, 'material-button.btn-yes, [role="button"]').filter(button => sameLabel(txt(button), ['创建广告单元'])).length === 1);
      if (creators.length > 1) throw new AdapterError('STRUCTURE', '创建广告单元表单不唯一，已停止');
      return creators[0];
    }
    if (this.formatCards().length) return undefined;
    // Preserve the observed legacy titled form when there is no real creator.
    const title = elements(this.doc, 'h1,h2').find((e) => /创建广告单元/.test(txt(e)));
    if (title) return title.closest('main,[role="main"],form') || this.doc.body;
    return undefined;
  }
  private nameInput(scope: ParentNode): HTMLInputElement {
    const inputs = elements(scope, 'material-input:not([type]) input[aria-labelledby], material-input:not([type="money64"]) input');
    const named = inputs.filter((e) => containsLabel(accessibleName(e), ['输入广告单元名称', '广告单元名称']));
    return one(named.length ? named : inputs, '广告单元名称输入框') as HTMLInputElement;
  }
  private formatLabel(): string | undefined {
    return txt(this.doc.querySelector('div.format-label')) || undefined;
  }
  private partnerCheckbox(form: Element): Element | undefined {
    const cards = elements(form, 'third-party-bidding-card');
    if (!cards.length) return undefined;
    const card = one(cards, '合作平台出价组件');
    const controls = elements(card, '[role="checkbox"], input[type="checkbox"]').filter(control =>
      sameLabel(accessibleName(control), [PARTNER_BIDDING_LABEL, '合作平台出价'])
      || sameLabel(fieldText(control.querySelector('.bidding-headline')), [PARTNER_BIDDING_LABEL]));
    return one(controls, '合作平台出价复选框');
  }
  private partnerChecked(control: Element): boolean {
    if (control.tagName === 'INPUT') return (control as HTMLInputElement).checked;
    const checked = control.getAttribute('aria-checked');
    if (checked !== 'true' && checked !== 'false') throw new AdapterError('STRUCTURE', '合作平台出价状态无法读回，未执行提交');
    return checked === 'true';
  }
  private async setPartnerBidding(form: Element, expected: boolean, checkpoint: () => Promise<void>): Promise<boolean> {
    const control = this.partnerCheckbox(form);
    if (!control) {
      if (expected) throw new AdapterError('ROW', '当前广告格式没有可确认的合作平台出价复选框，不能启用此设置', false);
      return false;
    }
    if (this.partnerChecked(control) !== expected) {
      await checkpoint();
      click(control, expected ? '启用合作平台出价' : '关闭合作平台出价');
      await this.wait(() => {
        const current = this.partnerCheckbox(form);
        return !!current && this.partnerChecked(current) === expected;
      }, '回读合作平台出价');
    }
    return true;
  }
  private assertPartnerBidding(form: Element, expected: boolean, previouslyPresent: boolean): void {
    const control = this.partnerCheckbox(form);
    if (!control) {
      if (expected || previouslyPresent) throw new AdapterError('STRUCTURE', '提交前合作平台出价控件缺失，未执行提交');
      return;
    }
    if (this.partnerChecked(control) !== expected) throw new AdapterError('STRUCTURE', '提交前合作平台出价状态发生变化，未执行提交');
  }
  private assertSavedPartnerBidding(expected: boolean, actual: Partial<Actual>): void {
    let value: string | undefined;
    try { value = this.savedField('合作平台出价'); }
    catch (error) {
      if (error instanceof AdapterError) error.actual = { ...actual, ...error.actual };
      throw error;
    }
    const enabled = value && sameLabel(value, ['已启用', '启用', '是']);
    const disabled = value && sameLabel(value, ['已停用', '停用', '未启用', '否']);
    if (enabled || disabled) actual.partnerBidding = !!enabled;
    if ((value !== undefined && !enabled && !disabled) || (actual.partnerBidding !== undefined && actual.partnerBidding !== expected)
      || (expected && actual.partnerBidding === undefined)) {
      throw new AdapterError('VERIFY', '保存后合作平台出价状态缺失、无法识别或与请求不一致，保留 ID 待核验', true, actual);
    }
  }
  private assertPlatformDefaults(form: Element): void {
    // These per-format labels/states were read from the six live forms.
    // Bidding-only flows may remove advanced cards. Never invent a missing
    // setting or mutate unrelated checkboxes/toggles to simulate a default.
    const format = formatFrom(this.formatLabel());
    this.assertRewardDefaults(form, format);
    const expectedMedia = format ? MEDIA_DEFAULTS[format] : DEFAULT_MEDIA_TYPES;
    const mediaCards = elements(form, 'ad-media-type-card');
    if (mediaCards.length > 1) throw new AdapterError('STRUCTURE', '广告类型组件不唯一，无法核对默认设置');
    for (const card of mediaCards) {
      const controls = elements(card, '[role="checkbox"], input[type="checkbox"]');
      const labelled = (control: Element, label: string): boolean =>
        sameLabel(accessibleName(control), [label]) || sameLabel(fieldText(control), [label]);
      if (controls.some(control => !expectedMedia.some(label => labelled(control, label)))) {
        throw new AdapterError('STRUCTURE', '广告类型包含当前格式未识别的选项，无法核对默认设置');
      }
      for (const label of expectedMedia) {
        const choice = one(controls.filter(control => labelled(control, label)), `默认广告类型“${label}”`);
        const checked = choice.tagName === 'INPUT' ? (choice as HTMLInputElement).checked : choice.getAttribute('aria-checked') === 'true';
        if (!checked) throw new AdapterError('STRUCTURE', `广告类型“${label}”未启用，未执行提交`);
      }
    }
    const frequencyCards = elements(form, 'frequency-cap-card');
    if (frequencyCards.length > 1) throw new AdapterError('STRUCTURE', '频次上限组件不唯一，无法核对默认设置');
    for (const card of frequencyCards) {
      const control = one(elements(card, '[role="switch"]'), '频次上限开关');
      if (control.getAttribute('aria-checked') !== 'false') throw new AdapterError('STRUCTURE', '频次上限未停用，未执行提交');
    }
  }
  private assertRewardDefaults(form: Element, format: AdFormat | undefined): void {
    const cards = elements(form, 'reward-settings-card');
    const rewarded = format === 'rewarded' || format === 'rewarded-interstitial';
    if (!rewarded) {
      if (cards.length) throw new AdapterError('STRUCTURE', '当前广告格式出现不适用的奖励设置，未执行提交');
      return;
    }
    // A bidding-only form may remove all advanced/default cards. Otherwise
    // both rewarded formats must preserve the observed 1 / Reward defaults.
    if (!cards.length) {
      const bidding = this.partnerCheckbox(form);
      if (bidding && this.partnerChecked(bidding)) return;
    }
    const card = one(cards, '奖励设置组件');
    const inputs = elements(card, 'input,textarea');
    const amount = one(inputs.filter(input => sameLabel(accessibleName(input), ['输入奖品数量'])), '奖励数量输入框') as HTMLInputElement;
    const item = one(inputs.filter(input => sameLabel(accessibleName(input), ['输入奖品'])), '奖励奖品输入框') as HTMLInputElement;
    if (amount.value !== REWARD_DEFAULT.amount || amount.getAttribute('aria-invalid') === 'true' || !amount.validity.valid
      || item.value !== REWARD_DEFAULT.item || item.getAttribute('aria-invalid') === 'true' || !item.validity.valid) {
      throw new AdapterError('STRUCTURE', `${FORMAT_PAGE[format!]}的奖励设置与平台默认“${REWARD_DEFAULT.amount} ${REWARD_DEFAULT.item}”不一致或无效，未执行提交`);
    }
  }
  private counter(scope: ParentNode): { current: number; max: number } | undefined {
    const text = txt(scope.querySelector('.counter-container .counter, .counter'));
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);
    return match ? { current: Number(match[1]), max: Number(match[2]) } : undefined;
  }
  private errorText(scope: ParentNode): string {
    return elements(scope, '.error-text').filter((e) => !e.classList.contains('hidden')).map(txt).filter(Boolean).join('；');
  }

  async setInput(input: HTMLInputElement, value: string, step: string): Promise<void> {
    if (!enabled(input) || input.readOnly) throw new AdapterError('STRUCTURE', `${step}：输入控件不可编辑`);
    const view = input.ownerDocument.defaultView!;
    input.focus();
    try { input.select(); } catch { /* selection may be blocked in a background tab */ }
    let inserted = false;
    try { inserted = input.ownerDocument.execCommand('insertText', false, value); } catch { inserted = false; }
    if (!inserted || input.value !== value) {
      const proto = input.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
      input.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      input.dispatchEvent(new view.Event('change', { bubbles: true }));
    }
    await this.sleep(350);
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
    await this.wait(() => inputMatchesValue(input, value), `${step}：等待输入回读`);
    input.blur();
    await this.sleep(250);
    if (!inputMatchesValue(input, value)) throw new AdapterError('ROW', `${step}：页面未接受输入值，未执行提交`, false);
  }

  private formatCards(): Element[] {
    return elements(this.doc, 'section.ad-format-card');
  }

  private async selectFormat(format: AdFormat, identity: Identity): Promise<void> {
    if (!this.onCreateRoute() || !this.formatCards().length) {
      await this.home(identity);
      const add = elements(this.doc, 'material-button[aria-label="添加广告单元"], [role="button"][aria-label="添加广告单元"]');
      click(one(add, '添加广告单元'), '添加广告单元');
      await this.wait(() => this.formatCards().length > 0, '等待广告格式选择');
    }
    const label = FORMAT_PAGE[format];
    const cards = this.formatCards().filter((card) => {
      const title = txt(card.querySelector('.header span') || card.querySelector('.header'));
      return formatFrom(title) === format;
    });
    const card = one(cards, `定位${label}格式卡片`);
    const button = elements(card, 'material-button.select-button, [role="button"]').filter((e) => formatFrom(accessibleName(e)) === format);
    click(one(button, `选择${label}`), `选择${label}`);
    await this.wait(() => this.activeForm(), `等待${label}创建表单`);
  }

  private floorRadio(mode: FloorMode): Element | undefined {
    const groups = elements(this.doc, 'ecpm-settings-controls > material-radio-group');
    const group = groups.length ? one(groups, '底价模式主选项组') : undefined;
    const radios = elements(group || this.doc, '[role="radio"], input[type="radio"]')
      .filter(control => !group || control.closest('material-radio-group') === group);
    const found = radios.filter(control => {
      // The observed Material radio has a decorative radio_button_* icon and
      // an exact label in its direct content div. Secondary optimization
      // groups are not the requested manual/auto/disabled mode controls.
      const content = [...control.children].find(child => child.matches('div.content'));
      const labels = content ? [fieldText(content)] : [accessibleName(control), fieldText(control)];
      for (const id of (control.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) labels.push(fieldText(this.doc.getElementById(id)));
      if (control.tagName === 'INPUT') for (const label of (control as HTMLInputElement).labels || []) labels.push(fieldText(label));
      return ZH[mode].some(label => labels.some(value => sameLabel(value, [label])));
    });
    return found.length ? one(found, '底价模式选项') : undefined;
  }
  private async selectFloorMode(mode: FloorMode, checkpoint?: () => Promise<void>): Promise<void> {
    const advanced = elements(this.doc, 'a.advanced-settings-toggle, [role="button"]').filter((e) => containsLabel(txt(e), ['高级设置']));
    if (advanced.length !== 1) throw new AdapterError('STRUCTURE', '高级设置入口不唯一');
    if ((advanced[0].getAttribute('aria-expanded') || 'false') !== 'true') {
      click(advanced[0], '展开高级设置');
    }
    const radio = await this.wait(() => this.floorRadio(mode), '等待底价模式选项');
    if (checkpoint) await checkpoint();
    click(radio, '选择底价模式');
    await this.wait(() => radio.getAttribute('aria-checked') === 'true' || (radio as HTMLInputElement).checked === true, '回读底价模式');
  }
  private async manualFloorControl(checkpoint?: () => Promise<void>): Promise<{ wrap: Element; input: HTMLInputElement }> {
    await this.selectFloorMode('manual', checkpoint);
    // The real floor component is mounted only after the manual radio is
    // selected; waiting for it before this click times out on the live form.
    const wrap = await this.wait(() => {
      const found = elements(this.doc, 'manual-ecpm-floor-input');
      return found.length ? one(found, '全局底价输入组件') : undefined;
    }, '等待底价输入');
    const label = txt(wrap.querySelector('.global-ecpm-input-label'));
    if (!/全球/.test(label) || !/底价/.test(label)) throw new AdapterError('STRUCTURE', '底价组件不是全局底价，已停止');
    const input = one(elements(wrap, 'input'), '全局底价输入框') as HTMLInputElement;
    if (currencyOf(input) !== 'USD') throw new AdapterError('CURRENCY', '底价控件关联币种不是 USD');
    return { wrap, input };
  }

  async prepare(identity: Identity, format: AdFormat, name: string, floor: string, checkpoint: () => Promise<void>, mode: FloorMode = 'manual', partnerBidding = false): Promise<void> {
    this.prepared = undefined; this.submitted = false;
    await checkpoint(); await this.assertIdentity(identity);
    if (!this.activeForm()) await this.selectFormat(format, identity);
    const form = required(this.activeForm(), '未识别到创建广告单元表单');
    await checkpoint(); await this.assertIdentity(identity);
    const declared = this.formatLabel();
    if (!formatFrom(declared) || formatFrom(declared) !== format) throw new AdapterError('STRUCTURE', `创建表单广告格式“${declared || '未知'}”与请求不一致`);
    const partnerControlPresent = await this.setPartnerBidding(form, partnerBidding, checkpoint);
    const nameInput = this.nameInput(form);
    const counter = this.counter(form.closest('main') || this.doc);
    const maxLength = counter?.max ?? nameInput.maxLength;
    if (maxLength >= 0 && name.length > maxLength) throw new AdapterError('ROW', `名称超过当前页面上限 ${maxLength}，未截断`, false);
    await this.setInput(nameInput, name, '广告单元名称');
    let floorInput: HTMLInputElement | undefined;
    // Partner bidding units have no floor controls. The legacy mode argument
    // remains accepted, but it never selects or implies a floor in this path.
    if (!partnerBidding) {
      if (mode === 'manual') {
        ({ input: floorInput } = await this.manualFloorControl(checkpoint));
        checkConstraints(floorInput, floor);
        await this.setInput(floorInput, normalizeDecimal(floor), '全局底价');
        if (!inputMatchesValue(floorInput, floor)) throw new AdapterError('ROW', '底价输入回读不一致，未执行提交', false);
      } else await this.selectFloorMode(mode, checkpoint);
    }
    const errors = this.errorText(form);
    if (errors) throw new AdapterError('ROW', errors, false);
    if (nameInput.getAttribute('aria-invalid') === 'true' || floorInput?.getAttribute('aria-invalid') === 'true') throw new AdapterError('ROW', '名称或底价未通过页面校验，未执行提交', false);
    const counterAfter = this.counter(form.closest('main') || this.doc);
    if (counterAfter && counterAfter.current !== name.length) throw new AdapterError('ROW', `名称计数回读为 ${counterAfter.current}/${counterAfter.max}，未执行提交`, false);
    const create = elements(this.doc, 'material-button.btn-yes, [role="button"]').filter((e) => sameLabel(txt(e), ['创建广告单元']));
    const createButton = one(create, '创建广告单元按钮');
    if (!enabled(createButton)) throw new AdapterError('ROW', '创建广告单元按钮仍不可用，底价或名称未通过页面校验', false);
    this.assertPlatformDefaults(form);
    this.assertPartnerBidding(form, partnerBidding, partnerControlPresent);
    this.prepared = { identity, format, name, floor: !partnerBidding && mode === 'manual' ? normalizeDecimal(floor) : '', mode, partnerBidding, partnerControlPresent, nameInput, floorInput, form };
  }

  async submit(beforeClick?: () => void): Promise<void> {
    const state = this.prepared;
    if (!state || this.submitted) throw new AdapterError('SUBMIT_GUARD', '当前表单未通过准备或已经执行过提交');
    await this.assertIdentity(state.identity);
    const form = this.activeForm();
    if (!form || form !== state.form) throw new AdapterError('STRUCTURE', '提交前表单被替换，需重新预检');
    const nameInput = this.nameInput(form);
    if (nameInput.value !== state.name) throw new AdapterError('STRUCTURE', '提交前名称发生变化');
    if (!state.partnerBidding) {
      const radio = required(this.floorRadio(state.mode), '提交前缺少底价模式选项');
      if (!(radio.getAttribute('aria-checked') === 'true' || (radio as HTMLInputElement).checked === true)) throw new AdapterError('STRUCTURE', '提交前底价模式发生变化');
      if (state.mode === 'manual') {
        const floorWrap = required(this.doc.querySelector('manual-ecpm-floor-input'), '提交前缺少底价组件');
        const floorInput = required(floorWrap.querySelector('input'), '提交前缺少底价输入');
        if (!inputMatchesValue(floorInput, state.floor)) throw new AdapterError('STRUCTURE', '提交前名称或底价发生变化');
        if (currencyOf(floorInput) !== 'USD') throw new AdapterError('CURRENCY', '提交前底价币种不是 USD');
        checkConstraints(floorInput, state.floor);
      }
    }
    if (formatFrom(this.formatLabel()) !== state.format) throw new AdapterError('STRUCTURE', '提交前广告格式发生变化');
    const create = elements(this.doc, 'material-button.btn-yes, [role="button"]').filter((e) => sameLabel(txt(e), ['创建广告单元']));
    const createButton = one(create, '提交前创建按钮');
    if (!enabled(createButton)) throw new AdapterError('ROW', '提交前创建按钮不可用', false);
    this.assertPlatformDefaults(form);
    this.assertPartnerBidding(form, state.partnerBidding, state.partnerControlPresent);
    // Keep the final storage/permission check synchronous with the native click.
    beforeClick?.();
    this.submitted = true;
    click(createButton, '创建广告单元');
  }

  async verifyById(identity: Identity, unitId: string, name: string, format: AdFormat, floor: string, mode: FloorMode = 'manual', partnerBidding = false): Promise<Actual> {
    await this.assertIdentity(identity);
    if (!UNIT_RX.test(unitId) || !unitId.startsWith(`ca-app-${identity.publisherId}/`)) {
      throw new AdapterError('VERIFY', '已知广告位 ID 与当前发布商不匹配', true, { unitId, publisherId: identity.publisherId, appId: identity.appId });
    }
    const app = identity.appId.match(APP_RX);
    const known = unitId.match(UNIT_RX);
    if (!app || !known || app[1] !== known[1] || `pub-${app[1]}` !== identity.publisherId) throw new AdapterError('IDENTITY', '应用和广告单元的发布商不一致');
    const listPath = `/v2/apps/${app[2]}/adunits/list`;
    let directlyOpened = false;
    if (this.canRouteWithinDocument()) {
      const detailPath = `/v2/apps/${app[2]}/adunits/${known[2]}/edit`;
      let fingerprint = '', firstObserved = 0;
      const settled = (): boolean => {
        if (this.doc.location.pathname !== detailPath || this.activeForm() || this.savedField('广告单元 ID') !== unitId) {
          fingerprint = ''; return false;
        }
        const savedName = this.savedField('广告单元名称'), savedFormat = this.savedField('广告格式');
        const savedFloor = partnerBidding ? undefined : this.savedField('有效每千次展示费用底价');
        if (savedName === undefined || savedFormat === undefined || (!partnerBidding && savedFloor === undefined)) {
          fingerprint = ''; return false;
        }
        const current = JSON.stringify([unitId, savedName, savedFormat, savedFloor]);
        if (current !== fingerprint) { fingerprint = current; firstObserved = Date.now(); return false; }
        return Date.now() - firstObserved >= 200;
      };
      for (let attempt = 0; attempt < 2 && !directlyOpened; attempt++) {
        try {
          await this.routeWithinDocument(detailPath, settled, '按已知 ID 打开保存后配置', this.timeout);
          directlyOpened = true;
        } catch (error) {
          if (settled()) { directlyOpened = true; break; }
          if (!(error instanceof AdapterError) || error.code !== 'TIMEOUT' || attempt === 1) break;
          // Keep the exact readonly target and give the SPA one bounded retry.
          // A different app or unrelated displayed ID never becomes proof.
          this.targetListApp(identity);
        }
      }
    }
    if (!directlyOpened) {
      await this.home(identity);
      const search = this.searchInput();
      if (!search) throw new AdapterError('VERIFY', '未找到广告单元搜索框，无法按已知 ID 核验');
      await this.setInput(search, unitId, '按已知广告位 ID 搜索');
      try { this.grid()?.scrollIntoView({ block: 'start', inline: 'nearest' }); } catch { /* best effort */ }
    // The input changes before AdMob finishes filtering. Old unrelated rows
    // and an old zero-total footer are not evidence that this ID is absent.
      const matches = await this.wait(() => {
      if (this.searchInput()?.value.trim() !== unitId) return undefined;
      const exact = this.rows().filter((candidate) => this.rowInfo(candidate)?.unitId === unitId);
      return exact.length ? exact : undefined;
    }, '等待已知广告位 ID 搜索结果', 20000).catch((error: unknown) => {
      if (error instanceof AdapterError && error.code === 'TIMEOUT') return [] as Element[];
      throw error;
    });
      if (matches.length !== 1) throw new AdapterError('VERIFY', '按已知广告位 ID 未找到唯一记录', true, { unitId, publisherId: identity.publisherId, appId: identity.appId });
      const row = matches[0];
    // New units expose the name as an SPA row control; an <a href> is not
    // guaranteed. Clicking the named cell is the same user path as opening the
    // saved edit page and avoids guessing a URL.
      const cell = row.querySelector('ess-cell[essfield="ad-unit-with-id-info"]');
      const clickable = cell?.querySelector('a[href*="/adunits/"], .u-primary-text.u-clickable-link, [role="link"]') || cell || row;
      click(clickable, '打开已知广告位保存后编辑页');
      await this.wait(() => !this.onListRoute() && !this.activeForm() && this.savedField('广告单元 ID'), '等待已知广告位保存后编辑页');
    }
    await this.assertIdentity(identity);
    const savedUnit = this.savedField('广告单元 ID');
    const savedName = this.savedField('广告单元名称');
    const savedFormat = formatFrom(this.savedField('广告格式'));
    const parsed = partnerBidding ? { mode: 'partner-bidding', floor: '', currency: '', verified: true }
      : this.savedFloor(this.savedField('有效每千次展示费用底价'));
    const actual: Partial<Actual> = {
      unitId, publisherId: identity.publisherId, appId: identity.appId,
      name: savedName, format: savedFormat, mode: parsed.mode,
      floor: parsed.floor ?? (parsed.mode === 'auto' || parsed.mode === 'disabled' ? '' : undefined), currency: parsed.currency, verified: false,
    };
    if (savedUnit !== unitId) throw new AdapterError('VERIFY', '保存后编辑页广告位 ID 与已知 ID 不一致', true, actual);
    if (savedName !== name) throw new AdapterError('VERIFY', '保存后广告单元名称与请求不一致', true, actual);
    if (savedFormat !== format) throw new AdapterError('VERIFY', '保存后广告格式与请求不一致', true, actual);
    if (!partnerBidding && (!parsed.verified || !matchesFloor(parsed, floor, mode))) {
      throw new AdapterError('VERIFY', '保存后底价模式或金额与请求不一致', true, actual);
    }
    this.assertSavedPartnerBidding(partnerBidding, actual);
    actual.verified = true;
    // Returning is cleanup; a later navigation failure cannot invalidate the
    // exact saved configuration already read above. The next prepare/home
    // still has to establish its own usable list before it can create.
    try {
      if (directlyOpened) await this.routeWithinDocument(listPath, () => this.listReady(app[2]), '返回广告单元列表', 4000, true);
      else await this.backToList(identity);
    } catch { /* retain the verified proof and known ID */ }
    return actual as Actual;
  }

  private creationReceipt(): { unitId: string; appId: string; publisherId: string; name: string; appName: string; format: AdFormat } | undefined {
    const instructionScopes = elements(this.doc, '.instructions-container .instructions').filter(scope =>
      elements(scope, 'ol > li').some(li => /请使用下面的广告单元\s*ID\s*来集成代码/.test(txt(li))));
    if (!instructionScopes.length) return undefined;
    const fail = (message: string): never => { throw new AdapterError('VERIFY', '创建完成说明：' + message); };
    if (instructionScopes.length !== 1) return fail('出现多个成功说明区域，不能确认本次广告单元');
    const scope = instructionScopes[0];
    const rows = elements(scope, 'ol > li');
    const unitRows = rows.filter(li => /请使用下面的广告单元\s*ID\s*来集成代码/.test(txt(li)));
    const appRows = rows.filter(li => /使用下面这个应用\s*ID\s*完成/.test(txt(li)));
    if (unitRows.length !== 1 || appRows.length !== 1) return fail('应用 ID 或广告单元 ID 的说明行不唯一');
    const card = (row: Element): { id: string; name: string; image: Element } => {
      const copies = elements(row, 'div.copy-button[data-value]');
      if (copies.length !== 1) return fail('说明行的复制 ID 控件不唯一');
      const copy = copies[0];
      const value = copy.previousElementSibling;
      const id = copy.getAttribute('data-value') || '';
      if (!value || !visible(value) || txt(value) !== id) return fail('复制 ID 与相邻可见文字不一致');
      const images = copy.parentElement ? elements(copy.parentElement, 'img[alt]') : [];
      if (images.length !== 1 || !images[0].getAttribute('alt')?.trim()) return fail('ID 卡片缺少唯一名称');
      return { id, name: images[0].getAttribute('alt')!, image: images[0] };
    };
    const unit = card(unitRows[0]);
    const app = card(appRows[0]);
    const unitMatch = unit.id.match(UNIT_RX);
    const appMatch = app.id.match(APP_RX);
    if (!unitMatch || !appMatch) return fail('应用 ID 与广告单元 ID 类型或格式不正确');
    if (unitMatch[1] !== appMatch[1] || routeAppId(this.doc) !== appMatch[2]) return fail('发布商或应用与当前应用路由不一致');
    const formats = new Set<AdFormat>();
    for (const link of elements(unitRows[0], 'a[href]')) {
      const url = new URL(link.getAttribute('href')!, this.doc.location.href);
      if (url.hostname !== 'developers.google.com') continue;
      const match = url.pathname.match(/^\/admob\/(?:android|ios)\/(banner|interstitial|rewarded-interstitial|rewarded|app-open|native)(?:\/|$)/);
      if (match) formats.add(match[1] as AdFormat);
    }
    if (formats.size !== 1) return fail('广告单元植入指南未明确对应唯一广告格式');
    const format = [...formats][0];
    const iconFormat = (unit.image.getAttribute('src') || '').match(/admob_format_(banner|interstitial|rewarded_interstitial|rewarded-interstitial|rewarded|app_open|app-open|native)_icon/);
    if (iconFormat && iconFormat[1].replaceAll('_', '-') !== format) return fail('广告格式图标与植入指南冲突');
    return { unitId: unit.id, appId: app.id, publisherId: `pub-${unitMatch[1]}`, name: unit.name, appName: app.name, format };
  }

  recoverCreatedId(identity: Identity, name: string, format: AdFormat): string | undefined {
    const receipt = this.creationReceipt();
    if (!receipt) return undefined;
    if (receipt.publisherId !== identity.publisherId || receipt.appId !== identity.appId || receipt.appName !== identity.appName) {
      throw new AdapterError('VERIFY', '创建完成说明的发布商或应用与本任务不一致');
    }
    if (receipt.name !== name || receipt.format !== format) throw new AdapterError('VERIFY', '创建完成说明的广告单元名称或格式与本任务不一致');
    return receipt.unitId;
  }

  async waitForUnitId(): Promise<string> {
    const unitId = await this.wait(() => {
      const receipt = this.creationReceipt();
      if (receipt) return receipt.unitId;
      if (this.onListRoute() || this.activeForm()) return undefined;
      const saved = this.savedField('广告单元 ID');
      if (saved && UNIT_RX.test(saved)) return saved;
      return undefined;
    }, '等待真实广告单元 ID');
    if (!UNIT_RX.test(unitId)) throw new AdapterError('VERIFY', '取得的广告单元 ID 格式无效', true);
    return unitId;
  }

  async verify(identity: Identity, format: AdFormat, name: string, floor: string, mode: FloorMode = 'manual', partnerBidding = false): Promise<Actual> {
    await this.assertIdentity(identity);
    const unitId = await this.waitForUnitId();
    const partial: Partial<Actual> = { unitId, publisherId: identity.publisherId, appId: identity.appId, verified: false };
    try {
      if (!unitId.startsWith(`ca-app-${identity.publisherId}/`)) throw new AdapterError('IDENTITY', '广告单元 ID 所属发布商不一致');
      if (this.creationReceipt()) {
        if (this.recoverCreatedId(identity, name, format) !== unitId) throw new AdapterError('VERIFY', '创建完成说明的广告单元 ID 发生变化');
        // The instructions page confirms creation but has no saved floor.
        // The caller has already persisted this ID; now read its saved editor.
        return await this.verifyById(identity, unitId, name, format, floor, mode, partnerBidding);
      }
      if (this.activeForm()) throw new AdapterError('VERIFY', '仍停留在可编辑创建表单，不能作为已保存配置证据');
      const savedUnit = this.savedField('广告单元 ID');
      if (savedUnit !== unitId) throw new AdapterError('VERIFY', '保存后详情的广告单元 ID 与最初取得的 ID 不一致');
      const savedName = this.savedField('广告单元名称');
      const savedFormat = formatFrom(this.savedField('广告格式'));
      const parsed = partnerBidding ? { mode: 'partner-bidding', floor: '', currency: '', verified: true }
        : this.savedFloor(this.savedField('有效每千次展示费用底价'));
      Object.assign(partial, { name: savedName, format: savedFormat, mode: parsed.mode, floor: parsed.floor ?? (parsed.mode === 'auto' || parsed.mode === 'disabled' ? '' : undefined), currency: parsed.currency });
      if (!savedName || !savedFormat || (!partnerBidding && (parsed.mode === 'unknown' || (mode === 'manual' && !parsed.floor)))) throw new AdapterError('VERIFY', '已取得 ID，但保存后页面缺少名称、格式或底价字段');
      if (savedName !== name || savedFormat !== format || (!partnerBidding && !matchesFloor(parsed, floor, mode))) {
        throw new AdapterError('VERIFY', '已创建，但保存后配置与请求不一致');
      }
      this.assertSavedPartnerBidding(partnerBidding, partial);
      return { ...(partial as Actual), verified: true };
    } catch (error) {
      if (error instanceof AdapterError) { error.actual = { ...partial, ...(error.actual || {}) }; throw error; }
      throw new AdapterError('VERIFY', '已取得 ID，但保存后的配置无法可靠读取', true, partial);
    }
  }

  diagnostics(): unknown {
    const redact = (s: string) => s.replace(/ca-app-pub-\d{16}[~/]\d+/g, '[已隐去广告ID]').replace(/pub-\d+/g, '[已隐去发布商ID]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[已隐去邮箱]');
    const knownLabels = Object.values(ZH).flat();
    const numericAttr = (e: Element, key: string) => { const s = e.getAttribute(key); return s && /^(?:\d+(?:\.\d+)?|any)$/.test(s) ? s : undefined; };
    const safeLabel = (s: string) => knownLabels.find((x) => compact(x) === compact(s)) || (s.includes('US$') ? '[关联标签含US$]' : s.includes('USD') ? '[关联标签含USD]' : s.includes('$') ? '[关联标签仅含$]' : '[未在诊断白名单中的文字]');
    const items = elements(this.doc, 'input:not([type="hidden"]),textarea,button,[role="button"],[role="radio"],dt,th,legend').slice(0, 300).map((e) => ({
      tag: e.tagName.toLowerCase(), role: ['button', 'radio', 'textbox', 'spinbutton', 'rowheader', 'columnheader'].includes(e.getAttribute('role') || '') ? e.getAttribute('role') : undefined, label: safeLabel(redact(accessibleName(e))),
      type: e.tagName === 'INPUT' ? (e as HTMLInputElement).type : undefined,
      disabled: !enabled(e), min: numericAttr(e, 'min'), max: numericAttr(e, 'max'), step: numericAttr(e, 'step'), maxLength: numericAttr(e, 'maxlength'),
    }));
    return { adapter: 'live-chromium126-2026-11-13', time: new Date().toISOString(), origin: this.doc.location?.origin, controls: items, omitted: '不导出 URL 路径、查询参数、DOM HTML、输入值、账号 ID、应用名、Cookie、Token、密码或任意页面正文' };
  }
}

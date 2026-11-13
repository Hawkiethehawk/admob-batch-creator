import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import type { DOMWindow } from 'jsdom';
import { AdMobAdapter, AdapterError, currencyOf, checkConstraints, readField } from '../src/adapter.ts';
import type { AdFormat, FloorMode, Identity } from '../src/types.ts';

const fixtureHtml = readFileSync(new URL('./live_fixture.html', import.meta.url), 'utf8');
const savedDetailHtml = readFileSync(new URL('./fixtures/saved-detail.html', import.meta.url), 'utf8');
const successHtml = readFileSync(new URL('./fixtures/success-instructions.html', import.meta.url), 'utf8');
const publisherId = 'pub-1111111111111111';
const appId = 'ca-app-pub-1111111111111111~2222222222';
const unitId = 'ca-app-pub-1111111111111111/3333333003';
const identity: Identity = { publisherId, appId, appName: '测试应用', evidence: [] };
const usdKey = 'abc:live-usd:' + publisherId + ':' + appId;
const receiptUnitId = 'ca-app-pub-1111111111111111/4444444444';

interface FixtureState { page: string; format: string; clicks: { name: string; floor: string; format: string }[]; currency: string; maxName: number }
interface FixtureUnit { name: string; unitId: string; format: string; floor: string; mode: string }
interface FixtureApi { state: FixtureState; units: FixtureUnit[]; renderList(): void; renderFormats(): void; renderForm(format: string): void; renderDetail(unit: FixtureUnit): void }
interface FixtureEnv { dom: JSDOM; window: DOMWindow; doc: Document; adapter: AdMobAdapter; fixture: FixtureApi }

test('three formats and three floor modes create once and verify their own saved configuration',async t=>{
  for(const format of ['interstitial','app-open','native'] as AdFormat[])for(const mode of ['manual','auto','disabled'] as FloorMode[])await t.test(`${format}/${mode}`,async t=>{
    const env=load();t.after(()=>env.dom.window.close());
    const account=await env.adapter.identify();const floor=mode==='manual'?'1000':'';
    await env.adapter.prepare(account,format,'new '+format+' '+mode,floor,async()=>{},mode);
    assert.equal(env.fixture.state.clicks.length,0);
    assert.equal(env.doc.querySelector('manual-ecpm-floor-input')!.hasAttribute('hidden'),mode!=='manual');
    await env.adapter.submit();assert.equal(env.fixture.state.clicks.length,1);
    await assert.rejects(env.adapter.submit(),/已经执行/);
    const result=await env.adapter.verify(account,format,'new '+format+' '+mode,floor,mode);
    assert.equal(result.verified,true);assert.equal(result.format,format);assert.equal(result.mode,mode);
    if(mode==='manual')assert.equal(result.floor,'1000');
  });
});
test('changing a selected nonmanual mode before submit blocks creation',async t=>{
  const env=load();t.after(()=>env.dom.window.close());
  const account=await env.adapter.identify();await env.adapter.prepare(account,'native','mode must match','',async()=>{},'disabled');
  const radios=[...env.doc.querySelectorAll('[role=radio]')];
  for(const radio of radios)radio.setAttribute('aria-checked',String(radio.textContent!.includes('Google')));
  await assert.rejects(env.adapter.submit(),/模式发生变化/);assert.equal(env.fixture.state.clicks.length,0);
});

function load(url = 'https://admob.google.com/v2/apps/2222222222/adunits/list'): FixtureEnv {
  const dom = new JSDOM(fixtureHtml, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const window = dom.window;
  const adapter = new AdMobAdapter(window.document, 5000);
  const fixture = (window as unknown as { fixture: FixtureApi }).fixture;
  return { dom, window, doc: window.document, adapter, fixture };
}
async function identified(): Promise<{ env: FixtureEnv; identity: Identity }> {
  const env = load();
  const identity = await env.adapter.identify();
  return { env, identity };
}

test('a stop during final identity readback is checked before the native create click',async t=>{
  const env=load();t.after(()=>env.dom.window.close());
  const account=await env.adapter.identify();
  await env.adapter.prepare(account,'interstitial','stop-at-click','60',async()=>{});
  let running=true,checks=0;
  const identify=env.adapter.identify.bind(env.adapter);
  t.mock.method(env.adapter,'identify',async()=>{const current=await identify();running=false;return current;});
  await assert.rejects(()=>env.adapter.submit(()=>{checks++;if(!running)throw Error('批次已停止');}),/已停止/);
  assert.equal(checks,1);assert.equal(env.fixture.state.clicks.length,0);
});

test('an allowed synchronous guard runs immediately before the only native click',async t=>{
  const env=load();t.after(()=>env.dom.window.close());
  const account=await env.adapter.identify();
  await env.adapter.prepare(account,'interstitial','guarded-click','60',async()=>{});
  const order:string[]=[];
  env.doc.addEventListener('click',event=>{if((event.target as Element).closest('material-button.btn-yes'))order.push('click');},true);
  await env.adapter.submit(()=>{order.push('guard');assert.equal(env.fixture.state.clicks.length,0);});
  assert.deepEqual(order,['guard','click']);assert.equal(env.fixture.state.clicks.length,1);
});

test('page readiness preserves colliding sandbox timers and a later wait after queued callbacks', async (t) => {
  const dom = new JSDOM('<main></main>');
  const view = dom.window;
  const pageTimers = new Map<number, () => void>();
  const sandboxTimers = new Set([1, 2]);
  const mocks = [
    t.mock.method(view, 'setInterval', (callback: TimerHandler) => { pageTimers.set(1, callback as () => void); return 1; }),
    t.mock.method(view, 'setTimeout', (callback: TimerHandler) => { pageTimers.set(2, callback as () => void); return 2; }),
    t.mock.method(view, 'clearInterval', (id: number | undefined) => { pageTimers.delete(id!); }),
    t.mock.method(view, 'clearTimeout', (id: number | undefined) => { pageTimers.delete(id!); }),
    // The userscript clock has the same numeric IDs but owns different work.
    t.mock.method(globalThis, 'clearInterval', (id: unknown) => { sandboxTimers.delete(Number(id)); }),
    t.mock.method(globalThis, 'clearTimeout', (id: unknown) => { sandboxTimers.delete(Number(id)); }),
  ];
  t.after(() => { for (const mock of mocks) mock.mock.restore(); view.close(); });
  const adapter = new AdMobAdapter(view.document);
  let ready = false;
  const waiting = adapter.wait(() => ready && 'ready', '等待表单');
  const latePoll = pageTimers.get(1)!;
  const lateTimeout = pageTimers.get(2)!;
  ready = true; latePoll();
  assert.equal(await waiting, 'ready');
  assert.deepEqual([...sandboxTimers], [1, 2]);
  assert.equal(pageTimers.size, 0);

  // A callback already queued before cancellation may run after IDs have
  // been reused by the next wait; it must not cancel that wait's deadline.
  let nextReady = false;
  const next = adapter.wait(() => nextReady && 'next', '等待下一表单');
  lateTimeout(); latePoll();
  assert.equal(pageTimers.size, 2);
  nextReady = true; pageTimers.get(1)!();
  assert.equal(await next, 'next');
  assert.equal(pageTimers.size, 0);
});

test('input readback completes using the document clock for both settling delays', async (t) => {
  const dom = new JSDOM('<input>');
  const view = dom.window;
  const pending: (() => void)[] = [];
  const timer = t.mock.method(view, 'setTimeout', (callback: TimerHandler) => { pending.push(callback as () => void); return pending.length; });
  t.after(() => { timer.mock.restore(); view.close(); });
  const adapter = new AdMobAdapter(view.document);
  const input = view.document.querySelector('input')!;
  let finished = false;
  const updating = adapter.setInput(input, '300', '全局底价').then(() => { finished = true; });
  assert.equal(input.value, '300');
  assert.equal(finished, false);
  assert.equal(pending.length, 1);
  pending.shift()!();
  // Resume the first delay, the immediate readback check, then the blur delay.
  for (let index = 0; index < 4; index++) await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(pending.length, 1);
  pending.shift()!();
  await updating;
  assert.equal(finished, true);
  assert.equal(input.value, '300');
});

test('identity derives the app from the live route, app name and ad-unit publisher prefix', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  assert.equal(identity.publisherId, publisherId);
  assert.equal(identity.appId, appId);
  assert.equal(identity.appName, '测试应用');
  assert.equal(identity.currency, 'USD');
  assert.match(identity.evidence.join(' '), /广告位 ID 的发布商前缀/);
  assert.match(identity.evidence.join(' '), /用户已确定的批次 USD 配置，不代表页面字段实测币种/);
});

test('identity accepts only an explicit App ID that matches the current route', async (t) => {
  const { env } = await identified();
  t.after(() => env.dom.window.close());
  const span = env.doc.createElement('span');
  span.className = 'copy-chip-text';
  span.textContent = appId;
  env.doc.body.append(span);
  assert.equal((await env.adapter.identify()).appId, appId);
  span.textContent = 'ca-app-pub-1111111111111111~9999999999';
  await assert.rejects(env.adapter.identify(), /与当前应用路由不一致/);
});


test('identity ignores the selected all-apps navigation entry and keeps the current app', async (t) => {
  const { env } = await identified();
  t.after(() => env.dom.window.close());
  const allApps = env.doc.createElement('material-list-item');
  allApps.className = 'secondary-sidebar-item item selected';
  allApps.setAttribute('role', 'link');
  allApps.setAttribute('aria-label', '前往“所有应用”页面');
  env.doc.querySelector('#sidebar')!.append(allApps);
  assert.equal((await env.adapter.identify()).appName, '测试应用');
});

test('form identity revalidates the current app from the session mapping without a unit id', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  env.fixture.renderForm('interstitial');
  const formIdentity = await env.adapter.identify();
  assert.equal(formIdentity.publisherId, identity.publisherId);
  assert.equal(formIdentity.appId, identity.appId);
  assert.equal(formIdentity.appName, identity.appName);
});

test('identity refuses a page without an app route', async (t) => {
  const env = load('https://admob.google.com/v2/apps/');
  t.after(() => env.dom.window.close());
  await assert.rejects(env.adapter.identify(), /应用路由/);
});

test('lookup reads saved details without opening a create form or requiring currency session evidence', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  let createEntries = 0;
  env.doc.querySelector('.add-ad-unit-button')!.addEventListener('click', () => { createEntries++; });
  const found = await env.adapter.lookup(identity, '目标名称');
  assert.equal(found.complete, true);
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].unitId, unitId);
  assert.equal(found.matches[0].format, 'interstitial');
  assert.equal(found.matches[0].mode, 'manual');
  assert.equal(found.matches[0].floor, '60');
  assert.equal(found.matches[0].currency, 'USD');
  assert.equal(found.matches[0].verified, true);
  const none = await env.adapter.lookup(identity, '不存在');
  assert.equal(none.complete, true);
  assert.deepEqual(none.matches, []);
  assert.equal(createEntries, 0);
  assert.equal(env.window.sessionStorage.getItem(usdKey), null);
  assert.equal(env.fixture.state.clicks.length, 0);
});

test('lookup clears a prior search, filters by exact name, and blocks on a missing total', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  const search = env.doc.querySelector('input[aria-label*="搜索广告单元"]') as HTMLInputElement;
  search.value = '目标名称';
  const searched = await env.adapter.lookup(identity, '目标名称');
  assert.equal(searched.complete, true);
  assert.equal(searched.matches.length, 1);
  assert.equal(searched.matches[0].name, '目标名称');
  search.value = '';
  env.doc.querySelector('.table-footer')!.remove();
  const missing = await env.adapter.lookup(identity, '目标名称');
  assert.equal(missing.complete, false);
  assert.match(missing.reason || '', /列表总数|总行数/);
});

test('lookup proves an empty grid only from an explicit zero total', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  env.fixture.units.length = 0;
  env.fixture.renderList();
  const result = await env.adapter.lookup(identity, '任意');
  assert.equal(result.complete, true);
  assert.deepEqual(result.matches, []);
});

test('interstitial prepare selects manual floor and fills the configured per-row value without submitting', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  await env.adapter.prepare(identity, 'interstitial', '新目标', '60.5', async () => {});
  assert.equal(env.fixture.state.page, 'form');
  assert.equal(env.fixture.state.format, 'interstitial');
  assert.equal((env.doc.querySelector('material-input:not([type]) input') as HTMLInputElement).value, '新目标');
  assert.equal((env.doc.querySelector('manual-ecpm-floor-input input') as HTMLInputElement).value, '60.5');
  assert.equal(env.doc.querySelector('.leading-text')!.textContent, 'US$');
  assert.equal([...env.doc.querySelectorAll('[role="radio"]')].find((e) => e.textContent.includes('人工指定底价'))!.getAttribute('aria-checked'), 'true');
  assert.equal((env.doc.querySelector('.btn-yes') as Element).getAttribute('aria-disabled'), 'false');
  assert.equal(env.fixture.state.clicks.length, 0);
});

test('app-open prepare uses the app-open format card and the same manual USD floor control', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  await env.adapter.prepare(identity, 'app-open', '开屏目标', '15', async () => {});
  assert.equal(env.fixture.state.page, 'form');
  assert.equal(env.fixture.state.format, 'app-open');
  assert.equal(env.doc.querySelector('.format-label')!.textContent, '开屏广告');
  assert.equal(env.doc.querySelector('.leading-text')!.textContent, 'US$');
  assert.equal(env.fixture.state.clicks.length, 0);
});

test('prepare uses confirmed USD configuration when the floor prefix is a bare dollar or absent', async (t) => {
  for (const currency of ['$', '']) {
    const { env, identity } = await identified();
    t.after(() => env.dom.window.close());
    env.fixture.state.currency = currency;
    await env.adapter.prepare(identity, 'interstitial', '新目标', '60.5', async () => {});
    assert.equal((env.doc.querySelector('manual-ecpm-floor-input input') as HTMLInputElement).value, '60.5');
    assert.equal([...env.doc.querySelectorAll('[role="radio"]')].find((e) => e.textContent.includes('人工指定底价'))!.getAttribute('aria-checked'), 'true');
    assert.equal(env.window.sessionStorage.getItem(usdKey), null);
    assert.equal(env.fixture.state.clicks.length, 0);
  }
});

test('prepare still rejects explicit other or conflicting currencies without changing manual mode', async (t) => {
  for (const currency of ['EUR', 'US$ EUR', '€']) {
    const { env, identity } = await identified();
    t.after(() => env.dom.window.close());
    env.fixture.state.currency = currency;
    await assert.rejects(env.adapter.prepare(identity, 'interstitial', '新目标', '60', async () => {}), /USD|币种/);
    assert.equal(env.fixture.state.clicks.length, 0);
  }
});

test('prepare enforces the live name counter and never truncates', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  env.fixture.state.maxName = 3;
  await assert.rejects(env.adapter.prepare(identity, 'interstitial', '名称太长', '60', async () => {}), /上限 3/);
  assert.equal(env.fixture.state.clicks.length, 0);
});

test('submit is the only create click and verify reads the saved read-only configuration back', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  await env.adapter.prepare(identity, 'interstitial', '新目标', '60.5', async () => {});
  await env.adapter.submit();
  assert.equal(env.fixture.state.clicks.length, 1);
  assert.equal(env.fixture.state.clicks[0].name, '新目标');
  assert.equal(env.fixture.state.clicks[0].floor, '60.5');
  const actual = await env.adapter.verify(identity, 'interstitial', '新目标', '60.5');
  assert.equal(actual.verified, true);
  assert.equal(actual.name, '新目标');
  assert.equal(actual.format, 'interstitial');
  assert.equal(actual.mode, 'manual');
  assert.equal(actual.floor, '60.5');
  assert.equal(actual.currency, 'USD');
  await assert.rejects(env.adapter.submit(), /已经执行过提交/);
  assert.equal(env.fixture.state.clicks.length, 1);
});

test('submit still stops if the configured dollar control changes to an explicit other currency', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  env.fixture.state.currency = '$';
  await env.adapter.prepare(identity, 'interstitial', '新目标', '60.5', async () => {});
  env.doc.querySelector('.leading-text')!.textContent = 'EUR';
  await assert.rejects(env.adapter.submit(), /不是 USD|冲突币种/);
  assert.equal(env.fixture.state.clicks.length, 0);
});

test('a saved floor mismatch preserves the real ID and is not counted as success', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  await env.adapter.prepare(identity, 'interstitial', '新目标', '60.5', async () => {});
  await env.adapter.submit();
  env.doc.querySelector('#v-floor')!.textContent = '全球底价设为 $40.00';
  try {
    await env.adapter.verify(identity, 'interstitial', '新目标', '60.5');
    assert.fail('must reject');
  } catch (error) {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.actual?.unitId, env.fixture.units.at(-1)?.unitId);
    assert.equal(error.actual?.floor, '40');
    assert.equal(error.actual?.verified, false);
  }
});

test('known-ID verification uses configured USD without currency cache or a create-form detour', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  let createEntries = 0;
  env.doc.querySelector('.add-ad-unit-button')!.addEventListener('click', () => { createEntries++; });
  assert.equal(env.window.sessionStorage.getItem(usdKey), null);
  const actual = await env.adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '60');
  assert.equal(actual.unitId, unitId);
  assert.equal(actual.verified, true);
  assert.equal(actual.currency, 'USD');
  assert.equal(env.window.sessionStorage.getItem(usdKey), null, '不得伪造字段US$实测证据');
  assert.equal(createEntries, 0);
  assert.equal(env.fixture.state.clicks.length, 0);
});

test('known-ID verification ignores obsolete currency session evidence and checks the saved unit directly', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  env.fixture.state.currency = '$';
  env.window.sessionStorage.setItem(usdKey, 'obsolete-session-value');
  const actual = await env.adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '60');
  assert.equal(actual.verified, true);
  assert.equal(actual.currency, 'USD');
  assert.equal(env.window.sessionStorage.getItem(usdKey), 'obsolete-session-value');
  assert.equal(env.fixture.state.clicks.length, 0);
});

test('an explicitly labelled saved USD floor verifies without writing synthetic session evidence', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  env.window.history.replaceState({}, '', '/v2/apps/2222222222/adunits/3333333003/edit');
  env.fixture.renderDetail(env.fixture.units[2]);
  env.doc.querySelector('#v-floor')!.textContent = '全球底价设为 US$60.00';
  const actual = await env.adapter.verify(identity, 'interstitial', '目标名称', '60');
  assert.equal(actual.verified, true);
  assert.equal(env.window.sessionStorage.getItem(usdKey), null);
  assert.equal(env.fixture.state.clicks.length, 0);
});

test('a conflicting currency in the saved floor cannot be accepted by fixed USD configuration', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  env.window.history.replaceState({}, '', '/v2/apps/2222222222/adunits/3333333003/edit');
  env.fixture.renderDetail(env.fixture.units[2]);
  env.doc.querySelector('#v-floor')!.textContent = '全球底价设为 US$60.00 EUR';
  await assert.rejects(env.adapter.verify(identity, 'interstitial', '目标名称', '60'), /保存后配置与请求不一致/);
});

test('a retained list and unrelated body text cannot supply a saved unit ID', async (t) => {
  const { env } = await identified();
  t.after(() => env.dom.window.close());
  env.doc.body.insertAdjacentHTML('beforeend', '<div>广告单元 ID ' + unitId + ' 插页式广告 全球底价设为 US$60</div>');
  env.adapter.timeout = 40;
  await assert.rejects(env.adapter.waitForUnitId(), /等待真实广告单元 ID/);
  env.window.history.replaceState({}, '', '/v2/apps/2222222222/adunits/3333333003/edit');
  await assert.rejects(env.adapter.waitForUnitId(), /等待真实广告单元 ID/);
});

test('success instructions capture the new unit ID despite a retained create heading and other list IDs', async (t) => {
  const dom = new JSDOM(successHtml, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/create', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const adapter = new AdMobAdapter(dom.window.document, 100);
  assert.ok(adapter.activeForm(), '实机成功说明仍保留创建广告单元标题');
  assert.ok(dom.window.document.querySelector('[role="grid"]')!.textContent!.includes(unitId));
  assert.equal(await adapter.waitForUnitId(), receiptUnitId);
  assert.equal(adapter.recoverCreatedId(identity, '脱敏插页200', 'interstitial'), receiptUnitId);
  assert.notEqual(receiptUnitId, appId, '应用的~ID不是广告单元/ID');
});

test('success recovery requires the exact task name, publisher, app and format without navigating', (t) => {
  const dom = new JSDOM(successHtml, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/create', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const adapter = new AdMobAdapter(dom.window.document, 100);
  const pathname = dom.window.location.pathname;
  assert.throws(() => adapter.recoverCreatedId(identity, '另一广告位', 'interstitial'), /名称或格式与本任务不一致/);
  assert.throws(() => adapter.recoverCreatedId(identity, '脱敏插页200', 'app-open'), /名称或格式与本任务不一致/);
  assert.throws(() => adapter.recoverCreatedId({ ...identity, publisherId: 'pub-9999999999999999' }, '脱敏插页200', 'interstitial'), /发布商或应用与本任务不一致/);
  assert.throws(() => adapter.recoverCreatedId({ ...identity, appId: 'ca-app-pub-1111111111111111~9999999999' }, '脱敏插页200', 'interstitial'), /发布商或应用与本任务不一致/);
  assert.equal(dom.window.location.pathname, pathname);
  dom.window.document.querySelector('.instructions-container')!.remove();
  assert.equal(adapter.recoverCreatedId(identity, '脱敏插页200', 'interstitial'), undefined, '保留的列表不是创建完成凭据');
});

test('success instructions reject copy-text conflicts, wrong ID types, publisher/app conflicts and format conflicts', async (t) => {
  for (const mutation of ['copy', 'app-as-unit', 'publisher', 'app-route', 'format']) {
    const dom = new JSDOM(successHtml, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/create', pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    const copies = [...doc.querySelectorAll<HTMLElement>('.instructions .copy-button')];
    const replace = (copy: HTMLElement, id: string): void => { copy.dataset.value = id; copy.previousElementSibling!.textContent = id; };
    if (mutation === 'copy') copies[1].dataset.value = unitId;
    if (mutation === 'app-as-unit') replace(copies[1], appId);
    if (mutation === 'publisher') replace(copies[1], 'ca-app-pub-9999999999999999/4444444444');
    if (mutation === 'app-route') replace(copies[0], 'ca-app-pub-1111111111111111~9999999999');
    if (mutation === 'format') doc.querySelector<HTMLAnchorElement>('a[href*="/interstitial"]')!.href = 'https://developers.google.com/admob/android/app-open';
    const adapter = new AdMobAdapter(doc, 100);
    await assert.rejects(adapter.waitForUnitId(), /创建完成说明/);
  }
});

test('success verification preserves its captured ID when saved configuration readback is unavailable', async (t) => {
  const dom = new JSDOM(successHtml, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/create', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const adapter = new AdMobAdapter(dom.window.document, 100);
  let checkedId = '';
  adapter.verifyById = async (_identity, id) => { checkedId = id; throw new AdapterError('VERIFY', '保存后配置尚未完整'); };
  assert.equal(await adapter.waitForUnitId(), receiptUnitId);
  await assert.rejects(adapter.verify(identity, 'interstitial', '脱敏插页200', '200'), (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.actual?.unitId, receiptUnitId);
    assert.equal(error.actual?.verified, false);
    assert.equal(error.actual?.floor, undefined, '说明页未显示保存金额，不以请求金额冒充实际值');
    return /保存后配置尚未完整/.test(error.message);
  });
  assert.equal(checkedId, receiptUnitId);
});

test('success verification opens the captured unit saved editor and verifies its actual configuration', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  Object.assign(env.fixture.units[2], { unitId: receiptUnitId, name: '脱敏插页200', floor: '200.00' });
  const success = new JSDOM(successHtml);
  t.after(() => success.window.close());
  env.window.history.pushState({}, '', '/v2/apps/2222222222/adunits/create');
  env.doc.querySelector('#app')!.innerHTML = success.window.document.querySelector('main')!.innerHTML;
  env.adapter.home = async () => {
    env.window.history.replaceState({}, '', '/v2/apps/2222222222/adunits/list');
    env.fixture.renderList();
  };
  const result = await env.adapter.verify(identity, 'interstitial', '脱敏插页200', '200');
  assert.equal(result.unitId, receiptUnitId);
  assert.equal(result.name, '脱敏插页200');
  assert.equal(result.floor, '200');
  assert.equal(result.verified, true);
  assert.equal(env.fixture.state.clicks.length, 0, '核验只导航和读取，不再次创建');
});

test('known-ID verification waits for the saved detail instead of using a still-mounted list', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  const oldLink = env.doc.querySelector('a[href*="3333333003"]')!;
  const delayedLink = oldLink.cloneNode(true) as HTMLAnchorElement;
  oldLink.replaceWith(delayedLink);
  delayedLink.addEventListener('click', (event) => {
    event.preventDefault();
    env.window.setTimeout(() => {
      env.window.history.pushState({}, '', delayedLink.getAttribute('href'));
      env.fixture.renderDetail(env.fixture.units[2]);
    }, 50);
  });
  const actual = await env.adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '60');
  assert.equal(actual.verified, true);
  assert.equal(actual.name, '目标名称');
  assert.equal(env.fixture.state.clicks.length, 0);
});

test('conflicting explicitly labelled saved IDs are rejected instead of choosing the first', async (t) => {
  const { env } = await identified();
  t.after(() => env.dom.window.close());
  env.window.history.replaceState({}, '', '/v2/apps/2222222222/adunits/3333333003/edit');
  env.fixture.renderDetail(env.fixture.units[2]);
  env.doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<div class="header" aria-label="广告单元 ID" aria-describedby="other-id"><div class="panel-description" id="other-id">ca-app-pub-1111111111111111/9999999999</div></div>');
  await assert.rejects(env.adapter.waitForUnitId(), /多个不同值/);
});

test('the redacted live saved-detail structure reads aria-describedby values with aria-hidden=true', async (t) => {
  const dom = new JSDOM(savedDetailHtml, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/3333333003/edit', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const adapter = new AdMobAdapter(dom.window.document, 100);
  // The live SPA session reached this detail from the already identified list.
  dom.window.sessionStorage.setItem('abc:live-identity:2222222222', JSON.stringify(identity));
  const actual = await adapter.verify(identity, 'interstitial', '脱敏插页100', '100');
  assert.equal(actual.unitId, unitId);
  assert.equal(actual.name, '脱敏插页100');
  assert.equal(actual.mode, 'manual');
  assert.equal(actual.floor, '100');
  assert.equal(actual.currency, 'USD');
  assert.equal(actual.verified, true);
});

test('configured USD does not bypass a saved amount mismatch and preserves the known ID', async (t) => {
  const dom = new JSDOM(savedDetailHtml, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/3333333003/edit', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const adapter = new AdMobAdapter(dom.window.document, 100);
  dom.window.sessionStorage.setItem('abc:live-identity:2222222222', JSON.stringify(identity));
  await assert.rejects(adapter.verify(identity, 'interstitial', '脱敏插页100', '200'), (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.actual?.unitId, unitId);
    assert.equal(error.actual?.currency, 'USD');
    assert.equal(error.actual?.floor, '100');
    assert.equal(error.actual?.verified, false);
    return /配置与请求不一致/.test(error.message);
  });
});

test('configured USD cannot certify a saved automatic or disabled floor as the requested manual mode', async (t) => {
  for (const summary of ['由 Google 优化', '已停用']) {
    const dom = new JSDOM(savedDetailHtml, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/3333333003/edit', pretendToBeVisual: true });
    t.after(() => dom.window.close());
    dom.window.sessionStorage.setItem('abc:live-identity:2222222222', JSON.stringify(identity));
    dom.window.document.querySelector('#saved-floor')!.textContent = summary;
    const adapter = new AdMobAdapter(dom.window.document, 100);
    await assert.rejects(adapter.verify(identity, 'interstitial', '脱敏插页100', '100'), (error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.actual?.unitId, unitId);
      assert.equal(error.actual?.verified, false);
      assert.notEqual(error.actual?.mode, 'manual');
      return /缺少名称、格式或底价字段|配置与请求不一致/.test(error.message);
    });
  }
});

test('aria-hidden saved descriptions are accepted only through a visible header explicit reference', async (t) => {
  for (const change of ['reference', 'css', 'ancestor']) {
    const dom = new JSDOM(savedDetailHtml, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/3333333003/edit', pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    const header = doc.querySelector('[aria-label="广告单元 ID"]')!;
    if (change === 'reference') header.removeAttribute('aria-describedby');
    if (change === 'css') (doc.querySelector('#saved-id') as HTMLElement).style.display = 'none';
    if (change === 'ancestor') header.setAttribute('aria-hidden', 'true');
    const adapter = new AdMobAdapter(doc, 30);
    await assert.rejects(adapter.waitForUnitId(), /等待真实广告单元 ID/);
  }
});

test('ambiguous add control stops instead of choosing a candidate', async (t) => {
  const { env, identity } = await identified();
  t.after(() => env.dom.window.close());
  const extra = env.doc.createElement('material-button');
  extra.setAttribute('aria-label', '添加广告单元');
  extra.textContent = '添加广告单元';
  env.doc.querySelector('.add-ad-unit-button')!.after(extra);
  await assert.rejects(env.adapter.prepare(identity, 'interstitial', '新目标', '60', async () => {}), /2 个候选/);
  assert.equal(env.fixture.state.clicks.length, 0);
});

test('fixed USD accepts a dollar or absent prefix while explicit non-USD symbols still stop', () => {
  const dom = new JSDOM('<manual-ecpm-floor-input><div class="global-ecpm-input-label" id="l">输入全球有效每千次展示费用底价</div><material-input><span class="leading-text">$</span><label><input aria-labelledby="l"></label></material-input></manual-ecpm-floor-input>');
  const input = dom.window.document.querySelector('input') as HTMLInputElement;
  const prefix = dom.window.document.querySelector('.leading-text')!;
  for (const value of ['$', '', 'US$', 'USD']) {
    prefix.textContent = value;
    assert.equal(currencyOf(input), 'USD');
  }
  for (const value of ['EUR', 'US$ €', '¥']) {
    prefix.textContent = value;
    assert.throws(() => currencyOf(input), /不是 USD|冲突币种/);
  }
  dom.window.close();
});

test('constraints still use integer arithmetic on attributes the live page provides', () => {
  const dom = new JSDOM('<input type="number" min="0.01" max="100" step="0.01">');
  const input = dom.window.document.querySelector('input') as HTMLInputElement;
  assert.doesNotThrow(() => checkConstraints(input, '60.00'));
  assert.throws(() => checkConstraints(input, '0'), /最小/);
  assert.throws(() => checkConstraints(input, '100.01'), /最大/);
  assert.throws(() => checkConstraints(input, '1.001'), /步长/);
  dom.window.close();
});

test('diagnostics omit page text, values, IDs and URL query strings', async (t) => {
  const { env } = await identified();
  t.after(() => env.dom.window.close());
  env.doc.body.insertAdjacentHTML('beforeend', '<input value="private@example.com" min="secret-token"><p>secret-token 测试应用</p>');
  const output = JSON.stringify(env.adapter.diagnostics());
  assert.ok(!output.includes('secret-token'));
  assert.ok(!output.includes(publisherId));
  assert.ok(!output.includes(appId));
  assert.ok(!output.includes('测试应用'));
  assert.ok(!output.includes('private@example.com'));
  assert.equal(readField(env.doc, ['应用名称']), undefined);
});

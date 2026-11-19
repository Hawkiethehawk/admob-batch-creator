import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AdMobAdapter } from '../src/adapter.ts';

const list = 'https://admob.google.com/v2/apps/2222222222/adunits/list';
const create = list.replace('/list', '/create');
const fallbackList = list.replace('admob.google.com', 'fixture.example');
const fallbackCreate = create.replace('admob.google.com', 'fixture.example');
const receipt = readFileSync(new URL('./fixtures/success-instructions.html', import.meta.url), 'utf8');
const liveFixture = readFileSync(new URL('./live_fixture.html', import.meta.url), 'utf8');
const expected = { publisherId: 'pub-1111111111111111', appId: 'ca-app-pub-1111111111111111~2222222222', appName: '测试应用', evidence: [] };
const canvas = '<div role="grid" aria-label="广告单元"></div>';
const grid = '<h1>广告单元</h1><input aria-label="按广告单元名称搜索">' + canvas + '<material-button role="button" aria-label="添加广告单元">添加广告单元</material-button>';
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

test('home restores the explicitly known app from overview without history back or a new document', async t => {
  const dom = new JSDOM(liveFixture, { url: 'https://admob.google.com/v2/apps/list', runScripts: 'dangerously' });
  try {
    const doc = dom.window.document, initialHistory = dom.window.history.length;
    const worker = doc.createElement('div'); worker.id = 'abc-worker-status'; doc.body.append(worker);
    t.mock.method(dom.window.history, 'back', () => { throw new Error('overview has no dependable app history'); });
    await new AdMobAdapter(doc).home(expected);
    assert.equal(dom.window.location.href, list);
    assert.equal(dom.window.history.length, initialHistory, 'list cleanup replaces the transient history entry');
    assert.equal(dom.window.document, doc); assert.equal(doc.querySelector('#abc-worker-status'), worker);
    assert.ok(doc.querySelector('[role=grid]')); assert.equal(doc.querySelector('h1')?.textContent, '广告单元');
  } finally { dom.window.close(); }
});

test('home refuses a different explicit app and never guesses a target from overview', async t => {
  for (const route of ['https://admob.google.com/v2/apps/9999999999/adunits/list', 'https://admob.google.com/v2/apps/list']) {
    const dom = new JSDOM(liveFixture, { url: route, runScripts: 'dangerously' });
    try {
      let navigations = 0;
      t.mock.method(dom.window.history, 'back', () => { navigations++; });
      t.mock.method(dom.window.history, 'replaceState', () => { navigations++; });
      const adapter = new AdMobAdapter(dom.window.document);
      if (route.includes('9999999999')) await assert.rejects(adapter.home(expected), /其他应用/);
      else await assert.rejects(adapter.home(), /无法确认目标应用/);
      assert.equal(navigations, 0); assert.equal(dom.window.location.href, route);
    } finally { dom.window.close(); }
  }
});

test('a canonical list URL with an old editor and retained grid waits for the actual list body', async t => {
  const dom = new JSDOM(liveFixture, { url: list, runScripts: 'dangerously' });
  try {
    const doc = dom.window.document;
    const fixture = (dom.window as unknown as { fixture: { renderForm(format: string): void; renderList(): void } }).fixture;
    const previousList = doc.querySelector('main')!.innerHTML;
    fixture.renderForm('interstitial'); doc.querySelector('main')!.insertAdjacentHTML('beforeend', previousList);
    dom.window.history.replaceState({}, '', create);
    const dispatch = dom.window.dispatchEvent.bind(dom.window);
    t.mock.method(dom.window, 'dispatchEvent', (event: Event) => {
      if (event.type === 'popstate') { dom.window.setTimeout(() => fixture.renderList(), 500); return true; }
      return dispatch(event);
    });
    t.mock.method(dom.window.history, 'back', () => { throw new Error('must remain at the requested list'); });
    let settled = false;
    const returning = new AdMobAdapter(doc).home(expected).then(() => { settled = true; });
    await flush();
    assert.equal(dom.window.location.href, list);
    assert.equal(settled, false, 'URL + retained old grid cannot certify list readiness');
    await returning;
    assert.equal(doc.querySelector('h1')?.textContent, '广告单元');
    assert.equal(doc.querySelector('manual-ecpm-floor-input'), null);
  } finally { dom.window.close(); }
});

test('reused worker list navigation retries an ignored SPA signal while keeping its document and app', async t => {
  const dom = new JSDOM(liveFixture, { url: list, runScripts: 'dangerously' });
  try {
    const doc = dom.window.document;
    const fixture = (dom.window as unknown as { fixture: { units: unknown[]; renderDetail(unit: unknown): void } }).fixture;
    fixture.renderDetail(fixture.units[2]);
    dom.window.history.replaceState({}, '', list.replace('/list', '/3333333003/edit'));
    const dispatch = dom.window.dispatchEvent.bind(dom.window);
    let signals = 0;
    t.mock.method(dom.window, 'dispatchEvent', (event: Event) => {
      if (event.type === 'popstate' && ++signals === 1) return true;
      return dispatch(event);
    });
    t.mock.method(dom.window.history, 'back', () => { throw new Error('retry must stay in the same app'); });
    await new AdMobAdapter(doc, 100).home(expected);
    assert.equal(signals, 2); assert.equal(dom.window.document, doc); assert.equal(dom.window.location.href, list);
    assert.equal(doc.querySelector('h1')?.textContent, '广告单元');
  } finally { dom.window.close(); }
});

test('home retains an already reached list route through a late grid beyond the first deadline', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const dom = new JSDOM('<main><input aria-label="按广告单元名称搜索"><material-button role="button">添加广告单元</material-button></main>', { url: list });
  try {
    let backs = 0;
    t.mock.method(dom.window.history, 'back', () => { backs++; throw new Error('must retain list'); });
    dom.window.setTimeout(() => { dom.window.document.querySelector('main')!.insertAdjacentHTML('beforeend', canvas); }, 25000);
    const returning = new AdMobAdapter(dom.window.document).home();
    t.mock.timers.tick(20000); await flush();
    assert.equal(backs, 0);
    t.mock.timers.tick(5000); await returning;
    assert.equal(backs, 0);
    assert.equal(dom.window.location.href, list);
  } finally { dom.window.close(); }
});

test('home follows two SPA history entries without requiring a list link or replacing the worker document', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const dom = new JSDOM(receipt, { url: fallbackCreate });
  try {
    const doc = dom.window.document;
    let backs = 0;
    t.mock.method(dom.window.history, 'back', () => {
      backs++;
      dom.window.history.replaceState({}, '', backs === 1 ? fallbackCreate : fallbackList);
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
      if (backs === 2) {
        doc.querySelector('main')!.innerHTML = '<h1>广告单元</h1>';
        dom.window.setTimeout(() => { doc.querySelector('main')!.insertAdjacentHTML('beforeend', grid); }, 6000);
      }
    });
    const returning = new AdMobAdapter(doc).home();
    await flush();
    assert.equal(backs, 2, 'a receipt-to-create hop is followed by the list hop');
    t.mock.timers.tick(6000); await returning;
    assert.equal(dom.window.document, doc);
    assert.equal(backs, 2, 'grid loading never triggers another history back');
    assert.equal(doc.querySelector('iframe'), null);
  } finally { dom.window.close(); }
});

test('a verified creation receipt prefers its unique native completion control', async t => {
  const dom = new JSDOM(receipt, { url: fallbackCreate });
  try {
    const doc = dom.window.document;
    doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<material-button role="button">完成</material-button>');
    let clicks = 0;
    doc.querySelector('material-button')!.addEventListener('click', () => {
      clicks++; dom.window.history.replaceState({}, '', fallbackList); doc.querySelector('main')!.innerHTML = grid;
    });
    t.mock.method(dom.window.history, 'back', () => { throw new Error('completion already returned'); });
    await new AdMobAdapter(doc).home();
    assert.equal(clicks, 1);
    assert.equal(dom.window.location.href, fallbackList);
  } finally { dom.window.close(); }
});

test('competing receipt completion controls are rejected without clicking', async t => {
  const dom = new JSDOM(receipt, { url: fallbackCreate });
  try {
    dom.window.document.querySelector('main')!.insertAdjacentHTML('beforeend', '<button>完成</button><button>完成</button>');
    let clicks = 0;
    for (const button of dom.window.document.querySelectorAll('button')) button.addEventListener('click', () => { clicks++; });
    await assert.rejects(new AdMobAdapter(dom.window.document).home(), /返回入口不唯一/);
    assert.equal(clicks, 0);
  } finally { dom.window.close(); }
});

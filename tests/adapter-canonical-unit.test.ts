import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AdMobAdapter, AdapterError } from '../src/adapter.ts';

const html = readFileSync(new URL('./live_fixture.html', import.meta.url), 'utf8');
const saved = readFileSync(new URL('./fixtures/saved-detail.html', import.meta.url), 'utf8');
const list = 'https://admob.google.com/v2/apps/2222222222/adunits/list';
const unitId = 'ca-app-pub-1111111111111111/3333333003';
function load() {
  const dom = new JSDOM(html, { url: list, runScripts: 'dangerously' });
  return { dom, adapter: new AdMobAdapter(dom.window.document, 500) };
}

test('canonical known-ID routing bypasses stale list search and retains the worker document', async t => {
  const { dom, adapter } = load();
  try {
    const identity = await adapter.identify(), doc = dom.window.document;
    const worker = doc.createElement('div'); worker.id = 'abc-worker-status'; doc.body.append(worker);
    t.mock.method(adapter, 'setInput', async () => { throw new Error('canonical verification must not search the old list'); });
    t.mock.method(dom.window.history, 'back', () => { throw new Error('canonical verification must not back through create'); });
    const actual = await adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '60');
    assert.equal(actual.unitId, unitId); assert.equal(actual.verified, true);
    assert.equal(dom.window.document, doc); assert.equal(doc.querySelector('#abc-worker-status'), worker);
    assert.equal(dom.window.location.href, list); assert.equal(doc.querySelector('iframe'), null);
  } finally { dom.window.close(); }
});

test('a failed canonical navigation falls back to the observed list row', async t => {
  const { dom, adapter } = load();
  try {
    const identity = await adapter.identify();
    const push = dom.window.history.pushState.bind(dom.window.history);
    let rejected = false;
    t.mock.method(dom.window.history, 'pushState', (data: unknown, unused: string, url?: string | URL | null) => {
      if (!rejected && String(url).endsWith('/edit')) { rejected = true; throw new Error('SPA history temporarily unavailable'); }
      push(data, unused, url);
    });
    const actual = await adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '60');
    assert.equal(rejected, true); assert.equal(actual.verified, true); assert.equal(actual.unitId, unitId);
  } finally { dom.window.close(); }
});

test('an unrelated displayed ID cannot satisfy the canonical unit read', async t => {
  const dom = new JSDOM(saved, { url: list.replace('/list', '/3333333003/edit') });
  try {
    dom.window.sessionStorage.setItem('abc:live-identity:2222222222', JSON.stringify({ publisherId: 'pub-1111111111111111', appId: 'ca-app-pub-1111111111111111~2222222222', appName: '测试应用', evidence: [] }));
    const adapter = new AdMobAdapter(dom.window.document, 500);
    const identity = await adapter.identify();
    let fallback = false;
    t.mock.method(adapter, 'home', async () => { fallback = true; throw new AdapterError('STRUCTURE', 'Unrelated saved unit rejected'); });
    await assert.rejects(adapter.verifyById(identity, unitId.replace('3333333003', '9999999999'), '脱敏插页100', 'interstitial', '100'), /Unrelated saved unit rejected/);
    assert.equal(fallback, true);
  } finally { dom.window.close(); }
});

test('list cleanup failure preserves exact saved proof without navigating the worker back', async t => {
  const { dom, adapter } = load();
  try {
    const identity = await adapter.identify();
    const push = dom.window.history.pushState.bind(dom.window.history);
    const replace = dom.window.history.replaceState.bind(dom.window.history);
    t.mock.method(dom.window.history, 'pushState', (data: unknown, unused: string, url?: string | URL | null) => {
      if (String(url).endsWith('/adunits/list')) throw new Error('list cleanup unavailable');
      push(data, unused, url);
    });
    t.mock.method(dom.window.history, 'back', () => { throw new Error('must preserve the verified document'); });
    t.mock.method(dom.window.history, 'replaceState', (data: unknown, unused: string, url?: string | URL | null) => {
      if (String(url).endsWith('/adunits/list')) throw new Error('list cleanup unavailable');
      replace(data, unused, url);
    });
    const actual = await adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '60');
    assert.equal(actual.verified, true); assert.equal(actual.unitId, unitId); assert.equal(actual.floor, '60');
    assert.match(dom.window.location.pathname, /3333333003\/edit$/);
  } finally { dom.window.close(); }
});

test('known-ID routing permits a detail load beyond four seconds before accepting settled fields', async t => {
  const { dom, adapter } = load();
  try {
    adapter.timeout = 6500;
    const identity = await adapter.identify();
    const fixture = (dom.window as unknown as { fixture: { units: unknown[]; renderDetail(unit: unknown): void } }).fixture;
    const dispatch = dom.window.dispatchEvent.bind(dom.window);
    let scheduled = false;
    t.mock.method(dom.window, 'dispatchEvent', (event: Event) => {
      if (event.type === 'popstate' && dom.window.location.pathname.endsWith('/3333333003/edit')) {
        if (!scheduled) { scheduled = true; dom.window.setTimeout(() => fixture.renderDetail(fixture.units[2]), 4500); }
        return true;
      }
      return dispatch(event);
    });
    t.mock.method(adapter, 'home', async () => { throw new Error('a pending known-ID load must not fall back to stale list search'); });
    const actual = await adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '60');
    assert.equal(scheduled, true); assert.equal(actual.verified, true); assert.equal(actual.unitId, unitId);
  } finally { dom.window.close(); }
});

test('known-ID routing safely repeats the SPA signal once when the first event was ignored', async t => {
  const { dom, adapter } = load();
  try {
    adapter.timeout = 500;
    const identity = await adapter.identify();
    const dispatch = dom.window.dispatchEvent.bind(dom.window);
    let detailSignals = 0;
    t.mock.method(dom.window, 'dispatchEvent', (event: Event) => {
      if (event.type === 'popstate' && dom.window.location.pathname.endsWith('/3333333003/edit') && ++detailSignals === 1) return true;
      return dispatch(event);
    });
    t.mock.method(adapter, 'home', async () => { throw new Error('successful direct retry must not search the list'); });
    const actual = await adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '60');
    assert.equal(detailSignals, 2); assert.equal(actual.unitId, unitId); assert.equal(actual.verified, true);
  } finally { dom.window.close(); }
});

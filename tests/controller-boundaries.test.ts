import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { Controller } from '../src/controller.ts';
import { AdMobAdapter } from '../src/adapter.ts';
import { mountPanel } from '../src/panel.ts';
import { createBatch, parseInput, exportCsv } from '../src/core.ts';
import type { Adapter, Identity } from '../src/types.ts';

const appA: Identity = { publisherId: 'pub-1234567890123456', appId: 'ca-app-pub-1234567890123456~1111111111', appName: 'App A', evidence: [] };
const appB: Identity = { ...appA, appId: 'ca-app-pub-1234567890123456~2222222222', appName: 'App B' };
const noop = async () => {};
function globals(t: TestContext, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
}
function memory(t: TestContext): Map<string, unknown> {
  const storage = new Map<string, unknown>();
  globals(t, {
    GM_getValue: (key: string, fallback?: unknown) => structuredClone(storage.has(key) ? storage.get(key) : fallback),
    GM_setValue: (key: string, value: unknown) => storage.set(key, structuredClone(value)),
    GM_listValues: () => [...storage.keys()],
  });
  return storage;
}
function panelFixture(t: TestContext) {
  const dom = new JSDOM('<body></body>', { url: 'https://admob.google.com/v2/apps/1111111111/adunits/list' });
  globals(t, { document: dom.window.document, location: dom.window.location });
  const storage = memory(t);
  let live = appA;
  let submissions = 0;
  const adapter: Adapter = {
    identify: async () => structuredClone(live), home: noop, diagnostics: () => ({}),
    lookup: async () => ({ complete: true, matches: [] }), prepare: noop,
    submit: async () => { submissions++; }, verify: async () => { throw new Error('No verification expected'); },
  };
  const controller = new Controller(adapter);
  controller.identity = structuredClone(appA); controller.lockRelease = () => {}; controller.lockedPublisher = appA.publisherId;
  const panel = mountPanel({
    identify: () => controller.identify(), preflight: config => controller.preflight(config), start: config => controller.start(config),
    pause: noop, resume: noop, stop: noop, retry: noop, verify: noop, degrade: noop, export: noop, copy: noop, diagnostics: noop, probe: noop,
  });
  controller.panel = panel; panel.update({ identity: appA });
  const root = dom.window.document.getElementById('abc-panel-host')!.shadowRoot!;
  const paste = root.querySelector('textarea')!;
  paste.value = 'Unit,60'; paste.dispatchEvent(new dom.window.Event('input'));
  const execution = root.querySelector<HTMLSelectElement>('[aria-label="执行方式"]')!;
  execution.value = 'single'; execution.dispatchEvent(new dom.window.Event('change'));
  const confirmation = root.querySelector<HTMLInputElement>('[type="checkbox"]')!;
  const confirm = () => { confirmation.checked = true; confirmation.dispatchEvent(new dom.window.Event('change')); };
  confirm();
  t.after(() => { panel.destroy(); dom.window.close(); });
  return { controller, adapter, panel, root, confirmation, confirm, storage, setLive: (identity: Identity) => { live = identity; }, submissions: () => submissions };
}

test('a stale SPA confirmation cannot start another application; reconfirming the new identity can', async t => {
  const f = panelFixture(t);
  assert.ok(f.root.querySelector('.identity')!.textContent!.includes('App A'));
  f.setLive(appB);
  const start = f.root.querySelector<HTMLButtonElement>('[data-action="start"]')!;
  start.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.batch, undefined);
  assert.equal(f.confirmation.checked, false);
  assert.equal(f.panel.getConfig().confirmedIdentity, undefined);
  assert.match(f.root.querySelector('.notice')!.textContent!, /确认不一致/);
  assert.ok(![...f.storage.keys()].some(key => key.includes('active:')));
  f.confirm(); start.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.batch!.identity.appId, appB.appId);
  assert.equal(f.controller.batch!.phase, 'running');
  assert.equal(f.submissions(), 0);
});

test('changing identity during preflight never confirms its draft', async t => {
  const f = panelFixture(t);
  let reads = 0;
  f.adapter.identify = async () => structuredClone(++reads === 1 ? appA : appB);
  await assert.rejects(() => f.controller.start(f.panel.getConfig()), /确认不一致/);
  assert.equal(f.controller.batch!.phase, 'draft');
  assert.equal(f.controller.batch!.confirmedAt, undefined);
  assert.equal(f.controller.batch!.identity.appId, appA.appId);
  assert.equal(f.confirmation.checked, false);
  assert.ok(![...f.storage.keys()].some(key => key.includes('active:')));
});

test('a publisher switch and an identification failure invalidate confirmation before any batch starts', async t => {
  const f = panelFixture(t);
  const other = { ...appB, publisherId: 'pub-9999999999999999', appId: 'ca-app-pub-9999999999999999~2222222222' };
  f.setLive(other);
  await assert.rejects(() => f.controller.start(f.panel.getConfig()), /确认不一致/);
  assert.equal(f.controller.batch, undefined); assert.equal(f.confirmation.checked, false);
  f.confirm();
  f.adapter.identify = async () => { throw new Error('Cannot identify this page'); };
  await assert.rejects(() => f.controller.identify(), /Cannot identify/);
  assert.equal(f.confirmation.checked, false); assert.equal(f.panel.getConfig().confirmedIdentity, undefined);
  assert.equal(f.confirmation.disabled, true);
  f.adapter.identify = async () => structuredClone(appA);
  await f.controller.identify();
  assert.equal(f.confirmation.checked, false);
});

test('start requires an explicit identity confirmation', async t => {
  const f = panelFixture(t);
  const config = f.panel.getConfig(); delete config.confirmedIdentity;
  await assert.rejects(() => f.controller.start(config), /确认不一致/);
  assert.equal(f.controller.batch, undefined); assert.equal(f.submissions(), 0);
});

test('a real same-name old receipt on the controller cannot certify a new worker assignment', async t => {
  const html = readFileSync(new URL('./live_fixture.html', import.meta.url), 'utf8');
  const receipt = new JSDOM(readFileSync(new URL('./fixtures/success-instructions.html', import.meta.url), 'utf8'));
  const dom = new JSDOM(html, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/list', runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => { dom.window.close(); receipt.window.close(); });
  memory(t);
  const adapter = new AdMobAdapter(dom.window.document, 1000);
  const identity = await adapter.identify();
  const fixture = (dom.window as unknown as { fixture: { units: object[]; state: { clicks: unknown[] } } }).fixture;
  const oldId = 'ca-app-pub-1111111111111111/4444444444', name = '脱敏插页200';
  fixture.units.push({ name, unitId: oldId, format: 'interstitial', floor: '200', mode: 'manual' });
  dom.window.history.pushState({}, '', '/v2/apps/2222222222/adunits/create');
  dom.window.document.getElementById('app')!.innerHTML = receipt.window.document.querySelector('main')!.innerHTML;
  assert.equal(adapter.recoverCreatedId(identity, name, 'interstitial'), oldId, 'the old receipt really does match these user fields');
  const controller = new Controller(adapter);
  controller.panel = { update() {}, destroy() {}, getConfig() { throw new Error('unused'); } };
  controller.identity = identity; controller.lockRelease = () => {}; controller.lockedPublisher = identity.publisherId;
  const batch = createBatch(parseInput(`${name},200`), identity, 'interstitial', 2, 'tabs', dom.window.location.href, controller.id);
  batch.phase = 'paused'; controller.batch = batch;
  const intentAt = new Date().toISOString();
  Object.assign(batch.tasks[0], { status: 'uncertain', intentAt, assignmentId: 'new-assignment', workerId: 'new-worker' });
  controller.save(); await controller.verify();
  assert.equal(batch.tasks[0].status, 'uncertain'); assert.equal(batch.tasks[0].actual, undefined);
  assert.equal(batch.tasks[0].assignmentId, 'new-assignment'); assert.equal(batch.tasks[0].intentAt, intentAt);
  assert.equal(fixture.state.clicks.length, 0); assert.ok(!exportCsv(batch, 'success').includes(oldId));
});

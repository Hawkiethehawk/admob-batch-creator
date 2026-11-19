import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountPanel } from '../src/panel.ts';
import type { PanelActions, PanelConfig } from '../src/panel.ts';
import type { Identity } from '../src/types.ts';

const appA: Identity = { publisherId: 'pub-1234567890123456', appId: 'ca-app-pub-1234567890123456~1111111111', appName: 'App A', evidence: [] };
const appB: Identity = { ...appA, appId: 'ca-app-pub-1234567890123456~2222222222', appName: 'App B' };
const ids = (identity: Identity) => ({ publisherId: identity.publisherId, appId: identity.appId });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(overrides: Partial<PanelActions> = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://apps.admob.com/v2/apps/1111111111/adunits/list' });
  Object.assign(globalThis, { document: dom.window.document });
  const no = async () => {};
  const panel = mountPanel({ identify: no, preflight: no, start: no, pause: no, resume: no, stop: no, retry: no, verify: no, degrade: no, export: no, copy: no, diagnostics: no, probe: no, ...overrides });
  const root = dom.window.document.querySelector('#abc-panel-host')!.shadowRoot!;
  const start = root.querySelector<HTMLButtonElement>('[data-action=start]')!;
  const edit = (label: string, value: string) => {
    const input = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    assert.ok(input, label); input.value = value; input.dispatchEvent(new dom.window.Event('input'));
  };
  const addRow = (name = 'UNIT', floor = '60') => {
    [...root.querySelectorAll('button')].find(button => button.textContent === '增加一行')!.click();
    const line = panel.getConfig().rows.at(-1)!.line;
    edit(`第 ${line} 行广告位名称`, name); edit(`第 ${line} 行底价 USD`, floor);
  };
  const confirm = () => {
    const button = root.querySelector<HTMLButtonElement>('[data-action="confirm-create"]');
    assert.ok(button, 'preview confirmation is present'); button.click();
  };
  const dialog = () => root.querySelector<HTMLDialogElement>('[role="dialog"][open]');
  return { dom, panel, root, start, addRow, confirm, dialog, edit, dispose() { panel.destroy(); dom.window.close(); } };
}

test('opening creation preview requires a valid explicitly identified publisher and app', async () => {
  const calls: PanelConfig[] = [];
  const ui = fixture({ start: async config => { calls.push(config); } });
  try {
    ui.addRow(); assert.equal(ui.start.disabled, true);
    ui.start.click(); await tick(); assert.equal(ui.dialog(), null); assert.equal(calls.length, 0);
    for (const identity of [{ ...appA, appId: 'invalid' }, { ...appA, publisherId: 'pub-9999999999999999' }]) {
      ui.panel.update({ identity }); assert.equal(ui.start.disabled, true);
      ui.start.click(); await tick(); assert.equal(ui.dialog(), null); assert.equal(calls.length, 0);
    }
    ui.panel.update({ identity: appA }); assert.equal(ui.start.disabled, false);
    ui.start.click(); await tick(); assert.ok(ui.dialog()); assert.equal(calls.length, 0);
    ui.confirm(); await tick(); assert.equal(calls.length, 1); assert.deepEqual(calls[0].confirmedIdentity, ids(appA));
  } finally { ui.dispose(); }
});

test('modal confirmation passes the displayed identity snapshot to the controller after a stale SPA navigation', async () => {
  const received: PanelConfig[] = [];
  const ui = fixture({ start: async config => { received.push(config); } });
  try {
    ui.panel.update({ identity: appA }); ui.addRow(); ui.start.click(); await tick();
    assert.ok(ui.dialog()); assert.equal(received.length, 0);
    ui.panel.update({ identity: structuredClone(appA), notice: '同一身份的状态刷新' });
    assert.ok(ui.dialog());
    // Unidentified SPA navigation must preserve the displayed confirmation
    // snapshot so the controller can reject a different live identity.
    ui.dom.window.history.pushState({}, '', '/v2/apps/2222222222/adunits/list');
    ui.confirm(); await tick(); assert.equal(received.length, 1);
    assert.deepEqual(received[0].confirmedIdentity, ids(appA));
    received[0].confirmedIdentity!.appId = appB.appId;
    assert.notDeepEqual(ui.panel.getConfig().confirmedIdentity, ids(appB), 'callback mutation cannot change panel identity');
  } finally { ui.dispose(); }
});

test('identity changes, missing identity and identification errors invalidate an open preview before dispatch', async t => {
  for (const change of [
    { name: 'app switch', state: { identity: appB } },
    { name: 'publisher switch', state: { identity: { ...appB, publisherId: 'pub-9999999999999999', appId: 'ca-app-pub-9999999999999999~2222222222' } } },
    { name: 'identification error', state: { identityError: '无法确认当前应用' } },
    { name: 'missing identity', state: { identity: undefined } },
  ]) await t.test(change.name, async () => {
    const calls: PanelConfig[] = []; const ui = fixture({ start: async config => { calls.push(config); } });
    try {
      ui.panel.update({ identity: appA }); ui.addRow(); ui.start.click(); await tick();
      const staleConfirm = ui.root.querySelector<HTMLButtonElement>('[data-action="confirm-create"]')!; assert.ok(staleConfirm);
      ui.panel.update(change.state); staleConfirm.click(); await tick();
      assert.equal(calls.length, 0); assert.equal(ui.panel.getConfig().confirmedIdentity, undefined);
      assert.ok(!ui.dialog() || ui.dialog()!.hidden);
      ui.panel.update({ identity: appB, identityError: '' }); assert.equal(calls.length, 0);
      ui.start.click(); await tick(); ui.confirm(); await tick();
      assert.equal(calls.length, 1); assert.deepEqual(calls[0].confirmedIdentity, ids(appB));
    } finally { ui.dispose(); }
  });
});

test('an identity object mutated in place cannot change or reuse an open confirmation snapshot', async () => {
  const received: PanelConfig[] = []; const ui = fixture({ start: async config => { received.push(config); } });
  try {
    const mutableIdentity = structuredClone(appA);
    ui.panel.update({ identity: mutableIdentity }); ui.addRow(); ui.start.click(); await tick();
    const stale = ui.root.querySelector<HTMLButtonElement>('[data-action="confirm-create"]')!;
    mutableIdentity.appId = appB.appId;
    ui.panel.update({ identity: mutableIdentity }); stale.click(); await tick();
    assert.equal(received.length, 0); assert.equal(ui.panel.getConfig().confirmedIdentity, undefined);
    assert.equal(ui.dialog(), null);
    ui.start.click(); await tick(); ui.confirm(); await tick();
    assert.equal(received.length, 1); assert.deepEqual(received[0].confirmedIdentity, ids(appB));
  } finally { ui.dispose(); }
});

test('row edits and cancel invalidate a preview; an old detached confirmation never submits', async () => {
  const received: PanelConfig[] = []; const ui = fixture({ start: async config => { received.push(config); } });
  try {
    ui.panel.update({ identity: appA }); ui.addRow(); ui.start.click(); await tick();
    const stale = ui.root.querySelector<HTMLButtonElement>('[data-action="confirm-create"]')!;
    ui.edit('第 1 行底价 USD', '61'); stale.click(); await tick();
    assert.equal(received.length, 0); assert.ok(!ui.dialog() || ui.dialog()!.hidden);
    ui.start.click(); await tick();
    const canceled = ui.root.querySelector<HTMLButtonElement>('[data-action="confirm-create"]')!;
    ui.root.querySelector<HTMLButtonElement>('[data-action="cancel-preview"]')!.click(); await tick();
    canceled.click(); await tick(); assert.equal(received.length, 0);
    ui.start.click(); await tick(); ui.confirm(); await tick();
    assert.equal(received.length, 1); assert.equal(received[0].rows[0].floor, '61');
  } finally { ui.dispose(); }
});

test('mode changes preserve literal manually entered names without imported-header special cases', () => {
  const ui = fixture();
  try {
    ui.addRow('广告位名称', '60'); ui.addRow('A  help_outline', '40');
    const mode = ui.root.querySelector<HTMLSelectElement>('[aria-label="底价模式"]')!;
    for (const value of ['auto', 'disabled', 'manual']) {
      mode.value = value; mode.dispatchEvent(new ui.dom.window.Event('change'));
      assert.deepEqual(ui.panel.getConfig().rows.map(row => [row.name, row.floor]), [['广告位名称', '60'], ['A  help_outline', '40']]);
    }
  } finally { ui.dispose(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountPanel } from '../src/panel.ts';
import type { PanelActions, PanelConfig } from '../src/panel.ts';
import type { FloorMode, Identity } from '../src/types.ts';

const appA: Identity = { publisherId: 'pub-1234567890123456', appId: 'ca-app-pub-1234567890123456~1111111111', appName: 'App A', evidence: [] };
const appB: Identity = { ...appA, appId: 'ca-app-pub-1234567890123456~2222222222', appName: 'App B' };
const ids = (identity: Identity) => ({ publisherId: identity.publisherId, appId: identity.appId });

function fixture(overrides: Partial<PanelActions> = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://apps.admob.com/v2/apps/1111111111/adunits/list' });
  Object.assign(globalThis, { document: dom.window.document });
  const no = async () => {};
  const panel = mountPanel({ identify: no, preflight: no, start: no, pause: no, resume: no, stop: no, retry: no, verify: no, degrade: no, export: no, copy: no, diagnostics: no, probe: no, ...overrides });
  const root = dom.window.document.querySelector('#abc-panel-host')!.shadowRoot!;
  const paste = root.querySelector('textarea')!;
  const confirm = root.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  const start = root.querySelector<HTMLButtonElement>('[data-action=start]')!;
  const mode = root.querySelector<HTMLSelectElement>('[aria-label="底价模式"]')!;
  const load = (text: string) => { paste.value = text; paste.dispatchEvent(new dom.window.Event('input')); };
  const chooseMode = (value: FloorMode) => { mode.value = value; mode.dispatchEvent(new dom.window.Event('change')); };
  const check = () => { confirm.checked = true; confirm.dispatchEvent(new dom.window.Event('change')); };
  const edit = (label: string, value: string) => {
    const input = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    input.value = value; input.dispatchEvent(new dom.window.Event('input'));
  };
  return { dom, panel, root, paste, confirm, start, load, chooseMode, check, edit, dispose() { panel.destroy(); dom.window.close(); } };
}

test('confirmation requires an explicitly identified publisher and app', () => {
  const ui = fixture();
  try {
    ui.load('UNIT,60');
    assert.equal(ui.confirm.disabled, true);
    ui.check();
    assert.equal(ui.confirm.checked, false);
    assert.equal(ui.panel.getConfig().confirmedIdentity, undefined);
    assert.equal(ui.start.disabled, true);
    for (const identity of [{ ...appA, appId: 'invalid' }, { ...appA, publisherId: 'pub-9999999999999999' }]) {
      ui.panel.update({ identity });
      ui.check();
      assert.equal(ui.confirm.disabled, true);
      assert.equal(ui.start.disabled, true);
    }
    ui.panel.update({ identity: appA });
    assert.equal(ui.confirm.disabled, false);
    ui.check();
    assert.equal(ui.start.disabled, false);
  } finally { ui.dispose(); }
});

test('start passes the displayed identity captured when the user confirmed', async () => {
  const received: PanelConfig[] = [];
  const ui = fixture({ start: async config => { received.push(config); } });
  try {
    ui.panel.update({ identity: appA });
    ui.load('UNIT,60'); ui.check();
    assert.deepEqual(ui.panel.getConfig().confirmedIdentity, ids(appA));
    const detached = ui.panel.getConfig();
    detached.confirmedIdentity!.appId = appB.appId;
    ui.panel.update({ identity: structuredClone(appA), notice: '同一身份的状态刷新' });
    assert.equal(ui.confirm.checked, true);
    // A SPA navigation has not yet been identified: the controller must receive
    // the old confirmation snapshot so it can reject the new live identity.
    ui.dom.window.history.pushState({}, '', '/v2/apps/2222222222/adunits/list');
    ui.start.click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].confirmedIdentity, ids(appA));
  } finally { ui.dispose(); }
});

test('identity changes and identification errors invalidate the confirmation snapshot', () => {
  const ui = fixture();
  try {
    ui.panel.update({ identity: appA }); ui.load('UNIT,60'); ui.check();
    ui.panel.update({ identity: appB });
    assert.equal(ui.confirm.checked, false);
    assert.equal(ui.panel.getConfig().confirmedIdentity, undefined);
    assert.equal(ui.start.disabled, true);
    ui.check(); assert.deepEqual(ui.panel.getConfig().confirmedIdentity, ids(appB));
    ui.panel.update({ identityError: '无法确认当前应用' });
    assert.equal(ui.confirm.checked, false); assert.equal(ui.confirm.disabled, true);
    assert.equal(ui.panel.getConfig().confirmedIdentity, undefined);
    ui.panel.update({ identity: appB, identityError: '' });
    assert.equal(ui.confirm.checked, false); assert.equal(ui.start.disabled, true);
    ui.check(); ui.panel.update({ identity: undefined });
    assert.equal(ui.confirm.checked, false); assert.equal(ui.confirm.disabled, true);
    assert.equal(ui.panel.getConfig().confirmedIdentity, undefined);
    ui.panel.update({ identity: appA }); ui.check();
    ui.edit('第 1 行广告位名称', 'EDITED');
    assert.equal(ui.confirm.checked, false);
    assert.equal(ui.panel.getConfig().confirmedIdentity, undefined);
    const mutableIdentity = structuredClone(appA);
    ui.panel.update({ identity: mutableIdentity }); ui.check();
    mutableIdentity.appId = appB.appId;
    assert.deepEqual(ui.panel.getConfig().confirmedIdentity, ids(appA));
    ui.panel.update({ identity: mutableIdentity });
    assert.equal(ui.confirm.checked, false);
    assert.equal(ui.panel.getConfig().confirmedIdentity, undefined);
  } finally { ui.dispose(); }
});

test('switching a pasted name-only list to a nonmanual mode removes its header and preserves edits', async t => {
  for (const mode of ['auto', 'disabled'] as const) await t.test(mode, () => {
    const ui = fixture();
    try {
      ui.panel.update({ identity: appA });
      ui.load('广告位名称\nA\nB');
      ui.edit('第 2 行广告位名称', 'A_EDITED');
      const prefix = ui.root.querySelector<HTMLInputElement>('[aria-label="名称前缀"]')!;
      prefix.value = 'prefix_';
      [...ui.root.querySelectorAll('button')].find(button => button.textContent === '批量应用前缀')!.click();
      ui.chooseMode(mode);
      const rows = ui.panel.getConfig().rows;
      assert.deepEqual(rows.map(row => [row.line, row.name]), [[2, 'prefix_A_EDITED'], [3, 'prefix_B']]);
      assert.ok(rows.every(row => row.errors.length === 0));
      assert.ok(!ui.paste.value.includes('广告位名称'));
      ui.check(); assert.equal(ui.start.disabled, false);
      ui.chooseMode('manual');
      assert.deepEqual(ui.panel.getConfig().rows.map(row => row.name), ['prefix_A_EDITED', 'prefix_B']);
      assert.ok(ui.panel.getConfig().rows.every(row => row.errors.includes('缺失底价')));
    } finally { ui.dispose(); }
  });
});

test('a user-edited header or a real two-column name is retained across a mode change', () => {
  const ui = fixture();
  try {
    ui.load('广告位名称\nA');
    ui.edit('第 1 行广告位名称', 'INTENDED_UNIT');
    ui.chooseMode('auto');
    assert.deepEqual(ui.panel.getConfig().rows.map(row => row.name), ['INTENDED_UNIT', 'A']);
    ui.chooseMode('manual');
    ui.load('广告位名称,60\nB,40');
    ui.chooseMode('disabled');
    assert.deepEqual(ui.panel.getConfig().rows.map(row => [row.name, row.floor]), [['广告位名称', '60'], ['B', '40']]);
  } finally { ui.dispose(); }
});

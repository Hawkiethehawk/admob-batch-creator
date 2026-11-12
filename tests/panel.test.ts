import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountPanel } from '../src/panel.ts';
import type { PanelActions, PanelConfig } from '../src/panel.ts';
import { createBatch, parseInput } from '../src/core.ts';
import type { Batch } from '../src/types.ts';

function fixture(overrides: Partial<PanelActions> = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://apps.admob.com/' });
  Object.assign(globalThis, { document: dom.window.document });
  const no = async () => {};
  const handle = mountPanel({ identify: no, preflight: no, start: no, pause: no, resume: no, stop: no, retry: no, verify: no, degrade: no, export: no, copy: no, diagnostics: no, probe: no, ...overrides });
  const root = dom.window.document.querySelector('#abc-panel-host')!.shadowRoot!;
  const button = (text: string) => {
    const found = [...root.querySelectorAll('button')].find(node => node.textContent === text);
    assert.ok(found, `button missing: ${text}`); return found;
  };
  const paste = root.querySelector('textarea')!;
  const load = (text: string) => {
    paste.value = text; paste.dispatchEvent(new dom.window.Event('input', { bubbles: true })); button('解析到清单').click();
  };
  const confirm = (value = true) => {
    const checkbox = root.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    checkbox.checked = value; checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, handle, root, button, paste, load, confirm, dispose() { handle.destroy(); dom.window.close(); } };
}
const identity = { publisherId: 'pub-1234567890123456', appId: 'ca-app-pub-1234567890123456~1234567890', appName: '测试应用', evidence: [] };
function batch(): Batch {
  const created = createBatch(parseInput('广告位名称,底价USD\nA,60\nB,40'), identity, 'interstitial', 2, 'tabs', 'https://apps.admob.com/', 'controller-test');
  created.confirmedAt = new Date().toISOString(); return created;
}

test('CSV/Excel 清单保留原始行号、逗号名称及每行独立底价', () => {
  const ui = fixture();
  try {
    ui.load('\uFEFF广告位名称,底价USD\r\n"A,B",60\r\nC,40');
    assert.deepEqual(ui.handle.getConfig().rows.map(row => [row.line, row.name, row.floor]), [[2, 'A,B', '60'], [3, 'C', '40']]);
    assert.equal(ui.handle.getConfig().concurrency, 2);
    ui.load('广告位名称\t底价USD\nExcel A\t20\nExcel B\t15');
    assert.deepEqual(ui.handle.getConfig().rows.map(row => [row.name, row.floor]), [['Excel A', '20'], ['Excel B', '15']]);
  } finally { ui.dispose(); }
});

test('预检通过和整批确认缺一不可，修改清单后必须重新预检', () => {
  const ui = fixture();
  try {
    ui.load('A,60\nB,40');
    ui.confirm(); assert.equal(ui.button('开始创建').disabled, true);
    ui.handle.update({ ready: true, checks: [{ label: '预检通过', ok: true }] });
    assert.equal(ui.button('开始创建').disabled, false);
    ui.confirm(false); assert.equal(ui.button('开始创建').disabled, true);
    ui.confirm();
    const name = ui.root.querySelector<HTMLInputElement>('.input-table input')!;
    name.focus(); name.value = 'A edited'; name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    assert.equal(ui.button('开始创建').disabled, true);
    assert.equal(ui.root.activeElement, name, '行内修改不重建输入控件或打断焦点');
    ui.handle.update({ identity, notice: '只更新状态' });
    assert.equal(ui.root.activeElement, name);
    assert.equal(ui.handle.getConfig().rows[0].name, 'A edited');
    ui.paste.value = 'C,10'; ui.paste.dispatchEvent(new ui.dom.window.Event('input'));
    assert.equal(ui.button('预检（不提交）').disabled, true, '未解析的粘贴修改不能使用旧清单预检');
  } finally { ui.dispose(); }
});

test('解析错误、重复名称与空新增行不会被表格序列化吞掉', () => {
  const ui = fixture();
  try {
    ui.load('A,60,unexpected');
    assert.match(ui.handle.getConfig().rows[0].errors.join(' '), /两列/);
    assert.equal(ui.button('预检（不提交）').disabled, true);
    ui.load('A,60\nA,40');
    assert.ok(ui.handle.getConfig().rows.every(row => row.errors.some(error => error.includes('重复'))));
    ui.load('A,60\nB,40'); ui.button('增加一行').click();
    const rows = ui.handle.getConfig().rows;
    assert.equal(rows.length, 3); assert.equal(rows[1].errors.length, 0); assert.ok(rows[2].errors.length);
    const remove = [...ui.root.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === '删除第 3 行')!;
    remove.click(); assert.equal(ui.button('预检（不提交）').disabled, false);
  } finally { ui.dispose(); }
});

test('活动与暂停批次冻结配置，结束批次可以预检新清单', () => {
  const ui = fixture();
  try {
    ui.load('A,60\nB,40');
    ui.handle.update({ ready: true }); ui.confirm();
    assert.equal(ui.button('开始创建').disabled, false);
    const current = batch(); current.phase = 'running'; ui.handle.update({ batch: current });
    assert.equal(ui.button('暂停').disabled, false);
    assert.equal(ui.button('降级为单页').disabled, false);
    assert.equal(ui.button('继续').disabled, true);
    assert.equal(ui.button('预检（不提交）').disabled, true);
    assert.equal(ui.paste.disabled, true);
    current.phase = 'paused'; ui.handle.update({ batch: current });
    assert.equal(ui.button('暂停').disabled, true);
    assert.equal(ui.button('继续').disabled, false);
    assert.equal(ui.button('降级为单页').disabled, false);
    assert.equal(ui.button('预检（不提交）').disabled, true);
    current.phase = 'done'; ui.handle.update({ batch: current });
    assert.equal(ui.paste.disabled, false);
    assert.equal(ui.button('预检（不提交）').disabled, false);
    assert.equal(ui.button('继续').disabled, true);
    assert.equal(ui.button('降级为单页').disabled, true);
    assert.equal(ui.button('开始创建').disabled, true, '结束批次不能用残留的ready与确认状态再次开始');
    current.phase = 'paused'; delete current.confirmedAt; ui.handle.update({ batch: current });
    assert.equal(ui.button('继续').disabled, true, '未确认开始的草稿不能通过继续绕过整批确认');
    current.confirmedAt = new Date().toISOString(); current.stopRequestedAt = new Date().toISOString(); ui.handle.update({ batch: current });
    assert.equal(ui.button('继续').disabled, true, '持久化停止意图禁止通过继续重新派发');
  } finally { ui.dispose(); }
});

test('未确认草稿允许停止，并且不会触发开始', async () => {
  let stops = 0, starts = 0;
  const ui = fixture({ stop: async () => { stops++; }, start: async () => { starts++; } });
  try {
    const current = batch(); delete current.confirmedAt; current.phase = 'draft';
    ui.handle.update({ batch: current });
    assert.equal(ui.button('停止').disabled, false);
    assert.equal(ui.button('继续').disabled, true);
    ui.button('停止').click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 1); assert.equal(starts, 0);
  } finally { ui.dispose(); }
});

test('执行日志显示中文步骤、批次累计耗时与本行间隔，保留原因并隐藏凭证', () => {
  const ui = fixture();
  try {
    const current = batch(); current.createdAt = '2026-11-12T00:00:00.000Z';
    current.tasks[0].logs = [
      { at: '2026-11-12T00:00:01.000Z', step: 'filling', message: '开始填表' },
      { at: '2026-11-12T00:00:02.250Z', step: 'submitting', message: '提交意图已保存' },
      { at: '2026-11-12T00:00:03.500Z', step: 'uncertain', message: '保存配置未确认 token=secret-token password="secret password" Bearer secret-bearer Cookie: sid=secret-cookie; session=secret-session' },
      { at: '时间无效', step: 'failed', message: '时间无法解释' },
    ];
    ui.handle.update({ batch: current });
    const log = ui.root.querySelector('.log')!.textContent!;
    assert.match(log, /填表中 · 累计耗时 1\.000 秒 \/ 本行上步间隔 1\.000 秒/);
    assert.match(log, /提交中 · 累计耗时 2\.250 秒 \/ 本行上步间隔 1\.250 秒/);
    assert.match(log, /结果不确定/); assert.match(log, /保存配置未确认/);
    assert.match(log, /累计耗时 未知 \/ 本行上步间隔 未知/);
    assert.doesNotMatch(log, /filling|submitting|NaN|secret-token|secret password|secret-bearer|secret-cookie|secret-session/);
    assert.match(log, /凭证已隐藏/);
  } finally { ui.dispose(); }
});

test('重试仅开放无提交意图的明确失败项，配置待核验项进入核验', () => {
  const ui = fixture();
  try {
    const current = batch(); current.phase = 'paused'; current.tasks[0].status = 'failed';
    ui.handle.update({ batch: current }); assert.equal(ui.button('重试明确失败项').disabled, false);
    current.stopRequestedAt = new Date().toISOString(); ui.handle.update({ batch: current });
    assert.equal(ui.button('重试明确失败项').disabled, false, '停止后允许用户明确重试已确认未提交的安全失败项');
    assert.equal(ui.button('继续').disabled, true, '重试操作真正执行并清理停止意图前仍禁止直接继续');
    assert.equal(ui.button('开始创建').disabled, true);
    delete current.stopRequestedAt;
    current.tasks[0].attempts = 3; ui.handle.update({ batch: current });
    assert.equal(ui.button('重试明确失败项').disabled, true, '用尽三次尝试后禁用无效重试');
    current.tasks[0].attempts = 0; current.tasks[0].actual = { unitId: 'ca-app-pub-1234567890123456/1234567890' }; ui.handle.update({ batch: current });
    assert.equal(ui.button('重试明确失败项').disabled, true, '已取得ID不可通过失败状态重新创建');
    delete current.tasks[0].actual;
    current.tasks[0].intentAt = new Date().toISOString(); ui.handle.update({ batch: current });
    assert.equal(ui.button('重试明确失败项').disabled, true);
    current.tasks[0].status = 'created-unverified'; ui.handle.update({ batch: current });
    assert.equal(ui.button('核验结果不确定项').disabled, false);
    assert.equal(ui.button('重试明确失败项').disabled, true);
    current.phase = 'stopping'; ui.handle.update({ batch: current });
    assert.equal(ui.button('核验结果不确定项').disabled, false, '停止后仍可申请核验；运行时继续检查执行页是否已安全结束');
    assert.equal(ui.button('降级为单页').disabled, true);
    current.phase = 'paused'; current.execution = 'single'; ui.handle.update({ batch: current });
    assert.equal(ui.button('降级为单页').disabled, true);
  } finally { ui.dispose(); }
});

test('面板以文本显示结果，折叠、销毁及重复挂载保护有效', () => {
  const ui = fixture();
  try {
    const current = batch(); current.phase = 'done'; current.tasks[0].name = '<img src=x onerror=alert(1)>';
    current.tasks[0].reason = '<script>throw new Error()</script>';
    ui.handle.update({ batch: current, notice: '<b>仅文本</b>' });
    assert.equal(ui.root.querySelector('img,script'), null);
    assert.ok(ui.root.textContent!.includes('<img src=x onerror=alert(1)>'));
    ui.button('收起').click(); assert.equal(ui.root.querySelector('.shell')!.classList.contains('collapsed'), true);
    ui.button('展开').click(); assert.equal(ui.root.querySelector('.shell')!.classList.contains('collapsed'), false);
    assert.throws(() => mountPanel({} as PanelActions), /已存在/);
    ui.handle.destroy(); assert.equal(ui.dom.window.document.querySelector('#abc-panel-host'), null);
  } finally { ui.dispose(); }
});

test('预检只传递当前配置，不会触发开始或提交操作', async () => {
  const received: PanelConfig[] = []; let starts = 0;
  const ui = fixture({ preflight: async config => { received.push(config); }, start: async () => { starts++; } });
  try {
    ui.load('A,60'); ui.button('预检（不提交）').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.length, 1); assert.equal(starts, 0);
    assert.equal(received[0].rows[0].floor, '60');
    received[0].rows[0].name = 'mutated'; assert.equal(ui.handle.getConfig().rows[0].name, 'A', '回调配置与面板清单隔离');
  } finally { ui.dispose(); }
});

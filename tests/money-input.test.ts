import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AdMobAdapter } from '../src/adapter.ts';
import { normalizeDecimal } from '../src/core.ts';

const html = readFileSync(new URL('./live_fixture.html', import.meta.url), 'utf8');
interface Fixture {
  renderForm(format: string): void;
  state: { clicks: { name: string; floor: string; format: string }[] };
}
async function form() {
  const dom = new JSDOM(html, {
    url: 'https://admob.google.com/v2/apps/2222222222/adunits/list', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  const adapter = new AdMobAdapter(dom.window.document, 100);
  const identity = await adapter.identify();
  const fixture = (dom.window as unknown as { fixture: Fixture }).fixture;
  fixture.renderForm('interstitial');
  const input = dom.window.document.querySelector('manual-ecpm-floor-input input') as HTMLInputElement;
  return { dom, adapter, identity, fixture, input };
}

test('native money formatting to 1,000.00 passes prepare and exactly one guarded submit', async t => {
  const { dom, adapter, identity, fixture, input } = await form();
  t.after(() => dom.window.close());
  input.addEventListener('input', () => { input.value = '1,000.00'; });
  await adapter.prepare(identity, 'interstitial', '任意名称 money_1000', '1000', async () => {});
  assert.equal(input.value, '1,000.00');
  assert.equal(adapter.prepared?.floor, '1000');
  assert.equal(fixture.state.clicks.length, 0);
  await adapter.submit();
  assert.equal(fixture.state.clicks.length, 1);
  assert.equal(fixture.state.clicks[0].name, '任意名称 money_1000');
  assert.equal(fixture.state.clicks[0].floor, '1,000.00');
  assert.equal(fixture.state.clicks[0].format, 'interstitial');
  await assert.rejects(adapter.submit(), /已经执行过提交/);
  assert.equal(fixture.state.clicks.length, 1);
  const actual = await adapter.verify(identity, 'interstitial', '任意名称 money_1000', '1000');
  assert.equal(actual.floor, '1000');
  assert.equal(actual.verified, true);
});

test('canonical money grouping applied on blur passes the final input readback without losing precision', async t => {
  const dom = new JSDOM('<manual-ecpm-floor-input><input></manual-ecpm-floor-input>');
  t.after(() => dom.window.close());
  const input = dom.window.document.querySelector('input')!;
  input.addEventListener('blur', () => { input.value = '1,234,567.89'; });
  await new AdMobAdapter(dom.window.document, 100).setInput(input, '1234567.89', '全局底价');
  assert.equal(input.value, '1,234,567.89');
});

test('malformed money formatting cannot finish prepare or click create', async t => {
  const { dom, adapter, identity, fixture, input } = await form();
  t.after(() => dom.window.close());
  input.addEventListener('input', () => { input.value = '1,00.00'; });
  await assert.rejects(adapter.prepare(identity, 'interstitial', 'invalid grouping', '1000', async () => {}), /等待输入回读/);
  assert.equal(adapter.prepared, undefined);
  assert.equal(fixture.state.clicks.length, 0);
});

test('malformed grouping or a changed amount after preparation blocks submit', async t => {
  const { dom, adapter, identity, fixture, input } = await form();
  t.after(() => dom.window.close());
  await adapter.prepare(identity, 'interstitial', 'unchanged amount required', '1000', async () => {});
  for (const displayed of ['10,00', '1,00.00', '1,000,00', '1234,567.00', '01,000.00', '1,000.00.50', '1,000,', ',1,000.00', '1 000.00', '1e3', '+1,000.00', '-1,000.00', '2,000.00']) {
    input.value = displayed;
    await assert.rejects(adapter.submit(), /名称或底价发生变化/, displayed);
    assert.equal(adapter.submitted, false);
    assert.equal(fixture.state.clicks.length, 0, displayed);
  }
});

test('malformed money grouping introduced by blur fails the final readback', async t => {
  const dom = new JSDOM('<manual-ecpm-floor-input><input></manual-ecpm-floor-input>');
  t.after(() => dom.window.close());
  const input = dom.window.document.querySelector('input')!;
  input.addEventListener('blur', () => { input.value = '1,00.00'; });
  await assert.rejects(new AdMobAdapter(dom.window.document, 100).setInput(input, '1000', '全局底价'), /页面未接受输入值/);
});

test('grouped readback stays forbidden for ordinary inputs and non-native controls', async () => {
  for (const markup of ['<input>', '<manual-ecpm-floor-input><textarea></textarea></manual-ecpm-floor-input>']) {
    const dom = new JSDOM(markup);
    try {
      const input = dom.window.document.querySelector('input,textarea') as HTMLInputElement;
      input.addEventListener('input', () => { input.value = '1,000.00'; });
      await assert.rejects(new AdMobAdapter(dom.window.document, 30).setInput(input, '1000', '普通控件'), /等待输入回读/);
    } finally { dom.window.close(); }
  }
  assert.throws(() => normalizeDecimal('1,000.00'), /千分位/);
});

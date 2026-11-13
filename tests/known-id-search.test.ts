import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AdMobAdapter, AdapterError } from '../src/adapter.ts';

const html = readFileSync(new URL('./live_fixture.html', import.meta.url), 'utf8');
const unitId = 'ca-app-pub-1111111111111111/3333333003';

for (const stale of ['unrelated rows', 'zero-total footer']) {
  test('known-ID search waits through stale ' + stale + ' until its exact row renders', async t => {
    const dom = new JSDOM(html, {
      url: 'https://admob.google.com/v2/apps/2222222222/adunits/list', runScripts: 'dangerously', pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    const adapter = new AdMobAdapter(doc, 5000);
    const identity = await adapter.identify();
    const target = doc.querySelector('a[href*="3333333003"]')!.closest('[role="row"]')!;
    const grid = doc.querySelector('[role="grid"]')!;
    target.remove();
    if (stale === 'zero-total footer') {
      for (const row of grid.querySelectorAll('.particle-table-row:not(.particle-table-header)')) row.remove();
      doc.querySelector('.table-footer')!.textContent = '第 0 - 0 行，共 0 行';
    }
    const search = doc.querySelector('input.search') as HTMLInputElement;
    let scheduled = false, rendered = false;
    search.addEventListener('input', () => {
      if (search.value !== unitId || scheduled) return;
      scheduled = true;
      // Longer than setInput's settling delays: input readback and arbitrary
      // old rows / a stale zero total do not mean filtering has completed.
      dom.window.setTimeout(() => {
        for (const row of grid.querySelectorAll('.particle-table-row:not(.particle-table-header)')) row.remove();
        grid.append(target);
        doc.querySelector('.table-footer')!.textContent = '第 1 - 1 行，共 1 行';
        rendered = true;
      }, 1200);
    });
    const actual = await adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '60');
    assert.equal(rendered, true);
    assert.equal(actual.unitId, unitId);
    assert.equal(actual.name, '目标名称');
    assert.equal(actual.verified, true);
    const fixture = (dom.window as unknown as { fixture: { state: { clicks: unknown[] } } }).fixture;
    assert.equal(fixture.state.clicks.length, 0, 'read-only verification never submits a create form');
  });
}

test('an absent exact ID waits to its deadline and preserves that known ID unverified', async t => {
  const dom = new JSDOM(html, {
    url: 'https://admob.google.com/v2/apps/2222222222/adunits/list', runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const adapter = new AdMobAdapter(doc, 5000);
  const identity = await adapter.identify();
  doc.querySelector('a[href*="3333333003"]')!.closest('[role="row"]')!.remove();
  t.mock.method(adapter, 'setInput', async (input: HTMLInputElement, value: string) => { input.value = value; });
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let settled = false;
  const waiting = adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '60').finally(() => { settled = true; });
  const rejected = assert.rejects(waiting, error => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.actual?.unitId, unitId);
    assert.notEqual(error.actual?.verified, true);
    return /未找到唯一记录/.test(error.message);
  });
  for (let index = 0; index < 12; index++) await Promise.resolve();
  t.mock.timers.tick(19999);
  for (let index = 0; index < 4; index++) await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejected;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AdMobAdapter, AdapterError } from '../src/adapter.ts';
import { normalizeDecimal } from '../src/core.ts';
import type { Identity } from '../src/types.ts';

const html = readFileSync(new URL('./fixtures/saved-detail.html', import.meta.url), 'utf8');
const unitId = 'ca-app-pub-1111111111111111/3333333003';
const identity: Identity = {
  publisherId: 'pub-1111111111111111', appId: 'ca-app-pub-1111111111111111~2222222222',
  appName: '测试应用', evidence: [],
};

function saved(summary: string) {
  const dom = new JSDOM(html, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/3333333003/edit' });
  dom.window.sessionStorage.setItem('abc:live-identity:2222222222', JSON.stringify(identity));
  dom.window.document.querySelector('#saved-floor')!.textContent = summary;
  return { dom, adapter: new AdMobAdapter(dom.window.document, 100) };
}

test('saved USD summaries accept canonical thousands grouping and preserve decimal precision', async () => {
  for (const [displayed, expected] of [
    ['1,000.00', '1000'], ['12,345.60', '12345.6'], ['1,234,567.89', '1234567.89'],
    ['1000.00', '1000'], ['999.00', '999'], ['1,000', '1000'],
  ]) {
    const { dom, adapter } = saved('全球底价设为 $' + displayed);
    try {
      const actual = await adapter.verify(identity, 'interstitial', '脱敏插页100', expected);
      assert.equal(actual.unitId, unitId);
      assert.equal(actual.floor, expected);
      assert.equal(actual.mode, 'manual');
      assert.equal(actual.currency, 'USD');
      assert.equal(actual.verified, true);
    } finally { dom.window.close(); }
  }
});

test('malformed saved grouping never verifies a valid numeric prefix', async () => {
  for (const displayed of ['10,00', '1,00.00', '1,000,00', '1234,567.00', '01,000.00', '1,000.00.50', '1,000,', '-1,000.00', ',1,000.00', '1 000.00', '1e3', '+1,000.00']) {
    const { dom, adapter } = saved('全球底价设为 $' + displayed);
    try {
      await assert.rejects(adapter.verify(identity, 'interstitial', '脱敏插页100', '1'), error => {
        assert.ok(error instanceof AdapterError, displayed);
        assert.equal(error.actual?.unitId, unitId);
        assert.equal(error.actual?.floor, undefined, displayed);
        assert.equal(error.actual?.verified, false);
        return true;
      });
    } finally { dom.window.close(); }
  }
});

test('a valid grouped amount still rejects a different requested floor', async () => {
  const { dom, adapter } = saved('全球底价设为 $1,000.00');
  try {
    await assert.rejects(adapter.verify(identity, 'interstitial', '脱敏插页100', '1'), error => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.actual?.unitId, unitId);
      assert.equal(error.actual?.floor, '1000');
      assert.equal(error.actual?.verified, false);
      return true;
    });
  } finally { dom.window.close(); }
});

test('user-entered decimals continue rejecting grouping', () => {
  assert.throws(() => normalizeDecimal('1,000.00'), /千分位/);
  assert.throws(() => normalizeDecimal('10,00'), /千分位/);
});

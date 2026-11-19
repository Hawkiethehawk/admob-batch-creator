import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AdMobAdapter } from '../src/adapter.ts';
import type { AdFormat, FloorMode, Identity } from '../src/types.ts';

const labels: Record<AdFormat, string> = {
  banner: '横幅广告', interstitial: '插页式广告', 'rewarded-interstitial': '插页式激励广告',
  rewarded: '激励广告', native: '原生高级广告', 'app-open': '开屏广告',
};
// Independent expectations from the six no-submit form captures, 2026-11-19.
const media: Record<AdFormat, string[]> = {
  banner: ['文字、图片和富媒体', '视频'], interstitial: ['文字、图片和富媒体', '视频'],
  'app-open': ['文字、图片和富媒体', '视频'], native: ['图片', '视频'],
  rewarded: ['视频', '广告连播', '互动式'], 'rewarded-interstitial': ['视频', '互动式'],
};
const formats = Object.keys(labels) as AdFormat[];
const source = readFileSync(new URL('./live_fixture.html', import.meta.url), 'utf8');
const fixtureHtml = source
  .replace(/const fmt = \(f\) => [^\r\n]+;/, `const formatLabels = ${JSON.stringify(labels)}; const fmt = f => formatLabels[f];`)
  .replace("[['interstitial', '插页式广告'], ['app-open', '开屏广告'], ['native', '原生高级广告'], ['rewarded-interstitial', '插页式激励广告']]", 'Object.entries(formatLabels)')
  .replace(/state\.format = label === '开屏广告'[^;]+;/, 'state.format = Object.keys(formatLabels).find(format => formatLabels[format] === label);');
const receiptHtml = readFileSync(new URL('./fixtures/success-instructions.html', import.meta.url), 'utf8');
const identity: Identity = {
  publisherId: 'pub-1111111111111111', appId: 'ca-app-pub-1111111111111111~2222222222',
  appName: '测试应用', evidence: [],
};
interface Fixture {
  state: { page: string; format: AdFormat; clicks: { name: string; format: string; floor: string }[] };
  renderForm(format: AdFormat): void;
}

function defaults(doc: Document, format: AdFormat): void {
  const host = doc.querySelector('main')!;
  host.insertAdjacentHTML('beforeend', '<ad-media-type-card>' + media[format].map((label, index) =>
    `<material-checkbox role="checkbox" aria-checked="true" aria-labelledby="format-media-${index}"><material-icon>check_box</material-icon><div id="format-media-${index}">${label}</div></material-checkbox>`).join('') + '</ad-media-type-card>');
  if (format !== 'banner' && format !== 'native') {
    host.insertAdjacentHTML('beforeend', '<frequency-cap-card><div role="switch" aria-checked="false" aria-label="已停用">已停用</div></frequency-cap-card>');
  }
  if (format === 'rewarded' || format === 'rewarded-interstitial') {
    host.insertAdjacentHTML('beforeend', '<reward-settings-card><form-card><reward-settings-input>' +
      '<material-input class="reward-amount" type="number" checkinteger checkpositive><label id="reward-amount-label">输入奖品数量</label><input aria-labelledby="reward-amount-label" value="1" aria-invalid="false" required></material-input>' +
      '<material-input class="reward-type" multiline><textarea aria-label="输入奖品" aria-invalid="false">Reward</textarea><div aria-hidden="true" class="mirror-text">Reward</div></material-input>' +
      '</reward-settings-input></form-card></reward-settings-card>' +
      '<server-side-verification-card><span>服务器端验证</span><span>未设置</span></server-side-verification-card>');
  }
}
function load() {
  const dom = new JSDOM(fixtureHtml, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/list', runScripts: 'dangerously' });
  const doc = dom.window.document;
  const fixture = (dom.window as unknown as { fixture: Fixture }).fixture;
  // Let the original real-structure fixture choose/render/save the format;
  // append only the additional per-format default cards captured from AdMob.
  doc.addEventListener('click', () => {
    if (fixture.state.page === 'form' && !doc.querySelector('ad-media-type-card')) defaults(doc, fixture.state.format);
  });
  return { dom, doc, fixture, adapter: new AdMobAdapter(doc, 1000) };
}

test('six exact format cards select their own form, create once and verify all three floor modes', async t => {
  for (const format of formats) for (const mode of ['manual', 'auto', 'disabled'] as FloorMode[]) {
    await t.test(`${format}/${mode}`, async t => {
      const env = load(); t.after(() => env.dom.window.close());
      const account = await env.adapter.identify();
      const floor = mode === 'manual' ? '60' : '';
      const name = `FORMAT_${format}_${mode}`;
      await env.adapter.prepare(account, format, name, floor, async () => {}, mode);
      assert.equal(env.doc.querySelector('.format-label')!.textContent, labels[format]);
      assert.equal(env.fixture.state.format, format);
      assert.equal(env.fixture.state.clicks.length, 0, 'selection and preparation do not submit');
      if (format === 'rewarded' || format === 'rewarded-interstitial') {
        assert.equal((env.doc.querySelector('reward-settings-card input') as HTMLInputElement).value, '1');
        assert.equal((env.doc.querySelector('reward-settings-card textarea') as HTMLTextAreaElement).value, 'Reward');
      }
      await env.adapter.submit();
      assert.equal(env.fixture.state.clicks.length, 1);
      assert.equal(env.fixture.state.clicks[0].format, format);
      const result = await env.adapter.verify(account, format, name, floor, mode);
      assert.equal(result.verified, true);
      assert.equal(result.format, format);
      assert.equal(result.name, name);
      assert.equal(result.mode, mode);
      const byId = await env.adapter.verifyById(account, result.unitId, name, format, floor, mode);
      assert.equal(byId.format, format, 'list-cell and saved-detail formats agree');
      assert.equal(byId.unitId, result.unitId);
      assert.equal(byId.verified, true);
      assert.equal(env.fixture.state.clicks.length, 1, 'verification cannot create another unit');
    });
  }
});

test('native and rewarded media choices are format-specific and rechecked before submit', async t => {
  for (const [format, label] of [['native', '图片'], ['rewarded', '广告连播'], ['rewarded-interstitial', '互动式']] as const) {
    await t.test(format, async t => {
      const env = load(); t.after(() => env.dom.window.close());
      const account = await env.adapter.identify();
      await env.adapter.prepare(account, format, 'MEDIA_' + format, '60', async () => {});
      const choice = [...env.doc.querySelectorAll('ad-media-type-card [role="checkbox"]')].find(control => control.textContent!.includes(label))!;
      choice.setAttribute('aria-checked', 'false');
      await assert.rejects(env.adapter.submit(), /广告类型.*未启用/);
      assert.equal(env.fixture.state.clicks.length, 0);
    });
  }
});

test('rewarded forms reject missing or changed reward defaults without clicking create', async t => {
  for (const format of ['rewarded', 'rewarded-interstitial'] as AdFormat[]) {
    for (const scenario of ['amount', 'item', 'missing-card', 'changed-after-prepare']) {
      await t.test(`${format}/${scenario}`, async t => {
        const env = load(); t.after(() => env.dom.window.close());
        const account = await env.adapter.identify();
        env.fixture.renderForm(format); defaults(env.doc, format);
        if (scenario === 'changed-after-prepare') {
          await env.adapter.prepare(account, format, 'REWARD_GUARD', '60', async () => {});
          (env.doc.querySelector('reward-settings-card textarea') as HTMLTextAreaElement).value = 'Coins';
          await assert.rejects(env.adapter.submit(), /奖励设置.*默认/);
        } else {
          if (scenario === 'amount') (env.doc.querySelector('reward-settings-card input') as HTMLInputElement).value = '2';
          if (scenario === 'item') (env.doc.querySelector('reward-settings-card textarea') as HTMLTextAreaElement).value = '';
          if (scenario === 'missing-card') env.doc.querySelector('reward-settings-card')!.remove();
          await assert.rejects(env.adapter.prepare(account, format, 'REWARD_GUARD', '60', async () => {}), /奖励/);
        }
        assert.equal(env.fixture.state.clicks.length, 0);
      });
    }
  }
});

test('success receipts distinguish all six SDK guide paths and reject conflicting format icons', async t => {
  for (const format of formats) await t.test(format, () => {
    const icon = format.replaceAll('-', '_');
    const html = receiptHtml.replaceAll('/android/interstitial', '/android/' + format)
      .replaceAll('admob_format_interstitial_icon', 'admob_format_' + icon + '_icon');
    const dom = new JSDOM(html, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/create' });
    try {
      const adapter = new AdMobAdapter(dom.window.document, 100);
      assert.equal(adapter.recoverCreatedId(identity, '脱敏插页200', format), 'ca-app-pub-1111111111111111/4444444444');
      const other = format === 'rewarded' ? 'rewarded-interstitial' : 'rewarded';
      assert.throws(() => adapter.recoverCreatedId(identity, '脱敏插页200', other), /格式与本任务不一致/);
      dom.window.document.querySelector('img[src*="admob_format_"]')!.setAttribute('src', '/images/admob_format_' + other.replaceAll('-', '_') + '_icon.png');
      assert.throws(() => adapter.recoverCreatedId(identity, '脱敏插页200', format), /图标.*冲突/);
    } finally { dom.window.close(); }
  });
});

test('a receipt with two different supported SDK formats remains ambiguous', () => {
  const dom = new JSDOM(receiptHtml, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/create' });
  try {
    dom.window.document.querySelector('a[href*="/android/interstitial"]')!.insertAdjacentHTML('afterend', '<a href="https://developers.google.com/admob/android/rewarded-interstitial">插页式激励广告指南</a>');
    assert.throws(() => new AdMobAdapter(dom.window.document).recoverCreatedId(identity, '脱敏插页200', 'interstitial'), /唯一广告格式/);
  } finally { dom.window.close(); }
});

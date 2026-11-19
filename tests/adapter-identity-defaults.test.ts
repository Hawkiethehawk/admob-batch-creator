import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AdMobAdapter } from '../src/adapter.ts';

const html = readFileSync(new URL('./live_fixture.html', import.meta.url), 'utf8');
function load() {
  const dom = new JSDOM(html, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/list', runScripts: 'dangerously' });
  return { dom, doc: dom.window.document, adapter: new AdMobAdapter(dom.window.document, 1000) };
}
interface Fixture { renderForm(format: string): void; state: { clicks: unknown[] } }
function defaults(doc: Document) {
  doc.querySelector('main')!.insertAdjacentHTML('beforeend',
    '<ad-media-type-card><material-checkbox role="checkbox" aria-checked="true"><material-icon>check_box</material-icon>文字、图片和富媒体</material-checkbox>' +
    '<material-checkbox role="checkbox" aria-checked="true"><material-icon>check_box</material-icon>视频</material-checkbox></ad-media-type-card>' +
    '<frequency-cap-card><material-toggle aria-label="启用“频次上限”"><div role="switch" aria-checked="false" aria-label="已停用">已停用</div></material-toggle></frequency-cap-card>');
}

test('explicit media and frequency defaults are read without clicking their controls', async () => {
  const { dom, doc, adapter } = load();
  try {
    const account = await adapter.identify();
    const fixture = (dom.window as unknown as { fixture: Fixture }).fixture;
    fixture.renderForm('interstitial'); defaults(doc);
    let settingsClicks = 0;
    for (const control of doc.querySelectorAll('ad-media-type-card [role=checkbox], frequency-cap-card [role=switch]')) {
      control.addEventListener('click', () => { settingsClicks++; });
    }
    await adapter.prepare(account, 'interstitial', 'checked defaults', '60', async () => {});
    assert.equal(fixture.state.clicks.length, 0);
    await adapter.submit();
    assert.equal(fixture.state.clicks.length, 1);
    assert.equal(settingsClicks, 0);
  } finally { dom.window.close(); }
});

test('explicit nondefault or ambiguous settings block prepare and changed settings block submit', async () => {
  for (const scenario of ['media', 'frequency', 'duplicate', 'changed-after-prepare']) {
    const { dom, doc, adapter } = load();
    try {
      const account = await adapter.identify();
      const fixture = (dom.window as unknown as { fixture: Fixture }).fixture;
      fixture.renderForm('interstitial'); defaults(doc);
      if (scenario === 'media') doc.querySelector('ad-media-type-card [role=checkbox]')!.setAttribute('aria-checked', 'false');
      if (scenario === 'frequency') doc.querySelector('frequency-cap-card [role=switch]')!.setAttribute('aria-checked', 'true');
      if (scenario === 'duplicate') doc.querySelector('ad-media-type-card')!.append(doc.querySelector('ad-media-type-card [role=checkbox]')!.cloneNode(true));
      if (scenario === 'changed-after-prepare') {
        await adapter.prepare(account, 'interstitial', scenario, '60', async () => {});
        doc.querySelector('frequency-cap-card [role=switch]')!.setAttribute('aria-checked', 'true');
        await assert.rejects(adapter.submit(), /频次上限未停用/);
      } else await assert.rejects(adapter.prepare(account, 'interstitial', scenario, '60', async () => {}), /广告类型|频次上限/);
      assert.equal(fixture.state.clicks.length, 0, scenario);
    } finally { dom.window.close(); }
  }
});

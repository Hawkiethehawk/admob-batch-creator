import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AdMobAdapter } from '../src/adapter.ts';
import type { FloorMode } from '../src/types.ts';

const html = readFileSync(new URL('./live_fixture.html', import.meta.url), 'utf8');
interface Fixture { renderForm(format: string): void; state: { clicks: unknown[] } }
async function form() {
  const dom = new JSDOM(html, { url: 'https://admob.google.com/v2/apps/2222222222/adunits/list', runScripts: 'dangerously' });
  const doc = dom.window.document, adapter = new AdMobAdapter(doc, 200);
  const identity = await adapter.identify();
  const fixture = (dom.window as unknown as { fixture: Fixture }).fixture;
  fixture.renderForm('interstitial');
  return { dom, doc, adapter, identity, fixture };
}
function materialRadios(doc: Document) {
  const radios = [...doc.querySelectorAll('material-radio[role=radio]')];
  const settings = doc.createElement('ecpm-settings-controls'), group = doc.createElement('material-radio-group');
  radios[0].before(settings); settings.append(group);
  for (const radio of radios) {
    const label = radio.textContent!;
    radio.innerHTML = '<div class="icon-container"><material-icon><i class="material-icons-extended">radio_button_unchecked</i></material-icon><material-ripple></material-ripple></div><div class="content">' + label + '</div>';
    group.append(radio);
  }
  return { radios, settings, group };
}

test('observed Material radios ignore icon text and secondary optimization groups for every mode', async () => {
  for (const mode of ['manual', 'auto', 'disabled'] as FloorMode[]) {
    const { dom, doc, adapter, identity, fixture } = await form();
    try {
      const { settings } = materialRadios(doc);
      settings.insertAdjacentHTML('beforeend', '<google-optimization><material-radio-group><material-radio role="radio" aria-checked="false"><div class="content">人工指定底价</div></material-radio></material-radio-group></google-optimization>');
      let secondaryClicks = 0;
      doc.querySelector('google-optimization material-radio')!.addEventListener('click', () => { secondaryClicks++; });
      // Match the live checkbox layout: its aria-labelledby references a
      // content button whose own aria-label is an unrelated tooltip sentence.
      doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<ad-media-type-card>' +
        ['文字、图片和富媒体', '视频'].map((label, index) => '<material-checkbox role="checkbox" aria-checked="true" aria-labelledby="media-' + index + '"><div class="icon-container"><material-icon>check_box</material-icon></div><div class="content"><div role="button" id="media-' + index + '" aria-label="Point for more information">' + label + '</div></div></material-checkbox>').join('') +
        '</ad-media-type-card><frequency-cap-card><div role="switch" aria-checked="false" aria-label="已停用">已停用<material-icon>remove</material-icon></div></frequency-cap-card>');
      const floor = mode === 'manual' ? '60' : '';
      await adapter.prepare(identity, 'interstitial', 'material ' + mode, floor, async () => {}, mode);
      await adapter.submit();
      assert.equal(fixture.state.clicks.length, 1, mode);
      assert.equal(secondaryClicks, 0);
      const actual = await adapter.verify(identity, 'interstitial', 'material ' + mode, floor, mode);
      assert.equal(actual.verified, true); assert.equal(actual.mode, mode);
    } finally { dom.window.close(); }
  }
});

test('native radios accept exact associated labels with decorative icons', async () => {
  const { dom, doc, adapter, identity } = await form();
  try {
    for (const radio of [...doc.querySelectorAll('material-radio[role=radio]')]) {
      const label = doc.createElement('label'), input = doc.createElement('input');
      input.type = 'radio'; input.name = 'mode'; input.checked = radio.getAttribute('aria-checked') === 'true';
      label.append(input); label.insertAdjacentHTML('beforeend', '<material-icon>radio_button_unchecked</material-icon><span>' + radio.textContent + '</span>');
      input.addEventListener('click', () => { doc.querySelector('manual-ecpm-floor-input')!.removeAttribute('hidden'); });
      radio.replaceWith(label);
    }
    let clicks = 0;
    doc.querySelector('.btn-yes')!.addEventListener('click', event => { event.stopImmediatePropagation(); clicks++; }, true);
    await adapter.prepare(identity, 'interstitial', 'native radio', '60', async () => {});
    assert.equal((doc.querySelectorAll('input[type=radio]')[1] as HTMLInputElement).checked, true);
    await adapter.submit(); assert.equal(clicks, 1);
  } finally { dom.window.close(); }
});

test('ambiguous primary groups and duplicate exact labels still prevent create', async () => {
  for (const variant of ['groups', 'labels']) {
    const { dom, doc, adapter, identity, fixture } = await form();
    try {
      const { radios, settings, group } = materialRadios(doc);
      if (variant === 'groups') settings.append(group.cloneNode(true));
      else group.append(radios[1].cloneNode(true));
      await assert.rejects(adapter.prepare(identity, 'interstitial', variant, '60', async () => {}), /底价模式.*找到 2/);
      assert.equal(fixture.state.clicks.length, 0);
    } finally { dom.window.close(); }
  }
});

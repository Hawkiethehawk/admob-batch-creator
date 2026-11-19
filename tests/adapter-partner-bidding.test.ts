import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AdMobAdapter, AdapterError } from '../src/adapter.ts';

const html = readFileSync(new URL('./live_fixture.html', import.meta.url), 'utf8');
const label = '我目前在另一中介平台（而非 AdMob）上将此广告单元用于实时出价。';
interface Fixture { renderForm(format: string): void; renderList(): void; state: { clicks: unknown[] } }
async function form(origin = 'https://admob.google.com') {
  const dom = new JSDOM(html, { url: origin + '/v2/apps/2222222222/adunits/list', runScripts: 'dangerously' });
  const doc = dom.window.document, adapter = new AdMobAdapter(doc, 300);
  const identity = await adapter.identify();
  const fixture = (dom.window as unknown as { fixture: Fixture }).fixture;
  fixture.renderForm('interstitial');
  return { dom, doc, adapter, identity, fixture };
}
function checkbox(doc: Document, checked = false) {
  const card = doc.createElement('third-party-bidding-card');
  card.innerHTML = '<material-checkbox role="checkbox" aria-checked="' + checked + '"><material-icon>check_box_outline_blank</material-icon>' +
    '<div class="bidding-headline">' + label + '</div><div>创建广告单元后，您将无法更改此设置</div></material-checkbox>';
  doc.querySelector('main')!.append(card);
  const control = card.querySelector('material-checkbox')!;
  let clicks = 0;
  control.addEventListener('click', () => { clicks++; control.setAttribute('aria-checked', String(control.getAttribute('aria-checked') !== 'true')); });
  return { card, control, clicks: () => clicks };
}
function savedPartner(doc: Document, value: string) {
  doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<div class="header" aria-label="合作平台出价" aria-describedby="saved-partner">' +
    '<div class="panel-name">合作平台出价</div><div class="panel-description" id="saved-partner">' + value + '</div></div>');
}
function removeFloorSettings(doc: Document) {
  doc.querySelector('.advanced-settings-toggle')?.remove();
  doc.querySelector('.advanced')?.remove();
}
function savedWithoutFloor(doc: Document, name: string, unitId = 'ca-app-pub-1111111111111111/3333333009', format = '插页式广告') {
  doc.defaultView!.history.pushState({}, '', '/v2/apps/2222222222/adunits/' + unitId.split('/')[1] + '/edit');
  const main = doc.querySelector('main')!;
  main.innerHTML = '<h1>修改广告单元</h1>';
  for (const [label, value, id] of [['广告单元名称', name, 'v-name'], ['广告格式', format, 'v-format'], ['广告单元 ID', unitId, 'v-id']]) {
    const header = doc.createElement('div'); header.className = 'header'; header.setAttribute('aria-label', label); header.setAttribute('aria-describedby', id);
    const description = doc.createElement('div'); description.id = id; description.className = 'panel-description'; description.textContent = value;
    header.append(description); main.append(header);
  }
}

test('partner bidding defaults off, is actively disabled when needed, and is rechecked before click', async () => {
  const { dom, doc, adapter, identity, fixture } = await form();
  try {
    const partner = checkbox(doc, true);
    await adapter.prepare(identity, 'interstitial', 'default off', '60', async () => {});
    assert.equal(partner.control.getAttribute('aria-checked'), 'false');
    assert.equal(partner.clicks(), 1);
    partner.control.setAttribute('aria-checked', 'true');
    await assert.rejects(adapter.submit(), /合作平台出价状态发生变化/);
    assert.equal(fixture.state.clicks.length, 0);
    partner.control.setAttribute('aria-checked', 'false');
    partner.card.remove();
    await assert.rejects(adapter.submit(), /合作平台出价控件缺失/);
    assert.equal(fixture.state.clicks.length, 0);
  } finally { dom.window.close(); }
});

test('partner bidding creates once without any floor controls and requires positive saved evidence', async () => {
  const { dom, doc, adapter, identity, fixture } = await form();
  try {
    const partner = checkbox(doc);
    partner.control.addEventListener('click', () => removeFloorSettings(doc));
    doc.querySelector('.btn-yes')!.addEventListener('click', event => {
      event.stopImmediatePropagation(); fixture.state.clicks.push({ partnerBidding: true });
      savedWithoutFloor(doc, 'partner enabled');
    }, true);
    await adapter.prepare(identity, 'interstitial', 'partner enabled', '', async () => {}, 'disabled', true);
    assert.equal(partner.clicks(), 1);
    assert.equal(adapter.prepared?.partnerBidding, true);
    assert.equal(adapter.prepared?.floor, ''); assert.equal(adapter.prepared?.floorInput, undefined);
    assert.equal(doc.querySelector('[role=radio], manual-ecpm-floor-input'), null);
    partner.control.setAttribute('aria-checked', 'false');
    await assert.rejects(adapter.submit(), /合作平台出价状态发生变化/);
    assert.equal(fixture.state.clicks.length, 0);
    partner.control.setAttribute('aria-checked', 'true');
    await adapter.submit(); assert.equal(fixture.state.clicks.length, 1);
    await assert.rejects(adapter.submit(), /已经执行过提交/);
    const unitId = doc.querySelector('#v-id')!.textContent;
    await assert.rejects(adapter.verify(identity, 'interstitial', 'partner enabled', '', 'disabled', true), error => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.actual?.unitId, unitId);
      assert.equal(error.actual?.verified, false);
      return /合作平台出价状态缺失/.test(error.message);
    });
    savedPartner(doc, '已启用');
    const actual = await adapter.verify(identity, 'interstitial', 'partner enabled', '', 'disabled', true);
    assert.equal(actual.partnerBidding, true); assert.equal(actual.verified, true);
    assert.equal(actual.mode, 'partner-bidding'); assert.equal(actual.floor, ''); assert.equal(actual.currency, '');
    doc.querySelector('#saved-partner')!.textContent = '已停用';
    await assert.rejects(adapter.verify(identity, 'interstitial', 'partner enabled', '', 'disabled', true), /合作平台出价/);
    assert.equal(fixture.state.clicks.length, 1);
  } finally { dom.window.close(); }
});

test('absent partner controls allow default off but never explicit enablement', async () => {
  const { dom, adapter, identity, fixture } = await form();
  try {
    await assert.rejects(adapter.prepare(identity, 'interstitial', 'unsupported true', '60', async () => {}, 'manual', true), /没有可确认的合作平台出价/);
    assert.equal(adapter.prepared, undefined); assert.equal(fixture.state.clicks.length, 0);
    await adapter.prepare(identity, 'interstitial', 'off without card', '60', async () => {}, 'manual', false);
    await adapter.submit(); assert.equal(fixture.state.clicks.length, 1);
    const actual = await adapter.verify(identity, 'interstitial', 'off without card', '60');
    assert.equal(actual.verified, true); assert.equal(actual.partnerBidding, undefined, 'missing saved evidence is not invented');
  } finally { dom.window.close(); }
});

test('ambiguous, unknown-state or unrelated partner controls cannot authorize prepare', async () => {
  for (const scenario of ['duplicate', 'mixed', 'unrecognized-label']) {
    const { dom, doc, adapter, identity, fixture } = await form();
    try {
      const partner = checkbox(doc);
      if (scenario === 'duplicate') partner.card.append(partner.control.cloneNode(true));
      if (scenario === 'mixed') partner.control.setAttribute('aria-checked', 'mixed');
      if (scenario === 'unrecognized-label') partner.control.querySelector('.bidding-headline')!.textContent = '其他设置';
      await assert.rejects(adapter.prepare(identity, 'interstitial', scenario, '60', async () => {}), /合作平台出价/);
      assert.equal(partner.clicks(), 0); assert.equal(fixture.state.clicks.length, 0);
    } finally { dom.window.close(); }
  }
});

test('partner bidding ignores legacy floor mode arguments without selecting or filling floors', async () => {
  for (const mode of ['manual', 'auto', 'disabled'] as const) {
    const { dom, doc, adapter, identity, fixture } = await form();
    try {
      const partner = checkbox(doc);
      let radioClicks = 0, moneyWrites = 0;
      for (const radio of doc.querySelectorAll('[role=radio]')) radio.addEventListener('click', () => { radioClicks++; });
      doc.querySelector('manual-ecpm-floor-input input')!.addEventListener('input', () => { moneyWrites++; });
      await adapter.prepare(identity, 'interstitial', 'legacy ' + mode, '1234', async () => {}, mode, true);
      assert.equal(partner.control.getAttribute('aria-checked'), 'true');
      assert.equal(adapter.prepared?.floor, '');
      await adapter.submit();
      assert.equal(fixture.state.clicks.length, 1);
      assert.equal(radioClicks, 0); assert.equal(moneyWrites, 0);
    } finally { dom.window.close(); }
  }
});

test('known-ID partner verification through the list needs matching ID, name and format without a saved floor', async () => {
  for (const variant of ['valid', 'id', 'name', 'format'] as const) {
    const { dom, doc, adapter, identity, fixture } = await form('http://localhost');
    try {
      fixture.renderList();
      const unitId = 'ca-app-pub-1111111111111111/3333333003';
      doc.querySelector('a[href*="3333333003"]')!.addEventListener('click', event => {
        event.preventDefault(); event.stopImmediatePropagation();
        savedWithoutFloor(doc, variant === 'name' ? 'other name' : '目标名称', variant === 'id' ? unitId.replace('3333333003', '9999999999') : unitId, variant === 'format' ? '开屏广告' : '插页式广告');
        savedPartner(doc, '已启用');
      }, true);
      const verifying = adapter.verifyById(identity, unitId, '目标名称', 'interstitial', '', 'disabled', true);
      if (variant === 'valid') {
        const actual = await verifying;
        assert.equal(actual.verified, true); assert.equal(actual.partnerBidding, true);
        assert.equal(actual.mode, 'partner-bidding'); assert.equal(actual.floor, ''); assert.equal(actual.currency, '');
      } else await assert.rejects(verifying, /ID.*不一致|名称.*不一致|格式.*不一致/);
      assert.equal(fixture.state.clicks.length, 0, 'verification never submits');
    } finally { dom.window.close(); }
  }
});

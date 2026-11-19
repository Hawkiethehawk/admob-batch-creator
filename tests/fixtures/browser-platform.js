// Served only on loopback by tests/browser.mjs; extends the real DOM fixture.
(() => {
  const run = window.__abcRunId;
  const fixture = window.fixture;
  fixture.setExtendedForms(true);
  const key = 'fixture:units';
  const sync = () => {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved) fixture.units.splice(0, fixture.units.length, ...saved);
    if (fixture.state.page === 'list') fixture.renderList();
  };
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(fixture.units));
  sync();
  if (location.pathname.endsWith('/adunits/create')) fixture.renderFormats();
  addEventListener('storage', event => { if (event.key === key) sync(); });
  document.addEventListener('click', event => {
    const button = event.target.closest('.btn-yes');
    if (!button || button.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault(); event.stopImmediatePropagation();
    const { name, floor, mode, format, partnerBidding } = fixture.readForm();
    if (!name || !mode || (mode === 'manual' && !floor)) throw new Error('Fixture rejected invalid form');
    if (!fixture.formats.includes(format) || (partnerBidding && (!fixture.partnerFormats.includes(format) || mode !== 'partner-bidding' || floor !== '' || document.querySelector('manual-ecpm-floor-input, .floor-settings [role="radio"]')))) {
      throw new Error('Fixture rejected unsupported format or bidding floor controls');
    }
    button.setAttribute('aria-disabled', 'true'); button.classList.add('is-disabled');
    const request = { name, floor: mode === 'manual' ? floor : '', format, mode, partnerBidding, manual: mode === 'manual', tab: window.__gmTestTabId };
    const clicks = JSON.parse(localStorage.getItem('fixture:clicks') || '[]');
    clicks.push({ ...request, at: Date.now() }); localStorage.setItem('fixture:clicks', JSON.stringify(clicks));
    void fetch('/api/create?run=' + encodeURIComponent(run), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    }).then(async response => {
      if (!response.ok) throw new Error(await response.text());
      const unit = await response.json();
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      if (all.some(existing => existing.unitId === unit.unitId)) throw new Error('Duplicate fixture ID');
      all.push(unit); localStorage.setItem(key, JSON.stringify(all));
      fixture.units.splice(0, fixture.units.length, ...all);
      history.pushState({}, '', '/v2/apps/2222222222/adunits/' + unit.unitId.split('/')[1] + '/edit');
      fixture.renderDetail(unit);
    }).catch(error => { setTimeout(() => { throw error; }); });
  }, true);
})();

// Served only on loopback by tests/browser.mjs; extends the real DOM fixture.
(() => {
  const run = new URL(location.href).searchParams.get('run');
  const fixture = window.fixture;
  const key = 'fixture:units';
  const sync = () => {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved) fixture.units.splice(0, fixture.units.length, ...saved);
    if (fixture.state.page === 'list') fixture.renderList();
  };
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(fixture.units));
  sync();
  addEventListener('storage', event => { if (event.key === key) sync(); });
  document.addEventListener('click', event => {
    const button = event.target.closest('.btn-yes');
    if (!button || button.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault(); event.stopImmediatePropagation();
    const name = document.querySelector('material-input:not([type]) input').value;
    const floor = document.querySelector('manual-ecpm-floor-input input').value;
    const selected = [...document.querySelectorAll('[role="radio"]')].filter(radio => radio.getAttribute('aria-checked') === 'true');
    const mode = selected.length !== 1 ? undefined : selected[0].textContent.includes('人工指定底价') ? 'manual' : selected[0].textContent.includes('已停用') ? 'disabled' : 'auto';
    if (!name || !mode || (mode === 'manual' && !floor)) throw new Error('Fixture rejected invalid form');
    button.setAttribute('aria-disabled', 'true'); button.classList.add('is-disabled');
    const request = { name, floor: mode === 'manual' ? floor : '', format: fixture.state.format, mode, manual: mode === 'manual', tab: window.__gmTestTabId };
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

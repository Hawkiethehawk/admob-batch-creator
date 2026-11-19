import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';

// Real isolated Chromium pages and Web Locks; simulated GM APIs and a
// loopback-only backend using the redacted live DOM. Never uses HubVPS data.
if (!process.env.ADMOB_TEST_SCRIPT) {
  const built = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status || 1);
}
const scriptPath = resolve(process.env.ADMOB_TEST_SCRIPT || 'dist/admob-batch-creator.user.js');
const script = await readFile(scriptPath);
const liveFixture = await readFile(new URL('./live_fixture.html', import.meta.url), 'utf8');
const platform = await readFile(new URL('./fixtures/browser-platform.js', import.meta.url));
const fixture = liveFixture.replace('</body>', '<script src="/platform.js"></script><script src="/userscript.js"></script></body>');
const rowsCount = Number(process.env.ADMOB_BENCH_ROWS || 10);
const saveDelayMs = Number(process.env.ADMOB_BENCH_SAVE_MS || 8000);
assert.ok(Number.isInteger(rowsCount) && rowsCount >= 2 && rowsCount <= 100);
assert.ok(Number.isFinite(saveDelayMs) && saveDelayMs >= 0 && saveDelayMs <= 15000);
const backends = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/create') {
      const backend = backends.get(url.searchParams.get('run'));
      if (!backend || request.method !== 'POST') { response.writeHead(400).end('Unknown test run'); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      assert.ok(input.name && ['manual', 'auto', 'disabled', 'partner-bidding'].includes(input.mode));
      assert.ok(input.mode !== 'manual' || /^\d+(?:\.\d+)?$/.test(input.floor));
      if (input.mode === 'partner-bidding') {
        assert.equal(input.partnerBidding, true);
        assert.equal(input.floor, '');
      }
      const record = { ...input, at: Date.now(), unitId: 'ca-app-pub-1111111111111111/' + String(7000000000 + ++backend.sequence) };
      backend.requests.push(record); backend.inflight++; backend.peakInflight = Math.max(backend.peakInflight, backend.inflight);
      await pause(backend.delay);
      backend.inflight--; record.savedAt = Date.now();
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(record));
      return;
    }
    response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript;charset=utf-8' : 'text/html;charset=utf-8');
    if (url.pathname === '/userscript.js') response.end(script);
    else if (url.pathname === '/platform.js') response.end(platform);
    else if (url.pathname === '/sentinel') response.end('<title>User tab sentinel</title><h1>Unrelated user page</h1>');
    else response.end(fixture);
  } catch (error) { response.writeHead(500).end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const outputPath = resolve(process.env.ADMOB_BROWSER_RESULTS || 'tests/browser-results-0.5.10.json');
const results = {
  at: new Date().toISOString(),
  scope: 'Isolated headless Chromium; real pages, Web Locks, native storage notifications; simulated GM and delayed loopback backend. Not HubVPS/Tampermonkey or real AdMob acceptance.',
  script: { version: script.toString().match(/@version\s+(\S+)/)?.[1], bytes: script.length, sha256: createHash('sha256').update(script).digest('hex') },
  workload: { rows: rowsCount, saveDelayMs, throttleMs: 2500 }, cases: [],
  measurements: { heap: 'Sum of page CDP JSHeapUsedSize, sampled every 2 seconds; excludes native browser memory', serializedBytes: 'Logical UTF-16 bytes (2 * string length), not disk usage' },
};

async function setup(browser, { delay = saveDelayMs, silentTabOpen = false, skipOpenNumber, deferOpenNumber, simulateForeground = false, grantWindowClose = false } = {}) {
  const id = randomUUID();
  const backend = { sequence: 0, requests: [], delay, inflight: 0, peakInflight: 0 }; backends.set(id, backend);
  const context = await browser.newContext({ viewport: { width: 1500, height: 1150 }, acceptDownloads: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const workers = new Map(); const deferredUrls = new Map(); const errors = []; const opens = []; const focuses = []; const closedWorkers = []; const probes = []; const sessions = new Map(); const gmMetrics = new Map();
  const metrics = { peakPages: 0, peakWorkers: 0, peakActiveAssignments: 0, peakHeapBytes: 0, peakDomNodes: 0 }; let sampleBusy = false;
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    metrics.peakPages = Math.max(metrics.peakPages, context.pages().length);
  });
  async function sample() {
    if (sampleBusy) return; sampleBusy = true;
    try {
      let heap = 0; let nodes = 0;
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        const gm = await page.evaluate(() => window.__gmMetrics).catch(() => undefined);
        if (gm) gmMetrics.set(page, gm);
        let session = sessions.get(page);
        if (!session) { session = await context.newCDPSession(page); sessions.set(page, session); await session.send('Performance.enable'); }
        const report = await session.send('Performance.getMetrics');
        const values = Object.fromEntries(report.metrics.map(value => [value.name, value.value]));
        heap += values.JSHeapUsedSize || 0; nodes += values.Nodes || 0;
      }
      metrics.peakHeapBytes = Math.max(metrics.peakHeapBytes, heap); metrics.peakDomNodes = Math.max(metrics.peakDomNodes, nodes);
    } catch { /* A context closing during an observation is expected. */ }
    finally { sampleBusy = false; }
  }
  const sampler = setInterval(() => void sample(), 2000);
  await context.exposeBinding('__abcProbe', (_source, report) => { probes.push(report); });
  await context.exposeBinding('__abcOpen', async ({ page }, url, workerId, active, at, openNumber) => {
    const openerId = [...workers].find(([, worker]) => worker === page)?.[0] ?? null;
    const canaryPassed = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.startsWith('gm:abc:v1:batch:'));
      return key ? JSON.parse(localStorage.getItem(key)).canaryPassed : false;
    });
    opens.push({ at, active, canaryPassed, workerId, openerId, url });
    if (openNumber === skipOpenNumber) return false;
    const worker = await context.newPage(); workers.set(workerId, worker);
    worker.on('close', () => {
      closedWorkers.push({ workerId, at: Date.now() });
    });
    metrics.peakWorkers = Math.max(metrics.peakWorkers, [...workers.values()].filter(page => !page.isClosed()).length);
    if (openNumber === deferOpenNumber) { deferredUrls.set(workerId, url); return true; }
    await worker.goto(url);
    if (simulateForeground && active) await worker.bringToFront();
    return true;
  });
  await context.exposeBinding('__abcFocus', async (_source, workerId) => {
    const worker = workers.get(workerId);
    if (!worker || worker.isClosed()) return false;
    await worker.bringToFront();
    focuses.push({ workerId, at: Date.now() });
    const deferredUrl = deferredUrls.get(workerId);
    if (deferredUrl) {
      deferredUrls.delete(workerId);
      await worker.goto(deferredUrl);
    }
    return true;
  });
  await context.exposeBinding('__abcClose', async (_source, workerId) => { await workers.get(workerId)?.close(); return true; });
  await context.exposeBinding('__abcSelfClose', async ({ page }) => {
    if ([...workers.values()].includes(page) && !page.isClosed()) await page.close();
  });
  await context.addInitScript(({ runId, silentTabOpen, grantWindowClose }) => {
    window.__abcRunId = runId;
    const listeners = new Map(); let listenerId = 0; let openNumber = 0;
    const decode = value => value === null ? undefined : JSON.parse(value);
    const metrics = window.__gmMetrics = { writes: 0, writeBytes: 0, remoteNotifications: 0, probes: [] };
    // Playwright also initializes each new about:blank document, where the
    // secure-context UUID API is absent. This ID belongs only to the shim.
    window.__gmTestTabId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'blank-' + Math.random();
    window.GM_getValue = (key, fallback) => { const value = localStorage.getItem('gm:' + key); return value === null ? fallback : decode(value); };
    window.GM_setValue = (key, value) => {
      const old = localStorage.getItem('gm:' + key); const next = JSON.stringify(value);
      metrics.writes++; metrics.writeBytes += 2 * (key.length + next.length);
      if (value?.type === 'hello' && value.probe) {
        metrics.probes.push(value.probe);
        void window.__abcProbe(value);
      }
      localStorage.setItem('gm:' + key, next);
      for (const item of listeners.values()) if (item.key === key) item.callback(key, decode(old), value, false);
    };
    window.GM_deleteValue = key => localStorage.removeItem('gm:' + key);
    window.GM_listValues = () => Object.keys(localStorage).filter(key => key.startsWith('gm:')).map(key => key.slice(3));
    window.GM_addValueChangeListener = (key, callback) => { const id = ++listenerId; listeners.set(id, { key, callback }); return id; };
    window.GM_removeValueChangeListener = id => listeners.delete(id);
    addEventListener('storage', event => {
      if (!event.key?.startsWith('gm:')) return;
      for (const item of listeners.values()) if (item.key === event.key.slice(3)) {
        metrics.remoteNotifications++; item.callback(item.key, decode(event.oldValue), decode(event.newValue), true);
      }
    });
    window.GM_getTab = callback => callback(JSON.parse(sessionStorage.getItem('mock:tab') || '{}'));
    window.GM_saveTab = (tab, callback) => { sessionStorage.setItem('mock:tab', JSON.stringify(tab)); callback?.(); };
    window.GM_setClipboard = text => { window.__mockClipboard = text; };
    if (grantWindowClose && new URL(location.href).searchParams.has('__admob_batch_worker')) {
      window.close = () => { void window.__abcSelfClose(); };
    }
    window.GM_openInTab = (url, options) => {
      if (silentTabOpen) return { closed: false, close() { this.closed = true; } };
      const id = crypto.randomUUID(); void window.__abcOpen(url, id, options?.active === true, Date.now(), ++openNumber);
      return { closed: false, focus() { void window.__abcFocus(id); }, close() { void window.__abcClose(id).then(() => { this.closed = true; this.onclose?.(); }); } };
    };
  }, { runId: id, silentTabOpen, grantWindowClose });
  const page = await context.newPage(); await page.goto(origin + '/v2/apps/2222222222/adunits/list?run=' + id);
  await page.locator('#abc-panel-host .identity-state').filter({ hasText: '账号与应用已识别' }).waitFor();
  return { context, page, backend, errors, opens, focuses, closedWorkers, probes, gmMetrics, metrics, workers, sample,
    async close() { clearInterval(sampler); await context.close(); backends.delete(id); } };
}

async function readBatch(page) {
  return page.evaluate(() => {
    const latest = Object.keys(localStorage).find(key => key.startsWith('gm:abc:v1:latest:'));
    const id = latest && JSON.parse(localStorage.getItem(latest));
    const key = Object.keys(localStorage).find(key => key.startsWith('gm:abc:v1:batch:') && key.endsWith(':' + id));
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  });
}
async function configure(run, rows, format = 'interstitial', mode = 'manual', execution = 'paged', partnerBidding = false) {
  const page = run.page;
  const panel = page.locator('#abc-panel-host');
  const prefixSwitch = panel.getByRole('switch', { name: '批量应用前缀', exact: true });
  if (await prefixSwitch.isChecked()) await prefixSwitch.uncheck();
  const bidding = panel.getByRole('checkbox', { name: '合作平台出价', exact: true });
  if (await bidding.isChecked()) await bidding.uncheck();
  await panel.getByLabel('广告格式', { exact: true }).selectOption(format);
  await panel.getByLabel('底价模式', { exact: true }).selectOption(mode);
  await panel.getByLabel('执行方式', { exact: true }).selectOption(execution);
  if (partnerBidding) await bidding.check();
  const remove = panel.getByRole('button', { name: /^删除第 \d+ 行$/ });
  while (await remove.count()) await remove.first().click();
  for (const [name, floor] of rows) {
    await panel.getByRole('button', { name: '增加一行', exact: true }).click();
    await panel.getByRole('textbox', { name: /^第 \d+ 行广告位名称$/ }).last().fill(name);
    if (mode === 'manual' && !partnerBidding) await panel.getByRole('textbox', { name: /^第 \d+ 行底价 USD$/ }).last().fill(floor);
  }
  assert.equal(await panel.getByRole('textbox', { name: /^第 \d+ 行广告位名称$/ }).count(), rows.length, 'add-row controls fill the editable rows');
}
async function openPreview(run) {
  const panel = run.page.locator('#abc-panel-host');
  const requests = run.backend.requests.length;
  const batch = await readBatch(run.page);
  const partnerBidding = await panel.getByRole('checkbox', { name: '合作平台出价', exact: true }).isChecked();
  await panel.locator('[data-action="start"]').click();
  const dialog = panel.getByRole('dialog', { name: '创建预览', exact: true });
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.getByRole('columnheader', { name: '合作平台出价', exact: true }).count(), 1);
  const biddingCells = await dialog.locator('tbody tr td:last-child').allTextContents();
  assert.ok(biddingCells.length > 0);
  assert.ok(biddingCells.every(value => value === (partnerBidding ? '已勾选' : '未勾选')), 'preview snapshots the partner-bidding selection for every row');
  assert.equal(run.backend.requests.length, requests, 'opening the preview never submits a task');
  assert.deepEqual(await readBatch(run.page), batch, 'preview leaves the persisted batch unchanged');
}
async function confirmCreation(run) {
  const start = Date.now();
  await run.page.locator('#abc-panel-host [data-action="confirm-create"]').click();
  return start;
}
async function waitDone(run, timeout = 300000) {
  const end = Date.now() + timeout; let reported = -1;
  while (Date.now() < end) {
    const batch = await readBatch(run.page);
    run.metrics.peakActiveAssignments = Math.max(run.metrics.peakActiveAssignments, batch?.tasks.filter(task => ['filling', 'submitting', 'verifying'].includes(task.status)).length || 0);
    const completed = batch?.tasks.filter(task => task.status === 'success').length || 0;
    if (completed !== reported) { reported = completed; console.log('PROGRESS ' + completed + '/' + (batch?.tasks.length || 0) + ' workers=' + run.opens.length); }
    if (batch?.phase === 'done') return batch;
    if (batch?.phase === 'paused') throw new Error('Unexpected pause: ' + JSON.stringify(batch.tasks));
    await pause(200);
  }
  throw new Error('Timed out: ' + JSON.stringify(await readBatch(run.page)));
}
const gaps = values => values.slice(1).map((value, index) => value - values[index]);
function stats(values) { const sorted = [...values].sort((a, b) => a - b); return { min: sorted[0] ?? null, median: sorted[Math.floor(sorted.length / 2)] ?? null, max: sorted.at(-1) ?? null }; }

async function serialBenchmark(browser) {
  const run = await setup(browser);
  try {
    const rows = Array.from({ length: rowsCount }, (_, index) => ['POOL_' + (index + 1), (100 + index * 7 + (index % 2 ? 0.25 : 0)).toString()]);
    const execution = 'single';
    const setupAt = Date.now(); await configure(run, rows, 'interstitial', 'manual', execution); const inputMs = Date.now() - setupAt;
    await openPreview(run);
    const start = await confirmCreation(run);
    const batch = await waitDone(run); const elapsedMs = Date.now() - start; await run.sample();
    assert.equal(batch.tasks.length, rows.length); assert.ok(batch.tasks.every(task => task.status === 'success'), JSON.stringify(batch.tasks));
    assert.equal(run.backend.requests.length, rows.length, 'one backend submit per input row');
    assert.equal(new Set(run.backend.requests.map(row => row.unitId)).size, rows.length, 'every ID is unique');
    assert.equal(new Set(run.backend.requests.map(row => row.name)).size, rows.length, 'no duplicate submissions');
    for (const [name, floor] of rows) {
      const request = run.backend.requests.find(row => row.name === name); const task = batch.tasks.find(task => task.name === name);
      assert.equal(request.floor, floor); assert.equal(request.format, 'interstitial'); assert.equal(task.actual.name, name); assert.equal(task.actual.floor, floor);
      assert.equal(task.actual.unitId, request.unitId); assert.equal(task.actual.currency, 'USD'); assert.equal(task.actual.appId, batch.identity.appId);
      assert.equal(task.actual.publisherId, batch.identity.publisherId); assert.equal(task.actual.mode, 'manual'); assert.equal(task.actual.verified, true);
    }
    assert.equal(batch.execution, execution);
    const canaryDone = Date.parse(batch.tasks[0].finishedAt);
    const preparedAlongsideFirst = batch.tasks.slice(1).filter(task =>
      Date.parse(task.logs.find(log => log.step === 'filling')?.at) < canaryDone).length;
    assert.ok(batch.tasks.slice(1).every(task => Date.parse(task.intentAt) >= canaryDone),
      'remaining submissions start after the first saved configuration is verified');
    assert.equal(run.opens.length, 0, 'serial execution stays on the original page');
    assert.equal(run.metrics.peakActiveAssignments, 1);
    assert.equal(preparedAlongsideFirst, 0);
    assert.equal(run.backend.peakInflight, 1);
    assert.equal(new Set(batch.tasks.map(task => task.workerId)).size, 1);
    assert.ok(batch.startedAt && batch.completedAt && Date.parse(batch.completedAt) >= Date.parse(batch.confirmedAt), 'batch records total workflow timestamps');
    const grants = gaps(batch.tasks.map(task => Date.parse(task.intentAt)).sort((a, b) => a - b));
    const submits = gaps(run.backend.requests.map(row => row.at));
    assert.ok(grants.every(gap => gap >= 2450), 'publisher-wide grants retain the 2500 ms throttle');
    assert.ok(submits.every(gap => gap >= 1950), 'no burst submissions between worker pages');
    const gm = [...run.gmMetrics.values()];
    const remoteNotifications = gm.reduce((sum, page) => sum + page.remoteNotifications, 0);
    assert.deepEqual(run.errors, []);
    const storage = await run.page.evaluate(() => ({ entries: localStorage.length,
      bytes: Object.keys(localStorage).reduce((total, key) => total + 2 * (key.length + localStorage.getItem(key).length), 0),
      gmEntries: Object.keys(localStorage).filter(key => key.startsWith('gm:')).length }));
    return { execution, rows: rows.length, inputMs, automaticPreparationMs: Date.parse(batch.confirmedAt) - Date.parse(batch.startedAt), elapsedMs, elapsedIncludesAutomaticPreparation: true, rowsPerMinute: rows.length * 60000 / elapsedMs,
      workerTabsOpened: run.opens.length, preparedAlongsideFirst, ...run.metrics, peakInflightSaves: run.backend.peakInflight,
      tasksPerWorker: [batch.tasks.length], grantIntervalsMs: stats(grants), submitIntervalsMs: stats(submits), remoteNotifications,
      gmWrites: gm.reduce((sum, page) => sum + page.writes, 0), gmWriteBytes: gm.reduce((sum, page) => sum + page.writeBytes, 0), storage,
      assertions: ['preview-before-confirmation', 'exact-name-floor-format-app-publisher-id', 'unique-id-and-no-resubmit', 'first-verification-before-remaining-submits', 'global-throttle', 'one-page-and-one-active-task'] };
  } finally { await run.close(); }
}
async function lockChecks(browser) {
  const run = await setup(browser, { delay: 0, deferOpenNumber: 1 });
  try {
    await run.page.getByRole('button', { name: '检测跨页能力', exact: true }).click();
    await run.page.locator('#abc-panel-host .notice').filter({ hasText: '跨页检查通过' }).waitFor();
    await run.page.waitForFunction(() => !document.querySelector('#abc-panel-host').shadowRoot.querySelector('[data-action=probe]').disabled);
    assert.equal(run.opens.length, 2);
    assert.equal(run.focuses.filter(focus => focus.workerId === run.opens[0].workerId).length, 2, 'a deferred page is focused for startup and again for its foreground check');
    assert.deepEqual(run.context.pages(), [run.page]);
    await run.page.evaluate(() => {
      window.__controllerLock = new Promise((resolve, reject) => {
        void navigator.locks.request('admob-batch-controller:pub-1111111111111111', { ifAvailable: true }, lock => {
          if (!lock) { reject(Error('Diagnostic failed to release the main lock')); return; }
          resolve();
          return new Promise(release => { window.__releaseControllerLock = release; });
        }).catch(reject);
      });
      return window.__controllerLock;
    });
    const sentinel = await run.context.newPage(); await sentinel.goto(origin + '/sentinel');
    const second = await run.context.newPage(); await second.goto(run.page.url());
    await second.getByRole('button', { name: '检测跨页能力', exact: true }).click();
    await second.locator('#abc-panel-host .notice').filter({ hasText: '已有活动主控' }).waitFor({ timeout: 10000 });
    const url = new URL(run.page.url());
    url.searchParams.set('__admob_batch_worker', randomUUID());
    const worker = await run.context.newPage(); await worker.goto(url.href);
    await worker.locator('#abc-worker-status').waitFor();
    const duplicate = await run.context.newPage();
    await duplicate.goto(url.href);
    await duplicate.locator('#abc-batch-creator').filter({ hasText: '已有活动主控' }).waitFor({ timeout: 10000 });
    assert.equal(run.backend.requests.length, 0); assert.equal(sentinel.isClosed(), false); assert.equal(await sentinel.title(), 'User tab sentinel'); assert.deepEqual(run.errors, []);
    return { controllerMutex: true, workerMutex: true, deferredPageStartedAfterFocus: true, diagnosticTabsClosed: 2, unrelatedTabRetained: true, createRequests: 0 };
  } finally { await run.close(); }
}

async function delayedSubmitLock(browser) {
  const helper = await build({
    stdin: { contents: "import { serializeSubmission } from './src/gm.ts'; window.__serializeSubmission = serializeSubmission;", resolveDir: process.cwd(), sourcefile: 'submission-lock-browser-test.js' },
    bundle: true, write: false, format: 'iife', target: ['chrome109'],
  });
  const run = await setup(browser, { delay: 0 });
  try {
    const first = await run.context.newPage(); const second = await run.context.newPage();
    const publisherId = 'pub-1111111111111111';
    const lockName = 'admob-batch-submit:' + publisherId;
    for (const [page, worker] of [[first, 'A'], [second, 'B']]) {
      await page.goto(origin + '/sentinel');
      await page.addScriptTag({ content: helper.outputFiles[0].text });
      await page.evaluate(worker => {
        const button = document.createElement('button'); button.id = 'submit-probe';
        button.textContent = 'Loopback test click'; document.body.append(button);
        button.addEventListener('click', () => {
          const clicks = JSON.parse(localStorage.getItem('submission-lock-clicks') || '[]');
          clicks.push({ worker, at: Date.now() }); localStorage.setItem('submission-lock-clicks', JSON.stringify(clicks));
        });
      }, worker);
    }
    await first.evaluate(publisherId => {
      const gate = new Promise(resolve => { window.__releaseSubmitGate = resolve; });
      window.__submission = window.__serializeSubmission(publisherId, async beforeClick => {
        window.__enteredAt = Date.now();
        await gate;
        beforeClick(); document.querySelector('#submit-probe').click();
      }).then(() => { window.__finished = true; }, error => { window.__submissionError = error.message; });
    }, publisherId);
    await first.waitForFunction(() => window.__enteredAt !== undefined);
    await second.evaluate(publisherId => {
      window.__submission = window.__serializeSubmission(publisherId, async beforeClick => {
        window.__enteredAt = Date.now();
        beforeClick(); document.querySelector('#submit-probe').click();
      }).then(() => { window.__finished = true; }, error => { window.__submissionError = error.message; });
    }, publisherId);
    await second.waitForFunction(async lockName => {
      const locks = await navigator.locks.query();
      return locks.held.some(lock => lock.name === lockName) && locks.pending.some(lock => lock.name === lockName);
    }, lockName);
    // Hold A after it has acquired the actual browser lock and B has queued.
    // A delayed pre-click path must not let B consume its own callback early.
    await pause(2500);
    const beforeRelease = await second.evaluate(async lockName => ({
      entered: window.__enteredAt !== undefined,
      pending: (await navigator.locks.query()).pending.some(lock => lock.name === lockName),
    }), lockName);
    assert.equal(beforeRelease.entered, false, 'B cannot enter the submit callback while A owns the lock');
    assert.equal(beforeRelease.pending, true, 'B remains queued after A has been delayed for 2500 ms');
    await first.evaluate(() => { window.__releaseSubmitGate(); });
    await Promise.all([first, second].map(page => page.waitForFunction(() => window.__finished || window.__submissionError, undefined, { timeout: 10000 })));
    const outcome = await first.evaluate(() => ({
      clicks: JSON.parse(localStorage.getItem('submission-lock-clicks') || '[]'),
      enteredAt: window.__enteredAt, error: window.__submissionError,
    }));
    assert.equal(outcome.error, undefined);
    assert.equal(await second.evaluate(() => window.__submissionError), undefined);
    assert.deepEqual(outcome.clicks.map(click => click.worker), ['A', 'B']);
    const firstPreClickDelayMs = outcome.clicks[0].at - outcome.enteredAt;
    const actualClickIntervalMs = outcome.clicks[1].at - outcome.clicks[0].at;
    assert.ok(firstPreClickDelayMs >= 2500, 'A was delayed for at least 2500 ms after entering the locked callback');
    assert.ok(actualClickIntervalMs >= 2500, 'real cross-page DOM clicks remain at least 2500 ms apart');
    assert.equal(run.backend.requests.length, 0); assert.deepEqual(run.errors, []);
    return { realWebLocks: true, queuedCallbackBlocked: true, firstPreClickDelayMs, actualClickIntervalMs, clicks: outcome.clicks, createRequests: 0 };
  } finally { await run.close(); }
}

async function modesAndHistory(browser) {
  const run = await setup(browser, { delay: 0 });
  const batches = [];
  try {
    for (const format of ['banner', 'interstitial', 'rewarded-interstitial', 'rewarded', 'native', 'app-open']) {
      const modes = format === 'rewarded-interstitial' ? ['manual', 'auto', 'disabled'] : ['manual', 'auto', 'disabled', 'partner-bidding'];
      for (const mode of modes) {
        const name = `LOCAL_${format}_${mode}`;
        const partnerBidding = mode === 'partner-bidding';
        await configure(run, [[name, '1000']], format, partnerBidding ? 'disabled' : mode, 'single', partnerBidding);
        await openPreview(run); await confirmCreation(run);
        await run.page.waitForFunction(name => {
          const latest = Object.keys(localStorage).find(key => key.startsWith('gm:abc:v1:latest:'));
          const id = latest && JSON.parse(localStorage.getItem(latest));
          const key = Object.keys(localStorage).find(key => key.startsWith('gm:abc:v1:batch:') && key.endsWith(':' + id));
          return key && JSON.parse(localStorage.getItem(key)).tasks[0].name === name;
        }, name);
        const batch = await waitDone(run, 40000); batches.push(batch);
        assert.equal(batch.tasks.length, 1); assert.equal(batch.tasks[0].status, 'success');
        assert.equal(batch.tasks[0].actual.mode, mode); assert.equal(batch.tasks[0].actual.format, format);
        assert.equal(batch.tasks[0].actual.floor, mode === 'manual' ? '1000' : '');
        assert.equal(batch.partnerBidding, partnerBidding);
        const request = run.backend.requests.at(-1);
        assert.equal(request.mode, mode);
        assert.equal(request.floor, partnerBidding ? '' : batch.tasks[0].actual.floor);
        assert.ok(batch.startedAt && batch.completedAt);
      }
    }
    assert.equal(run.backend.requests.length, 23, 'one submit for every supported format/mode combination');
    const active = await readBatch(run.page);
    const panel = run.page.locator('#abc-panel-host');
    await panel.getByLabel('任务批次', { exact: true }).selectOption(batches[0].id);
    await panel.locator('.batch-meta').filter({ hasText: batches[0].id }).waitFor();
    await panel.getByRole('button', { name: '复制“名称 + ID”', exact: true }).click();
    assert.match(await run.page.evaluate(() => window.__mockClipboard), /LOCAL_banner_manual/);
    const downloaded = run.page.waitForEvent('download');
    await panel.getByRole('button', { name: '导出全部', exact: true }).click();
    const csv = await readFile(await (await downloaded).path(), 'utf8');
    assert.ok(csv.includes(batches[0].id)); assert.ok(!csv.includes(active.id));
    assert.deepEqual(await readBatch(run.page), active, 'history selection/copy/export leave active batch untouched');
    assert.equal(await panel.getByRole('button', { name: '开始创建', exact: true }).isDisabled(), true);
    assert.deepEqual(run.errors, []);
    return { combinations: 23, succeeded: 23, createRequests: 23, historyCopyExportIsolated: true, completeWorkflowTimestamps: true };
  } finally { await run.close(); }
}

async function prefixAndPreview(browser) {
  const run = await setup(browser, { delay: 0 });
  try {
    assert.equal(await run.page.locator('#abc-panel-host').getByRole('checkbox', { name: '合作平台出价', exact: true }).isChecked(), false, 'partner bidding is off by default');
    await configure(run, [['MANUAL_ALPHA', '60.0'], ['MANUAL_BETA', '80']], 'interstitial', 'manual', 'single');
    const panel = run.page.locator('#abc-panel-host');
    const names = panel.getByRole('textbox', { name: /^第 \d+ 行广告位名称$/ });
    const floors = panel.getByRole('textbox', { name: /^第 \d+ 行底价 USD$/ });
    const prefix = panel.getByLabel('名称前缀', { exact: true });
    const prefixSwitch = panel.getByRole('switch', { name: '批量应用前缀', exact: true });
    const partnerBidding = panel.getByRole('checkbox', { name: '合作平台出价', exact: true });
    const mode = panel.getByLabel('底价模式', { exact: true });
    const start = panel.locator('[data-action="start"]');
    const dialog = panel.locator('dialog.creation-preview');
    assert.equal(await panel.getByLabel('CSV 或 TSV 输入', { exact: true }).count(), 0, 'legacy bulk paste input is removed');
    assert.equal(await panel.locator('input[type="file"]').count(), 0, 'legacy file import is removed');

    await mode.selectOption('auto');
    assert.equal(await prefixSwitch.isDisabled(), true, 'prefix mode requires a manual floor');
    await mode.selectOption('manual');
    await prefix.fill('  LOCAL_  '); await prefixSwitch.check();
    assert.equal(await mode.inputValue(), 'manual');
    assert.equal(await mode.isDisabled(), true, 'generated names keep the floor mode manual');
    assert.deepEqual(await names.evaluateAll(inputs => inputs.map(input => input.value)), ['LOCAL_60', 'LOCAL_80']);
    assert.ok(await names.evaluateAll(inputs => inputs.every(input => input.readOnly)), 'generated names are read-only');

    await floors.nth(0).fill('60.50');
    assert.equal(await names.nth(0).inputValue(), 'LOCAL_60.5', 'floor edits regenerate the name with a canonical amount');
    await prefix.fill('NEW_');
    assert.equal(await names.nth(0).inputValue(), 'NEW_60.5', 'prefix edits replace the previous prefix');
    await floors.nth(1).fill('60.500');
    assert.equal(await start.isDisabled(), true, 'equivalent floor values cannot generate duplicate names');
    await floors.nth(1).fill('90');
    assert.equal(await start.isDisabled(), false);

    await openPreview(run);
    assert.equal(run.backend.requests.length, 0);
    await panel.locator('[data-action="cancel-preview"]').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await dialog.evaluate(element => element.open), false, 'cancel closes the persistent native dialog');
    assert.equal(run.backend.requests.length, 0, 'canceling the preview submits nothing');
    assert.equal(await readBatch(run.page), null, 'canceling the preview does not create a draft batch');

    await partnerBidding.check();
    assert.equal(await floors.count(), 0, 'partner bidding hides per-row floors');
    assert.equal(await prefixSwitch.isChecked(), false);
    assert.equal(await prefixSwitch.isDisabled(), true);
    assert.equal(await mode.isDisabled(), true);
    await openPreview(run);
    assert.deepEqual(await dialog.locator('tbody td:nth-child(5)').allTextContents(), ['不适用', '不适用']);
    await panel.locator('[data-action="cancel-preview"]').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await dialog.evaluate(element => element.open), false);
    assert.equal(run.backend.requests.length, 0, 'the selected partner-bidding preview can be canceled without execution');
    await partnerBidding.uncheck();
    await prefixSwitch.check();

    await panel.getByRole('button', { name: '增加一行', exact: true }).click();
    await floors.last().fill('100.0');
    assert.equal(await names.last().inputValue(), 'NEW_100');
    await prefixSwitch.uncheck();
    assert.deepEqual(await names.evaluateAll(inputs => inputs.map(input => input.value)), ['MANUAL_ALPHA', 'MANUAL_BETA', ''], 'switching off restores independent manual names');
    assert.ok(await names.evaluateAll(inputs => inputs.every(input => !input.readOnly)));
    await names.last().fill('MANUAL_ALPHA');
    assert.equal(await start.isDisabled(), false, 'manual names may repeat within the current list');
    await openPreview(run);
    await panel.locator('[data-action="cancel-preview"]').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await dialog.evaluate(element => element.open), false);
    assert.equal(run.backend.requests.length, 0);

    await prefixSwitch.check();
    assert.deepEqual(await names.evaluateAll(inputs => inputs.map(input => input.value)), ['NEW_60.5', 'NEW_90', 'NEW_100'], 're-enabling generation never repeats a prefix');
    await openPreview(run); await confirmCreation(run);
    const batch = await waitDone(run, 40000);
    assert.ok(batch.tasks.every(task => task.status === 'success'));
    assert.deepEqual(run.backend.requests.map(row => row.name), ['NEW_60.5', 'NEW_90', 'NEW_100']);
    assert.deepEqual(run.backend.requests.map(row => row.floor), ['60.5', '90', '100']);
    assert.deepEqual(run.errors, []);
    return { addedRows: 3, generatedNamesTrackFloors: true, canonicalFloorDuplicateBlocked: true, manualNamesRestored: true, manualDuplicateAllowed: true, partnerBiddingDefaultOff: true, partnerBiddingPreviewSnapshot: true, canceledPreviews: 3, noSubmitBeforeConfirmation: true, confirmedCreateRequests: 3 };
  } finally { await run.close(); }
}

async function controllerRefresh(browser) {
  const run=await setup(browser,{delay:3000,grantWindowClose:true});
  try {
    await configure(run, [['REFRESH_INFLIGHT', '60']]);
    await openPreview(run);await confirmCreation(run);
    const deadline=Date.now()+15000;
    while(!run.backend.requests.length && Date.now()<deadline)await pause(50);
    assert.equal(run.backend.requests.length,1,'one request was submitted before the refresh');
    const before=await readBatch(run.page);
    assert.ok(before.tasks[0].intentAt);
    assert.equal(before.tasks[0].actual?.unitId,undefined,'refresh occurs before the ID is returned');
    await run.page.reload();
    await run.page.waitForFunction(()=>{
      const key=Object.keys(localStorage).find(key=>key.startsWith('gm:abc:v1:batch:'));
      const batch=key&&JSON.parse(localStorage.getItem(key));
      return batch?.phase==='done' && batch.tasks[0].status==='success';
    },undefined,{timeout:30000});
    const after=await readBatch(run.page);
    assert.equal(after.id,before.id);assert.equal(after.tasks[0].assignmentId,before.tasks[0].assignmentId);
    assert.equal(after.tasks[0].actual.unitId,run.backend.requests[0].unitId);
    assert.equal(after.tasks[0].actual.verified,true);assert.equal(run.backend.requests.length,1);
    assert.deepEqual(run.context.pages(),[run.page]);
    assert.equal(run.closedWorkers.length,1);
    assert.deepEqual(run.errors,[]);
    return {createRequests:1,restoredSameAssignment:true,lateIdCollected:true,savedConfigurationVerified:true,workerTabsClosed:1};
  } finally {await run.close();}
}

async function manualConnectionFallback(browser) {
  const run = await setup(browser, { silentTabOpen: true });
  try {
    const panel = run.page.locator('#abc-panel-host');
    const notice = panel.getByRole('status');
    await panel.getByLabel('执行方式', { exact: true }).selectOption('single');
    await panel.getByRole('button', { name: '检测跨页能力' }).click();
    await notice.filter({ hasText: '自动打开尚未收到执行页回应' }).waitFor({ timeout: 7000 });
    // Production links accept only AdMob hosts. The separate panel test
    // covers that link; this fixture opens the corresponding loopback worker.
    const workerId = await run.page.evaluate(() => {
      const prefix = 'gm:abc:v1:command:';
      return Object.keys(localStorage).find(key => key.startsWith(prefix))?.slice(prefix.length);
    });
    assert.ok(workerId, 'the manual fallback uses the waiting worker assignment');
    const url = new URL(run.page.url());
    url.search = '';
    url.searchParams.set('__admob_batch_worker', workerId);
    const worker = await run.context.newPage();
    await worker.goto(url.href, { waitUntil: 'domcontentloaded' });
    await notice.filter({ hasText: '跨页检查通过' }).waitFor({ timeout: 30000 });
    assert.equal(await readBatch(run.page), null);
    assert.equal(run.backend.requests.length, 0);
    const mailboxes = await run.page.evaluate(() => Object.keys(localStorage).filter(key =>
      key.startsWith('gm:abc:v1:command:') || key.startsWith('gm:abc:v1:report:')));
    assert.deepEqual(mailboxes, []);
    return { automaticOpenHadNoPage: true, manualLinkPassed: true, diagnosticMailboxesRemoved: true, createRequests: 0 };
  } finally { await run.close(); }
}

async function batchOpenFailure(browser) {
  const run = await setup(browser, { delay: 0, skipOpenNumber: 3 });
  try {
    const rows = Array.from({ length: 5 }, (_, index) => [`AUTONOMOUS_${index + 1}`, String(60 + index * 10)]);
    const panel = run.page.locator('#abc-panel-host');
    await configure(run, rows);
    await openPreview(run); await confirmCreation(run);

    const notice = panel.getByRole('status');
    await notice.filter({ hasText: '创建页启动超时' }).waitFor({ timeout: 40000 });
    await panel.locator('[data-action="start"]').waitFor();
    await run.page.waitForFunction(() => !document.querySelector('#abc-panel-host').shadowRoot.querySelector('[data-action="start"]').disabled);
    const draft = await readBatch(run.page);
    assert.equal(draft.phase, 'draft');
    assert.equal(draft.execution, 'paged');
    assert.equal(draft.tasks.length, 5);
    assert.ok(draft.tasks.every(task => task.status === 'pending' && !task.assignmentId && !task.intentAt && !task.actual));
    assert.equal(run.backend.requests.length, 0, 'a missing worker leaves all rows unsubmitted');
    assert.equal(run.opens.length, 5);
    assert.equal(run.closedWorkers.length, 4, 'all four opened workers are closed after the startup timeout');
    assert.deepEqual(run.context.pages(), [run.page]);
    assert.deepEqual(await run.page.evaluate(() => Object.keys(localStorage).filter(key =>
      key.startsWith('gm:abc:v1:command:') || key.startsWith('gm:abc:v1:report:'))), []);

    await panel.getByLabel('执行方式', { exact: true }).selectOption('single');
    await openPreview(run); await confirmCreation(run);
    const serial = await waitDone(run, 40000);
    assert.equal(serial.execution, 'single');
    assert.equal(serial.concurrency, 1);
    assert.ok(serial.tasks.every(task => task.status === 'success' && task.actual?.verified && task.attempts === 1));
    assert.deepEqual(run.backend.requests.map(row => [row.name, row.floor]), rows);
    assert.equal(new Set(run.backend.requests.map(row => row.unitId)).size, 5);
    assert.equal(run.opens.length, 5, 'serial retries on the original page');
    assert.deepEqual(run.context.pages(), [run.page]);
    assert.equal(run.metrics.peakActiveAssignments, 1);
    assert.deepEqual(run.errors, []);
    return { pendingRowsAfterOpenFailure: 5, workerTabsClosedAfterOpenFailure: 4, createRequestsAfterOpenFailure: 0,
      explicitSerialMode: serial.execution, verifiedRows: 5, createRequests: run.backend.requests.length };
  } finally { await run.close(); }
}

async function pagedCreatesAndCloses(browser) {
  const run = await setup(browser, { delay: 400, simulateForeground: true });
  try {
    const sentinel = await run.context.newPage();
    await sentinel.goto(origin + '/sentinel');
    await run.page.bringToFront();
    const rows = Array.from({ length: 5 }, (_, index) => [`PAGED_${index + 1}`, String(600 + index * 100)]);
    const panel = run.page.locator('#abc-panel-host');
    assert.equal(await panel.getByLabel('执行方式').inputValue(), 'paged');
    assert.deepEqual(await panel.getByLabel('执行方式').locator('option').allTextContents(), ['并发', '串行（当前页逐条执行）']);
    assert.equal(await panel.getByLabel('并发数').count(), 0);
    await configure(run, rows);
    await openPreview(run);
    assert.equal(run.opens.length, 0);
    const start = await confirmCreation(run);
    const batch = await waitDone(run, 110000);
    const confirmedToEndMs = Date.now() - start;

    assert.equal(batch.execution, 'paged');
    assert.equal(batch.concurrency, 1);
    assert.equal(run.opens.length, rows.length);
    assert.ok(run.opens.every(open => new URL(open.url).pathname === '/v2/apps/2222222222/adunits/create' && open.active));
    assert.ok(run.opens.every(open => open.openerId === null), 'all worker tabs are owned by the controller');
    assert.deepEqual(run.backend.requests.map(row => [row.name, row.floor]), rows);
    const openTimes = run.opens.map(open => open.at);
    const startup = run.probes.filter(report => !report.probe.identity);
    const identityChecks = run.probes.filter(report => report.probe.identity);
    assert.equal(startup.length, rows.length);
    assert.ok(Math.max(...openTimes) <= Math.min(...startup.map(report => report.at)), 'all open requests precede the first worker reply');
    assert.equal(identityChecks.length, rows.length);
    assert.ok(identityChecks.every(report => report.probe.locked && report.probe.notifications), 'every focused page passes real cross-page lock and notification checks');
    assert.equal(run.metrics.peakActiveAssignments, 1);
    assert.equal(run.backend.peakInflight, 1);
    assert.equal(new Set(run.backend.requests.map(row => row.tab)).size, rows.length, 'each row uses its own tab');
    assert.deepEqual(run.focuses.map(item => item.workerId), run.closedWorkers.map(item => item.workerId));
    assert.equal(run.context.pages().length, 2, 'the original controller and unrelated user page remain');
    assert.equal(sentinel.isClosed(), false);
    assert.ok(batch.tasks.every(task => task.status === 'success' && task.actual?.verified && task.attempts === 1));
    for (const [index, request] of run.backend.requests.entries()) {
      assert.equal(batch.tasks[index].actual.unitId, request.unitId);
      const closedAt = run.closedWorkers[index].at;
      assert.ok(closedAt >= Date.parse(batch.tasks[index].finishedAt), 'worker closes after collecting verified proof');
      if (index + 1 < rows.length) assert.ok(closedAt <= run.focuses[index + 1].at, 'the next row receives focus after the previous worker closes');
    }
    assert.deepEqual(run.errors, []);
    return { rows: rows.length, confirmedToEndMs, openRequestSpanMs: Math.max(...openTimes) - Math.min(...openTimes),
      directCreatePages: run.opens.length, allRequestsBeforeFirstStartupReply: true, workerFocusVerified: true, peakActiveAssignments: 1,
      peakInflightSaves: 1, verified: rows.length, workerTabsClosed: run.closedWorkers.length, extraTabsAtEnd: 0 };
  } finally { await run.close(); }
}

async function stoppedBatchUnblocksNext(browser) {
  const run = await setup(browser, { delay: 0, simulateForeground: true });
  try {
    const id = randomUUID();
    const oldKey = await run.page.evaluate(id => {
      const now = new Date(Date.now() - 60000).toISOString();
      const identity = { publisherId: 'pub-1111111111111111', appId: 'ca-app-pub-1111111111111111~2222222222', appName: '测试应用', evidence: [] };
      const batch = {
        schema: 1, id, identity, format: 'interstitial', mode: 'manual', currency: 'USD', execution: 'tabs', concurrency: 2,
        createdAt: now, startedAt: now, confirmedAt: now, stopRequestedAt: now, sourceUrl: location.href,
        phase: 'paused', canaryPassed: false, controllerId: 'previous-controller',
        tasks: [1, 2].map(line => ({
          id: 'old-task-' + line, line, name: 'UNCERTAIN_' + line, floor: '60', mode: 'manual', status: 'uncertain',
          reason: '跨页通信等待超时', intentAt: line === 2 ? now : undefined, assignmentId: 'old-assignment-' + line,
          workerId: 'old-worker-' + line, attempts: 1, logs: [{ at: now, step: 'uncertain', message: '跨页通信等待超时' }],
        })),
      };
      const key = 'gm:abc:v1:batch:' + identity.publisherId + ':' + identity.appId + ':' + id;
      localStorage.setItem(key, JSON.stringify(batch));
      localStorage.setItem('gm:abc:v1:latest:' + identity.publisherId + ':' + identity.appId, JSON.stringify(id));
      localStorage.setItem('gm:abc:v1:active:' + identity.publisherId, JSON.stringify({ id, appId: identity.appId }));
      return key;
    }, id);
    await run.page.reload();
    const panel = run.page.locator('#abc-panel-host');
    await panel.locator('.batch-meta').filter({ hasText: id }).waitFor();
    await panel.locator('.batch-meta').filter({ hasText: '已停止' }).waitFor();
    const archived = await readBatch(run.page);
    assert.equal(archived.phase, 'done');
    assert.equal(archived.id, id);
    assert.deepEqual(archived.tasks.map(task => task.status), ['uncertain', 'uncertain']);
    assert.equal(archived.tasks[1].intentAt, archived.stopRequestedAt);
    assert.equal(run.backend.requests.length, 0);

    const rows = [['NEW_AFTER_STOP_A', '60'], ['NEW_AFTER_STOP_B', '70']];
    await configure(run, rows);
    await openPreview(run);
    await confirmCreation(run);
    await run.page.waitForFunction(previous => {
      const key = Object.keys(localStorage).find(value => value.startsWith('gm:abc:v1:latest:'));
      return key && JSON.parse(localStorage.getItem(key)) !== previous;
    }, id);
    const completed = await waitDone(run, 45000);
    assert.notEqual(completed.id, id);
    assert.ok(completed.tasks.every(task => task.status === 'success'));
    assert.deepEqual(run.backend.requests.map(request => [request.name, request.floor]), rows);
    assert.equal(run.context.pages().length, 1);

    await panel.getByLabel('任务批次', { exact: true }).selectOption(id);
    await panel.locator('.batch-meta').filter({ hasText: id }).waitFor();
    assert.equal(await panel.locator('.result-table').getByText('结果不确定', { exact: true }).count(), 2);
    const persisted = await run.page.evaluate(key => JSON.parse(localStorage.getItem(key)), oldKey);
    assert.deepEqual(persisted.tasks, archived.tasks, 'the new batch never alters or retries uncertain old rows');
    assert.equal((await readBatch(run.page)).id, completed.id);
    await panel.locator('[data-action="verify"]').click();
    await run.page.waitForFunction(() => !document.querySelector('#abc-panel-host').shadowRoot.querySelector('[data-action="verify"]').disabled);
    assert.equal(await panel.locator('.result-table').getByText('结果不确定', { exact: true }).count(), 2);
    assert.deepEqual(await readBatch(run.page), completed, 'history verification preserves the current completed batch');
    assert.equal(run.backend.requests.length, rows.length, 'history verification submits nothing');
    assert.deepEqual(run.errors, []);
    return { migratedLegacyStoppedBatch: true, unresolvedRowsRetained: 2, newRowsVerified: 2, priorRowsRecreated: 0, extraTabsAtEnd: 0 };
  } finally { await run.close(); }
}

let browser;
try {
  const executablePath = process.env.ADMOB_BROWSER_PATH;
  if (executablePath) assert.ok(existsSync(executablePath), 'ADMOB_BROWSER_PATH does not exist');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  results.browser = { name: 'Chromium', version: browser.version(), profile: 'temporary isolated Playwright context' };
  const cases = [['stopped-batch-unblocks-next', () => stoppedBatchUnblocksNext(browser)], ['paged-creates-and-closes', () => pagedCreatesAndCloses(browser)], ['batch-open-failure', () => batchOpenFailure(browser)], ['manual-connection-fallback', () => manualConnectionFallback(browser)], ['cross-page-locks', () => lockChecks(browser)], ['delayed-submit-lock', () => delayedSubmitLock(browser)], ['prefix-and-preview', () => prefixAndPreview(browser)], ['modes-and-history', () => modesAndHistory(browser)], ['serial-benchmark', () => serialBenchmark(browser)], ['controller-refresh', () => controllerRefresh(browser)]];
  for (const [name, execute] of cases) {
    if (existsSync(resolve('tests/.browser-pause'))) { results.paused = true; break; }
    if (process.env.CASE_FILTER && !name.includes(process.env.CASE_FILTER)) continue;
    console.log('START ' + name);
    try { const details = await execute(); results.cases.push({ name, pass: true, ...details }); console.log(JSON.stringify(results.cases.at(-1))); }
    catch (error) { results.cases.push({ name, pass: false, error: error.stack }); console.error(error.stack); }
    // Persist every completed case before opening the next context so a
    // resource pause never loses already measured evidence.
    await writeFile(outputPath, JSON.stringify(results, null, 2) + '\n');
  }
} finally {
  if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(outputPath, JSON.stringify(results, null, 2) + '\n'); console.log('RESULTS ' + outputPath);
}
if (!results.cases.length || results.cases.some(result => !result.pass)) process.exitCode = 1;

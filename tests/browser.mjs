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
      assert.ok(input.name && ['manual', 'auto', 'disabled'].includes(input.mode));
      assert.ok(input.mode !== 'manual' || /^\d+(?:\.\d+)?$/.test(input.floor));
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
const outputPath = resolve(process.env.ADMOB_BROWSER_RESULTS || 'tests/browser-results-0.5.2.json');
const results = {
  at: new Date().toISOString(),
  scope: 'Isolated headless Chromium; real pages, Web Locks, native storage notifications; simulated GM and delayed loopback backend. Not HubVPS/Tampermonkey or real AdMob acceptance.',
  script: { version: script.toString().match(/@version\s+(\S+)/)?.[1], bytes: script.length, sha256: createHash('sha256').update(script).digest('hex') },
  workload: { rows: rowsCount, saveDelayMs, throttleMs: 2500 }, cases: [],
  measurements: { heap: 'Sum of page CDP JSHeapUsedSize, sampled every 2 seconds; excludes native browser memory', serializedBytes: 'Logical UTF-16 bytes (2 * string length), not disk usage' },
};

async function setup(browser, { delay = saveDelayMs } = {}) {
  const id = randomUUID();
  const backend = { sequence: 0, requests: [], delay, inflight: 0, peakInflight: 0 }; backends.set(id, backend);
  const context = await browser.newContext({ viewport: { width: 1500, height: 1150 }, acceptDownloads: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const workers = new Map(); const errors = []; const opens = []; const sessions = new Map();
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
  await context.exposeBinding('__abcOpen', async ({ page }, url, workerId) => {
    opens.push(await page.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.startsWith('gm:abc:v1:batch:'));
      return { at: Date.now(), canaryPassed: key ? JSON.parse(localStorage.getItem(key)).canaryPassed : false };
    }));
    const worker = await context.newPage(); workers.set(workerId, worker);
    metrics.peakWorkers = Math.max(metrics.peakWorkers, [...workers.values()].filter(page => !page.isClosed()).length);
    await worker.goto(url); return true;
  });
  await context.exposeBinding('__abcClose', async (_source, workerId) => { await workers.get(workerId)?.close(); return true; });
  await context.addInitScript(() => {
    const listeners = new Map(); let listenerId = 0;
    const decode = value => value === null ? undefined : JSON.parse(value);
    const metrics = window.__gmMetrics = { writes: 0, writeBytes: 0, remoteNotifications: 0, probes: [] };
    // Playwright also initializes each new about:blank document, where the
    // secure-context UUID API is absent. This ID belongs only to the shim.
    window.__gmTestTabId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'blank-' + Math.random();
    window.GM_getValue = (key, fallback) => { const value = localStorage.getItem('gm:' + key); return value === null ? fallback : decode(value); };
    window.GM_setValue = (key, value) => {
      const old = localStorage.getItem('gm:' + key); const next = JSON.stringify(value);
      metrics.writes++; metrics.writeBytes += 2 * (key.length + next.length);
      if (value?.type === 'hello' && value.probe) metrics.probes.push(value.probe);
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
    window.GM_openInTab = url => {
      const id = crypto.randomUUID(); void window.__abcOpen(url, id);
      return { closed: false, close() { this.closed = true; void window.__abcClose(id); } };
    };
  });
  const page = await context.newPage(); await page.goto(origin + '/v2/apps/2222222222/adunits/list?run=' + id);
  await page.locator('#abc-panel-host .identity-state').filter({ hasText: '账号与应用已识别' }).waitFor();
  return { context, page, backend, errors, opens, metrics, workers, sample,
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
async function configure(run, rows, concurrency, format = 'interstitial', mode = 'manual', execution = 'tabs') {
  const page = run.page;
  const panel = page.locator('#abc-panel-host');
  await panel.getByLabel('广告格式', { exact: true }).selectOption(format);
  await panel.getByLabel('底价模式', { exact: true }).selectOption(mode);
  await panel.getByLabel('执行方式', { exact: true }).selectOption(execution);
  if (execution === 'tabs') await panel.getByLabel('并发数', { exact: true }).selectOption(String(concurrency));
  await page.getByLabel('CSV 或 TSV 输入', { exact: true }).fill((mode === 'manual' ? '广告位名称,底价USD\n' : '广告位名称\n') + rows.map(row => mode === 'manual' ? row.join(',') : row[0]).join('\n'));
  assert.equal(await panel.locator('.input-table tbody tr:not(.error-row)').count(), rows.length, 'paste immediately fills editable rows');
  await page.getByRole('checkbox').check();
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

async function benchmark(browser, concurrency) {
  const run = await setup(browser);
  try {
    const rows = Array.from({ length: rowsCount }, (_, index) => ['POOL_' + (index + 1), (100 + index * 7 + (index % 2 ? 0.25 : 0)).toString()]);
    const setupAt = Date.now(); await configure(run, rows, concurrency); const inputMs = Date.now() - setupAt;
    const start = Date.now(); await run.page.getByRole('button', { name: '开始创建', exact: true }).click();
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
    assert.ok(run.opens.length <= concurrency, 'pool never exceeds configured capacity');
    const canaryDone = Date.parse(batch.tasks[0].finishedAt);
    assert.ok(batch.tasks.slice(1).every(task => Date.parse(task.logs.find(log => log.step === 'filling')?.at) >= canaryDone), 'new batch first-row verification precedes remaining work');
    const assignments = new Map(); for (const task of batch.tasks) assignments.set(task.workerId, (assignments.get(task.workerId) || 0) + 1);
    if (rows.length > concurrency) assert.ok([...assignments.values()].some(count => count > 1), 'worker pages are reused');
    assert.ok(batch.startedAt && batch.completedAt && Date.parse(batch.completedAt) >= Date.parse(batch.confirmedAt), 'batch records total workflow timestamps');
    const grants = gaps(batch.tasks.map(task => Date.parse(task.intentAt)).sort((a, b) => a - b));
    const submits = gaps(run.backend.requests.map(row => row.at));
    assert.ok(grants.every(gap => gap >= 2450), 'publisher-wide grants retain the 2500 ms throttle');
    assert.ok(submits.every(gap => gap >= 1950), 'no burst submissions between worker pages');
    const gm = []; for (const page of run.context.pages()) gm.push(await page.evaluate(() => window.__gmMetrics));
    assert.ok(gm.flatMap(page => page.probes).some(probe => probe.locked && probe.notifications), 'real cross-page lock exclusion and native remote notification observed');
    const remoteNotifications = gm.reduce((sum, page) => sum + page.remoteNotifications, 0); assert.ok(remoteNotifications > 0); assert.deepEqual(run.errors, []);
    const storage = await run.page.evaluate(() => ({ entries: localStorage.length,
      bytes: Object.keys(localStorage).reduce((total, key) => total + 2 * (key.length + localStorage.getItem(key).length), 0),
      gmEntries: Object.keys(localStorage).filter(key => key.startsWith('gm:')).length }));
    return { concurrency, rows: rows.length, inputMs, automaticPreparationMs: Date.parse(batch.confirmedAt) - Date.parse(batch.startedAt), elapsedMs, elapsedIncludesAutomaticPreparation: true, rowsPerMinute: rows.length * 60000 / elapsedMs,
      workerTabsOpened: run.opens.length, ...run.metrics, peakInflightSaves: run.backend.peakInflight,
      tasksPerWorker: [...assignments.values()].sort((a, b) => b - a), grantIntervalsMs: stats(grants), submitIntervalsMs: stats(submits), remoteNotifications,
      gmWrites: gm.reduce((sum, page) => sum + page.writes, 0), gmWriteBytes: gm.reduce((sum, page) => sum + page.writeBytes, 0), storage,
      assertions: ['exact-name-floor-format-app-publisher-id', 'unique-id-and-no-resubmit', 'verified-canary-before-expansion', 'pool-reuse-and-cap', 'global-throttle', 'real-Web-Locks', 'native-remote-storage-notifications'] };
  } finally { await run.close(); }
}
async function lockChecks(browser) {
  const run = await setup(browser, { delay: 0 });
  try {
    await run.page.getByRole('button', { name: '检测跨页能力', exact: true }).click();
    await run.page.locator('#abc-panel-host .notice').filter({ hasText: '跨页能力检查通过' }).waitFor();
    const sentinel = await run.context.newPage(); await sentinel.goto(origin + '/sentinel');
    const second = await run.context.newPage(); await second.goto(run.page.url());
    await second.getByRole('button', { name: '检测跨页能力', exact: true }).click();
    await second.locator('#abc-panel-host .notice').filter({ hasText: '已有活动主控' }).waitFor({ timeout: 10000 });
    const worker = [...run.workers.values()][0]; const state = await worker.evaluate(() => JSON.parse(sessionStorage.getItem('mock:tab')));
    const duplicate = await run.context.newPage(); const url = new URL(run.page.url()); url.searchParams.set('__admob_batch_worker', state.abcWorkerId);
    await duplicate.goto(url.href);
    await duplicate.locator('#abc-batch-creator').filter({ hasText: '已有活动主控' }).waitFor({ timeout: 10000 });
    assert.equal(run.backend.requests.length, 0); assert.equal(sentinel.isClosed(), false); assert.equal(await sentinel.title(), 'User tab sentinel'); assert.deepEqual(run.errors, []);
    return { controllerMutex: true, workerMutex: true, unrelatedTabRetained: true, createRequests: 0 };
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
    for (const format of ['interstitial', 'app-open', 'native']) for (const mode of ['manual', 'auto', 'disabled']) {
      const name = `LOCAL_${format}_${mode}`;
      await configure(run, [[name, '1000']], 1, format, mode, 'single');
      await run.page.getByRole('button', { name: '开始创建', exact: true }).click();
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
      assert.ok(batch.startedAt && batch.completedAt);
    }
    assert.equal(run.backend.requests.length, 9, 'one submit for every format/mode combination');
    const active = await readBatch(run.page);
    const panel = run.page.locator('#abc-panel-host');
    await panel.getByLabel('任务批次', { exact: true }).selectOption(batches[0].id);
    await panel.locator('.batch-meta').filter({ hasText: batches[0].id }).waitFor();
    await panel.getByRole('button', { name: '复制“名称 + ID”', exact: true }).click();
    assert.match(await run.page.evaluate(() => window.__mockClipboard), /LOCAL_interstitial_manual/);
    const downloaded = run.page.waitForEvent('download');
    await panel.getByRole('button', { name: '导出全部', exact: true }).click();
    const csv = await readFile(await (await downloaded).path(), 'utf8');
    assert.ok(csv.includes(batches[0].id)); assert.ok(!csv.includes(active.id));
    assert.deepEqual(await readBatch(run.page), active, 'history selection/copy/export leave active batch untouched');
    assert.equal(await panel.getByRole('button', { name: '开始创建', exact: true }).isDisabled(), true);
    assert.deepEqual(run.errors, []);
    return { combinations: 9, succeeded: 9, createRequests: 9, historyCopyExportIsolated: true, completeWorkflowTimestamps: true };
  } finally { await run.close(); }
}

async function controllerRefresh(browser) {
  const run=await setup(browser,{delay:3000});
  try {
    await configure(run,[['REFRESH_INFLIGHT','60']],1);
    await run.page.getByRole('button',{name:'开始创建',exact:true}).click();
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
    assert.deepEqual(run.errors,[]);
    return {createRequests:1,restoredSameAssignment:true,lateIdCollected:true,savedConfigurationVerified:true};
  } finally {await run.close();}
}

let browser;
try {
  const executablePath = process.env.ADMOB_BROWSER_PATH;
  if (executablePath) assert.ok(existsSync(executablePath), 'ADMOB_BROWSER_PATH does not exist');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  results.browser = { name: 'Chromium', version: browser.version(), profile: 'temporary isolated Playwright context' };
  const cases = [['cross-page-locks', () => lockChecks(browser)], ['delayed-submit-lock', () => delayedSubmitLock(browser)], ['modes-and-history', () => modesAndHistory(browser)], ['concurrency-1', () => benchmark(browser, 1)], ['concurrency-5', () => benchmark(browser, 5)], ['controller-refresh',()=>controllerRefresh(browser)]];
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
  const one = results.cases.find(result => result.name === 'concurrency-1' && result.pass); const five = results.cases.find(result => result.name === 'concurrency-5' && result.pass);
  if (one && five) results.comparison = { speedup: one.elapsedMs / five.elapsedMs, timeReductionPercent: 100 * (1 - five.elapsedMs / one.elapsedMs), additionalWorkerTabs: five.peakWorkers - one.peakWorkers };
} finally {
  if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(outputPath, JSON.stringify(results, null, 2) + '\n'); console.log('RESULTS ' + outputPath);
}
if (!results.cases.length || results.cases.some(result => !result.pass)) process.exitCode = 1;

import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.ts';
import { performJob } from '../src/worker.ts';
import { createBatch, parseInput, exportCsv, copyPairs } from '../src/core.ts';
import { batchElapsed, summarizeBatch } from '../src/history.ts';
import type { Actual, Adapter, Batch, Identity, FloorMode } from '../src/types.ts';
import type { Command, Job, Journal, Report } from '../src/protocol.ts';
import type { PanelHandle } from '../src/panel.ts';

const PREFIX = 'abc:v1:';
const identity: Identity = { publisherId: 'pub-1234567890123456', appId: 'ca-app-pub-1234567890123456~1234567890', appName: '运行时测试应用', evidence: ['mock'] };
const actual: Actual = { ...identity, name: '广告一', unitId: 'ca-app-pub-1234567890123456/1234567890', format: 'interstitial', mode: 'manual', floor: '60', currency: 'USD', verified: true };
const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value);
const storage = new Map<string, unknown>();
const writes: { key: string; value: unknown }[] = [];
Object.assign(globalThis, {
  GM_getValue: <T>(key: string, fallback?: T): T => storage.has(key) ? clone(storage.get(key) as T) : clone(fallback as T),
  GM_setValue: (key: string, value: unknown): void => { storage.set(key, clone(value)); writes.push({ key, value: clone(value) }); },
  GM_deleteValue: (key: string): void => { storage.delete(key); },
  GM_listValues: (): string[] => [...storage.keys()],
  GM_addValueChangeListener: (): number => 1,
  GM_removeValueChangeListener: (): void => {},
  GM_openInTab: (): never => { throw new Error('单元测试不得打开真实标签页'); },
  GM_setClipboard: (): void => {},
});

type Slot = Parameters<Controller['handle']>[0];
type Data = Omit<Report, 'id' | 'at' | 'workerId'>;
function fixture(rows = '广告一,60'): {
  controller: Controller; batch: Batch; job: Job; slot: Slot; adapter: Adapter; calls: { prepare: number; submit: number; verify: number }; updates: unknown[];
} {
  storage.clear(); writes.length = 0;
  const calls = { prepare: 0, submit: 0, verify: 0 };
  const adapter: Adapter = {
    identify: async () => clone(identity), home: async () => {}, diagnostics: () => ({}),
    lookup: async () => ({ complete: true, matches: [] }),
    prepare: async (_identity, _format, _name, _floor, checkpoint) => { calls.prepare++; await checkpoint(); },
    submit: async () => { calls.submit++; },
    verify: async () => { calls.verify++; return clone(actual); },
  };
  const controller = new Controller(adapter);
  const updates: unknown[] = [];
  controller.panel = { update: (value: unknown) => { updates.push(clone(value)); } } as unknown as PanelHandle;
  controller.identity = clone(identity);
  controller.lockRelease = () => {};
  controller.lockedPublisher = identity.publisherId;
  const batch = createBatch(parseInput(rows), identity, 'interstitial', 2, 'tabs', 'https://apps.admob.com/', controller.id);
  batch.phase = 'running';
  Object.assign(batch, { confirmedAt: new Date().toISOString() });
  controller.batch = batch;
  const task = batch.tasks[0];
  task.assignmentId = 'assignment'; task.workerId = 'worker'; task.attempts = 1;
  const slot: Slot = { id: 'worker', busy: 'assignment', since: Date.now(), probePassed: true, identity, batchId: batch.id };
  controller.slots.set(slot.id, slot);
  const job: Job = { batch: clone(batch), task: clone(task), assignmentId: 'assignment', workerId: 'worker', kind: 'create' };
  GM_setValue(PREFIX + 'command:worker', { seq: 1, job } satisfies Command);
  controller.save();
  return { controller, batch, job, slot, adapter, calls, updates };
}

function probePages(t: TestContext, fault?: 'lock' | 'notification' | 'identity') {
  const held = new Set<string>();
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request(name: string, _options: unknown, callback: (lock: { name: string } | null) => unknown) {
      if (held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve(callback({ name })).finally(() => { held.delete(name); });
    },
  } } });
  t.after(() => {
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const pages: { id: string; closed: boolean; challenges: string[]; close(): void }[] = [];
  const originalSet = GM_setValue;
  const reply = (page: typeof pages[number], command: Command, notified: boolean) => {
    if (!command.probe || page.closed) return;
    page.challenges.push(command.probe.nonce);
    const bad = pages.indexOf(page) === 2;
    originalSet(PREFIX + 'report:' + page.id, {
      id: crypto.randomUUID(), workerId: page.id, at: Date.now(), type: 'hello',
      probe: {
        nonce: command.probe.nonce,
        locked: held.has(command.probe.lockName) && !(bad && fault === 'lock'),
        notifications: notified && !(bad && fault === 'notification'),
        identity: bad && fault === 'identity' ? { ...identity, appId: 'ca-app-pub-1234567890123456~9999999999' } : clone(identity),
      },
    } satisfies Report);
  };
  t.mock.method(globalThis, 'GM_setValue', (key: string, value: unknown) => {
    originalSet(key, value);
    const page = pages.find(page => key === PREFIX + 'command:' + page.id);
    if (page) reply(page, value as Command, true);
  });
  t.mock.method(globalThis, 'GM_openInTab', (url: string) => {
    const id = new URL(url).searchParams.get('__admob_batch_worker')!;
    const page = { id, closed: false, challenges: [] as string[], close() { this.closed = true; } };
    pages.push(page); reply(page, GM_getValue<Command>(PREFIX + 'command:' + id), false);
    return page;
  });
  return pages;
}
function valueEvents(t: TestContext) {
  const listeners = new Map<number, { key: string; callback: (key: string, old: unknown, value: unknown, remote: boolean) => void }>();
  let sequence = 0;
  const originalSet = GM_setValue;
  t.mock.method(globalThis, 'GM_addValueChangeListener', (key: string, callback: (key: string, old: unknown, value: unknown, remote: boolean) => void) => {
    const id = ++sequence; listeners.set(id, { key, callback }); return id;
  });
  t.mock.method(globalThis, 'GM_removeValueChangeListener', (id: number) => { listeners.delete(id); });
  t.mock.method(globalThis, 'GM_setValue', (key: string, value: unknown) => {
    const old = GM_getValue(key); originalSet(key, value);
    for (const listener of [...listeners.values()]) if (listener.key === key) listener.callback(key, old, value, true);
  });
  return listeners;
}
function report(job: Job, data: Data, id: string = crypto.randomUUID()): Report { return { ...data, id, at: Date.now(), assignmentId: job.assignmentId, taskId: job.task.id, workerId: job.workerId }; }
function key(batch: Batch): string { return PREFIX + 'batch:' + batch.identity.publisherId + ':' + batch.identity.appId + ':' + batch.id; }

test('one Start checks a new batch automatically and total timing includes preparation and pause', async t => {
  const f=fixture();f.controller.batch=undefined;f.controller.slots.clear();
  (globalThis as unknown as {location:{href:string}}).location={href:'https://apps.admob.com/'};
  const epoch=Date.parse('2026-11-13T10:00:00.000Z');
  t.mock.timers.enable({apis:['Date'],now:epoch});
  const identify=f.adapter.identify;
  let checks=0;
  t.mock.method(f.adapter,'identify',async()=>{checks++;if(checks===1)t.mock.timers.tick(5000);return identify();});
  const config={format:'native' as const,mode:'disabled' as const,concurrency:1,execution:'single' as const,text:'NEW',rows:parseInput('NEW',{mode:'disabled'})};
  await f.controller.start(config);
  const batch=(f.controller as Controller).batch!;
  assert.equal(batch.phase,'running');assert.ok(checks>=2);
  assert.equal(Date.parse(batch.startedAt!),epoch);assert.equal(Date.parse(batch.confirmedAt!),epoch+5000);
  assert.equal(batch.mode,'disabled');assert.equal(batch.tasks[0].mode,'disabled');
  assert.equal(batch.completedAt,undefined);assert.equal(f.calls.submit,0);
  t.mock.timers.tick(10000);await f.controller.pause('test');
  t.mock.timers.tick(20000);await f.controller.resume();
  assert.equal(Date.parse(batch.startedAt!),epoch);assert.equal(batch.completedAt,undefined);
  batch.tasks[0].status='stopped';await f.controller.tick();
  assert.equal(batch.phase,'done');assert.equal(Date.parse(batch.completedAt!),epoch+35000);
  assert.equal(batchElapsed(summarizeBatch(batch)),'35.0 秒');
  t.mock.timers.tick(9000);f.controller.save();
  assert.equal(Date.parse(GM_getValue<Batch>(key(batch)).completedAt!),epoch+35000,'later saves preserve the original end');
});

test('nonmanual worker creation and verification retain the chosen mode without an amount',async t=>{
  for(const mode of ['auto','disabled'] as FloorMode[])await t.test(mode,async()=>{
    const f=fixture();f.batch.mode=mode;f.batch.format='native';f.batch.tasks[0].mode=mode;f.batch.tasks[0].floor='';
    f.job.batch=clone(f.batch);f.job.task=clone(f.batch.tasks[0]);f.controller.save();
    const seen:string[]=[];
    f.adapter.prepare=async(_i,format,_n,floor,checkpoint,selected)=>{assert.equal(format,'native');assert.equal(floor,'');seen.push(selected!);await checkpoint();};
    f.adapter.waitForUnitId=async()=>actual.unitId;
    f.adapter.verify=async(_i,format,name,floor,selected)=>{seen.push(selected!);return {...actual,format,name,floor,currency:'',mode:selected!};};
    await performJob(f.job,f.adapter,async data=>{await f.controller.handle(f.slot,report(f.job,data));},()=>permission(f.batch));
    assert.deepEqual(seen,[mode,mode]);assert.equal(f.calls.submit,1);
    assert.equal(f.batch.tasks[0].status,'success');assert.equal(f.batch.tasks[0].actual?.mode,mode);
    assert.equal(f.batch.tasks[0].actual?.floor,'');assert.equal(f.batch.tasks[0].actual?.currency,'');
  });
});

test('history browsing and exports are read only, scoped by publisher/app, and leave the active batch intact',()=>{
  const f=fixture();
  const old=createBatch(parseInput('HIST,80'),identity,'interstitial',1,'single','','old-controller');
  old.phase='done';old.tasks[0].status='success';old.tasks[0].actual={...actual,name:'HIST',floor:'80'};
  old.startedAt='2026-11-12T10:00:00.000Z';old.completedAt='2026-11-12T10:01:00.000Z';
  GM_setValue(key(old),old);
  const other=clone(old);other.id='other-app';other.identity.appId='ca-app-pub-1234567890123456~9999999999';GM_setValue(key(other),other);
  const foreign=clone(old);foreign.id='other-publisher';foreign.identity.publisherId='pub-9999999999999999';GM_setValue(key(foreign),foreign);
  const before=clone(f.batch);const storedBefore=new Map(storage);writes.length=0;
  f.controller.refreshHistory();
  const update=f.updates.at(-1) as {history:{id:string}[]};
  assert.deepEqual(new Set(update.history.map(row=>row.id)),new Set([old.id,f.batch.id]));
  const read=(id:string)=>(f.controller as unknown as {readHistory(id:string):Batch}).readHistory(id);
  const selected=read(old.id);
  assert.match(exportCsv(selected),/HIST/);assert.ok(!exportCsv(selected).includes('广告一'));assert.match(copyPairs(selected),/HIST/);
  assert.throws(()=>read(other.id),/未找到/);assert.throws(()=>read(foreign.id),/未找到/);assert.throws(()=>read('../bad'),/无效/);
  assert.deepEqual(f.controller.batch,before);assert.deepEqual(storage,storedBefore);assert.equal(writes.length,0);
});
async function permission(batch: Batch): Promise<void> {
  const cmd = GM_getValue<Command>(PREFIX + 'command:worker', { seq: 0 });
  if (cmd.blocked) throw new Error(cmd.blocked);
  if (batch.phase !== 'running') throw new Error('批次暂停，未提交');
  if (cmd.grant && (cmd.grant.assignmentId !== 'assignment' || cmd.grant.expires < Date.now())) throw new Error('提交许可无效');
}

test('submission intent and unique ownership are durable before the only create click', async () => {
  const f = fixture();
  f.adapter.submit = async () => {
    f.calls.submit++;
    const persisted = GM_getValue<Batch>(key(f.batch));
    const task = persisted.tasks[0];
    assert.equal(task.status, 'submitting');
    assert(task.intentAt);
    assert.equal(task.assignmentId, f.job.assignmentId);
    assert.equal(task.workerId, f.job.workerId);
    const journal = GM_getValue<Journal>(PREFIX + 'journal:' + f.job.assignmentId);
    assert.equal(journal.state, 'intent');
    const cmd = GM_getValue<Command>(PREFIX + 'command:worker');
    assert.equal(cmd.grant?.assignmentId, f.job.assignmentId);
  };
  await performJob(f.job, f.adapter, async data => { await f.controller.handle(f.slot, report(f.job, data)); }, () => permission(f.batch));
  assert.equal(f.calls.submit, 1);
  assert.equal(f.calls.verify, 1);
  assert.equal(f.batch.tasks[0].status, 'success');
  assert.equal(f.batch.tasks[0].actual?.unitId, actual.unitId);
  assert.equal(f.batch.canaryPassed, true);
});

test('paused intent receives a denial ACK and does not click create', async () => {
  const f = fixture(); let intentId = ''; let denial: Command | undefined;
  await performJob(f.job, f.adapter, async data => {
    const r = report(f.job, data);
    if (data.type === 'intent') { f.batch.phase = 'paused'; f.controller.save(); intentId = r.id; }
    await f.controller.handle(f.slot, r);
    if (data.type === 'intent') denial = GM_getValue<Command>(PREFIX + 'command:worker');
  }, () => permission(f.batch));
  assert.equal(denial?.ack, intentId);
  assert(denial?.blocked);
  assert.equal(denial?.grant, undefined);
  assert.equal(f.calls.submit, 0);
  assert.equal(f.batch.tasks[0].intentAt, undefined);
  assert.equal(f.batch.tasks[0].status, 'failed');
});

test('repeating the same intent report cannot grant twice or mutate the stored intent', async () => {
  const f = fixture(); f.batch.tasks[0].status = 'filling';
  const r = report(f.job, { type: 'intent' }, 'immutable-report');
  await f.controller.handle(f.slot, r);
  const intentAt = f.batch.tasks[0].intentAt;
  const command = clone(GM_getValue<Command>(PREFIX + 'command:worker'));
  const writeCount = writes.length;
  await f.controller.handle(f.slot, r);
  assert.equal(f.batch.tasks[0].intentAt, intentAt);
  assert.deepEqual(GM_getValue<Command>(PREFIX + 'command:worker'), command);
  assert.equal(writes.length, writeCount);
  assert.equal(f.batch.tasks[0].logs.filter(log => log.step === 'submitting').length, 1);
});

test('loading an unconfirmed draft cannot authorize resume after a refresh', async () => {
  const f = fixture();
  f.batch.phase = 'draft'; delete (f.batch as Batch & { confirmedAt?: string }).confirmedAt; f.controller.save();
  const restored = new Controller(f.adapter);
  restored.panel = { update: () => {} } as unknown as PanelHandle;
  restored.identity = clone(identity); restored.lockRelease = () => {}; restored.lockedPublisher = identity.publisherId;
  await restored.load();
  assert.equal(restored.batch?.phase, 'draft');
  assert.equal((restored.batch as Batch & { confirmedAt?: string }).confirmedAt, undefined);
  await assert.rejects(() => restored.resume(), /确认|预检|开始/);
  assert.notEqual(restored.batch?.phase, 'running');
});

test('stop converges to done only after no assignment is awaiting collection', async () => {
  const f = fixture('广告一,60\n广告二,40');
  f.batch.tasks[0].assignmentId = undefined; f.batch.tasks[0].workerId = undefined; f.slot.busy = undefined;
  await f.controller.stop();
  assert.equal(f.batch.phase, 'stopping');
  assert(f.batch.tasks.every(task => task.status === 'stopped'));
  await f.controller.tick();
  assert.equal(f.batch.phase, 'done');
  assert.equal(f.calls.submit, 0);
});

test('a frozen worker times out into uncertainty while retaining ownership, never a reassignment', async () => {
  const f = fixture('广告一,60\n广告二,40');
  Object.assign(f.batch.tasks[0], { status: 'submitting', intentAt: new Date().toISOString() });
  f.slot.since = Date.now() - 121_000;
  await f.controller.tick();
  assert.equal(f.batch.phase, 'paused');
  assert.equal(f.batch.tasks[0].status, 'uncertain');
  assert.equal(f.batch.tasks[0].assignmentId, 'assignment');
  assert.equal(f.slot.busy, 'assignment');
  await assert.rejects(() => f.controller.resume(), /待核验|先.*核验/);
  await f.controller.tick();
  assert.equal(f.batch.tasks[0].assignmentId, 'assignment');
  assert.equal(f.batch.tasks[1].assignmentId, undefined);
  assert.equal(f.calls.submit, 0);
});

test('an intent journal surviving worker refresh reports uncertainty without preparing or submitting', async () => {
  const f = fixture();
  GM_setValue(PREFIX + 'journal:' + f.job.assignmentId, { assignmentId: f.job.assignmentId, taskId: f.job.task.id, batchId: f.batch.id, state: 'intent' } satisfies Journal);
  const received: Data[] = [];
  await performJob(f.job, f.adapter, async data => { received.push(data); }, async () => {});
  assert.equal(received.length, 1);
  assert.equal(received[0].status, 'uncertain');
  assert.equal(f.calls.prepare, 0);
  assert.equal(f.calls.submit, 0);
});

test('a terminal result remains durable with its real ID if the result ACK transport fails', async () => {
  const f = fixture(); const received: Data[] = [];
  await performJob(f.job, f.adapter, async data => {
    received.push(clone(data));
    const r = report(f.job, data);
    if (data.type === 'result') {
      GM_setValue(PREFIX + 'journal:' + f.job.assignmentId, { assignmentId: f.job.assignmentId, taskId: f.job.task.id, batchId: f.batch.id, state: 'done', report: r } satisfies Journal);
      throw new Error('模拟最终ACK通信超时');
    }
    await f.controller.handle(f.slot, r);
  }, () => permission(f.batch));
  const journal = GM_getValue<Journal>(PREFIX + 'journal:' + f.job.assignmentId);
  assert.equal(journal.state, 'done');
  assert.equal(journal.report?.status, 'success');
  assert.equal(journal.report?.actual?.unitId, actual.unitId);
  assert.equal(received.filter(r => r.type === 'error').length, 0);
  assert.equal(f.calls.submit, 1);
});

test('a report with a different unit ID cannot replace a previously obtained real ID', async () => {
  const f = fixture();
  Object.assign(f.batch.tasks[0], { status: 'created-unverified', intentAt: new Date().toISOString(), actual: clone(actual) });
  const conflicting = { ...actual, unitId: 'ca-app-pub-1234567890123456/9999999999' };
  await f.controller.handle(f.slot, report(f.job, { type: 'result', status: 'success', actual: conflicting }));
  assert.equal(f.batch.tasks[0].actual?.unitId, actual.unitId);
  assert.equal(f.batch.tasks[0].status, 'created-unverified');
  assert.equal(f.batch.canaryPassed, false);
});

test('a late frozen-worker error is acknowledged without downgrading an independently verified result', async () => {
  const f = fixture();
  Object.assign(f.batch.tasks[0], { status: 'success', intentAt: new Date().toISOString(), actual: clone(actual) });
  f.slot.busy = undefined;
  const r = report(f.job, { type: 'error', status: 'uncertain', reason: '旧执行页通信已超时' });
  await f.controller.handle(f.slot, r);
  assert.equal(f.batch.tasks[0].status, 'success');
  assert.equal(f.batch.tasks[0].actual?.unitId, actual.unitId);
  assert.equal(GM_getValue<Command>(PREFIX + 'command:worker').ack, r.id);
});

test('verification transport errors restore an uncertain state with a reason, not a running verification', async () => {
  const f = fixture();
  f.batch.phase = 'paused';
  Object.assign(f.batch.tasks[0], { status: 'created-unverified', intentAt: new Date().toISOString(), actual: clone(actual) });
  f.adapter.lookup = async () => { throw new Error('模拟只读核验断网'); };
  await f.controller.verify().catch(() => {});
  assert.equal(f.controller.localBusy, false);
  assert.equal(f.batch.tasks[0].status, 'created-unverified');
  assert.equal(f.batch.tasks[0].actual?.unitId, actual.unitId);
  assert.match(f.batch.tasks[0].reason, /核验|断网/);
});

test('paused preflight uses fixed batch USD without separate confirmation and preserves all tasks', async () => {
  const f = fixture('广告一,60\n广告二,40');
  f.batch.phase = 'paused'; f.slot.busy = undefined;
  Object.assign(f.batch.tasks[0], { status: 'created-unverified', intentAt: new Date().toISOString(), actual: { ...actual, verified: false } });
  const before = clone(f.batch);
  const config = { format: 'interstitial' as const, concurrency: 2, execution: 'tabs' as const, text: '广告一,60\n广告二,40', rows: parseInput('广告一,60\n广告二,40') };
  await f.controller.preflight(config);
  assert.deepEqual(f.batch, before, '只读预检不能替换批次或丢失已知 ID、意图、分配');
  assert.equal(f.controller.identity?.currency, undefined);
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0);
  assert(f.updates.some(update => /按已确定的逐行金额与整批 USD/.test(JSON.stringify(update))));
  assert(!f.updates.some(update => /尚无真实 USD|创建前必须重新确认/.test(JSON.stringify(update))));
  await assert.rejects(() => f.controller.resume(), /待核验/);
  assert.equal(f.batch.phase, 'paused');
});

test('known-ID verification works without cached USD and unlocks the canary only after saved proof', async () => {
  const f = fixture('广告一,60\n广告二,40');
  f.batch.phase = 'paused'; f.slot.busy = undefined;
  Object.assign(f.batch.tasks[0], { status: 'created-unverified', intentAt: new Date().toISOString(), actual: { ...actual, verified: false } });
  f.adapter.verifyById = async (_identity, unitId) => { f.calls.verify++; assert.equal(unitId, actual.unitId); return clone(actual); };
  await f.controller.verify();
  assert.equal(f.batch.tasks[0].status, 'success');
  assert.equal(f.batch.tasks[0].actual?.unitId, actual.unitId);
  assert.equal(f.batch.canaryPassed, true); assert.equal(f.batch.phase, 'paused');
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0); assert.equal(f.calls.verify, 1);
  await f.controller.resume();
  assert.equal(f.batch.phase, 'running');
  assert.equal(f.calls.submit, 0, '继续仅恢复调度，不直接点击提交');
});

test('an uncertain submitted task persists its exact success receipt before saved-detail navigation', async () => {
  const f = fixture(); f.batch.phase = 'paused'; f.slot.busy = undefined;
  const intentAt = new Date().toISOString();
  Object.assign(f.batch.tasks[0], { status: 'uncertain', intentAt });
  f.adapter.recoverCreatedId = (received, name, format) => {
    assert.deepEqual(received, f.batch.identity); assert.equal(name, actual.name); assert.equal(format, actual.format);
    return actual.unitId;
  };
  f.adapter.lookup = async () => { throw new Error('已有精确说明凭据时不能退回同名查询'); };
  f.adapter.verifyById = async (_identity, unitId) => {
    f.calls.verify++;
    const persisted = GM_getValue<Batch>(key(f.batch)).tasks[0];
    assert.equal(unitId, actual.unitId); assert.equal(persisted.actual?.unitId, actual.unitId);
    assert.equal(persisted.actual?.verified, false, '导航前只能保存未核验凭据');
    assert.equal(persisted.intentAt, intentAt); assert.equal(persisted.assignmentId, 'assignment'); assert.equal(persisted.workerId, 'worker');
    return clone(actual);
  };
  await f.controller.verify();
  assert.equal(f.batch.tasks[0].status, 'success'); assert.equal(f.batch.tasks[0].actual?.unitId, actual.unitId);
  assert.equal(f.calls.verify, 1); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0);
});

test('a recovered success receipt survives saved-detail verification failure with its intent and ownership', async () => {
  const f = fixture(); f.batch.phase = 'paused'; f.slot.busy = undefined;
  const intentAt = new Date().toISOString(); Object.assign(f.batch.tasks[0], { status: 'uncertain', intentAt });
  f.adapter.recoverCreatedId = () => actual.unitId;
  f.adapter.verifyById = async () => { throw new Error('模拟保存详情断网'); };
  await f.controller.verify();
  const persisted = GM_getValue<Batch>(key(f.batch)).tasks[0];
  assert.equal(persisted.status, 'created-unverified'); assert.equal(persisted.actual?.unitId, actual.unitId);
  assert.equal(persisted.actual?.verified, false); assert.equal(persisted.intentAt, intentAt);
  assert.equal(persisted.assignmentId, 'assignment'); assert.equal(persisted.workerId, 'worker');
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0);
});

test('success receipt recovery is never attempted for an uncertain task without submission intent', async () => {
  const f = fixture(); f.batch.phase = 'paused'; f.slot.busy = undefined; f.batch.tasks[0].status = 'uncertain';
  let recovered = 0, lookedUp = 0;
  f.adapter.recoverCreatedId = () => { recovered++; return actual.unitId; };
  f.adapter.lookup = async () => { lookedUp++; return { complete: true, matches: [] }; };
  await f.controller.verify();
  assert.equal(recovered, 0); assert.equal(lookedUp, 1);
  assert.equal(f.batch.tasks[0].actual?.unitId, undefined); assert.equal(f.batch.tasks[0].status, 'uncertain');
  assert.equal(f.calls.submit, 0);
});

test('a submitted uncertain task without an exact receipt keeps its intent and uses conservative lookup', async () => {
  const f = fixture(); f.batch.phase = 'paused'; f.slot.busy = undefined;
  const intentAt = new Date().toISOString(); Object.assign(f.batch.tasks[0], { status: 'uncertain', intentAt });
  let lookedUp = 0; f.adapter.recoverCreatedId = () => undefined;
  f.adapter.lookup = async () => { lookedUp++; return { complete: true, matches: [] }; };
  await f.controller.verify();
  assert.equal(lookedUp, 1); assert.equal(f.batch.tasks[0].status, 'uncertain'); assert.equal(f.batch.tasks[0].actual?.unitId, undefined);
  assert.equal(f.batch.tasks[0].intentAt, intentAt); assert.equal(f.batch.tasks[0].assignmentId, 'assignment');
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0);
});

test('success receipts for another publisher are not persisted or used for saved-detail navigation', async () => {
  const f = fixture(); f.batch.phase = 'paused'; f.slot.busy = undefined;
  Object.assign(f.batch.tasks[0], { status: 'uncertain', intentAt: new Date().toISOString() });
  f.adapter.recoverCreatedId = () => 'ca-app-pub-9999999999999999/1234567890';
  f.adapter.verifyById = async () => { f.calls.verify++; return clone(actual); };
  await f.controller.verify();
  assert.equal(f.batch.tasks[0].actual?.unitId, undefined); assert.equal(f.batch.tasks[0].status, 'uncertain');
  assert.equal(f.calls.verify, 0); assert.equal(f.calls.submit, 0);
});

test('known-ID verification never overwrites original proof with a different unit ID', async () => {
  const f = fixture(); f.batch.phase = 'paused'; f.slot.busy = undefined;
  const original = { ...actual, verified: false };
  Object.assign(f.batch.tasks[0], { status: 'created-unverified', intentAt: new Date().toISOString(), actual: clone(original) });
  f.adapter.verifyById = async () => ({ ...actual, unitId: 'ca-app-pub-1234567890123456/9999999999' });
  await f.controller.verify();
  assert.equal(f.batch.tasks[0].status, 'created-unverified');
  assert.deepEqual(f.batch.tasks[0].actual, original);
  assert.equal(f.batch.canaryPassed, false); assert.equal(f.calls.submit, 0);
});

test('known-ID verification cannot unlock the canary with a different app or format', async () => {
  const f = fixture(); f.batch.phase = 'paused'; f.slot.busy = undefined;
  Object.assign(f.batch.tasks[0], { status: 'created-unverified', intentAt: new Date().toISOString(), actual: { ...actual, verified: false } });
  f.adapter.verifyById = async () => ({ ...actual, appId: 'ca-app-pub-1234567890123456~9999999999', format: 'app-open' });
  await f.controller.verify();
  assert.equal(f.batch.tasks[0].status, 'created-unverified');
  assert.equal(f.batch.canaryPassed, false); assert.equal(f.calls.submit, 0);
});

test('skipping an existing first row does not unlock concurrent creation before a real canary succeeds', async () => {
  const f = fixture('广告一,60\n广告二,40\n广告三,20');
  f.batch.createdAt = new Date(Date.now() - 1000).toISOString();
  await f.controller.handle(f.slot, report(f.job, { type: 'result', status: 'exists', actual: clone(actual) }));
  assert.equal(f.batch.canaryPassed, false);
  await f.controller.tick();
  assert(f.batch.tasks[1].assignmentId);
  await f.controller.tick();
  assert.equal(f.batch.tasks[2].assignmentId, undefined);
  assert.equal(f.calls.submit, 0);
});

test('reusing a worker slot preserves the prior terminal ACK while clearing stale grant and denial', async () => {
  const f = fixture('广告一,60\n广告二,40');
  f.slot.busy = undefined;
  GM_setValue(PREFIX + 'command:worker', {
    seq: 5, job: f.job, ack: 'old-terminal-report',
    grant: { assignmentId: f.job.assignmentId, expires: Date.now() + 10_000 }, blocked: '旧任务的拒绝许可',
  } satisfies Command);
  await f.controller.dispatch(f.slot, f.batch.tasks[1]);
  const cmd = GM_getValue<Command>(PREFIX + 'command:worker');
  assert.equal(cmd.ack, 'old-terminal-report');
  assert.equal(cmd.seq, 6);
  assert.equal(cmd.grant, undefined);
  assert.equal(cmd.blocked, undefined);
  assert.equal(cmd.job?.task.id, f.batch.tasks[1].id);
  assert.equal(cmd.job?.assignmentId, f.batch.tasks[1].assignmentId);
  assert.notEqual(cmd.job?.assignmentId, f.job.assignmentId);
  assert.equal(f.calls.submit, 0);
});

test('a late report for an already verified old task cannot clear the reused slot new assignment', async () => {
  const f = fixture('广告一,60\n广告二,40');
  Object.assign(f.batch.tasks[0], { status: 'success', intentAt: new Date().toISOString(), actual: clone(actual) });
  f.slot.busy = undefined;
  await f.controller.dispatch(f.slot, f.batch.tasks[1]);
  const nextAssignment = f.batch.tasks[1].assignmentId;
  const late = report(f.job, { type: 'error', status: 'uncertain', reason: '旧终态报告ACK延迟' });
  await f.controller.handle(f.slot, late);
  const cmd = GM_getValue<Command>(PREFIX + 'command:worker');
  assert.equal(cmd.ack, late.id);
  assert.equal(f.slot.busy, nextAssignment);
  assert.equal(cmd.job?.assignmentId, nextAssignment);
  assert.equal(f.batch.tasks[1].assignmentId, nextAssignment);
  assert.equal(f.batch.tasks[0].status, 'success');
  assert.equal(f.batch.tasks[0].actual?.unitId, actual.unitId);
});

test('switching publisher during a paused batch cannot release its original controller lock', async () => {
  const f = fixture();
  f.batch.phase = 'paused';
  let released = 0;
  f.controller.lockRelease = () => { released++; };
  f.controller.identity = {
    publisherId: 'pub-9876543210987654', appId: 'ca-app-pub-9876543210987654~9876543210', appName: '另一个发布商应用', evidence: ['mock'],
  };
  await assert.rejects(() => f.controller.acquire(), /账号|发布商|应用|批次/);
  assert.equal(released, 0);
  assert.equal(f.controller.lockedPublisher, identity.publisherId);
  assert.equal(typeof f.controller.lockRelease, 'function');
  assert.equal(f.batch.identity.publisherId, identity.publisherId);
  assert.equal(f.batch.phase, 'paused');
});

test('duplicate ad-unit names are allowed and the created unit ID is saved before config readback', async () => {
  const f = fixture('广告一,60');
  const createdId = 'ca-app-pub-1234567890123456/9876543210';
  f.adapter.lookup = async () => ({ complete: true, matches: [{ ...actual }] });
  f.adapter.waitForUnitId = async () => createdId;
  f.adapter.verify = async () => ({ ...actual, unitId: createdId, verified: true });
  const received: Data[] = [];
  await performJob(f.job, f.adapter, async data => { received.push(data); await f.controller.handle(f.slot, report(f.job, data)); }, () => permission(f.batch));
  assert.equal(f.calls.prepare, 1);
  assert.equal(f.calls.submit, 1);
  const created = received.find((data) => data.type === 'stage' && data.stage === 'created');
  assert.equal(created?.actual?.unitId, createdId);
  assert.equal(f.batch.tasks[0].actual?.unitId, createdId);
  assert.equal(f.batch.tasks[0].status, 'success');
});

test('preflight keeps a duplicate-name row pending because AdMob permits duplicate names', async () => {
  const f = fixture('广告一,60');
  f.controller.batch = undefined;
  f.adapter.lookup = async () => ({ complete: true, matches: [{ ...actual }] });
  (globalThis as unknown as { location: { href: string } }).location = { href: 'https://apps.admob.com/' };
  const config = { format: 'interstitial' as const, concurrency: 1, execution: 'single' as const, text: '广告一,60', rows: parseInput('广告一,60') };
  await f.controller.preflight(config);
  const created = (f.controller as Controller).batch;
  assert(created);
  assert.equal(created.tasks[0].status, 'pending');
  assert.match(created.tasks[0].reason, /允许重名/);
});

test('stopping an unconfirmed draft preserves incomplete preflight evidence while allowing a new batch', async () => {
  const f = fixture('广告一,60\n广告二,40');
  f.batch.phase = 'draft'; delete f.batch.confirmedAt;
  f.controller.slots.clear();
  for (const task of f.batch.tasks) { delete task.assignmentId; delete task.workerId; task.status = 'uncertain'; }
  f.batch.tasks[0].reason = '列表读取不完整，不能证明不存在';
  f.batch.tasks[1].reason = '发现已有ID，底价模式暂时无法核验';
  f.batch.tasks[1].actual = { unitId: actual.unitId, verified: false };
  const reasons = f.batch.tasks.map(task => task.reason);
  await f.controller.stop();
  await f.controller.tick();
  assert.equal(f.batch.phase, 'done');
  assert.deepEqual(f.batch.tasks.map(task => task.status), ['uncertain', 'uncertain']);
  assert.deepEqual(f.batch.tasks.map(task => task.reason), reasons);
  assert.equal(f.batch.tasks[1].actual?.unitId, actual.unitId);
  assert.equal(f.batch.tasks[1].actual?.verified, false);
  assert.equal(f.calls.submit, 0);
});

test('a persistent stop request survives controller refresh and refuses resume without creating', async () => {
  const f = fixture();
  Object.assign(f.batch.tasks[0], { status: 'submitting', intentAt: new Date().toISOString() });
  await f.controller.stop();
  const stopAt = (f.batch as Batch & { stopRequestedAt?: string }).stopRequestedAt;
  assert(stopAt);
  const restored = new Controller(f.adapter);
  restored.panel = { update: () => {} } as unknown as PanelHandle;
  restored.identity = clone(identity); restored.lockRelease = () => {}; restored.lockedPublisher = identity.publisherId;
  await restored.load();
  assert(['stopping', 'paused'].includes(restored.batch!.phase));
  assert.equal((restored.batch as Batch & { stopRequestedAt?: string }).stopRequestedAt, stopAt);
  await assert.rejects(() => restored.resume(), /停止|重试/);
  assert.equal(f.calls.submit, 0);
});

test('retry with no safe failures retains stop request; explicit safe retry clears it and waits paused', async () => {
  const blocked = fixture();
  blocked.batch.phase = 'paused';
  Object.assign(blocked.batch, { stopRequestedAt: '2026-11-12T01:00:00.000Z' });
  Object.assign(blocked.batch.tasks[0], { status: 'uncertain', intentAt: '2026-11-12T00:59:59.000Z' });
  blocked.slot.busy = undefined;
  await blocked.controller.retry();
  assert.equal((blocked.batch as Batch & { stopRequestedAt?: string }).stopRequestedAt, '2026-11-12T01:00:00.000Z');
  assert.equal(blocked.batch.tasks[0].status, 'uncertain');
  assert.equal(blocked.calls.submit, 0);

  const safe = fixture();
  safe.batch.phase = 'paused';
  Object.assign(safe.batch, { stopRequestedAt: '2026-11-12T01:00:00.000Z' });
  safe.batch.tasks[0].status = 'failed'; safe.slot.busy = undefined;
  await safe.controller.retry();
  assert.equal((safe.batch as Batch & { stopRequestedAt?: string }).stopRequestedAt, undefined);
  assert.equal(safe.batch.phase, 'paused');
  assert.equal(safe.batch.tasks[0].status, 'pending');
  assert.equal(safe.batch.tasks[0].assignmentId, undefined);
  assert.equal(safe.batch.tasks[0].workerId, undefined);
  assert.equal(safe.calls.submit, 0);
});

test('stopping an uncertain submitted task retains its assignment and ID and cannot finish the batch', async () => {
  const f = fixture();
  Object.assign(f.batch.tasks[0], { status: 'created-unverified', intentAt: new Date().toISOString(), actual: { unitId: actual.unitId, verified: false } });
  const assignment = f.batch.tasks[0].assignmentId;
  await f.controller.stop();
  await f.controller.tick();
  assert.notEqual(f.batch.phase, 'done');
  assert.equal(f.batch.tasks[0].status, 'created-unverified');
  assert.equal(f.batch.tasks[0].assignmentId, assignment);
  assert.equal(f.batch.tasks[0].workerId, 'worker');
  assert.equal(f.batch.tasks[0].actual?.unitId, actual.unitId);
  assert.equal(f.slot.busy, assignment);
  assert.equal(f.calls.submit, 0);
});

test('a timed-out pre-submit worker can report a definite failure and be retried safely after recovery', async () => {
  const f = fixture();
  f.batch.tasks[0].status = 'filling';
  GM_setValue(PREFIX + 'journal:' + f.job.assignmentId, {
    assignmentId: f.job.assignmentId, taskId: f.job.task.id, batchId: f.batch.id, state: 'filling',
  } satisfies Journal);
  f.slot.since = Date.now() - 121_000;
  await f.controller.tick();
  assert.equal(f.batch.tasks[0].status, 'uncertain');
  assert.equal(f.batch.tasks[0].intentAt, undefined);
  assert.equal(f.slot.busy, f.job.assignmentId);
  const recovered = report(f.job, { type: 'error', status: 'failed', reason: '执行页在填表期间恢复；已确认本分配没有提交意图，等待手动重试' });
  await f.controller.handle(f.slot, recovered);
  assert.equal(f.batch.tasks[0].status, 'failed');
  assert.equal(f.slot.busy, undefined);
  assert.equal(GM_getValue<Command>(PREFIX + 'command:worker').ack, recovered.id);
  await f.controller.retry();
  assert.equal(f.batch.tasks[0].status, 'pending');
  assert.equal(f.batch.tasks[0].assignmentId, undefined);
  assert.equal(f.batch.tasks[0].workerId, undefined);
  assert.equal(f.batch.tasks[0].intentAt, undefined);
  assert.equal(f.batch.phase, 'paused');
  assert.equal(f.calls.submit, 0);
});

test('refresh recovers an old single-page uncertain assignment only with matching pre-submit journal proof', async () => {
  const f = fixture(); f.batch.execution = 'single'; f.batch.concurrency = 1;
  const task = f.batch.tasks[0]; task.status = 'uncertain'; task.workerId = 'single:old-page';
  task.logs.push({ at: new Date().toISOString(), step: 'uncertain', message: '执行页超时，保留归属' });
  const originalLogs = clone(task.logs), assignmentId = task.assignmentId;
  GM_setValue(PREFIX + 'journal:' + assignmentId, { assignmentId: assignmentId!, taskId: task.id, batchId: f.batch.id, state: 'filling' } satisfies Journal);
  GM_setValue(PREFIX + 'command:' + task.workerId, { seq: 2 } satisfies Command);
  f.controller.save();
  const restored = new Controller(f.adapter); restored.identity = clone(identity);
  restored.panel = { update: () => {} } as unknown as PanelHandle;
  restored.lockRelease = () => {}; restored.lockedPublisher = identity.publisherId;
  await restored.load();
  const recovered = restored.batch!.tasks[0];
  assert.equal(recovered.status, 'failed'); assert.equal(recovered.assignmentId, assignmentId); assert.equal(recovered.workerId, 'single:old-page');
  assert.deepEqual(recovered.logs.slice(0, -1), originalLogs); assert.match(recovered.logs.at(-1)!.message, /确认未提交.*手动重试/);
  assert.equal(recovered.intentAt, undefined); assert.equal(recovered.actual, undefined);
  assert.equal(restored.slots.size, 0); assert.equal(restored.batch!.phase, 'paused'); assert.equal(recovered.attempts, 1);
  await restored.retry();
  assert.equal(recovered.status, 'pending'); assert.equal(recovered.assignmentId, undefined); assert.equal(recovered.workerId, undefined);
  assert.equal(recovered.attempts, 1); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0);
});

test('refresh keeps uncertainty without every required old single-page pre-submit proof', async () => {
  const cases = ['tabs', 'non-single-worker', 'current-page', 'missing-worker', 'missing-assignment', 'intent', 'partial-actual', 'actual-id', 'missing-journal', 'intent-journal', 'done-journal', 'wrong-assignment', 'wrong-task', 'wrong-batch', 'grant', 'expired-grant', 'done-batch'];
  for (const scenario of cases) {
    const f = fixture(); f.batch.execution = 'single'; f.batch.concurrency = 1;
    const task = f.batch.tasks[0]; task.status = 'uncertain'; task.workerId = 'single:old-page';
    const restored = new Controller(f.adapter); restored.identity = clone(identity);
    restored.panel = { update: () => {} } as unknown as PanelHandle;
    restored.lockRelease = () => {}; restored.lockedPublisher = identity.publisherId;
    const journal: Journal = { assignmentId: task.assignmentId!, taskId: task.id, batchId: f.batch.id, state: 'filling' };
    const command: Command = { seq: 2 };
    if (scenario === 'tabs') f.batch.execution = 'tabs';
    if (scenario === 'non-single-worker') task.workerId = 'worker-tab';
    if (scenario === 'current-page') task.workerId = 'single:' + restored.id;
    if (scenario === 'missing-worker') delete task.workerId;
    if (scenario === 'missing-assignment') delete task.assignmentId;
    if (scenario === 'intent') task.intentAt = new Date().toISOString();
    if (scenario === 'partial-actual') task.actual = {};
    if (scenario === 'actual-id') task.actual = { unitId: actual.unitId };
    if (scenario === 'intent-journal') journal.state = 'intent';
    if (scenario === 'done-journal') journal.state = 'done';
    if (scenario === 'wrong-assignment') journal.assignmentId = 'another-assignment';
    if (scenario === 'wrong-task') journal.taskId = 'another-task';
    if (scenario === 'wrong-batch') journal.batchId = 'another-batch';
    if (scenario === 'grant' || scenario === 'expired-grant') command.grant = { assignmentId: task.assignmentId!, expires: Date.now() + (scenario === 'grant' ? 10000 : -10000) };
    if (scenario === 'done-batch') f.batch.phase = 'done';
    if (scenario !== 'missing-journal') GM_setValue(PREFIX + 'journal:' + task.assignmentId, journal);
    GM_setValue(PREFIX + 'command:' + task.workerId, command); f.controller.save();
    await restored.load();
    assert.equal(restored.batch!.tasks[0].status, 'uncertain', scenario);
    assert.equal(restored.batch!.tasks[0].assignmentId, task.assignmentId, scenario);
    assert.equal(restored.batch!.tasks[0].workerId, task.workerId, scenario);
    assert.equal(f.calls.submit, 0, scenario);
  }
});

test('readback completion is durably logged before requesting the only submission permission', async () => {
  const f = fixture(); let sawReadback = false;
  await performJob(f.job, f.adapter, async data => {
    if (data.type === 'intent') {
      const persisted = GM_getValue<Batch>(key(f.batch)).tasks[0];
      assert.equal(persisted.status, 'filling'); assert.equal(persisted.logs.at(-1)?.message, '表单已读回，等待提交许可');
      assert.equal(persisted.intentAt, undefined);
      assert.equal(GM_getValue<Journal>(PREFIX + 'journal:' + f.job.assignmentId).state, 'filling');
      sawReadback = true;
    }
    await f.controller.handle(f.slot, report(f.job, data));
  }, () => permission(f.batch));
  assert.equal(sawReadback, true); assert.equal(f.calls.submit, 1); assert.equal(f.batch.tasks[0].status, 'success');
});

test('1000-row preflight persists once with every pending row and its complete log', async t => {
  const f = fixture(); f.controller.batch = undefined; f.controller.slots.clear();
  (globalThis as unknown as { location: { href: string } }).location = { href: 'https://apps.admob.com/' };
  const text = Array.from({ length: 1000 }, (_, i) => `BENCH_${i + 1},${i + 1}`).join('\n');
  writes.length = 0; f.updates.length = 0;
  await f.controller.preflight({ format: 'interstitial', concurrency: 1, execution: 'single', text, rows: parseInput(text) });
  const created = (f.controller as Controller).batch; assert(created);
  const batchWrites = writes.filter(write => write.key === key(created));
  assert.equal(batchWrites.length, 1, '预检应整批持久化一次，避免随行数重复写整批');
  assert.equal(writes.filter(write => write.key.startsWith(PREFIX + 'latest:')).length, 1);
  assert.equal(f.updates.filter(update => (update as { batch?: Batch }).batch).length, 1);
  const persisted = GM_getValue<Batch>(key(created));
  assert.equal(persisted.tasks.length, 1000);
  persisted.tasks.forEach((task, i) => {
    assert.equal(task.line, i + 1); assert.equal(task.name, `BENCH_${i + 1}`); assert.equal(task.floor, String(i + 1));
    assert.equal(task.status, 'pending'); assert.equal(task.logs.length, 1); assert.match(task.logs[0].message, /允许重名/);
  });
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0);
  t.diagnostic(`1000 rows: batch writes=${batchWrites.length}, stored bytes=${Buffer.byteLength(JSON.stringify(persisted))}`);
});

test('1000-row dispatch commands contain only the assigned task and compact ownership context', async t => {
  const text = Array.from({ length: 1000 }, (_, i) => `BENCH_${i + 1},60`).join('\n');
  const f = fixture(text); f.slot.busy = undefined;
  f.batch.tasks.forEach(task => { task.logs.push({ at: new Date().toISOString(), step: 'pending', message: '保留完整的逐行历史记录' }); });
  const selected = f.batch.tasks[999]; selected.actual = { unitId: actual.unitId, verified: false };
  await f.controller.dispatch(f.slot, selected);
  const cmd = GM_getValue<Command>(PREFIX + 'command:worker'); assert(cmd.job);
  assert.deepEqual(Object.keys(cmd.job.batch).sort(), ['controllerId', 'format', 'id', 'identity', 'mode', 'phase']);
  assert.deepEqual(cmd.job.task, selected);
  assert.equal(cmd.job.batch.controllerId, f.batch.controllerId); assert.equal(cmd.job.batch.phase, 'running');
  assert.equal('tasks' in cmd.job.batch, false);
  const compactBytes = Buffer.byteLength(JSON.stringify(cmd));
  const fullSnapshotBytes = Buffer.byteLength(JSON.stringify({ ...cmd, job: { ...cmd.job, batch: f.batch } }));
  assert(compactBytes < 2048); assert(compactBytes * 100 < fullSnapshotBytes, '命令大小不得随其余999行与日志增长');
  const persisted = GM_getValue<Batch>(key(f.batch));
  assert.deepEqual(persisted.tasks.map(task => task.logs), f.batch.tasks.map(task => task.logs), '精简命令不删除持久化历史证据');
  assert.equal(f.calls.submit, 0);
  t.diagnostic(`1000 rows: compact command bytes=${compactBytes}, old full snapshot bytes=${fullSnapshotBytes}`);
});

test('save preserves full batch durability while writing latest only when its value changes', () => {
  const f = fixture(); const latestKey = PREFIX + 'latest:' + identity.publisherId + ':' + identity.appId;
  writes.length = 0;
  f.controller.save(); f.controller.save();
  assert.equal(writes.filter(write => write.key === key(f.batch)).length, 2);
  assert.equal(writes.filter(write => write.key === latestKey).length, 0);
  storage.set(latestKey, 'stale-pointer'); f.controller.save();
  assert.equal(writes.filter(write => write.key === latestKey).length, 1);
  assert.equal(GM_getValue(latestKey), f.batch.id);
  const next = createBatch(parseInput('下一批,80'), identity, 'interstitial', 1, 'single', 'https://apps.admob.com/', f.controller.id);
  f.controller.batch = next; f.controller.save();
  assert.equal(writes.filter(write => write.key === latestKey).length, 2);
  assert.equal(GM_getValue(latestKey), next.id);
  assert.deepEqual(GM_getValue(key(next)), next);
});

test('tabs preflight verifies five distinct warm pages and dispatch preserves the canary before using the pool', async t => {
  const f = fixture(); f.controller.batch = undefined; f.controller.slots.clear(); storage.clear(); writes.length = 0;
  const pages = probePages(t);
  (globalThis as unknown as { location: { href: string } }).location = { href: 'https://apps.admob.com/' };
  const text = '广告一,60\n广告二,40\n广告三,30\n广告四,20\n广告五,10\n广告六,5';
  const config = { format: 'interstitial' as const, concurrency: 5, execution: 'tabs' as const, text, rows: parseInput(text) };
  await f.controller.preflight(config);
  const batch = (f.controller as Controller).batch!;
  assert.equal(pages.length, 5); assert.equal(new Set(pages.map(page => page.id)).size, 5);
  assert.equal(f.controller.slots.size, 5);
  for (const page of pages) {
    assert.equal(page.challenges.length, 2); assert.notEqual(page.challenges[0], page.challenges[1]);
    assert.equal(f.controller.slots.get(page.id)?.probePassed, true);
    assert.equal(GM_getValue<Command>(PREFIX + 'command:' + page.id).job, undefined);
    assert.equal(GM_getValue<Command>(PREFIX + 'command:' + page.id).grant, undefined);
  }
  assert.equal(batch.confirmedAt, undefined); assert.equal(batch.canaryPassed, false);
  assert.ok(batch.tasks.every(task => task.status === 'pending' && !task.assignmentId && !task.intentAt));
  await f.controller.probe(); assert.equal(pages.length, 5, 'ordinary capability checks may reuse a verified page');

  // No cold opening is permitted during this dispatch scenario: all pages
  // have already completed the real controller's two-challenge handshake.
  t.mock.method(f.controller, 'probe', async () => { throw new Error('Unexpected cold probe during result collection'); });
  for (const task of batch.tasks) task.logs[0].at = new Date(Date.now() - 1000).toISOString();
  await f.controller.start(config); await f.controller.tick(); await f.controller.tick();
  assert.equal(batch.tasks.filter(task => task.assignmentId).length, 1, 'only the canary dispatches before saved proof');
  const slot = [...f.controller.slots.values()].find(slot => slot.busy)!;
  const job = GM_getValue<Command>(PREFIX + 'command:' + slot.id).job!;
  await f.controller.handle(slot, report(job, { type: 'stage', stage: 'filling' }));
  await f.controller.handle(slot, report(job, { type: 'intent' }));
  assert.ok(GM_getValue<Batch>(key(batch)).tasks[0].intentAt, 'canary intent is still durable');
  await f.controller.handle(slot, report(job, { type: 'stage', stage: 'verifying' }));
  await f.controller.handle(slot, report(job, { type: 'result', status: 'success', actual: clone(actual) }));
  assert.equal(batch.canaryPassed, true);
  for (let index = 0; index < 5; index++) await f.controller.tick();
  assert.equal(batch.tasks.filter(task => task.assignmentId).length, 6);
  assert.equal([...f.controller.slots.values()].filter(slot => slot.busy).length, 5);
  assert.equal(new Set(batch.tasks.slice(1).map(task => task.workerId)).size, 5);
  assert.equal(pages.length, 5); assert.equal(f.calls.submit, 0);
});

test('a failing warm page prevents start even after an earlier successful preflight', async t => {
  for (const fault of ['lock', 'notification', 'identity'] as const) await t.test(fault, async t => {
    const f = fixture(); f.controller.batch = undefined; f.controller.slots.clear(); storage.clear(); writes.length = 0;
    const pages = probePages(t, fault);
    (globalThis as unknown as { location: { href: string } }).location = { href: 'https://apps.admob.com/' };
    const text = '广告一,60\n广告二,40';
    const config = { format: 'interstitial' as const, concurrency: 5, execution: 'tabs' as const, text, rows: parseInput(text) };
    f.controller.preflightSignature = f.controller.signature(config);
    await assert.rejects(() => f.controller.preflight(config), /跨页锁|通知|账号/);
    const batch = (f.controller as Controller).batch!;
    assert.equal(pages.length, 3); assert.equal(pages[2].closed, true);
    assert.equal(batch.phase, 'draft'); assert.equal(batch.confirmedAt, undefined);
    assert.ok(batch.tasks.every(task => !task.assignmentId && !task.intentAt));
    assert.equal(f.controller.preflightSignature, '');
    assert.ok(!f.updates.some(update => (update as { ready?: boolean }).ready === true));
    t.mock.method(f.controller,'probe',async()=>{throw new Error('跨页能力仍未通过');});
    await assert.rejects(() => f.controller.start(config), /跨页能力/);
    for (const page of pages) {
      const command = GM_getValue<Command>(PREFIX + 'command:' + page.id);
      assert.equal(command.job, undefined); assert.equal(command.grant, undefined);
    }
    assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0);
  });
});

test('report notifications collect a terminal result arriving during another tick without a timer', async t => {
  const f = fixture(); f.controller.batch = undefined; f.controller.slots.clear(); storage.clear();
  valueEvents(t); probePages(t);
  (globalThis as unknown as { location: { href: string } }).location = { href: 'https://apps.admob.com/' };
  const text = '广告一,60';
  await f.controller.preflight({ format: 'interstitial', concurrency: 1, execution: 'tabs', text, rows: parseInput(text) });
  const batch = (f.controller as Controller).batch!; batch.phase = 'paused';
  const slot = [...f.controller.slots.values()][0];
  await f.controller.dispatch(slot, batch.tasks[0]);
  const job = GM_getValue<Command>(PREFIX + 'command:' + slot.id).job!;
  const filling = report(job, { type: 'stage', stage: 'filling' });
  GM_setValue(PREFIX + 'report:' + slot.id, filling);
  assert.equal(f.controller.tickBusy, true, 'first notification has started collection');
  const terminal = report(job, { type: 'error', status: 'failed', reason: '明确在提交前停止' });
  GM_setValue(PREFIX + 'report:' + slot.id, terminal);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(batch.tasks[0].status, 'failed'); assert.equal(slot.busy, undefined);
  assert.equal(GM_getValue<Command>(PREFIX + 'command:' + slot.id).ack, terminal.id);
  assert.equal(f.controller.tickBusy, false); assert.equal(f.controller.reportTickPending, false);
  assert.equal(f.calls.submit, 0);
});

test('report notifications survive an active panel action and removed slots release their listeners', async t => {
  const f = fixture(); f.controller.batch = undefined; f.controller.slots.clear(); storage.clear();
  const listeners = valueEvents(t); const pages = probePages(t, 'notification');
  (globalThis as unknown as { location: { href: string } }).location = { href: 'https://apps.admob.com/' };
  const text = '广告一,60';
  const config = { format: 'interstitial' as const, concurrency: 2, execution: 'tabs' as const, text, rows: parseInput(text) };
  await f.controller.action(() => f.controller.preflight(config));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(listeners.size, 2);
  const batch = (f.controller as Controller).batch!; batch.phase = 'paused';
  const slot = [...f.controller.slots.values()][0];
  await f.controller.dispatch(slot, batch.tasks[0]);
  const job = GM_getValue<Command>(PREFIX + 'command:' + slot.id).job!;
  const terminal = report(job, { type: 'error', status: 'failed', reason: '操作期间收到明确未提交结果' });
  await f.controller.action(async () => {
    GM_setValue(PREFIX + 'report:' + slot.id, terminal);
    assert.equal(batch.tasks[0].status, 'pending', 'panel action defers collection without losing the notification');
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(batch.tasks[0].status, 'failed'); assert.equal(slot.busy, undefined);
  assert.equal(GM_getValue<Command>(PREFIX + 'command:' + slot.id).ack, terminal.id);
  batch.phase = 'draft';
  // Re-preflight removes the two old idle slots. The next new page is the
  // intentionally failing third page, which must also remove its listener.
  await assert.rejects(() => f.controller.preflight(config), /跨页锁|通知|账号/);
  assert.equal(pages.length, 3); assert.ok(pages.every(page => page.closed));
  assert.equal(listeners.size, 0); assert.equal(f.controller.slots.size, 0);
  assert.equal(f.calls.submit, 0);
});

test('an observed ID is durable and unverified before the saved configuration is read by that exact ID', async () => {
  const f = fixture(); f.batch.phase = 'paused';
  const task = f.batch.tasks[0]; task.status = 'uncertain'; task.intentAt = new Date().toISOString();
  const intentAt = task.intentAt; const assignmentId = task.assignmentId;
  let reads = 0;
  f.adapter.verifyById = async (observedIdentity, id) => {
    reads++; assert.equal(id, actual.unitId); assert.equal(observedIdentity.appId, f.batch.identity.appId);
    const persisted = GM_getValue<Batch>(key(f.batch)).tasks[0];
    assert.equal(persisted.actual?.unitId, id); assert.equal(persisted.actual?.verified, false);
    assert.equal(persisted.status, 'created-unverified'); assert.equal(persisted.intentAt, intentAt);
    return clone(actual);
  };
  await f.controller.recordObservedId(task.id, ' ' + actual.unitId + ' ');
  assert.equal(reads, 1); assert.equal(task.status, 'success'); assert.equal(task.actual?.unitId, actual.unitId);
  assert.equal(task.intentAt, intentAt); assert.equal(task.assignmentId, assignmentId);
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0);
});

test('a freshly reverified historical sample permits five new assignments without copying old results', async t => {
  const f=fixture(); f.batch.phase='done'; f.slot.busy=undefined;
  f.batch.tasks[0].status='success'; f.batch.tasks[0].actual=clone(actual);
  const original=clone(f.batch); let reads=0;
  f.adapter.verifyById=async (observed,id,name,format,floor)=>{
    reads++;assert.equal(observed.appId,identity.appId);assert.equal(id,actual.unitId);
    assert.equal(name,actual.name);assert.equal(format,actual.format);assert.equal(floor,actual.floor);
    assert.equal(f.controller.batch!.id,original.id,'original batch remains current until the read succeeds');
    return clone(actual);
  };
  const pages=probePages(t);
  (globalThis as unknown as {location:{href:string}}).location={href:'https://apps.admob.com/'};
  const text=Array.from({length:5},(_,i)=>`NEW_${i},${600+i*100}`).join('\n');
  const config={format:'interstitial' as const,concurrency:5,execution:'tabs' as const,text,rows:parseInput(text)};
  await f.controller.preflight(config);const batch=f.controller.batch!;
  assert.equal(reads,1);assert.equal(pages.length,5);assert.equal(batch.canaryPassed,true);
  assert.equal(batch.canaryEvidence?.sourceBatchId,original.id);assert.equal(batch.canaryEvidence?.unitId,actual.unitId);
  assert.ok(batch.tasks.every(task=>task.status==='pending'&&!task.actual&&!task.intentAt));
  for(const task of batch.tasks)task.logs[0].at=new Date(Date.now()-1000).toISOString();
  await f.controller.start(config);for(let i=0;i<5;i++)await f.controller.tick();
  assert.equal(batch.tasks.filter(task=>task.assignmentId).length,5);
  assert.equal(new Set(batch.tasks.map(task=>task.workerId)).size,5);
  assert.equal(f.calls.submit,0);assert.deepEqual(f.batch,original,'the old completed batch is preserved');
});

test('unqualified history keeps the new batch first-row gate', async t => {
  for(const scenario of ['no-verified-result','wrong-app','wrong-format','wrong-publisher','wrong-floor','wrong-mode','wrong-currency'] as const)await t.test(scenario,async t=>{
    const f=fixture();f.batch.phase='done';f.slot.busy=undefined;
    f.batch.tasks[0].status='success';f.batch.tasks[0].actual=clone(actual);let reads=0;
    const saved=f.batch.tasks[0].actual;
    if(scenario==='no-verified-result')saved.verified=false;
    if(scenario==='wrong-app')saved.appId='ca-app-pub-1234567890123456~9999999999';
    if(scenario==='wrong-format')saved.format='app-open';
    if(scenario==='wrong-publisher')saved.publisherId='pub-9999999999999999';
    if(scenario==='wrong-floor')saved.floor='1';
    if(scenario==='wrong-mode')saved.mode='auto';
    if(scenario==='wrong-currency')saved.currency='other';
    f.adapter.verifyById=async()=>{reads++;return clone(actual);};probePages(t);
    const text='NEW,600';await f.controller.preflight({format:'interstitial',concurrency:5,execution:'tabs',text,rows:parseInput(text)});
    assert.equal(reads,0,scenario);assert.equal(f.controller.batch!.canaryPassed,false,scenario);
    assert.equal(f.controller.batch!.canaryEvidence,undefined,scenario);assert.equal(f.calls.submit,0);
  });
});

test('a deleted or changed historical sample falls back to the new first-row gate without altering old results', async t => {
  for(const scenario of ['throws','id','name','app','publisher','format','floor','mode','currency','unverified'] as const)await t.test(scenario,async t=>{
    const f=fixture();f.batch.phase='done';f.slot.busy=undefined;
    f.batch.tasks[0].status='success';f.batch.tasks[0].actual=clone(actual);const old=clone(f.batch);
    f.adapter.verifyById=async()=>{
      if(scenario==='throws')throw new Error('saved detail unavailable');
      const returned=clone(actual);
      if(scenario==='id')returned.unitId='ca-app-pub-1234567890123456/9999999999';
      if(scenario==='name')returned.name='other';
      if(scenario==='app')returned.appId='ca-app-pub-1234567890123456~9999999999';
      if(scenario==='publisher')returned.publisherId='pub-9999999999999999';
      if(scenario==='format')returned.format='app-open';
      if(scenario==='floor')returned.floor='1';
      if(scenario==='mode')returned.mode='auto';
      if(scenario==='currency')returned.currency='other';
      if(scenario==='unverified')returned.verified=false;
      return returned;
    };
    const text='NEW,600';const config={format:'interstitial' as const,concurrency:5,execution:'tabs' as const,text,rows:parseInput(text)};
    probePages(t);
    await f.controller.preflight(config);
    assert.notEqual(f.controller.batch!.id,old.id,scenario);
    assert.equal(f.controller.batch!.canaryPassed,false,scenario);
    assert.equal(f.controller.batch!.canaryEvidence,undefined,scenario);
    assert.deepEqual(f.batch,old,scenario);
    assert.equal(f.calls.submit,0);assert.equal(f.calls.prepare,0);
  });
});

test('an observed ID remains unverified with its original intent when saved readback fails', async () => {
  const f = fixture(); f.batch.phase = 'paused';
  const task = f.batch.tasks[0]; task.status = 'uncertain'; task.intentAt = new Date().toISOString();
  const intentAt = task.intentAt;
  f.adapter.verifyById = async (_identity, id) => { assert.equal(id, actual.unitId); throw new Error('保存详情尚不可读'); };
  await f.controller.recordObservedId(task.id, actual.unitId);
  assert.equal(task.status, 'created-unverified'); assert.equal(task.actual?.unitId, actual.unitId);
  assert.equal(task.actual?.verified, false); assert.equal(task.intentAt, intentAt);
  assert.equal(f.batch.phase, 'paused'); assert.match(task.reason, /保存详情尚不可读/);
  assert.equal(GM_getValue<Batch>(key(f.batch)).tasks[0].actual?.unitId, actual.unitId);
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0);
});

test('observed-ID entry refuses unsubmitted or completed rows, wrong IDs, and overwriting earlier proof', async () => {
  const cases = ['running', 'draft', 'stopping', 'done', 'no-intent', 'missing-task', 'success', 'exists', 'invalid-id', 'other-publisher', 'different-known-id'] as const;
  for (const scenario of cases) {
    const f = fixture(); f.batch.phase = 'paused';
    const task = f.batch.tasks[0]; task.status = 'uncertain'; task.intentAt = new Date().toISOString();
    let id = actual.unitId; let taskId = task.id; let reads = 0;
    if (['running', 'draft', 'stopping', 'done'].includes(scenario)) f.batch.phase = scenario as Batch['phase'];
    if (scenario === 'no-intent') delete task.intentAt;
    if (scenario === 'missing-task') taskId = 'another-task';
    if (scenario === 'success' || scenario === 'exists') { task.status = scenario; task.actual = clone(actual); }
    if (scenario === 'invalid-id') id = 'ca-app-pub-1234567890123456~1234567890';
    if (scenario === 'other-publisher') id = 'ca-app-pub-9999999999999999/1234567890';
    if (scenario === 'different-known-id') task.actual = { ...actual, unitId: 'ca-app-pub-1234567890123456/9999999999', verified: false };
    f.adapter.verifyById = async () => { reads++; return clone(actual); };
    const before = clone(f.batch); writes.length = 0;
    await assert.rejects(() => f.controller.recordObservedId(taskId, id), /暂停|提交意图|待核验|格式|发布商|保留原 ID/, scenario);
    assert.deepEqual(f.batch, before, scenario); assert.equal(writes.length, 0, scenario);
    assert.equal(reads, 0, scenario); assert.equal(f.calls.submit, 0, scenario);
  }
});

test('paused preflight tops up only the pending demand and keeps all persisted task evidence', async t => {
  const f = fixture('广告一,60\n广告二,40\n广告三,30');
  f.batch.phase = 'paused'; f.batch.concurrency = 5; f.controller.slots.clear(); storage.clear();
  for (const task of f.batch.tasks) { delete task.assignmentId; delete task.workerId; }
  const pages = probePages(t);
  await f.controller.probe(true); await f.controller.probe(true);
  f.controller.slots.set('other-batch', { id: 'other-batch', since: Date.now(), probePassed: true, batchId: 'other', identity: clone(identity) });
  f.controller.slots.set('unverified', { id: 'unverified', since: Date.now(), batchId: f.batch.id, identity: clone(identity) });
  f.controller.slots.set('closed', { id: 'closed', since: Date.now(), probePassed: true, batchId: f.batch.id, identity: clone(identity), tab: { closed: true, close() {} } });
  const before = clone(f.batch); writes.length = 0;
  const text = '广告一,60\n广告二,40\n广告三,30';
  await f.controller.preflight({ format: 'interstitial', concurrency: 5, execution: 'tabs', text, rows: parseInput(text) });
  assert.equal(pages.length, 3, 'two valid idle pages need one new page for three pending tasks');
  assert.deepEqual(f.batch, before, 'prewarming never changes tasks, logs, intent or confirmation');
  assert.equal(writes.filter(write => write.key.startsWith(PREFIX + 'batch:')).length, 0);
  assert.ok(pages.every(page => page.challenges.length === 2));
  await f.controller.preflight({ format: 'interstitial', concurrency: 5, execution: 'tabs', text, rows: parseInput(text) });
  assert.equal(pages.length, 3, 'repeated paused preflight reuses the complete verified pool');
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.submit, 0);
});

test('paused preflight caps warming at concurrency and opens no page while a result remains uncertain', async t => {
  const text = Array.from({ length: 7 }, (_, index) => `暂停_${index},60`).join('\n');
  const f = fixture(text); f.batch.phase = 'paused'; f.batch.concurrency = 5; f.controller.slots.clear(); storage.clear();
  for (const task of f.batch.tasks) { delete task.assignmentId; delete task.workerId; }
  const pages = probePages(t);
  f.batch.tasks[0].status = 'uncertain'; f.batch.tasks[0].intentAt = new Date().toISOString();
  const config = { format: 'interstitial' as const, concurrency: 5, execution: 'tabs' as const, text, rows: parseInput(text) };
  await f.controller.preflight(config); assert.equal(pages.length, 0);
  f.batch.tasks[0].status = 'success'; f.batch.tasks[0].actual = { ...clone(actual), name: f.batch.tasks[0].name };
  const before = clone(f.batch);
  await f.controller.preflight(config);
  assert.equal(pages.length, 5, 'six pending rows require at most the configured five pages');
  assert.deepEqual(f.batch, before); assert.equal(f.calls.submit, 0);
});

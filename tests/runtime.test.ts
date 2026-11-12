import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.ts';
import { performJob } from '../src/worker.ts';
import { createBatch, parseInput } from '../src/core.ts';
import type { Actual, Adapter, Batch, Identity } from '../src/types.ts';
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
function report(job: Job, data: Data, id: string = crypto.randomUUID()): Report { return { ...data, id, at: Date.now(), assignmentId: job.assignmentId, taskId: job.task.id, workerId: job.workerId }; }
function key(batch: Batch): string { return PREFIX + 'batch:' + batch.identity.publisherId + ':' + batch.identity.appId + ':' + batch.id; }
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
  await f.controller.resume();
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

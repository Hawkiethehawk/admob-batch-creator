import test from 'node:test';
import assert from 'node:assert/strict';
import { canDispatch, canSubmitPrepared, mayRetry, needsVerification, reportBelongs, safeFailure } from '../src/protocol.ts';
import type { Report } from '../src/protocol.ts';
import type { Batch, Task } from '../src/types.ts';
import { createBatch, parseInput } from '../src/core.ts';

const makeBatch = (): Batch => createBatch(parseInput('一,60\n二,40'), {
  publisherId: 'pub-1234567890123456', appId: 'ca-app-pub-1234567890123456~1234567890', appName: '协议测试', evidence: [],
}, 'interstitial', 3, 'tabs', 'https://apps.admob.com/', 'controller');
const makeTask = (): Task => ({ ...makeBatch().tasks[0], assignmentId: 'assignment', workerId: 'worker' });
const makeReport = (task: Task): Report => ({ id: 'report', at: 1, workerId: 'worker', assignmentId: task.assignmentId, taskId: task.id, type: 'result', status: 'success' });

test('running parallel batches may fill preparation capacity while serial batches use one slot', () => {
  const batch = makeBatch();
  for (const phase of ['draft', 'paused', 'stopping', 'done'] as const) { batch.phase = phase; assert.equal(canDispatch(batch, 0), false); }
  batch.phase = 'running';
  assert.equal(canDispatch(batch, 0), true);
  assert.equal(canDispatch(batch, 1), true);
  batch.canaryPassed = true;
  assert.equal(canDispatch(batch, 2), true);
  assert.equal(canDispatch(batch, 3), false);
  batch.execution='single';assert.equal(canDispatch(batch,0),true);assert.equal(canDispatch(batch,1),false);
});

test('prepared submissions require the current assignment and first verified sample before expansion',()=>{
  const batch=makeBatch();batch.phase='running';
  const [first,second]=batch.tasks;
  Object.assign(first,{assignmentId:'first-assignment',workerId:'first-worker'});
  Object.assign(second,{assignmentId:'second-assignment',workerId:'second-worker'});
  assert.equal(canSubmitPrepared(undefined,first),false);
  assert.equal(canSubmitPrepared(batch,first),true);assert.equal(canSubmitPrepared(batch,second),false);
  batch.canaryPassed=true;assert.equal(canSubmitPrepared(batch,second),true);
  assert.equal(canSubmitPrepared(batch,{...second,assignmentId:'old-assignment'}),false);
  assert.equal(canSubmitPrepared(batch,{...second,workerId:'old-worker'}),false);
  for(const phase of ['draft','paused','stopping','done'] as const){batch.phase=phase;assert.equal(canSubmitPrepared(batch,second),false);}
  batch.phase='running';batch.canaryPassed=false;first.status='failed';assert.equal(canSubmitPrepared(batch,second),true,'an explicit pre-submit failure moves the first-row gate to the next eligible row');
});

test('only known pre-submit failures may retry and retry budget is bounded', () => {
  const task = makeTask(); task.status = 'failed';
  assert.equal(mayRetry(task), true);
  task.attempts = 2; assert.equal(mayRetry(task), true);
  task.attempts = 3; assert.equal(mayRetry(task), false);
  task.attempts = 0; task.intentAt = 'persisted'; assert.equal(mayRetry(task), false);
  delete task.intentAt; task.actual = { unitId: 'ca-app-pub-1234567890123456/1234567890' }; assert.equal(mayRetry(task), false);
  delete task.actual;
  for (const status of ['uncertain', 'created-unverified', 'submitting', 'verifying', 'conflict', 'stopped', 'success', 'exists', 'pending'] as const) {
    task.status = status; assert.equal(mayRetry(task), false, status);
  }
});

test('reports must match all current assignment and worker identifiers', () => {
  const task = makeTask(); const report = makeReport(task);
  assert.equal(reportBelongs(report, task, 'worker'), true);
  assert.equal(reportBelongs({ ...report, workerId: 'other' }, task, 'worker'), false);
  assert.equal(reportBelongs({ ...report, assignmentId: 'old-assignment' }, task, 'worker'), false);
  assert.equal(reportBelongs({ ...report, taskId: 'other-task' }, task, 'worker'), false);
  assert.equal(reportBelongs(report, { ...task, workerId: 'other' }, 'worker'), false);
});

test('unassigned reports cannot match by undefined assignment identifiers', () => {
  const task = makeTask(); delete task.assignmentId;
  const report = makeReport(task);
  assert.equal(reportBelongs(report, task, 'worker'), false);
});

test('uncertain and historical submitting states require verification, never a fresh create', () => {
  const task = makeTask();
  assert.equal(needsVerification(task), false);
  for (const status of ['uncertain', 'created-unverified', 'submitting', 'verifying'] as const) {
    task.status = status; assert.equal(needsVerification(task), true);
    assert.equal(safeFailure(task, false), 'uncertain');
    assert.equal(safeFailure(task, true), 'created-unverified');
  }
  task.status = 'failed'; task.intentAt = 'persisted';
  assert.equal(needsVerification(task), true);
  assert.equal(safeFailure(task, false), 'uncertain');
});

test('pre-submit failure stays failed, but any obtained unit ID remains created-unverified', () => {
  const task = makeTask(); task.status = 'filling';
  assert.equal(safeFailure(task, false), 'failed');
  assert.equal(safeFailure(task, true), 'created-unverified');
});

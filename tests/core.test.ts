import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLookup, copyPairs, createBatch, decimalEqual, exportCsv, normalizeDecimal, parseInput, recoverTask, transition, validateFloorAgainstInput } from '../src/core.ts';
import type { Actual, Identity } from '../src/types.ts';

const identity: Identity = { publisherId: 'pub-1234567890123456', appId: 'ca-app-pub-1234567890123456~1234567890', appName: '示例应用', evidence: ['测试夹具'] };
const actual: Actual = { publisherId: identity.publisherId, appId: identity.appId, name: '广告', unitId: 'ca-app-pub-1234567890123456/1234567890', format: 'interstitial', mode: 'manual', floor: '60.00', currency: 'USD', verified: true };
const batch = () => createBatch(parseInput('广告,60'), identity, 'interstitial', 2, 'tabs', 'https://apps.admob.com/', 'controller');

test('decimal text is lossless, normalized, and refuses ambiguous amounts', () => {
  assert.equal(normalizeDecimal('00060.000'), '60');
  assert.equal(normalizeDecimal('9007199254740993.0000000000000001'), '9007199254740993.0000000000000001');
  assert(decimalEqual('60', '60.00'));
  assert(decimalEqual('0', '00.00'));
  for (const value of ['-1', '+2', '1e2', '$60', '60,00', '1,000', '.5', '1.', 'Infinity', 'NaN', '']) assert.throws(() => normalizeDecimal(value));
  assert.equal(decimalEqual('bad', 'bad'), false);
});

test('actual input min max and decimal step constraints are enforced without floating point', () => {
  assert.deepEqual(validateFloorAgainstInput('0.3', { min: '0.1', max: '100', step: '0.1' }), []);
  assert.equal(validateFloorAgainstInput('0.31', { step: '0.1' }).length, 1);
  assert.equal(validateFloorAgainstInput('0', { min: '0.01' }).length, 1);
  assert.equal(validateFloorAgainstInput('101', { max: '100' }).length, 1);
  assert.deepEqual(validateFloorAgainstInput('999999999999999999.15', { min: '0.05', step: '0.1' }), []);
  assert.equal(validateFloorAgainstInput('1', { step: '0' }).length, 1);
  assert.deepEqual(validateFloorAgainstInput('0', {}), []);
});

test('CSV supports BOM, headers, empty records, quoted commas and escaped quotes', () => {
  const rows = parseInput('\uFEFF广告位名称,底价USD\r\n\r\n"广告,一",60.00\r\n"广告""二",40\r\n');
  assert.deepEqual(rows, [{ line: 3, name: '广告,一', floor: '60', errors: [] }, { line: 4, name: '广告"二', floor: '40', errors: [] }]);
});

test('TSV and multiline records retain physical source row numbers', () => {
  const rows = parseInput('\n广告位名称\t底价（USD / 千次展示）\n"广告\n一"\t20\n广告二\t15');
  assert.equal(rows[0].line, 3);
  assert.equal(rows[0].name, '广告\n一');
  assert.equal(rows[1].line, 5);
  assert.equal(rows[1].floor, '15');
});

test('invalid cells are row errors, duplicate names are allowed, and names are never truncated', () => {
  const rows = parseInput('重复,60\n重复,40\n,20\n无金额,\n负值,-1\n多列,1,2\n"未闭合,20');
  assert.equal(rows[0].errors.length, 0);
  assert.equal(rows[1].errors.length, 0);
  assert(rows.slice(2).every((row) => row.errors.length));
  const long = '长'.repeat(129);
  assert.equal(parseInput(`${long},1`)[0].name, long);
  assert.equal(parseInput(`${long},1`, { maxNameLength: 128 })[0].name, long);
  assert(parseInput(`${long},1`, { maxNameLength: 128 })[0].errors.length);
  assert(parseInput('  名称,1')[0].errors.length);
  assert.equal(parseInput(`${'长'.repeat(80)},1`)[0].errors.length, 0);
  assert(parseInput(`${'长'.repeat(81)},1`)[0].errors.some(error => error.includes('80')));
  assert(parseInput('四个字符,1', { maxNameLength: 3 })[0].errors.some(error => error.includes('3')));
});

test('lookup requires completeness and exact saved configuration and real unit ID', () => {
  const classify = (matches: Partial<Actual>[], complete = true) => classifyLookup({ matches, complete }, identity, 'interstitial', '广告', '60');
  assert.equal(classify([]).status, 'pending');
  assert.equal(classify([], false).status, 'uncertain');
  assert.equal(classify([actual]).status, 'exists');
  assert.equal(classify([actual, actual]).status, 'uncertain');
  assert.equal(classify([{ ...actual, floor: '40' }]).status, 'conflict');
  assert.equal(classify([{ ...actual, format: 'app-open' }]).status, 'conflict');
  assert.equal(classify([{ ...actual, mode: 'optimized' }]).status, 'conflict');
  assert.equal(classify([{ ...actual, currency: 'EUR' }]).status, 'conflict');
  assert.equal(classify([{ ...actual, verified: false }]).status, 'uncertain');
  assert.equal(classify([{ ...actual, unitId: identity.appId }]).status, 'uncertain');
  assert.equal(classify([{ ...actual, appId: 'other-app' }]).status, 'uncertain');
});

test('state machine requires submission intent and ownership before submitting', () => {
  const task = batch().tasks[0];
  assert.throws(() => transition(task, 'success'));
  transition(task, 'filling');
  assert.throws(() => transition(task, 'submitting'));
  task.assignmentId = 'assignment'; task.workerId = 'worker'; task.intentAt = new Date().toISOString();
  transition(task, 'submitting');
  assert.throws(() => transition(task, 'failed'));
  transition(task, 'verifying');
  assert.throws(() => transition(task, 'success'));
  task.actual = actual;
  transition(task, 'success');
  assert(task.finishedAt);
  assert.throws(() => transition(task, 'pending'));
});

test('recovery never resets submitted tasks or erases ownership', () => {
  for (const status of ['submitting', 'verifying', 'failed', 'pending'] as const) {
    const task = batch().tasks[0];
    Object.assign(task, { status, intentAt: '2026-01-01T00:00:00Z', assignmentId: 'a', workerId: 'w' });
    recoverTask(task);
    assert.equal(task.status, 'uncertain');
    assert.equal(task.assignmentId, 'a');
    assert.equal(task.workerId, 'w');
    assert.throws(() => transition(task, 'pending'));
  }
  const task = batch().tasks[0];
  Object.assign(task, { status: 'submitting', intentAt: 'now', actual });
  assert.equal(recoverTask(task).status, 'created-unverified');
  const filling = batch().tasks[0]; filling.status = 'filling';
  assert.equal(recoverTask(filling).status, 'failed');
  transition(filling, 'pending');
});

test('batch freezes identity, keeps distinct prices and validates public IDs', () => {
  const source = structuredClone(identity);
  const result = createBatch(parseInput('一,60\n二,40'), source, 'app-open', 3, 'tabs', 'https://apps.admob.com/', 'c');
  source.appName = '变更';
  assert.equal(result.identity.appName, '示例应用');
  assert.deepEqual(result.tasks.map((t) => t.floor), ['60', '40']);
  assert.notEqual(result.tasks[0].id, result.tasks[1].id);
  assert.throws(() => createBatch([], identity, 'interstitial', 2, 'tabs', '', 'c'));
  assert.throws(() => createBatch(parseInput('一,1'), { ...identity, publisherId: 'pub-wrong' }, 'interstitial', 2, 'tabs', '', 'c'));
  assert.equal(createBatch(parseInput('一,1'), identity, 'interstitial', 3, 'single', '', 'c').concurrency, 1);
  assert.equal(createBatch(parseInput('一,1'), identity, 'interstitial', 5, 'tabs', '', 'c').concurrency, 5);
  assert.throws(() => createBatch(parseInput('一,1'), identity, 'interstitial', 6, 'tabs', '', 'c'), /1、2、3、4 或 5/);
});

test('CSV includes BOM, quotes all values, prevents spreadsheet formulas and filters safely', () => {
  const result = batch();
  result.tasks[0].name = '=HYPERLINK("https://bad")';
  result.tasks[0].actual = actual;
  result.tasks[0].status = 'created-unverified';
  result.tasks[0].reason = '逗号, "引号"';
  const csv = exportCsv(result);
  assert(csv.startsWith('\uFEFF'));
  assert(csv.includes("\"'=HYPERLINK"));
  assert(csv.includes('"逗号, ""引号"""'));
  assert.equal(exportCsv(result, 'success').split('\r\n').length, 2);
  assert.equal(exportCsv(result, 'exceptions').split('\r\n').length, 3);
  assert(copyPairs(result).includes(actual.unitId));
  assert(copyPairs(result).startsWith('"\'=HYPERLINK'));
  result.tasks[0].status = 'exists';
  assert.equal(exportCsv(result, 'success').split('\r\n').length, 3);
});

test('batch boundary revalidates hand-built rows instead of trusting their errors arrays', () => {
  const row = { line: 1, name: '广告', floor: '60', errors: [] };
  const make = (rows: typeof row[]) => createBatch(rows, identity, 'interstitial', 2, 'tabs', 'https://apps.admob.com/', 'controller');
  const duplicateNames = make([row, { ...row, line: 2 }]);
  assert.equal(duplicateNames.tasks.length, 2);
  for (const name of ['', '  ', ' 广告', '广告 ', '长'.repeat(81), '\u0000广告']) assert.throws(() => make([{ ...row, name }]), /名称/);
  for (const floor of ['-1', '1,000', '1e2', '$60', '']) assert.throws(() => make([{ ...row, floor }]));
  assert.throws(() => make([{ ...row, floor: 60 as unknown as string }]), /字符串/);
  assert.throws(() => make([{ ...row, line: 0 }]), /行号/);
  assert.throws(() => make([{ ...row, line: NaN }]), /行号/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../src/gm.ts';

test('a remote ACK resolves with page polling frozen and removes its listener', { timeout: 1000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let ack: string | undefined, callback: (() => void) | undefined;
  const removed: number[] = [];
  Object.assign(globalThis, {
    GM_addValueChangeListener: (key: string, fn: () => void) => {
      assert.equal(key, 'abc:v1:command:worker'); callback = fn; return 17;
    },
    GM_removeValueChangeListener: (id: number) => removed.push(id),
  });
  const waiting = waitFor(() => ack, 60000, 'command:worker');
  ack = 'persisted-report-id'; callback!();
  assert.equal(await waiting, ack);
  assert.deepEqual(removed, [17]);
  callback!(); t.mock.timers.tick(60000);
  assert.deepEqual(removed, [17]);
});

test('a value changing during listener registration cannot lose its wakeup', { timeout: 1000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let ready: true | undefined;
  const removed: number[] = [];
  Object.assign(globalThis, {
    GM_addValueChangeListener: () => { ready = true; return 18; },
    GM_removeValueChangeListener: (id: number) => removed.push(id),
  });
  assert.equal(await waitFor(() => ready, 60000, 'report:worker'), true);
  assert.deepEqual(removed, [18]);
});

test('missing notifications retain polling and a timeout cleans up its listener', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let ready: true | undefined;
  Object.assign(globalThis, { GM_addValueChangeListener: () => { throw new Error('Unavailable'); } });
  const fallback = waitFor(() => ready, 1000, 'command:worker');
  ready = true; t.mock.timers.tick(400); assert.equal(await fallback, true);
  const removed: number[] = [];
  Object.assign(globalThis, {
    GM_addValueChangeListener: () => 19,
    GM_removeValueChangeListener: (id: number) => removed.push(id),
  });
  const timedOut = waitFor(() => undefined, 1000, 'command:worker');
  const rejection = assert.rejects(timedOut, /跨页通信等待超时/);
  t.mock.timers.tick(1000); await rejection;
  assert.deepEqual(removed, [19]);
});

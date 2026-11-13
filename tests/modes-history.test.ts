import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatch, parseInput, transition, exportCsv } from '../src/core.ts';
import { summarizeBatch, batchElapsed } from '../src/history.ts';
import type { AdFormat, FloorMode } from '../src/types.ts';

const identity={publisherId:'pub-1234567890123456',appId:'ca-app-pub-1234567890123456~1234567890',appName:'模式测试',evidence:[]};
test('all three formats require the chosen saved floor mode; only manual requires an amount',async t=>{
  for(const format of ['interstitial','app-open','native'] as AdFormat[])for(const mode of ['manual','auto','disabled'] as FloorMode[])await t.test(`${format}/${mode}`,()=>{
    const rows=parseInput(mode==='manual'?'A,1000':'A',{mode});
    const batch=createBatch(rows,identity,format,5,'tabs','','controller',mode);
    const task=batch.tasks[0];
    assert.equal(task.floor,mode==='manual'?'1000':'');assert.equal(task.mode,mode);
    task.status='verifying';
    task.actual={...identity,unitId:'ca-app-pub-1234567890123456/1234567890',name:'A',format,mode:mode==='disabled'?'auto':'disabled',verified:true};
    assert.throws(()=>transition(task,'success'),/核验/);
    task.actual.mode=mode;
    if(mode==='manual'){
      assert.throws(()=>transition(task,'success'),/核验/);
      task.actual.floor='1';task.actual.currency='USD';assert.throws(()=>transition(task,'success'),/核验/);
      task.actual.floor='1000';
    }
    task.status='verifying';transition(task,'success');assert.equal(task.status,'success');
    const csv=exportCsv(batch);assert.ok(csv.includes(format==='native'?'信息流（原生广告）':format==='app-open'?'开屏':'插页式'));
    assert.equal(parseInput('A',{mode}).some(row=>row.errors.length>0),mode==='manual');
  });
});
test('history uses recorded start/end, includes pauses, and never fabricates old completion times',()=>{
  const batch=createBatch(parseInput('A,1'),identity,'interstitial',1,'single','','controller');
  batch.confirmedAt='2026-11-13T10:00:00.000Z';batch.phase='done';batch.tasks[0].finishedAt='2026-11-13T10:10:00.000Z';
  assert.equal(summarizeBatch(batch).startedAt,batch.confirmedAt);
  assert.equal(batchElapsed(summarizeBatch(batch)),'未知');
  batch.startedAt='2026-11-13T09:59:00.000Z';batch.completedAt='2026-11-13T10:10:00.000Z';
  assert.equal(batchElapsed(summarizeBatch(batch)),'660.0 秒');
  batch.phase='paused';delete batch.completedAt;
  assert.equal(batchElapsed(summarizeBatch(batch),Date.parse('2026-11-13T10:05:00.000Z')),'360.0 秒（进行中）');
  batch.completedAt='invalid';assert.equal(batchElapsed(summarizeBatch(batch)),'未知');
});

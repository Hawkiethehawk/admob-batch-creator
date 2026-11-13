import test from 'node:test';
import assert from 'node:assert/strict';
import { performJob } from '../src/worker.ts';
import { createBatch, parseInput } from '../src/core.ts';
import type { Adapter, Identity } from '../src/types.ts';
import type { Job, Report } from '../src/protocol.ts';

test('an ACK failure after submit preserves the exact receipt ID without certifying its floor', async () => {
  for (const receipt of ['ca-app-pub-1234567890123456/1234567890', 'ca-app-pub-9999999999999999/1234567890', undefined]) {
    const storage=new Map<string,unknown>();
    Object.assign(globalThis,{GM_getValue:(key:string,fallback:unknown)=>storage.get(key)??fallback,GM_setValue:(key:string,value:unknown)=>storage.set(key,value)});
    const identity:Identity={publisherId:'pub-1234567890123456',appId:'ca-app-pub-1234567890123456~1234567890',appName:'App',evidence:[]};
    const batch=createBatch(parseInput('Unit,700'),identity,'interstitial',1,'tabs','https://admob.google.com/','controller');
    batch.phase='running';
    const job:Job={batch,task:batch.tasks[0],assignmentId:'assignment',workerId:'worker',kind:'create'};
    let submits=0,verifies=0;
    const reports:Omit<Report,'id'|'at'|'workerId'>[]=[];
    const adapter:Adapter={
      identify:async()=>identity,home:async()=>{},lookup:async()=>({complete:true,matches:[]}),diagnostics:()=>({}),
      prepare:async()=>{},submit:async()=>{submits++;},verify:async()=>{verifies++;throw Error('Must preserve before navigation');},
      recoverCreatedId:(seen,name,format)=>{assert.deepEqual(seen,identity);assert.equal(name,'Unit');assert.equal(format,'interstitial');return receipt;},
    };
    await performJob(job,adapter,async report=>{
      if(report.stage==='verifying')throw Error('ACK transport timeout');
      reports.push(report);
    },async()=>{});
    const result=reports.at(-1)!;
    assert.equal(submits,1);assert.equal(verifies,0);
    assert.equal(result.status,receipt?.includes(identity.publisherId)?'created-unverified':'uncertain');
    assert.equal(result.actual?.unitId,receipt?.includes(identity.publisherId)?receipt:undefined);
    assert.notEqual(result.actual?.verified,true);
    assert.equal(result.reason,'ACK transport timeout');
  }
});

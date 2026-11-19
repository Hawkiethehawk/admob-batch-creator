import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

const workerId='12345678-1234-1234-1234-123456789abc';
const workerUrl='https://admob.google.com/v2/apps/1234567890/adunits/list?__admob_batch_worker='+workerId;
function globals(t:TestContext, values:Record<string,unknown>):void {
  for(const [key,value] of Object.entries(values)){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});
  }
}
async function initialize(t:TestContext){
  // Import the actual entry module in an iframe-like context so its automatic
  // entry point exits; the exported tab initializer is exercised directly.
  globals(t,{window:{top:{},self:{}}});
  return (await import('../src/main.ts')).initializeTab;
}

test('a URL worker marker survives missing tab APIs and repeated startup',async t=>{
  const initializeTab=await initialize(t);
  globals(t,{GM_getTab:undefined,GM_saveTab:undefined});
  const first=await initializeTab(workerUrl),again=await initializeTab(workerUrl);
  assert.equal(first.abcWorkerId,workerId);assert.equal(again.abcWorkerId,workerId);
  assert.equal(typeof first.abcTabId,'string');
});

test('the worker role is captured before a delayed tab read completes',async t=>{
  const initializeTab=await initialize(t);let callback:((tab:Record<string,unknown>)=>void)|undefined;
  const saved:Record<string,unknown>[]=[];
  const location={href:workerUrl};
  globals(t,{location,GM_getTab:(fn:typeof callback)=>{callback=fn;},GM_saveTab:(state:Record<string,unknown>)=>{saved.push(structuredClone(state));}});
  const pending=initializeTab(location.href);
  location.href='https://admob.google.com/v2/apps/1234567890/adunits/list';
  callback!({abcTabId:'existing-tab'});
  const state=await pending;
  assert.equal(state.abcWorkerId,workerId);assert.equal(state.abcTabId,'existing-tab');
  assert.equal(saved[0].abcWorkerId,workerId);
});

test('a stalled tab read times out without discarding the URL worker role',async t=>{
  const initializeTab=await initialize(t);t.mock.timers.enable({apis:['setTimeout']});
  globals(t,{GM_getTab:()=>{},GM_saveTab:()=>{throw new Error('tab persistence unavailable');}});
  const pending=initializeTab(workerUrl);t.mock.timers.tick(2000);
  const state=await pending;assert.equal(state.abcWorkerId,workerId);assert.equal(typeof state.abcTabId,'string');
});

test('invalid URL markers cannot assign the worker role',async t=>{
  const initializeTab=await initialize(t);
  globals(t,{GM_getTab:(fn:(state:Record<string,unknown>)=>void)=>fn({abcTabId:'existing'}),GM_saveTab:()=>{}});
  const state=await initializeTab('https://admob.google.com/?__admob_batch_worker=invalid!');
  assert.equal(state.abcWorkerId,undefined);assert.equal(state.abcTabId,'existing');
});

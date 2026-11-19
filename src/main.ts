import { AdMobAdapter } from './adapter.ts';
import { Controller } from './controller.ts';
import { runWorker } from './worker.ts';
import { tabState, uuid } from './gm.ts';

function saveTab(state:Record<string,unknown>):void {
  try { if (typeof GM_saveTab === 'function') GM_saveTab(state); }
  catch { /* The URL marker remains authoritative when tab persistence fails. */ }
}

export async function initializeTab(href:string):Promise<Record<string,unknown>> {
  // Capture the role before awaiting a possibly missing or delayed tab API.
  const marker=new URL(href).searchParams.get('__admob_batch_worker');
  const state=await tabState();
  if(marker && /^[\w-]{20,80}$/.test(marker)){
    state.abcWorkerId=marker;saveTab(state);
    // Keep the marker across reloads; GM_saveTab has no reliable success signal
    // in every supported sandbox, and GM_getTab may be missing or time out.
  }
  if(!state.abcTabId){state.abcTabId=uuid();saveTab(state);}
  return state;
}

async function main():Promise<void>{
  if(window.top!==window.self || document.getElementById('abc-panel-host') || document.getElementById('abc-batch-creator') || document.getElementById('abc-worker-status'))return;
  const state=await initializeTab(location.href);
  const adapter=new AdMobAdapter();
  if(typeof state.abcWorkerId==='string')await runWorker(state.abcWorkerId,adapter);
  else await new Controller(adapter).init();
}
void main().catch(error=>{
  const box=document.createElement('div');box.id='abc-batch-creator';
  box.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:16px;background:#fff1f0;border:1px solid #cc3333;color:#8b1111;max-width:420px;font:14px sans-serif';
  box.textContent='AdMob Batch Creator 启动受阻：'+(error as Error).message;document.body.append(box);
});

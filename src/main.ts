import { AdMobAdapter } from './adapter.ts';
import { Controller } from './controller.ts';
import { runWorker } from './worker.ts';
import { tabState, uuid } from './gm.ts';

async function main():Promise<void>{
  if(window.top!==window.self || document.getElementById('abc-panel-host') || document.getElementById('abc-batch-creator') || document.getElementById('abc-worker-status'))return;
  const state=await tabState();
  const url=new URL(location.href),marker=url.searchParams.get('__admob_batch_worker');
  if(marker && /^[\w-]{20,80}$/.test(marker)){
    state.abcWorkerId=marker;GM_saveTab(state);url.searchParams.delete('__admob_batch_worker');history.replaceState(history.state,'',url.href);
  }
  if(!state.abcTabId){state.abcTabId=uuid();GM_saveTab(state);}
  const adapter=new AdMobAdapter();
  if(typeof state.abcWorkerId==='string')await runWorker(state.abcWorkerId,adapter);
  else await new Controller(adapter).init();
}
void main().catch(error=>{
  const box=document.createElement('div');box.id='abc-batch-creator';
  box.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:16px;background:#fff1f0;border:1px solid #cc3333;color:#8b1111;max-width:420px;font:14px sans-serif';
  box.textContent='AdMob Batch Creator 启动受阻：'+(error as Error).message;document.body.append(box);
});

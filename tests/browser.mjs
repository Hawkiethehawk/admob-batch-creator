import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Isolated headless contexts, local fixtures, and a GM shim. This does not
// validate extension installation, a real AdMob revision, or HubVPS.
const built=spawnSync(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});if(built.status!==0)process.exit(built.status||1);
const fixture=await readFile(new URL('./fixture.html',import.meta.url));
const script=await readFile(new URL('../dist/admob-batch-creator.user.js',import.meta.url));
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url?.startsWith('/userscript.js')?'text/javascript;charset=utf-8':'text/html;charset=utf-8');res.end(req.url?.startsWith('/userscript.js')?script:fixture);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const results={at:new Date().toISOString(),scope:'Headless isolated browser + semantic local fixture + simulated GM; not Tampermonkey or real AdMob acceptance',script:{bytes:script.length,sha256:createHash('sha256').update(script).digest('hex')},browsers:[]};
function browserPath(override, relative, roots){
 const candidates=roots.filter(Boolean).map(root=>join(root,...relative));
 return override || candidates.find(path=>existsSync(path)) || candidates[0] || '';
}
const configurations=[
 ['Chrome',browserPath(process.env.ADMOB_CHROME_PATH,['Google','Chrome','Application','chrome.exe'],[process.env.LOCALAPPDATA,process.env.ProgramFiles,process.env['ProgramFiles(x86)']])],
 ['Edge',browserPath(process.env.ADMOB_EDGE_PATH,['Microsoft','Edge','Application','msedge.exe'],[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA])],
];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const scratch=resolve('.scratch/browser-test');
if(!scratch.startsWith(resolve('.')+'\\')&&!scratch.startsWith(resolve('.')+'/'))throw new Error('Scratch path escaped project');
await mkdir(scratch,{recursive:true});process.env.TEMP=scratch;process.env.TMP=scratch;process.env.TMPDIR=scratch;

async function setup(browser,url='/fixture.html'){
 const context=await browser.newContext({viewport:{width:1600,height:1300},acceptDownloads:true});
 const tabs=new Map();let opened=0;const errors=[];const opens=[];
 context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
 await context.exposeBinding('__abcOpen',async({page},url,id)=>{opened++;opens.push(await page.evaluate(()=>{const k=Object.keys(localStorage).find(k=>k.startsWith('gm:abc:v1:batch:'));const b=k&&JSON.parse(localStorage.getItem(k));return {unitCount:JSON.parse(localStorage.getItem('fixture:units')||'[]').length,canaryPassed:b?.canaryPassed};}));const tab=await context.newPage();tabs.set(id,tab);await tab.goto(url);return true;});
 await context.exposeBinding('__abcClose',async(_source,id)=>{await tabs.get(id)?.close();return true;});
 await context.addInitScript(()=>{
  const listeners=new Map();let index=0;const decode=s=>s===null?undefined:JSON.parse(s);
  window.GM_getValue=(key,fallback)=>{const s=localStorage.getItem('gm:'+key);return s===null?fallback:decode(s);};
  window.GM_setValue=(key,value)=>{const old=localStorage.getItem('gm:'+key),next=JSON.stringify(value);localStorage.setItem('gm:'+key,next);for(const item of listeners.values())if(item.key===key)item.callback(key,decode(old),value,false);};
  window.GM_deleteValue=key=>localStorage.removeItem('gm:'+key);
  window.GM_listValues=()=>Object.keys(localStorage).filter(k=>k.startsWith('gm:')).map(k=>k.slice(3));
  window.GM_addValueChangeListener=(key,callback)=>{const id=++index;listeners.set(id,{key,callback});return id;};
  window.GM_removeValueChangeListener=id=>listeners.delete(id);
  addEventListener('storage',e=>{if(e.key?.startsWith('gm:'))for(const item of listeners.values())if(item.key===e.key.slice(3))item.callback(item.key,decode(e.oldValue),decode(e.newValue),true);});
  window.GM_getTab=callback=>callback(JSON.parse(sessionStorage.getItem('mock:tab')||'{}'));
  window.GM_saveTab=(tab,callback)=>{sessionStorage.setItem('mock:tab',JSON.stringify(tab));callback?.();};
  window.GM_setClipboard=text=>{window.__mockClipboard=text;};
  window.GM_openInTab=(url)=>{const id=crypto.randomUUID();void window.__abcOpen(url,id);return {closed:false,close(){this.closed=true;void window.__abcClose(id);}};};
 });
 const page=await context.newPage();await page.goto(origin+url);await page.locator('#abc-panel-host').waitFor({state:'attached'});
 await page.locator('#abc-panel-host .identity-state').filter({hasText:'账号与应用已识别'}).waitFor();
 return {context,page,errors,opens,get opened(){return opened;}};
}
async function batch(page){return page.evaluate(()=>{const latestKey=Object.keys(localStorage).find(k=>k.startsWith('gm:abc:v1:latest:'));const latest=latestKey&&JSON.parse(localStorage.getItem(latestKey));const key=Object.keys(localStorage).find(k=>k.startsWith('gm:abc:v1:batch:')&&(!latest||k.endsWith(':'+latest)));return key?JSON.parse(localStorage.getItem(key)):null;});}
async function waitBatch(page,phase,timeout=100000){
 try{await page.waitForFunction(expected=>{const latestKey=Object.keys(localStorage).find(k=>k.startsWith('gm:abc:v1:latest:'));const latest=latestKey&&JSON.parse(localStorage.getItem(latestKey));const key=Object.keys(localStorage).find(k=>k.startsWith('gm:abc:v1:batch:')&&(!latest||k.endsWith(':'+latest)));const b=key&&JSON.parse(localStorage.getItem(key));return b?.phase===expected;},phase,{timeout});return batch(page);}catch(e){throw new Error(e.message+'\nLast batch: '+JSON.stringify(await batch(page))+'\nNotice: '+await page.locator('#abc-panel-host .notice').textContent());}
}
async function list(page,key='units'){return page.evaluate(k=>JSON.parse(localStorage.getItem('fixture:'+k)||'[]'),key);}
async function configure(page,rows,{format='interstitial',execution='single'}={}){
 await page.getByLabel('广告格式',{exact:true}).selectOption(format);
 await page.getByLabel('执行方式',{exact:true}).selectOption(execution);
 await page.getByLabel('CSV 或 TSV 输入',{exact:true}).fill('广告位名称,底价USD\n'+rows.map(r=>r.join(',')).join('\n'));
 await page.getByRole('button',{name:'解析到清单',exact:true}).click();
 await page.getByRole('button',{name:'预检（不提交）',exact:true}).click();
 await page.locator('#abc-panel-host .notice').filter({hasText:'预检不创建广告位。待创建'}).waitFor({timeout:50000});
 assert.equal((await list(page)).length,0,'preflight must not create');
 await page.getByRole('checkbox').check();
}
async function start(page){await page.getByRole('button',{name:'开始创建',exact:true}).click();}
async function verifySuccess(page,expected){
 const b=await waitBatch(page,'done');assert.equal(b.tasks.length,expected.length);assert.ok(b.tasks.every(t=>t.status==='success'),JSON.stringify(b.tasks));
 const actual=await list(page);assert.equal(actual.length,expected.length);assert.equal((await list(page,'clicks')).length,expected.length,'one submit per row');
 for(const [name,floor]of expected){const t=b.tasks.find(t=>t.name===name);assert.equal(t.actual.name,name);assert.equal(t.actual.currency,'USD');assert.equal(t.actual.floor,floor);assert.match(t.actual.unitId,/\/\d{10}$/);assert.equal(t.actual.verified,true);}
 return b;
}
async function runCase(browser,label,fn){if(process.env.CASE_FILTER&&!label.includes(process.env.CASE_FILTER))return {case:label,skipped:true};const at=Date.now();console.log('START '+label);try{const details=await fn();const result={case:label,pass:true,elapsedMs:Date.now()-at,...details};console.log(JSON.stringify(result));return result;}catch(error){const result={case:label,pass:false,elapsedMs:Date.now()-at,error:error.stack};console.log(JSON.stringify(result));return result;}}
try{
 for(const [name,executablePath]of configurations){
  if(process.env.BROWSER_FILTER&&name!==process.env.BROWSER_FILTER)continue;
  if(!existsSync(executablePath)){results.browsers.push({name,available:false,executablePath});continue;}
  const browser=await chromium.launch({executablePath,headless:true,downloadsPath:join(scratch,'downloads')});const info={name,version:browser.version(),available:true,cases:[]};results.browsers.push(info);
  try{
   info.cases.push(await runCase(browser,'single-interstitial-distinct-floors-and-export',async()=>{
    const run=await setup(browser);try{const rows=[['INT_60','60'],['INT_40','40.25']];await configure(run.page,rows);await start(run.page);await verifySuccess(run.page,rows);
     const downloadPromise=run.page.waitForEvent('download');await run.page.getByRole('button',{name:'导出全部',exact:true}).click();const download=await downloadPromise;const file=await download.path();const csv=await readFile(file,'utf8');assert.ok(csv.includes('INT_60'));assert.ok(csv.includes('ca-app-pub-1234567890123456/'));
     await run.page.getByRole('button',{name:'复制“名称 + ID”',exact:true}).click();assert.ok((await run.page.evaluate(()=>window.__mockClipboard)).includes('INT_40'));assert.equal(run.opened,0);assert.deepEqual(run.errors,[]);return {rows:rows.length,preflightSubmits:0,workerTabs:run.opened,exportAndClipboard:true};
    }finally{await run.context.close();}
   }));
   info.cases.push(await runCase(browser,'single-app-open',async()=>{
    const run=await setup(browser);try{const rows=[['OPEN_15','15.01']];await configure(run.page,rows,{format:'app-open'});await start(run.page);const b=await verifySuccess(run.page,rows);assert.equal(b.tasks[0].actual.format,'app-open');assert.deepEqual(run.errors,[]);return {rows:1};}finally{await run.context.close();}
   }));
   info.cases.push(await runCase(browser,'two-workers-canary-pool-reuse-real-web-locks',async()=>{
    const run=await setup(browser);try{const started=Date.now();const rows=[['POOL_60','60'],['POOL_40','40'],['POOL_20','20'],['POOL_15','15']];await configure(run.page,rows,{execution:'tabs'});assert.equal(run.opened,1);await start(run.page);const b=await verifySuccess(run.page,rows);assert.ok(Date.now()-started<40000,'four-row pool must finish before any 60s ACK timeout');assert.equal(b.canaryPassed,true);assert.equal(run.opened,2,'fixed pool should reuse two tabs');assert.equal(new Set(b.tasks.map(t=>t.workerId)).size,2);assert.equal(run.opens[1].canaryPassed,true,'second worker opens only after verified canary');const clicks=await list(run.page,'clicks');for(let i=1;i<clicks.length;i++)assert.ok(clicks[i].at-clicks[i-1].at>=2000,'global submit throttle');assert.deepEqual(run.errors,[]);return {rows:4,workerTabs:run.opened,secondWorkerAfterVerifiedCanary:true,globalSubmitThrottle:true,ackTimeoutAvoided:true,realWebLocksCrossPage:true,gm:'simulated'};}finally{await run.context.close();}
   }));
   info.cases.push(await runCase(browser,'pause-after-submit-continues-verification-and-resume',async()=>{
    const run=await setup(browser,'/fixture.html?saveDelay=2000');try{const rows=[['PAUSE_60','60'],['PAUSE_40','40']];await configure(run.page,rows);await start(run.page);
     await run.page.waitForFunction(()=>{const k=Object.keys(localStorage).find(k=>k.startsWith('gm:abc:v1:batch:'));return k&&['submitting','verifying'].includes(JSON.parse(localStorage.getItem(k)).tasks[0].status);},{timeout:30000});
     await run.page.getByRole('button',{name:'暂停',exact:true}).click();await waitBatch(run.page,'paused');await pause(3500);const stopped=await batch(run.page);assert.equal(stopped.tasks[0].status,'success');assert.equal((await list(run.page)).length,1);assert.equal(stopped.tasks[1].status,'pending');await run.page.getByRole('button',{name:'继续',exact:true}).click();await verifySuccess(run.page,rows);assert.deepEqual(run.errors,[]);return {completedDuringPause:1,secondDispatchedAfterResume:true};
    }finally{await run.context.close();}
   }));
   info.cases.push(await runCase(browser,'ambiguous-dollar-blocks-submit',async()=>{
    const run=await setup(browser,'/fixture.html?currency=%24');try{await configure(run.page,[['BLOCK_60','60']]);await start(run.page);const b=await waitBatch(run.page,'paused',30000);assert.equal((await list(run.page,'clicks')).length,0);assert.equal(b.tasks[0].intentAt,undefined);assert.equal(b.tasks[0].status,'failed');assert.match(b.tasks[0].reason,/USD|美元/);assert.deepEqual(run.errors,[]);return {createClicks:0,submitIntent:false};}finally{await run.context.close();}
   }));
   info.cases.push(await runCase(browser,'controller-refresh-after-click-never-resubmits',async()=>{
    const run=await setup(browser,'/fixture.html?saveDelay=5000');try{
     await configure(run.page,[['REFRESH_CTRL','60']]);await start(run.page);
     await run.page.waitForFunction(()=>JSON.parse(localStorage.getItem('fixture:clicks')||'[]').length===1);
     const before=await batch(run.page);assert.ok(before.tasks[0].intentAt);
     await run.page.reload();const recovered=await waitBatch(run.page,'paused',15000);assert.equal(recovered.tasks[0].status,'uncertain');assert.equal(recovered.tasks[0].intentAt,before.tasks[0].intentAt);
     await run.page.getByRole('button',{name:'核验结果不确定项',exact:true}).click();
     await run.page.waitForFunction(()=>{const k=Object.keys(localStorage).find(k=>k.startsWith('gm:abc:v1:batch:'));return k&&JSON.parse(localStorage.getItem(k)).tasks[0].status==='uncertain';});
     assert.equal((await list(run.page,'clicks')).length,1);assert.equal((await list(run.page)).length,0);assert.deepEqual(run.errors,[]);return {createClicks:1,recoveredStatus:'uncertain',readOnlyVerificationNoResubmit:true};
    }finally{await run.context.close();}
   }));
   info.cases.push(await runCase(browser,'worker-refresh-after-click-never-resubmits',async()=>{
    const run=await setup(browser,'/fixture.html?saveDelay=5000');try{
     await configure(run.page,[['REFRESH_WORKER','60']],{execution:'tabs'});await start(run.page);
     await run.page.waitForFunction(()=>JSON.parse(localStorage.getItem('fixture:clicks')||'[]').length===1);
     const workers=[];for(const candidate of run.context.pages())if(await candidate.locator('#abc-worker-status').count())workers.push(candidate);assert.equal(workers.length,1);
     await workers[0].reload();const recovered=await waitBatch(run.page,'paused',15000);assert.equal(recovered.tasks[0].status,'uncertain');assert.ok(recovered.tasks[0].intentAt);assert.equal((await list(run.page,'clicks')).length,1);assert.equal((await list(run.page)).length,0);assert.deepEqual(run.errors,[]);return {createClicks:1,recoveredStatus:'uncertain',workerTabs:run.opened};
    }finally{await run.context.close();}
   }));
   info.cases.push(await runCase(browser,'publisher-controller-lock-across-pages',async()=>{
    const run=await setup(browser);try{await configure(run.page,[['LOCK_60','60']]);const second=await run.context.newPage();await second.goto(origin+'/fixture.html');await second.locator('#abc-panel-host .identity-state').filter({hasText:'已有活动主控'}).waitFor({timeout:10000});assert.equal((await list(run.page,'clicks')).length,0);return {secondControllerBlocked:true};}finally{await run.context.close();}
   }));
   info.cases.push(await runCase(browser,'draft-stop-persists-through-reload-and-allows-next-preflight',async()=>{
    const run=await setup(browser,'/fixture.html?partial=1');try{
     await configure(run.page,[['STOP_DRAFT','60']]);const draft=await batch(run.page);assert.equal(draft.phase,'draft');assert.equal(draft.tasks[0].status,'uncertain');assert.equal(draft.tasks[0].intentAt,undefined);assert.equal(draft.confirmedAt,undefined);const originalReason=draft.tasks[0].reason;
     await run.page.getByRole('button',{name:'停止',exact:true}).click();const stopped=await waitBatch(run.page,'done',10000);assert.ok(stopped.stopRequestedAt);assert.equal(stopped.tasks[0].status,'uncertain');assert.equal(stopped.tasks[0].reason,originalReason);assert.equal((await list(run.page,'clicks')).length,0);
     await run.page.reload();await run.page.locator('#abc-panel-host').waitFor({state:'attached'});const restored=await waitBatch(run.page,'done',10000);assert.equal(restored.id,stopped.id);assert.equal(restored.stopRequestedAt,stopped.stopRequestedAt);assert.equal(await run.page.getByRole('button',{name:'继续',exact:true}).isDisabled(),true);assert.equal(await run.page.getByRole('button',{name:'开始创建',exact:true}).isDisabled(),true);
     await run.page.evaluate(()=>window.fixture.setPartial(false));await configure(run.page,[['NEXT_DRAFT','40']]);const next=await batch(run.page);assert.notEqual(next.id,stopped.id);assert.equal(next.phase,'draft');assert.equal(next.tasks[0].status,'pending');assert.equal(await run.page.getByRole('button',{name:'开始创建',exact:true}).isEnabled(),true);
     const historical=await run.page.evaluate(id=>{const k=Object.keys(localStorage).find(k=>k.startsWith('gm:abc:v1:batch:')&&k.endsWith(':'+id));return JSON.parse(localStorage.getItem(k));},stopped.id);assert.equal(historical.phase,'done');assert.equal(historical.stopRequestedAt,stopped.stopRequestedAt);assert.equal(historical.tasks[0].status,'uncertain');assert.equal(historical.tasks[0].reason,originalReason);assert.equal(historical.tasks[0].intentAt,undefined);assert.equal((await list(run.page,'clicks')).length,0);assert.deepEqual(run.errors,[]);
     return {draftStopCreateClicks:0,reloadCannotResume:true,nextPreflightAllowed:true,uncertainEvidencePreserved:true};
    }finally{await run.context.close();}
   }));
  }finally{await browser.close();}
  console.log(JSON.stringify(info,null,2));
 }
}finally{server.close();await writeFile(new URL('../docs/browser-results.json',import.meta.url),JSON.stringify(results,null,2)+'\n');await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
if(results.browsers.some(b=>!b.available||b.cases.some(c=>c.pass===false)))process.exitCode=1;

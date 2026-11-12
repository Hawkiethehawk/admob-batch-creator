import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {AdMobAdapter,AdapterError,currencyOf,checkConstraints,readField} from '../src/adapter.ts';
import type {Identity} from '../src/types.ts';

const publisherId='pub-1234567890123456';
const appId='ca-app-pub-1234567890123456~1234567890';
const unitId='ca-app-pub-1234567890123456/9876543210';
const identity:Identity={publisherId,appId,appName:'测试应用',evidence:[]};
function context(extra=''):string {return `<dl><dt>发布商 ID</dt><dd>${publisherId}</dd><dt>应用 ID</dt><dd>${appId}</dd><dt>应用名称</dt><dd>测试应用</dd></dl>${extra}`;}
function dom(html:string) {return new JSDOM(html,{url:'https://apps.admob.com/'});}
function form(format='插页式',currency='USD'):string {return context(`<form><dl><dt>广告格式</dt><dd>${format}</dd></dl><label for="name">广告单元名称</label><input id="name" maxlength="80" required><button type="button" aria-expanded="true">高级设置</button><fieldset aria-label="有效每千次展示费用底价"><label><input type="radio" name="mode" value="auto" checked>由 Google 优化</label><label><input type="radio" name="mode" value="manual">手动设定底价</label><label for="floor">全局底价</label><span id="currency">${currency}</span><input id="floor" type="number" min="0.01" max="1000" step="0.01" aria-describedby="currency" required></fieldset><button type="button" id="create">创建广告单元</button></form>`);}
function saved(name='A',floor='60.00',format='插页式',currency='USD'):string{return context(`<dl><dt>广告单元 ID</dt><dd>${unitId}</dd><dt>广告单元名称</dt><dd>${name}</dd><dt>广告格式</dt><dd>${format}</dd><dt>底价模式</dt><dd>手动设定底价</dd><dt>全局底价</dt><dd>${floor}</dd><dt>底价币种</dt><dd>${currency}</dd></dl>`);}

test('identity accepts explicit fields, distinguishes app and unit IDs',async()=>{
 const page=dom(context(`<p>旧广告位 ${unitId}</p>`));const adapter=new AdMobAdapter(page.window.document,20);
 assert.equal((await adapter.identify()).appId,appId);
 page.window.document.body.innerHTML=`<p>${publisherId} ${appId} 测试应用</p>`;
 await assert.rejects(adapter.identify(),/没有可核对的发布商/);
});
test('identity rejects different selected publisher and conflicting fields',async()=>{
 const page=dom(context('<dl><dt>发布商 ID</dt><dd>pub-0000000000000000</dd></dl>'));
 await assert.rejects(new AdMobAdapter(page.window.document,20).identify(),/多个不同值/);
 page.window.document.body.innerHTML=context().replace(appId,'ca-app-pub-0000000000000000~1234567890');
 await assert.rejects(new AdMobAdapter(page.window.document,20).identify(),/不属于同一发布商/);
});
test('currency binds to input context and rejects bare dollar or competing currencies',()=>{
 const page=dom('<label for="f">全局底价</label><span id="c">USD</span><input id="f" aria-describedby="c"><aside>报表币种 CNY</aside>');
 const input=page.window.document.querySelector('input')!;
 assert.equal(currencyOf(input),'USD');
 page.window.document.getElementById('c')!.textContent='$';assert.throws(()=>currencyOf(input),/单独的/);
 page.window.document.getElementById('c')!.textContent='USD / CAD';assert.throws(()=>currencyOf(input),/不是 USD/);
});
test('page min max step rules checked using integer arithmetic',()=>{
 const page=dom('<input type="number" min="0.01" max="100" step="0.01">');const input=page.window.document.querySelector('input')!;
 assert.doesNotThrow(()=>checkConstraints(input,'60.00'));
 assert.throws(()=>checkConstraints(input,'0'),/最小/);
 assert.throws(()=>checkConstraints(input,'100.01'),/最大/);
 assert.throws(()=>checkConstraints(input,'1.001'),/步长/);
 input.removeAttribute('step');input.removeAttribute('min');assert.throws(()=>checkConstraints(input,'0.5'),/步长/);
});
test('mock semantic form activates manual mode, preserves per-row floor and verifies saved config',async()=>{
 for(const [format,fmt] of [['interstitial','插页式'],['app-open','开屏']] as const){
  const page=dom(form(fmt));const adapter=new AdMobAdapter(page.window.document,30);let checkpoints=0;let clicks=0;
  page.window.document.getElementById('create')!.addEventListener('click',()=>{clicks++;assert.equal((page.window.document.getElementById('floor') as HTMLInputElement).value,'60.03');assert.equal((page.window.document.querySelector('[value=manual]') as HTMLInputElement).checked,true);page.window.document.body.innerHTML=saved('A','60.030',fmt);});
  await adapter.prepare(identity,format,'A','60.03',async()=>{checkpoints++;});await adapter.submit();
  const result=await adapter.verify(identity,format,'A','60.03');assert.equal(result.verified,true);assert.equal(result.unitId,unitId);assert.ok(checkpoints>=3);assert.equal(clicks,1);
  await assert.rejects(adapter.submit(),/已经执行过提交/);
 }
});
test('wrong currency never reaches create, changed name refuses submit',async()=>{
 const page=dom(form('插页式','$'));const adapter=new AdMobAdapter(page.window.document,25);let submitted=0;page.window.document.getElementById('create')!.addEventListener('click',()=>submitted++);
 await assert.rejects(adapter.prepare(identity,'interstitial','A','60',async()=>{}),/无法从底价/);assert.equal(submitted,0);
 page.window.document.getElementById('currency')!.textContent='USD';await adapter.prepare(identity,'interstitial','A','60',async()=>{});
 (page.window.document.getElementById('name') as HTMLInputElement).value='B';await assert.rejects(adapter.submit(),/字段发生变化/);assert.equal(submitted,0);
});
test('ambiguous controls stop rather than picking first',async()=>{
 const page=dom(form().replace('<button type="button" id="create">','<button type="button">创建广告单元</button><button type="button" id="create">'));
 await assert.rejects(new AdMobAdapter(page.window.document,25).prepare(identity,'interstitial','A','60',async()=>{}),/2 个候选/);
});
test('already-created ID survives incomplete saved floor verification',async()=>{
 const page=dom(saved('A','40'));
 try{await new AdMobAdapter(page.window.document,25).verify(identity,'interstitial','A','60');assert.fail('must reject');}catch(err){assert.ok(err instanceof AdapterError);assert.equal(err.actual?.unitId,unitId);assert.equal(err.actual?.floor,'40');assert.equal(err.actual?.verified,false);}
});
test('list completeness requires matching explicit totals and pagination',async()=>{
 const html=context(`<section>共 1 个广告单元<table aria-label="广告单元"><thead><tr><th>广告单元名称</th><th>广告单元 ID</th><th>广告格式</th><th>底价模式</th><th>全局底价</th><th>底价币种</th></tr></thead><tbody><tr><td>A</td><td>${unitId}</td><td>插页式</td><td>手动设定底价</td><td>60</td><td>USD</td></tr></tbody></table></section>`);
 const page=dom(html);const adapter=new AdMobAdapter(page.window.document,25);const result=await adapter.lookup(identity,'A');assert.equal(result.complete,true);assert.equal(result.matches[0].verified,true);
 page.window.document.body.innerHTML=html.replace('共 1 个广告单元','');assert.equal((await adapter.lookup(identity,'A')).complete,false);
});
test('diagnostics excludes arbitrary page text, values, IDs and query strings',()=>{
 const page=new JSDOM(form().replace('min="0.01"','min="secret-token"')+'<button>private@example.com secret-token</button>',{url:'https://apps.admob.com/?token=secret-token'});
 const output=JSON.stringify(new AdMobAdapter(page.window.document).diagnostics());assert.ok(!output.includes('secret-token'));assert.ok(!output.includes(publisherId));assert.ok(!output.includes('测试应用'));assert.ok(!output.includes('private@example.com'));
 assert.equal(readField(page.window.document,['应用名称']),'测试应用');
});
test('detail navigation never combines ID A with configuration from unit B',async()=>{
 const otherId='ca-app-pub-1234567890123456/1111111111';
 const page=dom(context(`<dl><dt>广告单元 ID</dt><dd>${unitId}</dd></dl><a href="/observed-detail">查看广告单元</a>`));
 page.window.document.querySelector('a')!.addEventListener('click',e=>{e.preventDefault();page.window.document.body.innerHTML=saved().replace(unitId,otherId);});
 try{await new AdMobAdapter(page.window.document,30).verify(identity,'interstitial','A','60');assert.fail('must reject');}catch(err){assert.ok(err instanceof AdapterError);assert.match(err.message,/ID不一致/);assert.equal(err.actual?.unitId,unitId);assert.equal(err.actual?.verified,false);assert.equal(err.actual?.floor,undefined);}
});
test('search outside immediate table section prevents falsely complete lookup',async()=>{
 const page=dom(context('<main><label for="search">搜索广告单元</label><input id="search" value="A"><section>共 0 个广告单元<table aria-label="广告单元"><thead><tr><th>广告单元名称</th></tr></thead><tbody></tbody></table></section></main>'));
 const result=await new AdMobAdapter(page.window.document,30).lookup(identity,'A');assert.equal(result.complete,false);assert.match(result.reason!,/搜索或筛选/);
});
test('same names remain separate results, including different formats',async()=>{
 const page=dom(context(`<section>共 2 个广告单元<table aria-label="广告单元"><thead><tr><th>广告单元名称</th><th>广告单元 ID</th><th>广告格式</th></tr></thead><tbody><tr><td>A</td><td>${unitId}</td><td>插页式</td></tr><tr><td>A</td><td>ca-app-pub-1234567890123456/1111111111</td><td>开屏</td></tr></tbody></table></section>`));
 const result=await new AdMobAdapter(page.window.document,30).lookup(identity,'A');assert.equal(result.complete,true);assert.equal(result.matches.length,2);assert.equal(result.matches[1].format,'app-open');assert.ok(result.matches.every(r=>r.verified===false));
});
test('home follows observed link only and rechecks target app after navigation',async()=>{
 const page=dom(context('<a href="/observed-unit-list">广告单元</a>'));let observed=0;
 page.window.document.querySelector('a')!.addEventListener('click',e=>{e.preventDefault();observed++;page.window.document.body.innerHTML=context('<section>共 0 个广告单元<table aria-label="广告单元"><thead><tr><th>广告单元名称</th></tr></thead><tbody></tbody></table></section>').replace(appId,'ca-app-pub-1234567890123456~0000000000');});
 await assert.rejects(new AdMobAdapter(page.window.document,30).lookup(identity,'A'),/与批次不一致/);assert.equal(observed,1);
});
test('lookup enumerates pages and resets to observed first page for later queries',async()=>{
 const page=dom('');let current=0;let nextClicks=0;let firstClicks=0;
 const render=()=>{
  page.window.document.body.innerHTML=context(`<section>共 2 个广告单元<table aria-label="广告单元"><thead><tr><th>广告单元名称</th><th>广告单元 ID</th><th>广告格式</th></tr></thead><tbody><tr><td>${current===0?'A':'B'}</td><td>${current===0?unitId:'ca-app-pub-1234567890123456/1111111111'}</td><td>插页式</td></tr></tbody></table><button id="first" ${current===0?'disabled':''}>第一页</button><button id="next" ${current===1?'disabled':''}>下一页</button></section>`);
  page.window.document.getElementById('first')!.addEventListener('click',()=>{firstClicks++;current=0;render();});page.window.document.getElementById('next')!.addEventListener('click',()=>{nextClicks++;current=1;render();});
 };render();
 const adapter=new AdMobAdapter(page.window.document,30);
 const a=await adapter.lookup(identity,'A');assert.equal(a.complete,true);assert.equal(a.matches.length,1);
 const b=await adapter.lookup(identity,'B');assert.equal(b.complete,true);assert.equal(b.matches.length,1);assert.equal(firstClicks,1);assert.equal(nextClicks,2);
});

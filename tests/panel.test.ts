import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountPanel } from '../src/panel.ts';
import type { PanelActions, PanelConfig } from '../src/panel.ts';
import { createBatch, parseInput } from '../src/core.ts';
import type { Batch } from '../src/types.ts';
import { summarizeBatch } from '../src/history.ts';

function fixture(overrides: Partial<PanelActions> = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://apps.admob.com/' });
  Object.assign(globalThis, { document: dom.window.document });
  const no = async () => {};
  const handle = mountPanel({ identify: no, preflight: no, start: no, pause: no, resume: no, stop: no, retry: no, verify: no, degrade: no, export: no, copy: no, diagnostics: no, probe: no, ...overrides });
  handle.update({ identity });
  const root = dom.window.document.querySelector('#abc-panel-host')!.shadowRoot!;
  const button = (text: string) => {
    const found = [...root.querySelectorAll('button')].find(node => node.textContent === text);
    assert.ok(found, `button missing: ${text}`); return found;
  };
  const edit = (label: string, value: string) => {
    const input = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    assert.ok(input, `input missing: ${label}`);
    input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    return input;
  };
  const addRow = (name = '', floor = '') => {
    button('增加一行').click();
    const row = handle.getConfig().rows.at(-1)!;
    if (name) edit(`第 ${row.line} 行广告位名称`, name);
    if (floor) edit(`第 ${row.line} 行底价 USD`, floor);
    return row.line;
  };
  const rows = (values: [string, string][]) => { for (const [name, floor] of values) addRow(name, floor); };
  const chooseMode = (value: string) => {
    const mode = root.querySelector<HTMLSelectElement>('select[aria-label="底价模式"]')!;
    mode.value = value; mode.dispatchEvent(new dom.window.Event('change'));
  };
  const prefixSwitch = () => root.querySelector<HTMLInputElement>('input[role="switch"][aria-label="批量应用前缀"]')!;
  const togglePrefix = (value: boolean) => {
    const control = prefixSwitch(); assert.ok(control);
    control.checked = value; control.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, handle, root, button, edit, addRow, rows, chooseMode, prefixSwitch, togglePrefix, dispose() { handle.destroy(); dom.window.close(); } };
}
const identity = { publisherId: 'pub-1234567890123456', appId: 'ca-app-pub-1234567890123456~1234567890', appName: '测试应用', evidence: [] };

test('逐行输入保留三种底价模式和六种广告格式，新增行按钮位于表格下方',()=>{
  const ui=fixture();try{
    const mode=ui.root.querySelector<HTMLSelectElement>('select[aria-label="底价模式"]')!;
    assert.equal(mode.value,'manual');assert.deepEqual([...mode.options].map(o=>o.value),['manual','auto','disabled']);
    assert.deepEqual([...ui.root.querySelector<HTMLSelectElement>('select[aria-label="广告格式"]')!.options].map(o=>o.value),['interstitial','app-open','banner','native','rewarded','rewarded-interstitial']);
    assert.equal(ui.root.querySelector('[aria-label="请求底价币种"]'),null);
    assert.equal([...ui.root.querySelectorAll('button')].some(b=>b.textContent==='解析到清单'),false);
    assert.equal(ui.root.querySelector('textarea,input[type="file"]'),null);
    const table=ui.root.querySelector('.input-table')!;
    assert.ok(table.compareDocumentPosition(ui.button('增加一行')) & ui.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    mode.value='disabled';mode.dispatchEvent(new ui.dom.window.Event('change'));ui.rows([['A',''],['B','']]);
    assert.equal(ui.handle.getConfig().rows.length,2);assert.ok(ui.handle.getConfig().rows.every(row=>!row.errors.length));
    assert.equal(ui.root.querySelector<HTMLTableCellElement>('.input-table thead tr')!.children[2].hasAttribute('hidden'),true);
    assert.equal(ui.button('开始创建').disabled,false);assert.equal(ui.prefixSwitch().disabled,true);
    ui.chooseMode('auto');assert.equal(ui.prefixSwitch().disabled,true);
    mode.value='manual';mode.dispatchEvent(new ui.dom.window.Event('change'));
    assert.ok(ui.handle.getConfig().rows.every(row=>row.errors.includes('缺失底价')));
  }finally{ui.dispose();}
});
test('前缀开关按规范底价生成名称，修改底价或前缀不重复叠加，关闭恢复手动名称',()=>{
  const ui=fixture();try{
    ui.rows([['Manual  A','60.0'],['Manual B','40']]);
    ui.edit('名称前缀','  p_  ');ui.togglePrefix(true);ui.togglePrefix(true);
    assert.deepEqual(ui.handle.getConfig().rows.map(row=>row.name),['p_60','p_40']);
    assert.ok([...ui.root.querySelectorAll<HTMLInputElement>('.input-table input[aria-label$="广告位名称"]')].every(input=>input.readOnly));
    assert.equal(ui.root.querySelector<HTMLSelectElement>('[aria-label="底价模式"]')!.disabled,true);
    ui.edit('第 1 行底价 USD','70.50');assert.deepEqual(ui.handle.getConfig().rows.map(row=>row.name),['p_70.5','p_40']);
    ui.edit('名称前缀',' q_ ');assert.deepEqual(ui.handle.getConfig().rows.map(row=>row.name),['q_70.5','q_40']);
    ui.edit('名称前缀','x'.repeat(80));assert.ok(ui.handle.getConfig().rows.every(row=>row.errors.some(error=>error.includes('超过'))));
    ui.togglePrefix(false);assert.deepEqual(ui.handle.getConfig().rows.map(row=>[row.name,row.floor]),[['Manual  A','70.5'],['Manual B','40']]);
    assert.ok([...ui.root.querySelectorAll<HTMLInputElement>('.input-table input[aria-label$="广告位名称"]')].every(input=>!input.readOnly));
    assert.equal(ui.root.querySelector<HTMLSelectElement>('[aria-label="底价模式"]')!.disabled,false);
  }finally{ui.dispose();}
});
test('前缀开启时新增行的手动名称为空，关闭再开启保留各自名称与最新底价',()=>{
  const ui=fixture();try{
    ui.rows([['Original','1']]);ui.edit('名称前缀','unit_');ui.togglePrefix(true);
    ui.addRow('','2');assert.deepEqual(ui.handle.getConfig().rows.map(row=>row.name),['unit_1','unit_2']);
    ui.togglePrefix(false);assert.deepEqual(ui.handle.getConfig().rows.map(row=>row.name),['Original','']);
    assert.equal(ui.button('开始创建').disabled,true);
    ui.edit('第 2 行广告位名称','Independent');ui.edit('第 1 行广告位名称','Edited');
    ui.togglePrefix(true);ui.edit('第 2 行底价 USD','3.00');
    assert.deepEqual(ui.handle.getConfig().rows.map(row=>row.name),['unit_1','unit_3']);
    ui.togglePrefix(false);assert.deepEqual(ui.handle.getConfig().rows.map(row=>row.name),['Edited','Independent']);
  }finally{ui.dispose();}
});
test('仅在前缀开关开启时阻止当前清单中生成的重复名称',()=>{
  const ui=fixture();try{
    ui.rows([['Same','60'],['Same','60.0']]);assert.ok(ui.handle.getConfig().rows.every(row=>!row.errors.length));
    assert.equal(ui.button('开始创建').disabled,false,'手动重名仍被允许');
    ui.edit('名称前缀','dup_');ui.togglePrefix(true);
    assert.deepEqual(ui.handle.getConfig().rows.map(row=>row.name),['dup_60','dup_60']);
    assert.ok(ui.handle.getConfig().rows.some(row=>row.errors.some(error=>/重复/.test(error))));
    assert.equal(ui.button('开始创建').disabled,true);
    ui.edit('第 2 行底价 USD','61');assert.equal(ui.button('开始创建').disabled,false);
    ui.edit('第 2 行底价 USD','60.00');assert.equal(ui.button('开始创建').disabled,true);
    ui.togglePrefix(false);assert.ok(ui.handle.getConfig().rows.every(row=>!row.errors.length));assert.equal(ui.button('开始创建').disabled,false);
  }finally{ui.dispose();}
});
test('合作平台出价默认未选，预览展示选择且确认配置保存其快照',async()=>{
  const received:PanelConfig[]=[];const ui=fixture({start:async config=>{received.push(config);}});
  try{
    ui.rows([['A','60']]);const partner=ui.root.querySelector<HTMLInputElement>('input[aria-label="合作平台出价"]')!;
    assert.ok(partner);assert.equal(partner.checked,false);assert.equal(ui.handle.getConfig().partnerBidding,false);
    ui.button('开始创建').click();await new Promise(resolve=>setImmediate(resolve));
    assert.match(ui.root.querySelector('[role="dialog"]')!.textContent!,/合作平台出价/);
    assert.match(ui.root.querySelector('[role="dialog"]')!.textContent!,/未勾选/);
    ui.root.querySelector<HTMLButtonElement>('[data-action="cancel-preview"]')!.click();await new Promise(resolve=>setImmediate(resolve));
    partner.checked=true;partner.dispatchEvent(new ui.dom.window.Event('change'));
    assert.equal(ui.root.querySelector<HTMLInputElement>('[aria-label="第 1 行底价 USD"]')!.closest('td')!.hidden,true);
    assert.equal(ui.prefixSwitch().disabled,true);
    ui.button('开始创建').click();await new Promise(resolve=>setImmediate(resolve));
    assert.match(ui.root.querySelector('[role="dialog"]')!.textContent!,/已勾选/);
    assert.equal(received.length,0);
    ui.root.querySelector<HTMLButtonElement>('[data-action="confirm-create"]')!.click();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(received.length,1);assert.equal(received[0].partnerBidding,true);
    assert.equal(received[0].rows[0].floor,'');
    partner.checked=false;partner.dispatchEvent(new ui.dom.window.Event('change'));assert.equal(received[0].partnerBidding,true);
  }finally{ui.dispose();}
});
test('history selection displays and exports the selected batch without replacing the active task',async()=>{
  const old=batch();old.phase='done';old.tasks[0].name='historical';old.startedAt='2026-11-13T10:00:00Z';old.completedAt='2026-11-13T10:00:01.500Z';
  const current=batch();current.phase='running';const received:unknown[]=[];
  const ui=fixture({viewHistory:async id=>ui.handle.update({historyBatch:id?old:undefined}),history:async()=>{},export:async(filter,id)=>{received.push([filter,id]);}});
  try{
    ui.handle.update({batch:current,history:[summarizeBatch(old)]});
    const choose=ui.root.querySelector<HTMLSelectElement>('[aria-label="任务批次"]')!;
    choose.value=old.id;choose.dispatchEvent(new ui.dom.window.Event('change'));await new Promise(resolve=>setImmediate(resolve));
    assert.ok(ui.root.querySelector('.batch-meta')!.textContent!.includes(old.id));assert.ok(ui.root.querySelector('.batch-timing')!.textContent!.includes('1.5 秒'));
    assert.equal(ui.button('开始创建').disabled,true);assert.equal(ui.button('重试明确失败项').disabled,true);
    ui.button('导出全部').click();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(received,[['all',old.id]]);
    choose.value='';choose.dispatchEvent(new ui.dom.window.Event('change'));await new Promise(resolve=>setImmediate(resolve));
    assert.ok(ui.root.querySelector('.batch-meta')!.textContent!.includes(current.id));assert.equal(current.phase,'running');
  }finally{ui.dispose();}
});

test('stopping archives unresolved rows, clears their editor once and leaves a new draft available',()=>{
  const ui=fixture({verifyHistory:async()=>{}});
  try{
    const old=batch();old.phase='paused';
    old.tasks[0].status='uncertain';old.tasks[0].intentAt=new Date().toISOString();
    old.tasks[1].status='created-unverified';old.tasks[1].intentAt=new Date().toISOString();
    old.tasks[1].actual={unitId:'ca-app-pub-1234567890123456/1234567891',verified:false};
    ui.handle.update({batch:old});
    assert.equal(ui.handle.getConfig().rows.length,2);
    assert.match(ui.root.textContent!,/还有 2 条提交结果或配置待核验/);
    old.stopRequestedAt=new Date().toISOString();ui.handle.update({batch:old});
    assert.equal(ui.button('继续').disabled,true);
    assert.equal(ui.button('继续').title,'');
    assert.doesNotMatch(ui.root.textContent!,/核验通过后再继续/);
    old.phase='done';old.completedAt=new Date().toISOString();
    const proof=structuredClone(old);
    ui.handle.update({batch:old});
    assert.match(ui.root.querySelector('.batch-meta')!.textContent!,/已停止/);
    assert.doesNotMatch(ui.root.querySelector('.batch-meta')!.textContent!,/已结束/);
    assert.equal(ui.handle.getConfig().rows.length,0,'stopped rows are not offered for another create');
    assert.equal(ui.root.querySelectorAll('.result-table tbody tr').length,2);
    assert.match(ui.root.querySelector('.result-table')!.textContent!,/1234567891/);
    assert.equal(ui.button('继续').disabled,true);assert.equal(ui.button('重试明确失败项').disabled,true);
    assert.equal(ui.button('核验结果不确定项').disabled,false);
    ui.rows([['A','60']]);
    assert.equal(ui.button('开始创建').disabled,false,'a deliberately entered duplicate name is still a new request');
    ui.handle.update({batch:old,history:[summarizeBatch(old)],historyBatch:structuredClone(old)});
    assert.deepEqual(ui.handle.getConfig().rows.map(row=>[row.name,row.floor]),[['A','60']],'repeated archive notifications do not clear a separate draft');
    assert.deepEqual(old,proof,'UI retirement preserves the original IDs, status and intent');
  }finally{ui.dispose();}
});

test('a refreshed stopped batch leaves a blank editor without erasing an independently entered draft',()=>{
  for(const draftFirst of [false,true]){
    const ui=fixture();
    try{
      const old=batch();old.phase='done';old.stopRequestedAt=new Date().toISOString();old.tasks[0].status='uncertain';old.tasks[0].intentAt=new Date().toISOString();
      if(draftFirst)ui.rows([['Separate draft','90']]);
      ui.handle.update({batch:old});
      assert.equal(ui.handle.getConfig().rows.length,draftFirst?1:0);
      if(!draftFirst)ui.rows([['Separate draft','90']]);
      ui.handle.update({batch:structuredClone(old),history:[summarizeBatch(old)]});
      assert.deepEqual(ui.handle.getConfig().rows.map(row=>row.name),['Separate draft']);
      assert.equal(ui.button('开始创建').disabled,false);
    }finally{ui.dispose();}
  }
});

test('stopped history verification and observed IDs use archive-scoped APIs while a new batch stays untouched',async()=>{
  const old=batch();old.phase='done';old.stopRequestedAt=new Date().toISOString();
  old.tasks[0].status='created-unverified';old.tasks[0].intentAt=new Date().toISOString();old.tasks[0].actual={unitId:'ca-app-pub-1234567890123456/1234567890',verified:false};
  old.tasks[1].status='uncertain';old.tasks[1].intentAt=new Date().toISOString();
  const current=batch();current.phase='done';current.tasks[0].name='New batch result';
  const proof=structuredClone(current),calls:unknown[]=[];
  const ui=fixture({
    viewHistory:async id=>ui.handle.update({historyBatch:id?old:undefined}),
    verify:async()=>{calls.push('wrong-active-verify');},recordObservedId:async()=>{calls.push('wrong-active-record');},
    verifyHistory:async id=>{calls.push(['verify',id]);},
    recordHistoryObservedId:async(id,taskId,unitId)=>{calls.push(['record',id,taskId,unitId]);},
    export:async(filter,id)=>{calls.push(['export',filter,id]);},copy:async id=>{calls.push(['copy',id]);},
  });
  try{
    ui.handle.update({batch:current,history:[summarizeBatch(old)]});ui.rows([['Fresh draft','80']]);
    const choose=ui.root.querySelector<HTMLSelectElement>('[aria-label="任务批次"]')!;
    choose.value=old.id;choose.dispatchEvent(new ui.dom.window.Event('change'));await new Promise(resolve=>setImmediate(resolve));
    assert.match(ui.root.querySelector('.batch-meta')!.textContent!,/已停止/);
    for(const text of ['开始创建','继续','重试明确失败项','停止','降级为单页'])assert.equal(ui.button(text).disabled,true,text);
    assert.equal(ui.button('核验结果不确定项').disabled,false);
    ui.root.querySelector<HTMLButtonElement>('[data-action="verify"]')!.click();await new Promise(resolve=>setImmediate(resolve));
    const id=ui.root.querySelector<HTMLInputElement>('input[placeholder="成功说明中的广告位 ID"]')!;
    const record=ui.root.querySelector<HTMLButtonElement>('[data-action="record-observed-id"]')!;
    assert.ok(id);assert.equal(record.dataset.batchId,old.id);assert.equal(record.dataset.taskId,old.tasks[1].id);
    id.value='ca-app-pub-9999999999999999/1234567890';id.dispatchEvent(new ui.dom.window.Event('input'));assert.equal(record.disabled,true);
    id.value='ca-app-pub-1234567890123456/1234567891';id.dispatchEvent(new ui.dom.window.Event('input'));assert.equal(record.disabled,false);
    record.click();await new Promise(resolve=>setImmediate(resolve));
    ui.button('导出异常').click();await new Promise(resolve=>setImmediate(resolve));
    ui.button('复制“名称 + ID”').click();await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,[['verify',old.id],['record',old.id,old.tasks[1].id,id.value],['export','exceptions',old.id],['copy',old.id]]);
    assert.deepEqual(current,proof);
    assert.equal(old.tasks[0].actual?.unitId,'ca-app-pub-1234567890123456/1234567890');
    choose.value='';choose.dispatchEvent(new ui.dom.window.Event('change'));await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(ui.handle.getConfig().rows.map(row=>row.name),['Fresh draft']);
    assert.equal(ui.button('开始创建').disabled,false);
  }finally{ui.dispose();}
});

test('resume hints are hidden for history and stopped archives, and history cannot verify during active work',async()=>{
  const current=batch();current.phase='paused';current.tasks[0].status='uncertain';current.tasks[0].intentAt=new Date().toISOString();
  const old=batch();old.phase='done';old.stopRequestedAt=new Date().toISOString();old.tasks[0].status='uncertain';old.tasks[0].intentAt=new Date().toISOString();
  const ui=fixture({verifyHistory:async()=>{},viewHistory:async id=>ui.handle.update({historyBatch:id?old:undefined})});
  try{
    ui.handle.update({batch:current,history:[summarizeBatch(old)]});
    assert.match(ui.button('继续').title,/先核验/);
    const choose=ui.root.querySelector<HTMLSelectElement>('[aria-label="任务批次"]')!;
    choose.value=old.id;choose.dispatchEvent(new ui.dom.window.Event('change'));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ui.button('继续').title,'');assert.doesNotMatch(ui.root.textContent!,/核验通过后再继续/);
    current.phase='running';ui.handle.update({batch:current});assert.equal(ui.button('核验结果不确定项').disabled,true);
    choose.value='';choose.dispatchEvent(new ui.dom.window.Event('change'));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ui.button('继续').title,'');
  }finally{ui.dispose();}
});
test('执行页链接在等待连接时可打开，完成后清除且拒绝外部或非执行页地址', () => {
  const ui=fixture();
  try{
    const link=ui.root.querySelector<HTMLAnchorElement>('a[data-action=open-worker]')!;
    assert.equal(link.hidden,true);
    const url='https://admob.google.com/v2/apps/1234567890/adunits/list?__admob_batch_worker=12345678-1234-1234-1234-123456789abc';
    ui.handle.update({busy:true,workerUrl:url});
    assert.equal(link.hidden,false);assert.equal(link.href,url);assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener');
    for(const bad of ['javascript:alert(1)','https://example.com/?__admob_batch_worker=12345678-1234-1234-1234-123456789abc','https://admob.google.com/v2/apps/1234567890/adunits/list']){
      ui.handle.update({workerUrl:bad});assert.equal(link.hidden,true);assert.equal(link.hasAttribute('href'),false);
    }
    ui.handle.update({workerUrl:url});ui.handle.update({workerUrl:''});
    assert.equal(link.hidden,true);assert.equal(link.hasAttribute('href'),false);
  }finally{ui.dispose();}
});
function batch(): Batch {
  const created = createBatch(parseInput('广告位名称,底价USD\nA,60\nB,40'), identity, 'interstitial', 2, 'tabs', 'https://apps.admob.com/', 'controller-test');
  created.confirmedAt = new Date().toISOString(); return created;
}

test('补录成功说明 ID 仅针对暂停的已提交不确定行，并交给原核验流程', async () => {
  const calls: string[][]=[];
  const ui=fixture({recordObservedId:async(taskId,unitId)=>{calls.push([taskId,unitId]);}});
  try {
    const b=batch();b.phase='paused';const task=b.tasks[0];task.status='uncertain';task.intentAt=new Date().toISOString();
    ui.handle.update({batch:b});
    const id=ui.root.querySelector<HTMLInputElement>('input[placeholder="成功说明中的广告位 ID"]')!;
    const record=ui.root.querySelector<HTMLButtonElement>('button[data-action=record-observed-id]')!;
    assert.ok(id);assert.equal(record.disabled,true);
    id.value='ca-app-pub-9999999999999999/1234567890';id.dispatchEvent(new ui.dom.window.Event('input'));assert.equal(record.disabled,true);
    id.value='ca-app-pub-1234567890123456/1234567890';id.dispatchEvent(new ui.dom.window.Event('input'));assert.equal(record.disabled,false);
    record.click();await Promise.resolve();assert.deepEqual(calls,[[task.id,id.value]]);
    task.actual={unitId:id.value,verified:false};ui.handle.update({batch:b});
    assert.equal(ui.root.querySelector('button[data-action=record-observed-id]'),null);
  } finally {ui.dispose();}
});

test('新增行保留名称字面值、原行号及每行独立底价', () => {
  const ui = fixture();
  try {
    ui.rows([['A,B','60'],['C  D','40']]);
    assert.deepEqual(ui.handle.getConfig().rows.map(row => [row.line, row.name, row.floor]), [[1, 'A,B', '60'], [2, 'C  D', '40']]);
    assert.equal(ui.handle.getConfig().execution, 'paged');
    assert.equal(ui.handle.getConfig().concurrency, 1);
  } finally { ui.dispose(); }
});

test('行内编辑不打断焦点，未通过校验的清单不能打开预览', () => {
  const ui = fixture();
  try {
    ui.rows([['A','60'],['B','40']]);
    assert.equal(ui.button('开始创建').disabled, false);
    ui.handle.update({ ready: true, checks: [{ label: '预检通过', ok: true }] });
    assert.equal(ui.button('开始创建').disabled, false);
    const name = ui.root.querySelector<HTMLInputElement>('.input-table input')!;
    name.focus(); name.value = 'A edited'; name.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    assert.equal(ui.button('开始创建').disabled, false);
    assert.equal(ui.root.activeElement, name, '行内修改不重建输入控件或打断焦点');
    ui.handle.update({ identity, notice: '只更新状态' });
    assert.equal(ui.root.activeElement, name);
    assert.equal(ui.handle.getConfig().rows[0].name, 'A edited');
    ui.edit('第 1 行底价 USD','bad');
    assert.equal(ui.root.querySelector('button[data-action=preflight]'), null);
    assert.equal(ui.button('开始创建').disabled, true, '无效金额不能进入确认预览');
  } finally { ui.dispose(); }
});

test('手动名称允许重复，空新增行阻止预览且删除后恢复', () => {
  const ui = fixture();
  try {
    ui.rows([['A','60'],['A','40']]);
    assert.ok(ui.handle.getConfig().rows.every(row => row.errors.length === 0));
    assert.equal(ui.button('开始创建').disabled, false);
    ui.button('增加一行').click();
    const rows = ui.handle.getConfig().rows;
    assert.equal(rows.length, 3); assert.equal(rows[1].errors.length, 0); assert.ok(rows[2].errors.length);
    const remove = [...ui.root.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === '删除第 3 行')!;
    remove.click(); assert.equal(ui.button('开始创建').disabled, false);
  } finally { ui.dispose(); }
});

test('活动与暂停批次冻结配置，结束批次可以预检新清单', () => {
  const ui = fixture();
  try {
    ui.rows([['A','60'],['B','40']]);
    ui.handle.update({ ready: true });
    assert.equal(ui.button('开始创建').disabled, false);
    const current = batch(); current.phase = 'running'; ui.handle.update({ batch: current });
    assert.equal(ui.button('暂停').disabled, false);
    assert.equal(ui.button('降级为单页').disabled, false);
    assert.equal(ui.button('继续').disabled, true);
    assert.equal(ui.button('开始创建').disabled, true);
    assert.equal(ui.root.querySelector<HTMLInputElement>('[aria-label="第 1 行广告位名称"]')!.disabled, true);
    assert.equal(ui.prefixSwitch().disabled,true);
    current.phase = 'paused'; ui.handle.update({ batch: current });
    assert.equal(ui.button('暂停').disabled, true);
    assert.equal(ui.button('继续').disabled, false);
    assert.equal(ui.button('降级为单页').disabled, false);
    assert.equal(ui.button('开始创建').disabled, true, '暂停批次使用继续或核验，不覆盖原任务');
    current.phase = 'done'; ui.handle.update({ batch: current });
    assert.equal(ui.root.querySelector<HTMLInputElement>('[aria-label="第 1 行广告位名称"]')!.disabled, false);
    assert.equal(ui.root.querySelector('button[data-action=preflight]'), null);
    assert.equal(ui.button('继续').disabled, true);
    assert.equal(ui.button('降级为单页').disabled, true);
    assert.equal(ui.root.querySelector('[role="dialog"][open]'),null,'结束批次不会自行打开新批预览');
    current.phase = 'paused'; delete current.confirmedAt; ui.handle.update({ batch: current });
    assert.equal(ui.button('继续').disabled, true, '未确认开始的草稿不能通过继续绕过整批确认');
    current.confirmedAt = new Date().toISOString(); current.stopRequestedAt = new Date().toISOString(); ui.handle.update({ batch: current });
    assert.equal(ui.button('继续').disabled, true, '持久化停止意图禁止通过继续重新派发');
  } finally { ui.dispose(); }
});

test('未确认草稿允许停止，并且不会触发开始', async () => {
  let stops = 0, starts = 0;
  const ui = fixture({ stop: async () => { stops++; }, start: async () => { starts++; } });
  try {
    const current = batch(); delete current.confirmedAt; current.phase = 'draft';
    ui.handle.update({ batch: current });
    assert.equal(ui.button('停止').disabled, false);
    assert.equal(ui.button('继续').disabled, true);
    ui.button('停止').click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 1); assert.equal(starts, 0);
  } finally { ui.dispose(); }
});

test('恢复后配置待核验时说明继续阻塞原因，并保留只读预检与核验入口', () => {
  const ui = fixture();
  try {
    const current = batch(); current.phase = 'paused';
    current.tasks[0].status = 'created-unverified';
    current.tasks[0].intentAt = new Date().toISOString();
    current.tasks[0].actual = { unitId: 'ca-app-pub-1234567890123456/1234567890' };
    ui.handle.update({ batch: current, identity });
    assert.equal(ui.button('继续').disabled, true);
    assert.match(ui.button('继续').title, /先核验/);
    assert.match(ui.root.textContent!, /还有 1 条提交结果或配置待核验/);
    assert.equal(ui.button('核验结果不确定项').disabled, false);
    assert.equal(ui.root.querySelector('button[data-action=preflight]'), null);
    assert.equal(ui.button('继续').dataset.action, 'resume');
    current.tasks[0].status = 'success'; ui.handle.update({ batch: current });
    assert.equal(ui.button('继续').disabled, false, '只读核验成功后允许继续，币种仍在真实提交前检查');
  } finally { ui.dispose(); }
});

test('继续回调失败会显示明确错误并恢复按钮，不会静默停留在忙碌状态', async () => {
  const ui = fixture({ resume: async () => { throw new Error('同一发布商账号已有活动主控'); } });
  try {
    const current = batch(); current.phase = 'paused'; ui.handle.update({ batch: current });
    ui.button('继续').click(); await new Promise(resolve => setImmediate(resolve));
    assert.match(ui.root.querySelector('.notice')!.textContent!, /已有活动主控/);
    assert.equal(ui.button('继续').disabled, false);
  } finally { ui.dispose(); }
});

test('恢复后按批次显示 USD，缺少会话币种不会要求单独确认或阻止继续', () => {
  const ui = fixture();
  try {
    const current = batch(); current.phase = 'paused';
    ui.handle.update({ batch: current, identity });
    assert.doesNotMatch(ui.root.querySelector('.identity')!.textContent!, /批次底价币种/);
    assert.equal(ui.root.querySelector('[aria-label="请求底价币种"]'), null);
    assert.doesNotMatch(ui.root.textContent!, /尚未在真实底价字段确认|创建前必须重新确认/);
    assert.equal(ui.button('继续').disabled, false);
    assert.equal(ui.root.querySelector('[role="dialog"][open]'),null,'恢复不会自行打开新批创建预览');
  } finally { ui.dispose(); }
});

test('五行恢复批次通过稳定 action 继续，点击普通金额输入不触发恢复', async () => {
  let resumes = 0;
  const ui = fixture({ resume: async () => { resumes++; } });
  try {
    const current = createBatch(parseInput('A,100\nB,200\nC,300\nD,400\nE,500'), identity, 'interstitial', 1, 'single', 'https://apps.admob.com/', 'controller-test');
    current.phase = 'paused'; current.confirmedAt = new Date().toISOString();
    ui.handle.update({ batch: current });
    const oldTarget = ui.root.querySelector<HTMLInputElement>('[aria-label="第 5 行底价 USD"]')!;
    assert.equal(oldTarget.getAttribute('aria-label'), '第 5 行底价 USD');
    assert.notEqual(oldTarget, ui.button('继续'));
    oldTarget.click(); await new Promise(resolve => setImmediate(resolve)); assert.equal(resumes, 0);
    ui.root.querySelector<HTMLButtonElement>('button[data-action="resume"]')!.click();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(resumes, 1);
  } finally { ui.dispose(); }
});

test('执行日志显示中文步骤、批次累计耗时与本行间隔，保留原因并隐藏凭证', () => {
  const ui = fixture();
  try {
    const current = batch(); current.createdAt = '2026-11-12T00:00:00.000Z';
    current.tasks[0].logs = [
      { at: '2026-11-12T00:00:01.000Z', step: 'filling', message: '开始填表' },
      { at: '2026-11-12T00:00:02.250Z', step: 'submitting', message: '提交意图已保存' },
      { at: '2026-11-12T00:00:03.500Z', step: 'uncertain', message: '保存配置未确认 token=secret-token password="secret password" Bearer secret-bearer Cookie: sid=secret-cookie; session=secret-session' },
      { at: '时间无效', step: 'failed', message: '时间无法解释' },
    ];
    ui.handle.update({ batch: current });
    const log = ui.root.querySelector('.log')!.textContent!;
    assert.match(log, /填表中 · 累计耗时 1\.000 秒 \/ 本行上步间隔 1\.000 秒/);
    assert.match(log, /提交中 · 累计耗时 2\.250 秒 \/ 本行上步间隔 1\.250 秒/);
    assert.match(log, /结果不确定/); assert.match(log, /保存配置未确认/);
    assert.match(log, /累计耗时 未知 \/ 本行上步间隔 未知/);
    assert.doesNotMatch(log, /filling|submitting|NaN|secret-token|secret password|secret-bearer|secret-cookie|secret-session/);
    assert.match(log, /凭证已隐藏/);
  } finally { ui.dispose(); }
});

test('重试仅开放无提交意图的明确失败项，配置待核验项进入核验', () => {
  const ui = fixture();
  try {
    const current = batch(); current.phase = 'paused'; current.tasks[0].status = 'failed';
    ui.handle.update({ batch: current }); assert.equal(ui.button('重试明确失败项').disabled, false);
    current.stopRequestedAt = new Date().toISOString(); ui.handle.update({ batch: current });
    assert.equal(ui.button('重试明确失败项').disabled, true, '停止意图保留后只能核验，不重新派发旧任务');
    assert.equal(ui.button('继续').disabled, true, '重试操作真正执行并清理停止意图前仍禁止直接继续');
    assert.equal(ui.button('开始创建').disabled, true);
    delete current.stopRequestedAt;
    current.tasks[0].attempts = 3; ui.handle.update({ batch: current });
    assert.equal(ui.button('重试明确失败项').disabled, true, '用尽三次尝试后禁用无效重试');
    current.tasks[0].attempts = 0; current.tasks[0].actual = { unitId: 'ca-app-pub-1234567890123456/1234567890' }; ui.handle.update({ batch: current });
    assert.equal(ui.button('重试明确失败项').disabled, true, '已取得ID不可通过失败状态重新创建');
    delete current.tasks[0].actual;
    current.tasks[0].intentAt = new Date().toISOString(); ui.handle.update({ batch: current });
    assert.equal(ui.button('重试明确失败项').disabled, true);
    current.tasks[0].status = 'created-unverified'; ui.handle.update({ batch: current });
    assert.equal(ui.button('核验结果不确定项').disabled, false);
    assert.equal(ui.button('重试明确失败项').disabled, true);
    current.phase = 'stopping'; ui.handle.update({ batch: current });
    assert.equal(ui.button('核验结果不确定项').disabled, false, '停止后仍可申请核验；运行时继续检查执行页是否已安全结束');
    assert.equal(ui.button('降级为单页').disabled, true);
    current.phase = 'paused'; current.execution = 'single'; ui.handle.update({ batch: current });
    assert.equal(ui.button('降级为单页').disabled, true);
  } finally { ui.dispose(); }
});

test('面板以文本显示结果，折叠、销毁及重复挂载保护有效', () => {
  const ui = fixture();
  try {
    const current = batch(); current.phase = 'done'; current.tasks[0].name = '<img src=x onerror=alert(1)>';
    current.tasks[0].reason = '<script>throw new Error()</script>';
    ui.handle.update({ batch: current, notice: '<b>仅文本</b>' });
    assert.equal(ui.root.querySelector('img,script'), null);
    assert.ok(ui.root.textContent!.includes('<img src=x onerror=alert(1)>'));
    ui.button('收起').click(); assert.equal(ui.root.querySelector('.shell')!.classList.contains('collapsed'), true);
    ui.button('展开').click(); assert.equal(ui.root.querySelector('.shell')!.classList.contains('collapsed'), false);
    assert.throws(() => mountPanel({} as PanelActions), /已存在/);
    ui.handle.destroy(); assert.equal(ui.dom.window.document.querySelector('#abc-panel-host'), null);
  } finally { ui.dispose(); }
});

test('开始只打开预览，取消不执行，确认一次才传递隔离的当前配置', async () => {
  const received: PanelConfig[] = []; let preflights = 0;
  const ui = fixture({ preflight: async () => { preflights++; }, start: async config => { received.push(config); } });
  try {
    ui.rows([['A','60'],['B','40']]);ui.button('开始创建').click();
    await new Promise(resolve => setImmediate(resolve));
    const preview=ui.root.querySelector('[role="dialog"]')!;assert.ok(preview);assert.match(preview.textContent!,/创建预览/);
    assert.deepEqual([...preview.querySelectorAll('dt')].map(label=>label.textContent), ['应用', 'AdMob App ID', '发布商 ID']);
    assert.ok(preview.textContent!.includes('A'));assert.ok(preview.textContent!.includes('60'));
    assert.equal(received.length,0);assert.equal(preflights,0);
    ui.root.querySelector<HTMLButtonElement>('[data-action="cancel-preview"]')!.click();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(received.length,0);assert.equal(preflights,0);
    assert.equal(ui.root.querySelector('[role="dialog"][open]'),null);
    ui.button('开始创建').click();await new Promise(resolve=>setImmediate(resolve));
    const confirm=ui.root.querySelector<HTMLButtonElement>('[data-action="confirm-create"]')!;assert.equal(confirm.textContent,'确认创建');confirm.click();confirm.click();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(received.length,1);assert.equal(preflights,0);
    assert.deepEqual(received[0].confirmedIdentity,{publisherId:identity.publisherId,appId:identity.appId});
    assert.deepEqual(received[0].rows.map(row=>[row.name,row.floor]),[['A','60'],['B','40']]);
    assert.equal(received[0].rows[0].floor, '60');
    received[0].rows[0].name = 'mutated'; assert.equal(ui.handle.getConfig().rows[0].name, 'A', '回调配置与面板清单隔离');
  } finally { ui.dispose(); }
});

test('恢复草稿后重新填充编辑器并允许重新预检', () => {
  const ui = fixture();
  try {
    const current = batch(); current.phase = 'draft';
    current.format = 'app-open'; current.execution = 'single'; current.concurrency = 1;
    ui.handle.update({ batch: current });
    assert.deepEqual(ui.handle.getConfig().rows.map(row => [row.name, row.floor]), [['A', '60'], ['B', '40']]);
    assert.equal(ui.handle.getConfig().format, 'app-open');
    assert.equal(ui.handle.getConfig().execution, 'single');
    assert.equal(ui.handle.getConfig().concurrency, 1);
    assert.equal(ui.button('开始创建').disabled, false);
  } finally { ui.dispose(); }
});

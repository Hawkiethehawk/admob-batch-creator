import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AdMobAdapter } from '../src/adapter.ts';

const html=readFileSync(new URL('./fixtures/headingless-create.html',import.meta.url),'utf8');
const route='https://admob.google.com/v2/apps/2222222222/adunits/create';
test('the observed standalone AdMob form is recognized without a shell h1 or h2', () => {
  const dom=new JSDOM(html,{url:route});
  try{
    assert.equal(dom.window.document.querySelector('h1,h2'),null);
    const root=new AdMobAdapter(dom.window.document).activeForm();
    assert.equal(root,dom.window.document.querySelector('format-creator'));
    assert.equal(root?.querySelectorAll('ad-unit-name-card input').length,1);
    assert.equal(root?.querySelector('input')?.value,'');
  }finally{dom.window.close();}
});

test('late shell headings do not change the canonical creator identity', () => {
  const dom=new JSDOM(html,{url:route});
  try{
    const doc=dom.window.document;
    const adapter=new AdMobAdapter(doc);
    const creator=adapter.activeForm();
    for(const tag of ['h1','h2']){
      const heading=doc.createElement(tag);heading.textContent='创建广告单元';
      doc.body.prepend(heading);
      assert.equal(adapter.activeForm(),creator);
      heading.remove();
      assert.equal(adapter.activeForm(),creator);
    }
    const main=doc.createElement('main');doc.body.append(main);
    main.append(doc.querySelector('format-creator')!);
    main.insertAdjacentHTML('afterbegin','<h1>创建广告单元</h1>');
    assert.equal(adapter.activeForm(),creator);
  }finally{dom.window.close();}
});

test('a shell heading cannot bypass canonical creator structure validation', () => {
  for(const variant of ['missing-name','missing-submit','unknown-format','duplicate'] as const){
    const dom=new JSDOM(html,{url:route});
    try{
      const doc=dom.window.document;
      doc.body.insertAdjacentHTML('afterbegin','<h1>创建广告单元</h1>');
      if(variant==='missing-name')doc.querySelector('ad-unit-name-card')!.remove();
      if(variant==='missing-submit')doc.querySelector('material-button.btn-yes')!.remove();
      if(variant==='unknown-format')doc.querySelector('div.format-label')!.textContent='未知';
      if(variant==='duplicate')doc.body.append(doc.querySelector('format-creator')!.cloneNode(true));
      const adapter=new AdMobAdapter(doc);
      if(variant==='duplicate')assert.throws(()=>adapter.activeForm(),/不唯一/);
      else assert.equal(adapter.activeForm(),undefined);
    }finally{dom.window.close();}
  }
});

test('a heading arriving during preparation does not prevent the first guarded submit', async () => {
  const dom=new JSDOM(html,{url:route});
  try{
    const doc=dom.window.document;
    const identity={publisherId:'pub-1111111111111111',appId:'ca-app-pub-1111111111111111~2222222222',appName:'测试应用',evidence:[]};
    doc.body.insertAdjacentHTML('afterbegin','<nav><span class="primary-label unlinked-primary-text">测试应用</span></nav>');
    dom.window.sessionStorage.setItem('abc:live-identity:2222222222',JSON.stringify(identity));
    const creator=doc.querySelector('format-creator')!;
    doc.querySelector('ad-unit-form')!.insertAdjacentHTML('beforeend',
      '<material-radio role="radio" aria-checked="true">人工指定底价</material-radio>'+
      '<manual-ecpm-floor-input><div class="global-ecpm-input-label" id="test-floor-label">输入全球有效每千次展示费用底价</div>'+
      '<material-input type="money64"><span class="leading-text">US$</span><label><input aria-labelledby="test-floor-label" aria-invalid="false"></label></material-input></manual-ecpm-floor-input>');
    const advanced=doc.querySelector('.advanced-settings-toggle')!;
    advanced.addEventListener('click',()=>advanced.setAttribute('aria-expanded','true'));
    const name=doc.querySelector('ad-unit-name-card input') as HTMLInputElement;
    name.addEventListener('input',()=>{
      doc.querySelector('.counter')!.textContent=name.value.length+'/80';
      if(!doc.querySelector('h1'))doc.body.insertAdjacentHTML('afterbegin','<h1>创建广告单元</h1>');
    });
    const button=doc.querySelector('material-button.btn-yes')!;
    button.removeAttribute('disabled');button.classList.remove('is-disabled');button.setAttribute('aria-disabled','false');
    let clicks=0;button.addEventListener('click',()=>{clicks++;});
    const adapter=new AdMobAdapter(doc,1000);
    await adapter.prepare(identity,'interstitial','admob_int_900','900',async()=>{});
    assert.ok(doc.querySelector('h1'),'the shell heading arrived while filling');
    assert.equal(adapter.prepared?.form,creator);
    assert.equal(adapter.activeForm(),creator);
    assert.equal(clicks,0);
    await adapter.submit();
    assert.equal(clicks,1);
    await assert.rejects(adapter.submit(),/已经执行过提交/);
    assert.equal(clicks,1);
  }finally{dom.window.close();}
});

test('legacy titled forms without a creator retain their observed root', () => {
  const dom=new JSDOM('<main><h1>创建广告单元</h1><input></main>',{url:route});
  try{assert.equal(new AdMobAdapter(dom.window.document).activeForm(),dom.window.document.querySelector('main'));}
  finally{dom.window.close();}
});
test('saved routes, incomplete forms and competing creators cannot supply a create form', () => {
  for(const variant of ['saved','missing-name','missing-submit','unknown-format','duplicate'] as const){
    const dom=new JSDOM(html,{url:variant==='saved'?route.replace('create','3333333333/edit'):route});
    try{
      const doc=dom.window.document;
      if(variant==='missing-name')doc.querySelector('ad-unit-name-card')!.remove();
      if(variant==='missing-submit')doc.querySelector('material-button.btn-yes')!.remove();
      if(variant==='unknown-format')doc.querySelector('div.format-label')!.textContent='未知';
      if(variant==='duplicate')doc.body.append(doc.querySelector('format-creator')!.cloneNode(true));
      const adapter=new AdMobAdapter(doc);
      if(variant==='duplicate')assert.throws(()=>adapter.activeForm(),/不唯一/);
      else assert.equal(adapter.activeForm(),undefined);
    }finally{dom.window.close();}
  }
});

test('returning from a standalone page waits for the list grid after its route changes', {timeout:1000}, async t => {
  t.mock.timers.enable({apis:['setInterval','setTimeout']});
  const dom=new JSDOM('<main></main>',{url:route});
  try {
    const view=dom.window;
    t.mock.method(view.history,'back',()=>{
      view.history.replaceState({},'',route.replace('create','list'));
      view.setTimeout(()=>{view.document.querySelector('main')!.innerHTML='<div role="grid" aria-label="广告单元"></div>';},6000);
    });
    const waiting=new AdMobAdapter(view.document).home();
    t.mock.timers.tick(6200);await waiting;
    assert.ok(view.document.querySelector('[role=grid]'));
  }finally{dom.window.close();}
});

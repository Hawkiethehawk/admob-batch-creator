import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const header=`// ==UserScript==
// @name         AdMob Batch Creator
// @namespace    local.admob-batch-creator
// @version      ${pkg.version}
// @description  中文 AdMob 广告单元批量创建、手动 USD 底价、核验与导出；未知页面阻止提交
// @match        https://apps.admob.com/*
// @run-at       document-idle
// @noframes
// @sandbox      DOM
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @grant        GM_getTab
// @grant        GM_saveTab
// ==/UserScript==`;
await mkdir('dist',{recursive:true});
const result=await build({entryPoints:['src/main.ts'],bundle:true,write:false,format:'iife',target:['chrome109','edge109'],charset:'utf8',legalComments:'none'});
await writeFile('dist/admob-batch-creator.user.js',header+'\n\n'+result.outputFiles[0].text,'utf8');
console.log('Built dist/admob-batch-creator.user.js ('+result.outputFiles[0].contents.length+' bytes, no runtime dependencies)');

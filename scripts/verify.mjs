import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const commands=[
  ['node_modules/typescript/bin/tsc','--noEmit'],
  ['--test','tests/*.test.ts'],
  ['scripts/build.mjs'],
  ['--check','dist/admob-batch-creator.user.js'],
];
let log='Verification at '+new Date().toISOString()+'\nNode '+process.version+'\n';
for(const args of commands){
  const run=spawnSync(process.execPath,args,{encoding:'utf8'});
  const output=(run.stdout || '')+(run.stderr || '');
  log+='\n$ node '+args.join(' ')+'\n'+output+'\nExit: '+run.status+'\n';
  process.stdout.write(output);
  if(run.status!==0){await writeFile('docs/test-results.txt',log,'utf8');process.exit(run.status||1);}
}
await writeFile('docs/test-results.txt',log,'utf8');
console.log('Typecheck, logic/DOM/runtime tests, build and syntax check passed.');

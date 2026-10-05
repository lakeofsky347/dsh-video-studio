import {mkdirSync,symlinkSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const reference=process.env.DSH_REFERENCE_PLUGIN??'/Users/skylake/Work/Projects/dsh-梅花易数';
const runtime=resolve(reference,'.local/runtime/node_modules');
const dependencies=['tsdown','tsx','typescript','@types/node','@types/react','@types/react-dom','react','react-dom'];
for(const name of dependencies){const out=resolve(root,'node_modules',name);mkdirSync(dirname(out),{recursive:true});if(!existsSync(out))symlinkSync(resolve(reference,'node_modules',name),out,'dir');}
for(const name of Object.keys(JSON.parse(execFileSync('node',['-p',`JSON.stringify(require(${JSON.stringify(resolve(root,'package.json'))}).peerDependencies)`],{encoding:'utf8'})))){
  const out=resolve(root,'node_modules',name);mkdirSync(dirname(out),{recursive:true});if(!existsSync(out))symlinkSync(resolve(runtime,name),out,'dir');
}
const pw=resolve(root,'node_modules/playwright-core');if(!existsSync(pw))symlinkSync(resolve(root,'../../node_modules/playwright-core'),pw,'dir');
mkdirSync(resolve(root,'node_modules/@comfyorg/litegraph'),{recursive:true});
execFileSync('tar',['-xzf',resolve(root,'.local/vendor/comfyorg-litegraph-0.17.2.tgz'),'--strip-components=1','-C',resolve(root,'node_modules/@comfyorg/litegraph')]);
mkdirSync(resolve(root,'node_modules/.bin'),{recursive:true});
for(const [name,file] of [['tsc','typescript/bin/tsc'],['tsx','tsx/dist/cli.mjs']]){const out=resolve(root,'node_modules/.bin',name);if(!existsSync(out))symlinkSync(resolve(root,'node_modules',file),out);}
mkdirSync(resolve(root,'licenses'),{recursive:true});copyFileSync(resolve(root,'node_modules/@comfyorg/litegraph/LICENSE'),resolve(root,'licenses/LiteGraph-MIT.txt'));
console.log('Local development tools linked. Reference repositories were not modified.');

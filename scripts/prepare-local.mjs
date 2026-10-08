import {copyFileSync,existsSync,mkdirSync,readFileSync,realpathSync,statSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import {ensureDirectoryLink,linkHostDependencies} from './dev-environment.mjs';

const root=path.resolve(import.meta.dirname,'..');
if(!process.env.DSH_REFERENCE_PLUGIN)throw new Error('Set DSH_REFERENCE_PLUGIN to a prepared reference plugin directory to reuse its dependencies. For a clean setup, run npm ci --legacy-peer-deps --ignore-scripts and node scripts/link-host-dependencies.mjs <official-host/node_modules>. See README development steps.');
const reference=path.resolve(process.env.DSH_REFERENCE_PLUGIN);
const runtime=path.resolve(process.env.DSH_HOST_NODE_MODULES??path.join(reference,'.local/runtime/node_modules'));
const manifest=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
const dependencies=[...Object.keys(manifest.devDependencies),...Object.keys(manifest.dependencies)].map(name=>({name,target:path.join(reference,'node_modules',name),link:path.join(root,'node_modules',name)}));
// Validate sources before mutating the plugin; missing sources must never become dangling links.
for(const {name,target} of dependencies){if(!existsSync(target)||!statSync(target).isDirectory())throw new Error(`Missing reference dependency ${name}: ${target}. Use the standard npm setup in README instead.`);}
if(!existsSync(runtime))throw new Error(`DSH host dependencies are missing: ${runtime}. Set DSH_HOST_NODE_MODULES to the official host node_modules directory.`);
const binNames=['tsc','tsx'];
for(const name of binNames){const source=path.join(reference,'node_modules/.bin',name+(process.platform==='win32'?'.cmd':''));if(!existsSync(source))throw new Error(`Missing reference tool launcher: ${source}`);}
linkHostDependencies(root,runtime);
for(const {target,link} of dependencies){if(!existsSync(link))ensureDirectoryLink(target,link);}
mkdirSync(path.join(root,'node_modules/.bin'),{recursive:true});
for(const name of binNames){
  const file=name+(process.platform==='win32'?'.cmd':'');
  const source=path.join(reference,'node_modules/.bin',file),out=path.join(root,'node_modules/.bin',file);
  if(!existsSync(out)){if(process.platform==='win32')copyFileSync(source,out);else symlinkSync(realpathSync(source),out);}
}
mkdirSync(path.join(root,'licenses'),{recursive:true});
copyFileSync(path.join(root,'node_modules/@comfyorg/litegraph/LICENSE'),path.join(root,'licenses/LiteGraph-MIT.txt'));
console.log('Local dependencies linked from the explicit reference and DSH host. Source repositories were not modified.');

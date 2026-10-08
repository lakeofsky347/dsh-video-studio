import path from 'node:path';
import {linkHostDependencies} from './dev-environment.mjs';

const host=process.argv[2]??process.env.DSH_HOST_NODE_MODULES;
if(!host)throw new Error('Specify the official DSH host node_modules directory: node scripts/link-host-dependencies.mjs <host/node_modules>. Run npm ci --legacy-peer-deps --ignore-scripts in the plugin first.');
const root=path.resolve(import.meta.dirname,'..');
const count=linkHostDependencies(root,path.resolve(host));
console.log(`Linked ${count} DSH host peer dependencies. The plugin dependency declarations and lockfile were not changed.`);

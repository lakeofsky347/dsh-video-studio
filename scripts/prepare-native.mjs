// Prepare an owned native acceptance copy. This script never launches Electron.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, realpath, lstat, cp, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const archive=process.argv[2]&&path.resolve(process.argv[2]);
if(!archive)throw new Error('Usage: node scripts/prepare-native.mjs /absolute/path/dsh-video-studio-VERSION.tgz');
const sessionFixture=process.env.DSH_SESSION_FIXTURE==='1';
const provider=sessionFixture?'video-studio-session-offline':'video-studio-offline',model=sessionFixture?'offline-session-video':'offline-video';
const sourceApp=path.resolve(process.env.DSH_NATIVE_SOURCE_APP??'/Applications/DeepSeek Harness.app');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const archiveHash=sha(await readFile(archive));
const root=path.join(repo,'.local','native',archiveHash.slice(0,12));
const app=path.join(root,'视频工作台原生验收.app');
const dshHome=path.join(root,'home'),userData=path.join(root,'user-data'),logs=path.join(root,'logs');
const documents=path.join(root,'documents'),projects=path.join(root,'video-projects');
const profile=path.join(dshHome,'profiles','desktop'),installed=path.join(profile,'node_modules','dsh-video-studio');
const packageArchive=path.join(root,path.basename(archive));
const bundleId=`com.local.dsh.video-studio.acceptance-${archiveHash.slice(0,12)}`;

function run(command,args){
  const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:16*1024*1024});
  if(result.status!==0)throw new Error(`${command}: ${result.stderr||result.stdout||result.error?.message}`);
  return result.stdout;
}
async function walk(directory,prefix=''){
  const rows=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const relative=prefix?prefix+'/'+entry.name:entry.name;
    if(entry.isDirectory())rows.push(...await walk(path.join(directory,entry.name),relative));
    else if(entry.isFile()){const bytes=await readFile(path.join(directory,entry.name));rows.push({path:relative,bytes:bytes.length,sha256:sha(bytes)});}
    else throw new Error(`Installed package must contain real files, not symlinks: ${relative}`);
  }
  return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
function parseAsar(bytes){
  const headerSize=bytes.readUInt32LE(4),jsonSize=bytes.readUInt32LE(12);
  const json=bytes.subarray(16,16+jsonSize);
  return {header:JSON.parse(json.toString()),json,data:bytes.subarray(8+headerSize)};
}
function asarEntry(header,relative){let value=header;for(const part of relative.split('/'))value=value.files?.[part];if(!value||value.unpacked||value.link)throw new Error(`Missing packed ASAR entry: ${relative}`);return value;}
function entryBytes(parsed,relative){const entry=asarEntry(parsed.header,relative);return parsed.data.subarray(Number(entry.offset),Number(entry.offset)+entry.size);}
function replaceExactly(text,from,to,label){if(text.split(from).length!==2)throw new Error(`Native source changed: expected exactly one ${label}`);return text.replace(from,to);}
function appendAsar(original,replacements){
  const parsed=parseAsar(original),additions=[];let offset=parsed.data.length;
  for(const [relative,body] of replacements){
    const entry=asarEntry(parsed.header,relative),bytes=Buffer.from(body),blocks=[];
    for(let at=0;at<bytes.length;at+=4194304)blocks.push(sha(bytes.subarray(at,at+4194304)));
    Object.assign(entry,{offset:String(offset),size:bytes.length,integrity:{algorithm:'SHA256',hash:sha(bytes),blockSize:4194304,blocks}});
    additions.push(bytes);offset+=bytes.length;
  }
  const json=Buffer.from(JSON.stringify(parsed.header)),padded=Math.ceil((4+json.length)/4)*4,prefix=Buffer.alloc(12+padded);
  prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(4+padded,4);prefix.writeUInt32LE(padded,8);prefix.writeUInt32LE(json.length,12);json.copy(prefix,16);
  return Buffer.concat([prefix,parsed.data,...additions]);
}
function compareOtherEntries(before,after,excluded){
  let packed=0,unpacked=0;
  const walk=(a,b,prefix='')=>{
    for(const [name,entry] of Object.entries(a.files)){
      const relative=prefix?prefix+'/'+name:name,other=b.files[name];if(!other)throw new Error(`Missing ASAR entry ${relative}`);
      if(entry.files){walk(entry,other,relative);continue;}
      if(excluded.has(relative))continue;
      if(entry.unpacked||entry.link){if(JSON.stringify(entry)!==JSON.stringify(other))throw new Error(`ASAR descriptor changed ${relative}`);unpacked++;}
      else {if(!entryBytes(before,relative).equals(entryBytes(after,relative)))throw new Error(`Unrelated native code changed ${relative}`);packed++;}
    }
  };
  walk(before.header,after.header);return {packed,unpacked};
}
const entries=run('/usr/bin/tar',['-tzf',archive]).trim().split('\n');
if(!entries.length||entries.some(entry=>!entry.startsWith('package/')||entry.split('/').includes('..')||entry.startsWith('/')))throw new Error('Unsafe package archive');
if(run('/usr/bin/tar',['-tvzf',archive]).split('\n').filter(Boolean).some(line=>!['-','d'].includes(line[0])))throw new Error('Archive links/special files are not accepted');
try{await lstat(root);throw new Error(`Native preparation directory already exists; inspect its prepared.json instead of overwriting: ${root}`);}catch(error){if(error.code!=='ENOENT')throw error;}
for(const directory of [root,userData,path.join(userData,'session'),logs,documents,projects,installed])await mkdir(directory,{recursive:true});
await copyFile(archive,packageArchive);
run('/usr/bin/tar',['-xzf',packageArchive,'--strip-components=1','-C',installed]);
const manifest=JSON.parse(await readFile(path.join(installed,'package.json'),'utf8'));
if(manifest.name!=='dsh-video-studio')throw new Error('Expected a dsh-video-studio package');
const installedFiles=await walk(installed);
for(const file of installedFiles){
  const extracted=spawnSync('/usr/bin/tar',['-xOzf',packageArchive,'package/'+file.path],{encoding:null,maxBuffer:64*1024*1024});
  if(extracted.status!==0||sha(extracted.stdout)!==file.sha256)throw new Error(`Installed bytes differ from package: ${file.path}`);
}
// playwright-core is the host's declared external dependency. Materialize its
// published local installation as real files; the plugin itself remains exactly the tgz bytes.
const dependency=await realpath(path.join(repo,'node_modules','playwright-core'));
const dependencyManifest=JSON.parse(await readFile(path.join(dependency,'package.json'),'utf8'));
if(dependencyManifest.version!==manifest.dependencies?.['playwright-core'])throw new Error('Local playwright-core version does not match the package');
await cp(dependency,path.join(profile,'node_modules','playwright-core'),{recursive:true,dereference:true});
const fixture=path.join(profile,'offline-provider.mjs');await copyFile(path.join(repo,'tests','fixtures',sessionFixture?'session-provider.mjs':'preview-provider.mjs'),fixture);
await copyFile(path.join(repo,'tests','fixtures','fixture-response.mjs'),path.join(profile,'fixture-response.mjs'));
await writeFile(path.join(profile,'package.json'),JSON.stringify({name:'dsh-video-studio-native-acceptance',private:true,
  dependencies:{'dsh-video-studio':`file:${packageArchive}`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-video-studio']}}},null,2)+'\n');
await writeFile(path.join(profile,'cordis.yml'),'[]\n');
await writeFile(path.join(profile,'pnpm-workspace.yaml'),'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
await writeFile(path.join(profile,'cordis.patch.yml'),`# Owned native acceptance. Simulated model only; no real provider credentials.\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n- id: llm-pi-ai\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${model}\n- insert:\n    - id: ${provider}\n      name: ${JSON.stringify(fixture)}\n- id: video-studio\n  config:\n    baseDirectory: ${JSON.stringify(projects)}\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n- id: ui-settings-account\n  config:\n    version: 1\n    step: done\n    usage: detailed\n    developerTools: true\n    purpose: null\n    process: standard\n    completion: api-key\n- id: ui-theme\n  config:\n    preference: light\n- id: deepseek-account\n  config:\n    desktopPlatform: null\n    platformOrigin: http://127.0.0.1:9\n    inferenceOrigin: http://127.0.0.1:9\n    allowLoopbackHttp: true\n    requestTimeoutMs: 250\n    balanceTimeoutMs: 250\n    logoutMaxRetries: 0\n- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(documents)}\n`);
let cloned=false;
try{run('/bin/cp',['-cR',sourceApp,app]);cloned=true;}catch{await rm(app,{recursive:true,force:true});run('/usr/bin/ditto',[sourceApp,app]);}
const sourceAsar=path.join(sourceApp,'Contents','Resources','app.asar'),targetAsar=path.join(app,'Contents','Resources','app.asar');
const original=await readFile(sourceAsar),before=parseAsar(original),pkg=JSON.parse(entryBytes(before,'package.json'));
const mainEntry=pkg.main.replace(/^\.\//,'');let main=entryBytes(before,mainEntry).toString();
main=replaceExactly(main,'app.setAppLogsPath();',`// Owned acceptance isolation before single-instance ownership.\napp.setPath("userData", process.env.DSH_VIDEO_NATIVE_USER_DATA);\napp.setPath("sessionData", process.env.DSH_VIDEO_NATIVE_USER_DATA + "/session");\napp.setPath("documents", process.env.DSH_VIDEO_NATIVE_DOCUMENTS);\napp.setAppLogsPath(process.env.DSH_VIDEO_NATIVE_LOGS);`,'early native path setup');
main=replaceExactly(main,'app.setAsDefaultProtocolClient("dsh");','void 0; // Disabled only in this owned acceptance copy.','default protocol claim');
main=replaceExactly(main,'\tautomaticCheck();','\t// Automatic updater checks disabled only in this owned acceptance copy.','automatic updater check');
const nextPkg={...pkg,name:`dsh-video-native-${archiveHash.slice(0,12)}`,productName:'视频工作台原生验收'};delete nextPkg.dshMandatoryUpdatePolicy;
const changed=appendAsar(original,[['package.json',JSON.stringify(nextPkg,null,2)+'\n'],[mainEntry,main]]);
const after=parseAsar(changed),unchanged=compareOtherEntries(before,after,new Set(['package.json',mainEntry]));
await writeFile(targetAsar,changed);await rm(path.join(app,'Contents','Resources','app-update.yml'),{force:true});
const info=path.join(app,'Contents','Info.plist');
run('/usr/libexec/PlistBuddy',['-c',`Set :CFBundleIdentifier ${bundleId}`,info]);
// Preserve CFBundleName so Electron finds the shipped native helper binaries.
run('/usr/libexec/PlistBuddy',['-c','Set :CFBundleDisplayName 视频工作台原生验收',info]);
try{run('/usr/libexec/PlistBuddy',['-c','Delete :CFBundleURLTypes',info]);}catch{}
run('/usr/libexec/PlistBuddy',['-c',`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${sha(after.json)}`,info]);
run('/usr/bin/codesign',['--force','--deep','--sign','-','--identifier',bundleId,'--preserve-metadata=entitlements',app]);
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
if(sha(await readFile(sourceAsar))!==sha(original))throw new Error('Formal application bytes changed');
const executable=path.join(app,'Contents','MacOS','DeepSeek Harness');
const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
const launchScript=path.join(root,'launch-native.sh');
await writeFile(launchScript,`#!/bin/zsh\n# Launch only after root-agent authorization. Never starts or quits the formal app.\nexec /usr/bin/env -u ELECTRON_RUN_AS_NODE DSH_HOME=${quote(dshHome)} DSH_VIDEO_NATIVE_USER_DATA=${quote(userData)} DSH_VIDEO_NATIVE_LOGS=${quote(logs)} DSH_VIDEO_NATIVE_DOCUMENTS=${quote(documents)} DSH_VIDEO_PROJECTS=${quote(projects)} ${quote(executable)} ${quote('--user-data-dir='+userData)} ${quote('--log-file='+path.join(logs,'chromium.log'))} "$@"\n`,{mode:0o700});
const prepared={status:'prepared-not-launched',preparedAt:new Date().toISOString(),root,app,executable,bundleId,dshHome,userData,logs,documents,projects,profile,installed,
  installedRealPath:await realpath(installed),archive:{source:archive,copy:packageArchive,sha256:archiveHash},installedFiles,
  nativeProgram:{source:sourceApp,originalAsarSha256:sha(original),copyAsarSha256:sha(changed),modifiedEntries:['package.json',mainEntry],otherEntriesUnchanged:unchanged,apfsClone:cloned,
    isolation:['DSH_HOME','userData','sessionData','logs','documents','plugin project directory','package identity','scheme claim disabled','vendor updater disabled','account origins loopback'],signature:'own-copy ad-hoc deep strict verification passed',formalAppUnchanged:true},
  dependency:{name:dependencyManifest.name,version:dependencyManifest.version,source:dependency,materialized:true},
  mock:{provider,model,fixture,sha256:sha(await readFile(fixture)),realProvidersDisabled:true},launchScript,
  limitation:'Native runtime isolation modifies only the owned acceptance app. This preparation is not a native UI check or a real-provider test.'};
await writeFile(path.join(root,'prepared.json'),JSON.stringify(prepared,null,2)+'\n');
console.log(JSON.stringify({status:prepared.status,root,app,installed,archiveSha256:archiveHash,launchScript},null,2));

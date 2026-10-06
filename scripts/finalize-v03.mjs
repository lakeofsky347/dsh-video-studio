/** Seal already accepted bytes; never builds, packs, installs or calls a provider.
 * Run: node --import tsx scripts/finalize-v03.mjs [candidate.tgz] [prepared.json]
 */
import {readFile,writeFile,mkdir,copyFile,readdir,lstat,cp,rm,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {StudioService} from '../src/host/service.ts';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const artifacts=path.join(repo,'artifacts'),verify=path.resolve(process.env.DSH_V03_VERIFY_DIR??path.join(artifacts,'verification/v0.3'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const writeJson=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+'\n');};
const knownArchives={
  'dsh-video-studio-0.1.0.tgz':'ff9501ea1801b01891171c6ff2e81c00cafbbfe81b836214d74af246a5d5e898',
  'dsh-video-studio-0.2.0.tgz':'81b45f229291ccd4b086b5405b7f1c76e3c6dc4650dda17c53602fd738a43244',
  'dsh-video-studio-source-0.1.0.zip':'1696144fe22c07f0b818fbf2ceccd7ca96e1b5bd2d04c36b33b297de9f2a08eb',
  'dsh-video-studio-source-0.2.0.zip':'25d372119e4e98198ac9250402e2561025c0e284fb6446902f25b77c4ce21ee6',
  'dsh-video-studio-example-30s.zip':'69ceb5df78c2dfa7a5f6e5e0511be15f86a9da0eccdec25ea6522efdc9bef649',
  'dsh-video-studio-example-0.2.0.zip':'973ee3c9d15a624cb823ff3546805d8b175fdb2048e06a1e6c16c5944aff4db7'
};
const reportPaths={ui:'ui/verification.json',native:'native/verification.json',restart:'native/restart.json',nativeSession:'native-session/session-acceptance.json',legacy:'native/legacy-project.json',media:'media/verification.json',cleanup:'cleanup.json'};

function run(command,args,options={}){
  const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:64*1024*1024,...options});
  assert.equal(result.status,0,result.error?.message??String(result.stderr));return result.stdout;
}
async function walk(root,relative=''){
  const files=[];
  for(const name of (await readdir(path.join(root,relative))).sort()){
    const next=path.join(relative,name),stat=await lstat(path.join(root,next));
    assert.ok(!stat.isSymbolicLink(),'Archive source contains a symlink: '+next);
    if(stat.isDirectory())files.push(...await walk(root,next));else {assert.ok(stat.isFile(),'Archive source is not a regular file: '+next);files.push(next);}
  }
  return files;
}
async function legacyCheck(){
  const files=[];
  for(const [name,expected] of Object.entries(knownArchives)){
    const file=path.join(artifacts,name),bytes=await readFile(file);assert.equal(sha(bytes),expected,'Historical deliverable changed: '+name);files.push({path:file,sha256:expected,bytes:bytes.length});
  }
  return files;
}
function suiteSummary(text){
  // Node's default reporter may use an info symbol, '#', or plain summary lines.
  const tail=text.slice(-16000).replaceAll(/\x1b\[[0-9;]*m/g,'');
  const value=name=>Number([...tail.matchAll(new RegExp('(?:^|\\n)\\s*(?:ℹ|#)?\\s*'+name+'\\s+(\\d+)\\b','g'))].at(-1)?.[1]);
  const result={pass:value('pass'),fail:value('fail'),skip:value('skipped'),cancelled:value('cancelled')};
  assert.ok(Number.isSafeInteger(result.pass)&&result.pass>0,'Missing full suite summary');assert.equal(result.fail,0,'Full suite has failures');assert.equal(result.skip,0,'Full suite has skips');assert.equal(result.cancelled,0,'Full suite has cancelled tests');return result;
}
function portableProject(project){
  for(const output of project.outputs??[]){output.path=`exports/${output.id}/video.mp4`;delete output.url;if(output.qa){output.qa.snapshotRoot=`exports/${output.id}/snapshot`;output.qa.logPath=`exports/${output.id}/ffmpeg.log`;}}
  return project;
}
async function stageExample(original,stage,media){
  await walk(original);await cp(original,stage,{recursive:true,dereference:false});
  await writeJson(path.join(stage,'project.json'),portableProject(await json(path.join(stage,'project.json'))));
  // These are full source versions. Adjust only disposable output locations in the copied project records.
  for(const name of await readdir(path.join(stage,'.studio/versions'))){if(!name.endsWith('.json'))continue;const file=path.join(stage,'.studio/versions',name),record=await json(file);portableProject(record.project);await writeJson(file,record);}
  for(const output of (await json(path.join(stage,'project.json'))).outputs){const file=path.join(stage,'exports',output.id,'result.json');await writeJson(file,portableProject({outputs:[await json(file)]}).outputs[0]);}
  await mkdir(path.join(stage,'verification'),{recursive:true});
  for(const name of ['frozen-project.json','frozen-sources.json','old-media.json','new-media.json','verification.json','visual-review.json'])await copyFile(path.join(verify,'media',name),path.join(stage,'verification',name));
  await cp(path.join(verify,'media/frames'),path.join(stage,'verification/frames'),{recursive:true});
  await writeFile(path.join(stage,'README-示例.md'),'# 映流 0.3 可继续编辑的版本示例\n\n解压后在映流工作台打开本目录。请连同隐藏的 .studio 目录一起搬运；它保存完整源码版本、revision 索引与任务记录。当前工程是一镜头，保留旧版双镜头和新版单镜头两部 2 秒成片。\n\n受控前端源码、已有真实图片与本地正弦验收音用于检查版本、保存和渲染链路；不是模型创作质量或配音供应商展示。图片的原来源记录保留在 assets/sources.json。素材与成片均在项目目录内，输出路径采用相对路径；原始验收记录留在 verification 下。\n');
  const project=await json(path.join(stage,'project.json'));assert.equal(project.outputs.length,media.media.length);assert.ok((await walk(stage)).some(file=>file.startsWith('.studio/versions/')));
  for(const output of project.outputs){assert.ok(!path.isAbsolute(output.path));const expected=media.media.find(item=>item.sha256===shaFromOutput(media,output.id));assert.ok(expected,'Missing matching media record '+output.id);assert.equal(sha(await readFile(path.join(stage,output.path))),expected.sha256);}
}
function shaFromOutput(media,id){
  for(const check of media.checks??[]){const evidence=check.evidence??{};if(evidence.oldOutputId===id)return media.media[0]?.sha256;if(evidence.newOutputId===id)return media.media[1]?.sha256;}
  throw new Error('Media acceptance lacks the output id '+id);
}
async function verifyRelocation(root,base,media){
  let calls=0;const context={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){calls++;throw new Error('Archive readback does not call model APIs');}}};
  const service=new StudioService(context,{baseDirectory:base,restoreRecent:false});
  try{
    const opened=await service.rpc('open',{path:root});assert.equal(opened.ok,true,opened.ok?'':opened.error.message);const snapshot=await service.snapshot();assert.equal(snapshot.project.id,media.projectId);assert.equal(snapshot.project.outputs.length,2);
    const frozen=await json(path.join(root,'verification/frozen-project.json')),sources=await json(path.join(root,'verification/frozen-sources.json'));
    for(const shot of frozen.shots)assert.deepEqual(await service.store.readSource(root,shot,frozen.revision),sources[shot.id]);
    for(const shot of snapshot.project.shots)assert.ok((await service.store.readSource(root,shot)).js.includes('NEW-C'));
    const history=await service.store.history(root);assert.ok(history.entries.length>=3);const tasks=await service.rpc('tasks');assert.equal(tasks.ok,true);assert.ok(tasks.value.tasks.some(task=>task.kind==='export'&&task.status==='complete'));
    const outputs=[];
    for(const output of snapshot.project.outputs){assert.ok(output.path.startsWith(root+path.sep),'Output still points at the original machine');assert.equal(sha(await readFile(output.path)),shaFromOutput(media,output.id));const response=await fetch(output.url,{headers:{Range:'bytes=0-63'}});assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,64);outputs.push({id:output.id,revision:output.revision,relativePath:path.relative(root,output.path),sha256:shaFromOutput(media,output.id),rangeStatus:206});}
    assert.equal(calls,0);return {status:'PASS',currentRevision:snapshot.project.revision,pinnedRevision:frozen.revision,historicalSourceCount:frozen.shots.length,historyEntries:history.entries.length,completedExportTasks:tasks.value.tasks.filter(task=>task.kind==='export'&&task.status==='complete').length,outputs,modelInvocations:0,resourcesClosed:true};
  }finally{await service.dispose();}
}
const zipPython=String.raw`import sys,json,pathlib,zipfile,hashlib
jobs=json.load(sys.stdin);results=[]
for job in jobs:
 root=pathlib.Path(job['root'])
 with zipfile.ZipFile(job['path'],'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
  for name in job['files']:z.write(root/name,job['prefix']+'/'+name)
 with zipfile.ZipFile(job['path']) as z:
  assert z.testzip() is None
  assert sorted(z.namelist())==sorted(job['prefix']+'/'+name for name in job['files'])
  for name in job['files']:assert z.read(job['prefix']+'/'+name)==(root/name).read_bytes(),name
 out=pathlib.Path(job['path']);results.append({'kind':job['kind'],'path':str(out),'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'files':len(job['files']),'readback':'PASS'})
print(json.dumps(results))`;

async function main(){
  if(process.argv.includes('--help')){console.log('node --import tsx scripts/finalize-v03.mjs [candidate.tgz] [prepared.json]\nReports: '+Object.values(reportPaths).concat('tests.tap').map(file=>path.join(verify,file)).join('\n'));return;}
  const legacy=await legacyCheck(),manifest=await json(path.join(repo,'package.json'));assert.equal(manifest.name,'dsh-video-studio');assert.equal(manifest.version,'0.3.0');
  const candidate=path.resolve(process.argv[2]??path.join(artifacts,'candidate/dsh-video-studio-0.3.0.tgz')),candidateBytes=await readFile(candidate),archiveHash=sha(candidateBytes);
  const preparedFile=path.resolve(process.argv[3]??path.join(repo,'.local/native',archiveHash.slice(0,12),'prepared.json')),prepared=await json(preparedFile);assert.equal(prepared.archive.sha256,archiveHash);assert.equal(sha(await readFile(prepared.archive.copy)),archiveHash);
  const records={},data={};for(const [name,file] of Object.entries(reportPaths)){const value=await json(path.join(verify,file));assert.equal(value.status,'PASS',file);if(['ui','native','restart','nativeSession','legacy'].includes(name))assert.equal(value.archiveSha256,archiveHash,file+' uses another package');assert.deepEqual(value.errors??[],[],file+' has browser errors');data[name]=value;records[name]={path:path.join(verify,file),status:value.status,checks:value.checks?.length??0};}
  assert.equal(data.native.realProvider,false);assert.equal(data.nativeSession.realProvider,false);assert.equal(data.media.modelInvocations,0);assert.equal(data.media.resourcesClosed,true);assert.ok(data.restart.checks.some(check=>/both Session project bindings/.test(check.name)),'Missing two-Session restart check');
  const tests=suiteSummary(await readFile(path.join(verify,'tests.tap'),'utf8'));const acceptance=await readFile(path.join(repo,'docs/ACCEPTANCE-v0.3.md'),'utf8');assert.ok(acceptance.includes('不提前宣布原生验收'));
  const packedManifest=JSON.parse(run('/usr/bin/tar',['-xOzf',candidate,'package/package.json']));assert.deepEqual(packedManifest,manifest);
  const entries=run('/usr/bin/tar',['-tzf',candidate]).trim().split('\n');assert.ok(entries.every(entry=>entry.startsWith('package/')&&!entry.split('/').includes('..')));assert.ok(!entries.some(entry=>/^package\/(?:tests|artifacts|\.local)\//.test(entry)),'Acceptance fixtures leaked into install package');
  const installed=[];for(const file of prepared.installedFiles){const physical=await readFile(path.join(prepared.installed,file.path));assert.equal(sha(physical),file.sha256,'Installed file changed: '+file.path);assert.equal(physical.length,file.bytes);const archived=run('/usr/bin/tar',['-xOzf',candidate,'package/'+file.path],{encoding:null});assert.equal(sha(archived),file.sha256,'Installed package differs: '+file.path);if(!file.path.startsWith('node_modules/'))assert.equal(sha(await readFile(path.join(repo,file.path))),file.sha256,'Current production differs: '+file.path);installed.push(file);}
  assert.deepEqual((await walk(prepared.installed)).sort(),installed.map(file=>file.path).sort(),'Installation contains unrecorded files');
  const formalHash=sha(await readFile(path.join(prepared.nativeProgram.source,'Contents/Resources/app.asar')));assert.equal(formalHash,prepared.nativeProgram.originalAsarSha256,'Formal DSH app changed');
  assert.equal(prepared.mock.realProvidersDisabled,true);assert.equal(sha(await readFile(prepared.mock.fixture)),prepared.mock.sha256,'Native fixture changed since preparation');
  for(const item of data.media.media)assert.equal(sha(await readFile(item.file)),item.sha256);for(const name of ['old-media.json','new-media.json']){const media=await json(path.join(verify,'media',name));assert.equal(media.fullDecode,'PASS');assert.equal(sha(await readFile(media.file)),media.sha256);}
  const sourceFiles=['package.json','package-lock.json','tsconfig.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','cordis.patch.yml','.gitignore'];for(const folder of ['src','scripts','tests','docs','licenses','types'])for(const file of await walk(path.join(repo,folder)))sourceFiles.push(path.join(folder,file));
  const temporary=await mkdtemp(path.join(os.tmpdir(),'dsh-video-studio-v03-seal-'));let readback;
  const archive=path.join(artifacts,'dsh-video-studio-0.3.0.tgz'),example=path.join(artifacts,'examples/v0.3-revision-project');
  try{
    const stage=path.join(temporary,'v0.3-revision-project');await stageExample(data.media.projectRoot,stage,data.media);
    const stagedFiles=await walk(stage);const jobs=[{kind:'source',root:repo,prefix:'dsh-video-studio',path:path.join(temporary,'dsh-video-studio-source-0.3.0.zip'),files:sourceFiles.sort()},{kind:'editable-example',root:stage,prefix:'v0.3-revision-project',path:path.join(temporary,'dsh-video-studio-example-0.3.0.zip'),files:stagedFiles}];
    const archives=JSON.parse(run('/usr/bin/python3',['-c',zipPython],{input:JSON.stringify(jobs)}));
    const relocated=path.join(temporary,'relocated');await mkdir(relocated);run('/usr/bin/python3',['-c','import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',jobs[1].path,relocated]);readback=await verifyRelocation(path.join(relocated,'v0.3-revision-project'),path.join(temporary,'readback-index'),data.media);
    await legacyCheck();await mkdir(artifacts,{recursive:true});
    try{assert.equal(sha(await readFile(archive)),archiveHash,'Another 0.3 final package already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
    await copyFile(candidate,archive);assert.equal(sha(await readFile(archive)),archiveHash);
    await mkdir(path.dirname(example),{recursive:true});try{await lstat(example);throw new Error('Example already exists; inspect it before sealing again: '+example);}catch(error){if(error.code!=='ENOENT')throw error;}
    await cp(stage,example,{recursive:true,dereference:false});
    for(const item of archives){const destination=path.join(artifacts,path.basename(item.path));await copyFile(item.path,destination);assert.equal(sha(await readFile(destination)),item.sha256);item.path=destination;}
    await legacyCheck();
    const integrity={status:'PASS',archive:{path:archive,sha256:archiveHash,bytes:candidateBytes.length},installedRoot:prepared.installed,physicalFilesCompared:installed.length,productionFilesMatchCurrentBuild:true,formalAppAsarUnchanged:true,formalAppAsarSha256:formalHash,testFixture:{path:prepared.mock.fixture,sha256AtSealing:sha(await readFile(prepared.mock.fixture)),excludedFromRelease:true},files:installed};
    await copyFile(preparedFile,path.join(verify,'native/installation-prepared.json'));await writeJson(path.join(verify,'native/installation-integrity.json'),integrity);await writeJson(path.join(verify,'example-readback.json'),{...readback,root:example,zipReadback:'PASS'});await writeJson(path.join(verify,'archives.json'),{status:'PASS',archives});
    const summary={status:'DELIVERED_WITH_NATIVE_OFFLINE_SESSION_AND_ACTUAL_MEDIA_VALIDATION',recordedAt:new Date().toISOString(),plugin:manifest.name,version:manifest.version,archive:integrity.archive,sourceRoot:repo,exampleProject:example,archives,validation:{unitTests:tests,...records,physicalPackageFiles:installed.length,exampleReadback:'PASS'},media:data.media.media,realChatModel:{status:'NOT_CHECKED',reason:'Official agent loop uses explicit offline fixtures; no real cloud provider invocation.'},externalTts:{status:'NOT_CHECKED',reason:'Version snapshot sample uses local synthetic acceptance audio.'},fullHumanFilmReview:{status:'NOT_CHECKED',reason:'Keyframes, decode and playback checks do not establish whole-film human watching or listening.'},formalUserProfileInstallation:{status:'NOT_PERFORMED'},formalApplication:{modified:false,asarSha256:formalHash},legacyDeliverablesPreserved:{status:'PASS',files:legacy},cleanupRecord:records.cleanup.path,sealingResourcesClosed:true};
    await writeJson(path.join(verify,'delivery.json'),summary);await writeFile(path.join(artifacts,'dsh-video-studio-0.3.0.sha256'),archiveHash+'  dsh-video-studio-0.3.0.tgz\n');
    await writeFile(path.join(verify,'acceptance.md'),`# 映流 0.3 最终交付验收\n\n状态：${summary.status}\n\n- 最终安装包：${archive}\n- SHA-256：${archiveHash}\n- 完整回归：${tests.pass} PASS，${tests.fail} FAIL，${tests.skip} SKIP。\n- 实体安装与当前生产文件：${installed.length} 项一致；正式 DSH ASAR 未改变。\n- 官方 Web、原生工作台、原生 Session、重启与本地媒体验收：全部所需报告 PASS。\n- 示例 ZIP：完整 .studio、历史源码、任务与两部 MP4 临时解压后读取通过；输出 Range 206。\n- 0.1/0.2 的六项历史档案：执行前后 SHA-256 未改变。\n\n模型响应为离线 fixture；版本样例声音为本地正弦验收音。真实云端聊天模型、外部配音供应商、真人全片观看/听音和正式用户 profile 安装均不在本轮完成声明中。详细记录见 delivery.json、archives.json、example-readback.json 与 native/installation-integrity.json。\n`);
    console.log(JSON.stringify({archive:summary.archive,archives,tests,physicalFiles:installed.length,exampleReadback:readback.status,legacy:'PASS'},null,2));
  }finally{await rm(temporary,{recursive:true,force:true});}
}
await main();

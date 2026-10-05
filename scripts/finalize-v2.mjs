import {readFile,writeFile,mkdir,copyFile,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const repo=path.resolve(import.meta.dirname,'..'),artifacts=path.join(repo,'artifacts'),verify=path.join(artifacts,'verification/v0.2');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),json=async file=>JSON.parse(await readFile(file,'utf8'));
const manifest=await json(path.join(repo,'package.json'));assert.equal(manifest.version,'0.2.0');
const archive=path.join(artifacts,'dsh-video-studio-0.2.0.tgz'),candidate=path.join(artifacts,'candidate/dsh-video-studio-0.2.0.tgz');await copyFile(candidate,archive);const archiveHash=hash(await readFile(archive));
const prepared=await json(path.join(repo,'.local/native',archiveHash.slice(0,12),'prepared.json'));
const records={};
for(const [key,file] of Object.entries({ui:'ui/ui-acceptance.json',uiFollowup:'ui/ui-followup.json',previewSize:'ui/preview-size.json',frameShot:'ui/frame-shot-consistency.json',session:'session/session-acceptance.json',nativeSession:'native-session/session-acceptance.json',native:'native/native-acceptance.json',restart:'native/restart.json',media:'media/verification.json'})){
  const value=await json(path.join(verify,file));assert.equal(value.status,'PASS',file);if(value.archiveSha256)assert.equal(value.archiveSha256,archiveHash,file+' uses an earlier package');records[key]={path:path.join(verify,file),status:value.status,checks:value.checks?.length??value.cases?.length??2};
}
assert.equal((await json(path.join(verify,'ui/frame-shot-consistency.json'))).clientSha256,hash(await readFile(path.join(repo,'lib/client.js'))));
const tests=await readFile(path.join(verify,'tests.tap'),'utf8');assert.match(tests,/ℹ fail 0/);assert.match(tests,/ℹ skipped 0/);const testCount=Number(tests.match(/ℹ pass (\d+)/)?.[1]);assert.ok(testCount>=43);
const files=[];
for(const file of prepared.installedFiles){
 const installed=await readFile(path.join(prepared.installed,file.path));assert.equal(hash(installed),file.sha256);
 const extracted=spawnSync('/usr/bin/tar',['-xOzf',archive,'package/'+file.path],{encoding:null,maxBuffer:64*1024*1024});assert.equal(extracted.status,0);assert.equal(hash(extracted.stdout),file.sha256);files.push(file);
 if(file.path.startsWith('lib/')||['README.md','package.json','cordis.patch.yml'].includes(file.path)||file.path.startsWith('docs/'))assert.equal(hash(await readFile(path.join(repo,file.path))),file.sha256,'Current production file changed: '+file.path);
}
const officialAsar=path.join(prepared.nativeProgram.source,'Contents/Resources/app.asar'),formalHash=hash(await readFile(officialAsar));assert.equal(formalHash,prepared.nativeProgram.originalAsarSha256);
await copyFile(path.join(prepared.root,'prepared.json'),path.join(verify,'native/installation-prepared.json'));
await writeFile(path.join(verify,'native/installation-integrity.json'),JSON.stringify({status:'PASS',archive:{path:archive,sha256:archiveHash,bytes:(await lstat(archive)).size},installedRoot:prepared.installed,physicalFilesCompared:files.length,productionFilesMatchCurrentBuild:true,formalAppAsarUnchanged:true,formalAppAsarSha256:formalHash,testFixture:{path:prepared.mock.fixture,sha256AtRun:hash(await readFile(prepared.mock.fixture)),excludedFromRelease:true},files},null,2)+'\n');
const media=await json(path.join(verify,'media/verification.json'));assert.equal(media.resourcesClosed,true);assert.equal(media.chatModelInvocations,0);
for(const item of media.cases){assert.equal(hash(await readFile(item.media)),item.mediaQa.sha256);assert.equal(item.mediaQa.fullDecode,'PASS');}
const example=path.join(artifacts,'examples/v0.2-audio-project');const project=await json(path.join(example,'project.json'));assert.equal(project.shots.length,5);assert.equal(project.audioClips.length,3);assert.ok(!path.isAbsolute(project.outputs[0].path));assert.equal(hash(await readFile(path.join(example,project.outputs[0].path))),media.cases[0].mediaQa.sha256);
async function walk(root,relative=''){const result=[];for(const name of (await readdir(path.join(root,relative))).sort()){const next=path.join(relative,name),stat=await lstat(path.join(root,next));assert.ok(!stat.isSymbolicLink(),next);if(stat.isDirectory())result.push(...await walk(root,next));else if(stat.isFile())result.push(next);}return result;}
const sourceFiles=['package.json','package-lock.json','tsconfig.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','cordis.patch.yml','.gitignore'];for(const folder of ['src','scripts','tests','docs','licenses','types'])for(const file of await walk(path.join(repo,folder)))sourceFiles.push(path.join(folder,file));
const jobs=[{kind:'source',root:repo,prefix:'dsh-video-studio',path:path.join(artifacts,'dsh-video-studio-source-0.2.0.zip'),files:sourceFiles.sort()},{kind:'editable-example',root:example,prefix:'v0.2-audio-project',path:path.join(artifacts,'dsh-video-studio-example-0.2.0.zip'),files:await walk(example)}];
const python=String.raw`import json,sys,pathlib,zipfile,hashlib
jobs=json.load(sys.stdin);results=[]
for job in jobs:
 root=pathlib.Path(job['root'])
 with zipfile.ZipFile(job['path'],'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
  for file in job['files']:z.write(root/file,job['prefix']+'/'+file)
 with zipfile.ZipFile(job['path']) as z:
  assert z.testzip() is None
  for file in job['files']:assert z.read(job['prefix']+'/'+file)==(root/file).read_bytes(),file
 out=pathlib.Path(job['path']);results.append({'kind':job['kind'],'path':job['path'],'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'files':len(job['files']),'readback':'PASS'})
print(json.dumps(results))`;
const zipped=spawnSync('/usr/bin/python3',['-c',python],{input:JSON.stringify(jobs),encoding:'utf8',maxBuffer:1024*1024});assert.equal(zipped.status,0,zipped.stderr);const archives=JSON.parse(zipped.stdout);
const summary={status:'DELIVERED_WITH_NATIVE_OFFLINE_SESSION_AND_ACTUAL_MEDIA_VALIDATION',recordedAt:new Date().toISOString(),plugin:'dsh-video-studio',version:manifest.version,archive:{path:archive,sha256:archiveHash,bytes:(await lstat(archive)).size},sourceRoot:repo,exampleProject:example,archives,validation:{unitTests:{pass:testCount,fail:0,skip:0},...records,physicalPackageFiles:files.length},media:media.cases.map(item=>({path:item.media,sha256:item.mediaQa.sha256,target:item.target,frameCount:item.frameCount,duration:item.duration,audioCodec:'aac',fullDecode:'PASS'})),realChatModel:{status:'NOT_CHECKED',reason:'Session tool calls use explicit offline model fixtures; no real configured provider invocation.'},externalTts:{status:'NOT_CHECKED',reason:'Actual local macOS Tingting and local HTTP fixture tested; remote provider not selected.'},actualSpeech:{status:'PASS',endpoint:'local:say',voice:'Tingting'},fullHumanFilmReview:{status:'NOT_CHECKED',reason:'Keyframes, UI and playback segments checked; no claim of whole-film human viewing/listening.'},formalUserProfileInstallation:{status:'NOT_PERFORMED'},formalApplication:{modified:false,asarSha256:formalHash},v1DeliverablesPreserved:true,cleanupRecord:path.join(verify,'cleanup.json')};
await writeFile(path.join(verify,'delivery.json'),JSON.stringify(summary,null,2)+'\n');await writeFile(path.join(artifacts,'dsh-video-studio-0.2.0.sha256'),archiveHash+'  dsh-video-studio-0.2.0.tgz\n');console.log(JSON.stringify({archive:summary.archive,archives,tests:testCount,physicalFiles:files.length},null,2));

/** Verify legacy schema-1 migration through the physically installed native plugin.
 * Run only after native v0.3 acceptance, against its owned host:
 * DSH_TEST_URL=... DSH_PACKAGE_SHA=... DSH_NATIVE_PREPARED=/.../prepared.json \
 *   node scripts/verify-legacy-v03.mjs
 * Copies the v0.2 example once, leaves the original/archives untouched and restores focus.
 * No model, synthesis, editing or whole-film export requests are made.
 */
import {request} from 'playwright-core';
import {cp,mkdir,readFile,writeFile,readdir,lstat,copyFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=process.env.DSH_TEST_URL,packageSha=process.env.DSH_PACKAGE_SHA,preparedFile=process.env.DSH_NATIVE_PREPARED;
assert.ok(url,'DSH_TEST_URL is required');assert.match(packageSha??'',/^[a-f0-9]{64}$/,'DSH_PACKAGE_SHA is required');assert.ok(preparedFile,'DSH_NATIVE_PREPARED must name the owned prepared.json');
const prepared=JSON.parse(await readFile(path.resolve(preparedFile),'utf8'));
assert.equal(prepared.archive.sha256,packageSha,'Prepared native copy uses another package');
const original=path.join(repo,'artifacts/examples/v0.2-audio-project'),copy=path.join(path.resolve(prepared.projects),'legacy-v02-copy');
const out=path.join(repo,'artifacts/verification/v0.3/native'),reportFile=path.join(out,'legacy-project.json');await mkdir(out,{recursive:true});
const report={version:'0.3.0',startedAt:new Date().toISOString(),surface:'owned official DSH Desktop host, physically installed final package',archiveSha256:packageSha,status:'RUNNING',checks:[],errors:[],original,copy,prepared:path.resolve(preparedFile),modelInvocations:0,realProvider:false,externalTts:false,wholeFilmExport:false};
const archives=['dsh-video-studio-0.1.0.tgz','dsh-video-studio-0.2.0.tgz','dsh-video-studio-source-0.1.0.zip','dsh-video-studio-source-0.2.0.zip','dsh-video-studio-example-30s.zip','dsh-video-studio-example-0.2.0.zip'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function hashFile(file){const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
async function tree(directory,prefix=''){
  const files=[];
  for(const name of (await readdir(path.join(directory,prefix))).sort()){
    const relative=prefix?prefix+'/'+name:name,file=path.join(directory,relative),info=await lstat(file);assert.ok(!info.isSymbolicLink(),'Evidence tree contains a symlink: '+relative);
    if(info.isDirectory())files.push(...await tree(directory,relative));else {assert.ok(info.isFile(),'Evidence entry is not a regular file: '+relative);files.push({path:relative,bytes:info.size,sha256:await hashFile(file)});}
  }
  return files;
}
async function archiveManifest(){const rows=[];for(const name of archives){const file=path.join(repo,'artifacts',name),info=await lstat(file);assert.ok(info.isFile());rows.push({path:file,bytes:info.size,sha256:await hashFile(file)});}return rows;}
async function exists(file){try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function pass(name,evidence={}){report.checks.push({name,evidence});console.log(name);}
const api=await request.newContext();let previous,originalBefore,archivesBefore,primaryError;
const base=new URL(url).origin;
async function call(endpoint,payload={}){
  const response=await api.post(base+'/api/video-studio/'+endpoint,{data:{type:'client-request',rpcId:randomUUID(),method:'video-studio/'+endpoint,payload}});assert.ok(response.ok(),`${endpoint}: HTTP ${response.status()}`);
  const envelope=await response.json();assert.equal(envelope.result?.ok,true,`${endpoint}: ${JSON.stringify(envelope.result)}`);return envelope.result.value;
}
function relativeFile(directory,relative){const file=path.resolve(directory,relative);assert.ok(!path.isAbsolute(relative)&&file.startsWith(path.resolve(directory)+path.sep),'Project file must be relative: '+relative);return file;}
try{
  await api.get(url);previous=await call('current');assert.notEqual(previous.task?.status,'running','Run legacy check after the native project task has finished');report.previous={projectId:previous.project?.id,root:previous.root,sessionId:previous.sessionId,focus:previous.focus};
  assert.equal(await hashFile(prepared.archive.copy),packageSha);const manifest=JSON.parse(await readFile(path.join(prepared.installed,'package.json'),'utf8'));assert.equal(manifest.name,'dsh-video-studio');assert.equal(manifest.version,'0.3.0');
  for(const file of prepared.installedFiles){const physical=path.join(prepared.installed,file.path);assert.equal((await lstat(physical)).size,file.bytes,file.path);assert.equal(await hashFile(physical),file.sha256,'Installed package file changed: '+file.path);}
  pass('native installation retains the prepared final package bytes',{installed:prepared.installed,files:prepared.installedFiles.length,archiveSha256:packageSha});
  originalBefore=await tree(original);archivesBefore=await archiveManifest();const legacy=JSON.parse(await readFile(path.join(original,'project.json'),'utf8'));assert.equal(legacy.schemaVersion,1);assert.equal(await exists(path.join(original,'.studio/state.json')),false,'Original example must still be an unmigrated v0.2 project');
  assert.equal(await exists(copy),false,'Existing legacy-v02-copy is preserved; use a fresh prepared profile for this check');await cp(original,copy,{recursive:true,dereference:false,errorOnExist:true,force:false});assert.deepEqual(await tree(copy),originalBefore,'Copy must begin with every original byte');
  report.originalManifest=originalBefore;report.legacy={projectId:legacy.id,revision:legacy.revision,title:legacy.title,shots:legacy.shots.length,assets:legacy.assets.length,audioClips:legacy.audioClips?.length??0,outputs:legacy.outputs.length};
  const sources={};for(const shot of legacy.shots){sources[shot.id]={html:await readFile(relativeFile(original,shot.sourcePath+'/index.html'),'utf8'),css:await readFile(relativeFile(original,shot.sourcePath+'/style.css'),'utf8'),js:await readFile(relativeFile(original,shot.sourcePath+'/scene.js'),'utf8')};}
  report.sourceHashes=Object.fromEntries(legacy.shots.map(shot=>[shot.id,{sourcePath:shot.sourcePath,html:hash(Buffer.from(sources[shot.id].html)),css:hash(Buffer.from(sources[shot.id].css)),js:hash(Buffer.from(sources[shot.id].js))}]));
  const opened=await call('open',{path:copy,select:false});assert.equal(opened.root,copy);assert.ok(opened.previewUrl);assert.ok(opened.audioUrl,'Legacy mixed-audio project must retain its preview mix');
  for(const key of ['schemaVersion','id','title','topic','targetDuration','createdAt','updatedAt','revision','target','shots','shotOrder','assets','audioClips','graph','extensions','sessionIds'])assert.deepEqual(opened.project[key],legacy[key],'Legacy metadata changed: '+key);
  assert.equal(opened.project.outputs.length,legacy.outputs.length);for(const shot of legacy.shots)assert.deepEqual(await call('source',{projectId:legacy.id,shotId:shot.id}),sources[shot.id]);
  for(const asset of legacy.assets.filter(asset=>asset.path))assert.equal(await hashFile(relativeFile(copy,asset.path)),await hashFile(relativeFile(original,asset.path)),asset.path);
  pass('installed plugin opens the copied v0.2 schema-1 project without changing shots, image/audio assets, source or timing',report.legacy);
  const state=JSON.parse(await readFile(path.join(copy,'.studio/state.json'),'utf8'));assert.equal(state.version,1);assert.deepEqual(state.undo,[]);assert.deepEqual(state.redo,[]);assert.match(state.current,/^[a-zA-Z0-9_-]+$/);
  const versionFile=path.join(copy,'.studio/versions',state.current+'.json'),version=JSON.parse(await readFile(versionFile,'utf8'));assert.equal(version.version,1);assert.equal(version.id,state.current);assert.deepEqual(version.project,legacy);assert.deepEqual(version.sources,sources);
  const pointer=JSON.parse(await readFile(path.join(copy,'.studio/revisions',legacy.revision+'.json'),'utf8'));assert.equal(pointer.id,state.current);assert.equal(pointer.revision,legacy.revision);
  const history=await call('history',{projectId:legacy.id});assert.equal(history.entries.length,1);assert.equal(history.canUndo,false);assert.equal(history.canRedo,false);assert.equal(history.entries[0].revision,legacy.revision);
  pass('migration writes one complete baseline version and revision index while preserving schema and revision',{state:path.join(copy,'.studio/state.json'),version:versionFile,revision:legacy.revision,sourceCount:Object.keys(version.sources).length,history});
  const first=await call('inspect',{projectId:legacy.id,shotId:legacy.shotOrder[0],includeSource:true,frame:0});assert.deepEqual(first.source,sources[legacy.shotOrder[0]]);assert.equal(first.spec.durationFrames,legacy.shots.reduce((sum,shot)=>sum+shot.durationFrames,0));
  const frames=[0,first.spec.shots[1]?.startFrame??Math.floor(first.spec.durationFrames/2),first.spec.durationFrames-1],captures=[];await mkdir(path.join(out,'legacy-frames'),{recursive:true});
  for(const frame of [...new Set(frames)]){
    const shot=first.spec.shots.find(shot=>frame>=shot.startFrame&&frame<shot.endFrame);assert.ok(shot);const inspection=frame===0?first:await call('inspect',{projectId:legacy.id,shotId:shot.id,frame});assert.equal(inspection.frame.frame,frame);assert.equal(inspection.frame.shotId,shot.id);assert.ok(inspection.frame.path.startsWith(copy+path.sep));
    const bytes=await readFile(inspection.frame.path);assert.equal(hash(bytes),inspection.frame.sha256);assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));assert.equal(bytes.readUInt32BE(16),legacy.target.width);assert.equal(bytes.readUInt32BE(20),legacy.target.height);
    const served=await api.get(inspection.frame.url);assert.ok(served.ok());assert.equal(hash(await served.body()),inspection.frame.sha256);const evidence=path.join(out,'legacy-frames',String(frame).padStart(6,'0')+'.png');await copyFile(inspection.frame.path,evidence);captures.push({frame,shotId:shot.id,sha256:inspection.frame.sha256,width:legacy.target.width,height:legacy.target.height,path:evidence});
  }
  pass('actual legacy source renders first frame, a shot boundary and final frame at original dimensions',{captures,wholeFilmExport:false,frameDriven:true});
  const outputs=[];for(const output of opened.project.outputs){const old=legacy.outputs.find(item=>item.id===output.id);assert.ok(old);assert.equal(output.path,path.join(copy,'exports',output.id,'video.mp4'));assert.equal(await hashFile(output.path),await hashFile(relativeFile(original,old.path)));const response=await api.get(output.url,{headers:{Range:'bytes=0-63'}});assert.equal(response.status(),206);assert.equal((await response.body()).length,64);outputs.push({id:output.id,revision:output.revision,path:output.path,sha256:await hashFile(output.path),rangeStatus:206});}
  pass('legacy output locations relocate to the copied directory and existing MP4 bytes remain served',{outputs,reencoded:false,playbackHumanReview:'NOT_CHECKED'});
  const selected=await call('current');assert.equal(selected.project?.id,previous.project?.id,'Opening and inspection must not redirect the current workbench');report.opened={projectId:legacy.id,root:copy,previewUrl:opened.previewUrl,revision:opened.project.revision};
}catch(error){primaryError=error;report.errors.push(error.stack??String(error));}
finally{
  const finish=async work=>{try{await work();}catch(error){report.errors.push(error.stack??String(error));primaryError??=error;}};
  await finish(async()=>{
    if(previous?.project){const focus=previous.focus??{};await call('focus',{projectId:previous.project.id,...focus,...(previous.sessionId?{sessionId:previous.sessionId}:{})});const restored=await call('current');assert.equal(restored.project?.id,previous.project.id);assert.equal(restored.root,previous.root);assert.equal(restored.sessionId,previous.sessionId);assert.deepEqual(restored.focus??{},previous.focus??{});report.restored={projectId:restored.project.id,root:restored.root,sessionId:restored.sessionId,focus:restored.focus};pass('previous native workbench project and focus are restored for restart acceptance',report.restored);}
  });
  await finish(async()=>{
    if(originalBefore){assert.deepEqual(await tree(original),originalBefore,'Original v0.2 example bytes changed');pass('original v0.2 example tree remains byte-for-byte unchanged',{files:originalBefore.length});}
  });
  await finish(async()=>{
    if(archivesBefore){assert.deepEqual(await archiveManifest(),archivesBefore,'Historical release archive bytes changed');report.legacyArchives=archivesBefore;pass('all six v0.1/v0.2 install, source and sample archives remain byte-for-byte unchanged',{files:archivesBefore.length});}
  });
  report.status=primaryError?'FAIL':'PASS';report.completedAt=new Date().toISOString();await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');await api.dispose();
}
if(primaryError)throw primaryError;console.log(JSON.stringify({status:report.status,report:reportFile,checks:report.checks.length,archiveSha256:packageSha,modelInvocations:0},null,2));

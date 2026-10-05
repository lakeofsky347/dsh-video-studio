/** End-to-end local acceptance. Run: node --import tsx scripts/verify-flow.mjs
 * Model responses are deterministic fixtures. No formal DSH profile or real provider is touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {StudioService} from '../src/host/service.ts';
import {compileSpec} from '../src/core/index.ts';
import {fixtureResponse,fixtureChunks} from '../tests/fixtures/fixture-response.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outputDirectory=path.join(repo,'artifacts/verification/flow');
const baseDirectory=path.join(repo,'.local/flow-projects');
const fixtureRoot='/Users/skylake/Work/Projects/dsh-梅花易数/src/assets/tarot';
const provider='flow-offline-fixture',model='offline-video';
let delayMs=0,service,projectRoot,lastSnapshot;
const calls=[],steps=[],exports=[];
const report={schemaVersion:1,startedAt:new Date().toISOString(),status:'RUNNING',realProvider:false,
  modelEvidence:'Deterministic offline fixture through the real StudioService RPC handler and DshSceneGenerator. No real model quality or API validation claimed.',
  transport:'StudioService.rpc direct handler',formalDshProfileTouched:false,baseDirectory,outputDirectory,steps,modelCalls:calls,exports};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const stable=value=>JSON.stringify(value);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ctx={llm:{
  listProviders(){return [{id:provider,name:'端到端离线验收 · 模拟模型'}];},
  async listModels(id){assert.equal(id,provider);return [{id:model,name:'固定分镜和场景代码（模拟）',inputModalities:['text']}];},
  async resolveModelInfo(){return {inputModalities:['text']};},
  async *stream(options){
    assert.equal(options.provider,provider);assert.equal(options.model,model);
    const input=JSON.parse(options.messages[0].content.find(block=>block.type==='text').text);
    const response=fixtureResponse(input);calls.push({task:input.task,shotId:input.shot?.id,inputSha256:sha256(stable(input)),responseSha256:sha256(stable(response)),delayMs,realProvider:false});
    yield* fixtureChunks(JSON.stringify(response),{signal:options.signal,delayMs});
  }
}};

await fs.mkdir(outputDirectory,{recursive:true});await fs.mkdir(baseDirectory,{recursive:true});await fs.mkdir(path.join(outputDirectory,'keyframes'),{recursive:true});
async function saveReport(){await fs.writeFile(path.join(outputDirectory,'verification.json'),JSON.stringify(report,null,2)+'\n');}
async function rpc(endpoint,payload={}){
  const result=await service.rpc(endpoint,payload);assert.equal(result.ok,true,result.ok?'':result.error.message);
  if(result.value&&typeof result.value==='object'&&'project' in result.value)lastSnapshot=result.value;
  return result.value;
}
async function task(expected='complete',timeoutMs=600_000){
  const begin=Date.now();let lastProgress=-1,lastLog=0;
  while(Date.now()-begin<timeoutMs){
    const snapshot=await service.snapshot(),state=snapshot.task;lastSnapshot=snapshot;
    if(state?.status!=='running'){
      assert.ok(state,'Task state missing');assert.equal(state.status,expected,JSON.stringify(state));
      return snapshot;
    }
    if(state.progress>=lastProgress+.05||Date.now()-lastLog>15_000){console.log(JSON.stringify({task:state.kind,progress:Number(state.progress.toFixed(3)),message:state.message}));lastProgress=state.progress;lastLog=Date.now();}
    await sleep(180);
  }
  await rpc('cancel');throw new Error('Acceptance task exceeded '+timeoutMs+' ms');
}
async function fingerprints(snapshot=lastSnapshot){
  const shots=[];
  for(const shot of snapshot.project.shots){
    const source=await rpc('source',{shotId:shot.id});
    shots.push({id:shot.id,shotSha256:sha256(stable(shot)),sourceSha256:sha256(stable(source)),sourcePath:shot.sourcePath});
  }
  const assets=[];
  for(const asset of snapshot.project.assets)assets.push({id:asset.id,kind:asset.kind,path:asset.path,sha256:sha256(asset.path?await fs.readFile(path.join(snapshot.root,asset.path)):stable(asset))});
  return {projectId:snapshot.project.id,revision:snapshot.project.revision,root:snapshot.root,shots,assets};
}
async function step(name,run){
  console.log(JSON.stringify({step:name,status:'START'}));const item={name,startedAt:new Date().toISOString(),status:'RUNNING'};steps.push(item);await saveReport();
  try{item.evidence=await run();item.status='PASS';item.finishedAt=new Date().toISOString();await saveReport();console.log(JSON.stringify({step:name,status:'PASS'}));return item.evidence;}
  catch(error){item.status='FAIL';item.error=error.message;item.finishedAt=new Date().toISOString();throw error;}
}
async function snapshotEvidence(name){
  const snapshot=await service.snapshot(),file=path.join(outputDirectory,name+'.json');lastSnapshot=snapshot;
  await fs.writeFile(file,JSON.stringify(snapshot,null,2)+'\n');return {path:file,sha256:sha256(await fs.readFile(file)),revision:snapshot.project.revision};
}
async function liveRange(output,previewUrl){
  assert.equal(new URL(output.url).origin,new URL(previewUrl).origin);
  const response=await fetch(output.url,{headers:{Range:'bytes=0-63'}});assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,64);
  return {observedUrl:output.url,observedStatus:response.status,contentRange:response.headers.get('content-range'),urlState:'live-during-check; server-closed-after-verification'};
}
async function retainExport(output,label){
  const destination=path.join(outputDirectory,label+'.mp4');await fs.copyFile(output.path,destination);
  const keyframes=[];
  for(const frame of output.qa.frames){
    const destination=path.join(outputDirectory,'keyframes',label+'-'+String(frame.frame).padStart(6,'0')+'.png');await fs.copyFile(frame.path,destination);keyframes.push({...frame,path:destination});
  }
  const result={label,id:output.id,path:destination,originalPath:output.path,sha256:sha256(await fs.readFile(destination)),revision:output.revision,
    width:output.width,height:output.height,frameCount:output.frameCount,duration:output.duration,qa:output.qa,keyframes};exports.push(result);return result;
}
function unchangedExcept(before,after,selected){
  for(const original of before.shots.filter(shot=>shot.id!==selected))assert.deepEqual(after.shots.find(shot=>shot.id===original.id),original,'Unselected shot/source changed: '+original.id);
}

try{
  service=new StudioService(ctx,{baseDirectory});
  await step('catalog-and-create',async()=>{
    const catalog=await rpc('catalog');assert.equal(catalog.providers[0].id,provider);
    const created=await rpc('create',{title:'DSH 视频全链路 · 离线素材验收',topic:'仅用于本地验收的图文资产、连线分镜、源码编辑与 MP4 导出'});
    projectRoot=created.root;assert.equal(created.project.shots.length,3);assert.equal(created.project.target.width,1920);assert.equal(created.project.target.height,1080);assert.equal(created.project.target.fps.num,30);
    assert.equal((await fetch(created.previewUrl)).status,200);return {projectRoot,projectId:created.project.id,realProvider:false,environment:created.environment,...await snapshotEvidence('01-created')};
  });
  await step('import-three-images-and-text',async()=>{
    const sources=['major-00.webp','major-10.webp','wands-03.webp'];const items=[];
    for(const name of sources){
      const original=path.join(fixtureRoot,name),bytes=await fs.readFile(original);
      const imported=await rpc('import',{dataBase64:bytes.toString('base64'),mime:'image/webp',name:'本地验收素材 · '+name,description:'现有插件中已有的图像；仅用于插件验收 fixture，不作为用户影片的故事素材。'});
      const asset=imported.project.assets.at(-1);assert.equal(asset.kind,'image');assert.equal(sha256(await fs.readFile(path.join(imported.root,asset.path))),sha256(bytes));
      items.push({id:asset.id,fixtureSource:original,path:asset.path,sha256:sha256(bytes)});
    }
    const imported=await rpc('import',{text:'验收文字：同一资产可复用；镜头链确定顺序；源码可编辑；导出保存制作输入快照。',name:'本地验收说明',description:'独立文本资产'});
    assert.equal(imported.project.assets.length,4);assert.equal(imported.project.assets.filter(asset=>asset.kind==='image').length,3);
    return {assets:items,textAsset:imported.project.assets.at(-1),fingerprints:await fingerprints(imported),...await snapshotEvidence('02-imported')};
  });
  await step('generate-five-shot-storyboard',async()=>{
    await rpc('generate',{kind:'storyboard',provider,model});const generated=await task();assert.equal(generated.project.shots.length,5);
    const spec=compileSpec(generated.project);assert.equal(spec.durationFrames,900);assert.equal(spec.durationSeconds,30);assert.equal(spec.shots.every(shot=>shot.assets.some(asset=>asset.kind==='image')),true);
    return {frameCount:spec.durationFrames,durationSeconds:spec.durationSeconds,shotOrder:generated.project.shotOrder,realProvider:false,...await snapshotEvidence('03-storyboard')};
  });
  await step('generate-all-five-scenes',async()=>{
    const before=await service.snapshot();await rpc('generate',{kind:'scenes',provider,model});const generated=await task();const prints=await fingerprints(generated);
    assert.equal(prints.shots.length,5);assert.ok(generated.project.revision>=before.project.revision+5);assert.notEqual(generated.previewUrl,before.previewUrl);assert.equal(generated.previewRevision,generated.project.revision);
    return {fingerprints:prints,beforeRevision:before.project.revision,generatedRevision:generated.project.revision,previewCacheKeyChanged:true,realProvider:false,...await snapshotEvidence('04-generated-scenes')};
  });
  const selected=(await service.snapshot()).project.shots[2].id;
  await step('modify-only-selected-shot',async()=>{
    const before=await fingerprints(await service.snapshot());await rpc('generate',{kind:'modify',shotId:selected,instruction:'只修改选中镜头的主文案和强调色；保持其他镜头',provider,model});
    const modified=await task(),after=await fingerprints(modified);unchangedExcept(before,after,selected);
    assert.match(modified.project.shots.find(shot=>shot.id===selected).params.text,/已修改/);assert.notEqual(before.shots.find(shot=>shot.id===selected).shotSha256,after.shots.find(shot=>shot.id===selected).shotSha256);
    return {selected,before,after,unselectedPreserved:true,realProvider:false,...await snapshotEvidence('05-modified-selected')};
  });
  await step('modify-all-five-shots-in-a-real-service-loop-with-fixture-responses',async()=>{
    const before=await service.snapshot(),beforePrints=await fingerprints(before),firstCall=calls.length;
    await rpc('generate',{kind:'modify',instruction:'逐镜头修改整片的主文案与强调色，保持顺序、素材、时长和项目规格',provider,model});
    const modified=await task(),after=await fingerprints(modified),wholeFilmCalls=calls.slice(firstCall);
    assert.equal(wholeFilmCalls.length,5);assert.deepEqual(wholeFilmCalls.map(call=>call.shotId),before.project.shotOrder);assert.equal(wholeFilmCalls.every(call=>call.task==='modify-scene'),true);
    assert.deepEqual(modified.project.shotOrder,before.project.shotOrder);assert.equal(compileSpec(modified.project).durationFrames,900);assert.ok(modified.project.revision>=before.project.revision+5);
    for(const shot of modified.project.shots){assert.match(shot.params.text,/已修改/);assert.equal(shot.params.accent,'#f5be79');assert.equal(shot.durationFrames,before.project.shots.find(item=>item.id===shot.id).durationFrames);}
    return {realProvider:false,scope:'The complete five-shot modification loop called the fixture model once for each real service iteration.',calls:wholeFilmCalls,before:beforePrints,after,previewRevision:modified.previewRevision,...await snapshotEvidence('05b-modified-whole-film')};
  });
  await step('manual-source-edit-error-and-restore',async()=>{
    const source=await rpc('source',{shotId:selected}),manual={...source,css:source.css+'\n.orb{border-width:5px}',js:source.js+'\n// manual edit accepted by frame validation'};
    await rpc('saveSource',{shotId:selected,source:manual});const good=await task();const before=await fingerprints(good);
    const bad={...manual,js:'export function render(ctx) { throw new Error("FLOW_ACCEPTANCE_SOURCE_ERROR"); }'};
    await rpc('saveSource',{shotId:selected,source:bad});const failed=await task('failed');assert.match(failed.task.error,/FLOW_ACCEPTANCE_SOURCE_ERROR/);
    await rpc('restoreSource',{shotId:selected});const restored=await rpc('source',{shotId:selected});assert.deepEqual(restored,manual);
    await rpc('preview');const checked=await task(),after=await fingerprints(checked);unchangedExcept(before,after,selected);
    assert.equal(before.shots.find(shot=>shot.id===selected).sourceSha256,after.shots.find(shot=>shot.id===selected).sourceSha256);
    return {selected,failureTask:failed.task,lastGoodSha256:sha256(stable(manual)),restoredSha256:sha256(stable(restored)),before,after,...await snapshotEvidence('06-restored-source')};
  });
  await step('cancel-model-task-and-retry',async()=>{
    const before=await fingerprints(await service.snapshot());delayMs=100;
    await rpc('generate',{kind:'modify',shotId:selected,instruction:'取消验收；不应提交未完成输出',provider,model});await sleep(350);await rpc('cancel');const cancelled=await task('cancelled');
    const afterCancel=await fingerprints(cancelled);assert.deepEqual(afterCancel.shots,before.shots);delayMs=0;
    await rpc('generate',{kind:'modify',shotId:selected,instruction:'重试完成，仍只修改选中镜头',provider,model});const retried=await task(),after=await fingerprints(retried);unchangedExcept(before,after,selected);
    return {selected,cancelled:cancelled.task,before,afterCancel,after,retryStatus:retried.task.status,realProvider:false,...await snapshotEvidence('07-cancel-and-retry')};
  });
  const landscape=await step('export-30-seconds-1080p-900-frames-with-editing-snapshot',async()=>{
    const before=await service.snapshot(),original=structuredClone(before.project),originalRevision=original.revision;
    assert.equal(compileSpec(original).durationFrames,900);await rpc('export');
    // Edit project parameters during capture. The export must retain its earlier independent snapshot.
    let state=await service.snapshot();while(state.task.status==='running'&&state.task.progress<.12){await sleep(200);state=await service.snapshot();}
    assert.equal(state.task.status,'running','Export finished before snapshot edit could be tested');
    const edited=structuredClone(state.project);edited.shots[0].params.subtitle='导出期间保存的编辑；本次输出仍应保持启动时的版本';await rpc('save',{project:edited});
    const complete=await task(),output=complete.project.outputs.at(-1);assert.equal(output.revision,originalRevision);assert.equal(output.width,1920);assert.equal(output.height,1080);assert.equal(output.frameCount,900);assert.equal(output.duration,30);assert.equal(output.qa.fps,'30/1');
    const snapshot=JSON.parse(await fs.readFile(path.join(output.qa.snapshotRoot,'project.json'),'utf8'));
    assert.equal(snapshot.revision,originalRevision);assert.equal(snapshot.shots[0].params.subtitle,original.shots[0].params.subtitle);assert.notEqual(snapshot.shots[0].params.subtitle,complete.project.shots[0].params.subtitle);
    const byFrame=new Map(output.qa.frames.map(frame=>[frame.frame,frame]));const fades=[];
    for(let boundary=180;boundary<900;boundary+=180){assert.equal(byFrame.get(boundary-1).sha256,byFrame.get(boundary).sha256);assert.notEqual(byFrame.get(boundary).sha256,byFrame.get(boundary+89).sha256);fades.push({boundary,lastOutgoing:boundary-1,firstIncoming:boundary,blackSha256:byFrame.get(boundary).sha256,expectedFadeToBlack:true});}
    const retained=await retainExport(output,'landscape-30s-1920x1080-30fps');return {...retained,liveRange:await liveRange(output,complete.previewUrl),exportSnapshotPreserved:true,snapshotRevision:originalRevision,currentRevision:complete.project.revision,boundaryFades:fades,...await snapshotEvidence('08-landscape-export')};
  });
  await step('restart-and-read-back-all-data-and-output',async()=>{
    const before=await fingerprints(await service.snapshot()),beforeId=lastSnapshot.project.id;await service.dispose();service=new StudioService(ctx,{baseDirectory});
    const restarted=await rpc('current');assert.equal(restarted.project.id,beforeId);const opened=await rpc('open',{path:projectRoot}),after=await fingerprints(opened);
    assert.deepEqual(after.shots,before.shots);assert.deepEqual(after.assets,before.assets);
    const output=opened.project.outputs.find(item=>item.id===landscape.id);assert.ok(output);const range=await liveRange(output,opened.previewUrl);
    return {before,after,outputRangeAfterRestart:range,restoredAssetCount:opened.project.assets.length,restoredShotCount:opened.project.shots.length,...await snapshotEvidence('09-restarted')};
  });
  await step('copy-complete-project-open-and-restart-a-broken-graph-with-assets-still-readable',async()=>{
    const original=await service.snapshot(),before=await fingerprints(original),destination=path.join(baseDirectory,'relocated-'+original.project.id);
    await fs.cp(original.root,destination,{recursive:true});const opened=await rpc('open',{path:destination}),afterCopy=await fingerprints(opened);
    assert.equal(opened.root,destination);assert.deepEqual(afterCopy.shots,before.shots);assert.deepEqual(afterCopy.assets,before.assets);
    const copiedOutput=opened.project.outputs.find(output=>output.id===landscape.id);assert.ok(copiedOutput);assert.equal(copiedOutput.path,path.join(destination,'exports',landscape.id,'video.mp4'));
    const copiedOutputRange=await liveRange(copiedOutput,opened.assetBaseUrl),validProject=structuredClone(opened.project),draft=structuredClone(opened.project);
    draft.extensions.graphEdges=[];draft.shotOrder=[];const saved=await rpc('save',{project:draft});assert.equal(saved.previewRevision,null);assert.ok(saved.assetBaseUrl);assert.throws(()=>compileSpec(saved.project));
    async function checkDraftAssets(snapshot){
      const images=[];for(const asset of snapshot.project.assets.filter(item=>item.kind==='image')){
        const url=new URL(asset.path,snapshot.assetBaseUrl).href,response=await fetch(url);assert.equal(response.status,200);
        const bytes=Buffer.from(await response.arrayBuffer()),file=await fs.readFile(path.join(snapshot.root,asset.path));assert.equal(sha256(bytes),sha256(file));images.push({id:asset.id,path:asset.path,observedUrl:url,status:200,sha256:sha256(bytes),urlState:'historical; owned server closed after verification'});
      }return images;
    }
    const beforeRestartImages=await checkDraftAssets(saved);assert.equal((await service.rpc('preview',{})).ok,false);
    await service.dispose();service=new StudioService(ctx,{baseDirectory});const restarted=await rpc('current');assert.equal(restarted.root,destination);assert.deepEqual(restarted.project.extensions.graphEdges,[]);assert.deepEqual(restarted.project.shotOrder,[]);assert.equal(restarted.previewRevision,null);
    const afterRestartImages=await checkDraftAssets(restarted);assert.equal(afterRestartImages.length,3);
    await rpc('save',{project:validProject});const restored=await service.snapshot();assert.equal(compileSpec(restored.project).durationFrames,900);
    return {sourceRoot:original.root,copiedRoot:destination,before,afterCopy,copiedOutputRange,
      draftEvidence:{scope:'A saved graph with zero edges and no shot order is intentionally not renderable. Asset viewing remains available.',graphEdges:[],shotOrder:[],previewRevision:null,beforeRestartImages,afterRestartImages},
      validChainRestored:true,...await snapshotEvidence('09b-relocated-and-restored-draft')};
  });
  await step('export-portrait-2-seconds-1080x1920-60-frames',async()=>{
    const snapshot=await service.snapshot(),portrait=structuredClone(snapshot.project);portrait.title='DSH 视频竖屏 · 离线素材验收';portrait.targetDuration=2;
    portrait.target={width:1080,height:1920,fps:{num:30,den:1},audioMode:'none'};portrait.shots=portrait.shots.slice(0,2);portrait.shotOrder=portrait.shots.map(shot=>shot.id);delete portrait.extensions.graphEdges;
    for(const shot of portrait.shots){shot.durationFrames=30;shot.params.imageX=50;shot.params.imageY=55;shot.params.fontSize=86;}
    await rpc('save',{project:portrait});assert.equal(compileSpec((await service.snapshot()).project).durationFrames,60);
    await rpc('preview');await task();await rpc('export');const complete=await task(),output=complete.project.outputs.at(-1);
    assert.equal(output.width,1080);assert.equal(output.height,1920);assert.equal(output.frameCount,60);assert.equal(output.duration,2);assert.equal(output.qa.fps,'30/1');
    const retained=await retainExport(output,'portrait-2s-1080x1920-30fps');return {...retained,liveRange:await liveRange(output,complete.previewUrl),...await snapshotEvidence('10-portrait-export')};
  });
  await step('final-read-only-media-inspection',async()=>{
    const environment=(await service.snapshot()).environment,qa=[];
    for(const output of exports){
      const {stdout}=await promisify(execFile)(environment.ffprobePath,['-v','error','-count_frames','-show_streams','-show_format','-of','json',output.path],{maxBuffer:5_000_000});const probe=JSON.parse(stdout),video=probe.streams.find(stream=>stream.codec_type==='video');
      assert.equal(Number(video.nb_read_frames),output.frameCount);assert.equal(video.width,output.width);assert.equal(video.height,output.height);assert.equal(video.codec_name,'h264');assert.equal(video.pix_fmt,'yuv420p');assert.equal(probe.streams.filter(stream=>stream.codec_type==='audio').length,0);
      const file=path.join(outputDirectory,output.label+'-ffprobe.json');await fs.writeFile(file,JSON.stringify(probe,null,2)+'\n');qa.push({label:output.label,status:'PASS',path:file,sha256:sha256(await fs.readFile(output.path)),frameCount:Number(video.nb_read_frames),dimensions:[video.width,video.height],fps:video.r_frame_rate,audioStreams:0});
    }
    return {qa,fingerprints:await fingerprints(await service.snapshot()),realProvider:false};
  });
  report.status='PASS';
}catch(error){report.status='FAIL';report.error={message:error.message,stack:error.stack};process.exitCode=1;console.error(error);}
finally{
  if(service)await service.dispose();report.finishedAt=new Date().toISOString();report.ownedServersClosed=true;report.ownedBrowsersClosed=true;report.ownedEncodersClosed=true;
  report.urlState='All recorded loopback URLs are historical observations. Owned servers have been closed; use local media paths.';await saveReport();
  console.log(JSON.stringify({status:report.status,realProvider:false,report:path.join(outputDirectory,'verification.json'),exports:exports.map(output=>({path:output.path,width:output.width,height:output.height,frameCount:output.frameCount,duration:output.duration}))}));
}

/** Run: node --import tsx scripts/verify-media-v2.mjs. Uses local controlled source, not an LLM. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {StudioService} from '../src/host/service.ts';
import {ProjectStore} from '../src/host/store.ts';
import {defaultShot, compileSpec} from '../src/core/index.ts';
import {detectEnvironment} from '../src/host/renderer.ts';

const plugin=path.dirname(path.dirname(fileURLToPath(import.meta.url))),out=path.join(plugin,'artifacts/verification/v0.2/media'),media=path.join(plugin,'artifacts/media/v0.2'),example=path.join(plugin,'artifacts/examples/v0.2-audio-project');
const env=detectEnvironment(),exec=promisify(execFile),services=new Set();let modelCalls=0;
const context={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){modelCalls++;throw new Error('Controlled source media verification must not invoke a chat model');}}};
const report={startedAt:new Date().toISOString(),kind:'controlled-source media and local system speech acceptance',realChatModel:false,externalTts:false,systemTts:{endpoint:'local:say',voice:'Tingting',language:'zh-CN'},syntheticSound:'BGM and SFX are local FFmpeg test tones, not generated music or commercial audio',environment:env,checks:[],cases:[],status:'RUNNING'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function json(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n');}
async function record(name,evidence){report.checks.push({name,status:'PASS',evidence});await json(path.join(out,'verification.json'),report);console.log(name);}
async function rpc(service,endpoint,payload={}){const result=await service.rpc(endpoint,payload);assert.equal(result.ok,true,result.ok?'':result.error.message);return result.value;}
async function settled(service,timeout=600_000){const deadline=Date.now()+timeout;let snapshot=await service.snapshot(),last=-1;while(snapshot.task?.status==='running'&&Date.now()<deadline){const percent=Math.floor(snapshot.task.progress*100/5)*5;if(percent!==last){console.log(snapshot.task.kind+' '+percent+'% '+snapshot.task.message);last=percent;}await new Promise(resolve=>setTimeout(resolve,500));snapshot=await service.snapshot();}assert.equal(snapshot.task?.status,'complete',JSON.stringify(snapshot.task));return snapshot;}
function source(index){return {
  html:'<section class="sample-scene"><div class="sample-copy"><p class="sample-kicker"></p><h1></h1><p class="sample-subtitle"></p></div><p class="sample-foot"></p></section>',
  css:'.sample-scene{position:absolute;inset:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#f4f0e7}.sample-copy{position:absolute;left:8%;top:22%;width:46%}.sample-kicker{font-size:var(--small);letter-spacing:.16em;color:var(--accent);margin:0 0 1.4em}.sample-copy h1{font-size:var(--title);line-height:1.2;letter-spacing:.05em;margin:0 0 .5em;white-space:pre-wrap;overflow-wrap:anywhere}.sample-subtitle{font-size:var(--body);line-height:1.6;white-space:pre-wrap;opacity:.8;max-width:90%}.sample-foot{position:absolute;left:8%;bottom:6%;font-size:var(--small);letter-spacing:.08em;opacity:.6}',
  js:`export function render(ctx){
    const {root,ctx2d:g,width:w,height:h,params:p,progress,time,localFrame}=ctx;
    const portrait=h>=w,u=Math.min(w,h)/1080,enter=ctx.helpers.easeOutCubic(Math.min(1,time/.6));
    root.style.setProperty('--title',(Number(p.fontSize||80)*u)+'px');root.style.setProperty('--body',(30*u)+'px');root.style.setProperty('--small',(20*u)+'px');root.style.setProperty('--accent',p.accent);
    const copy=root.querySelector('.sample-copy');copy.style.top=portrait?'11%':'22%';copy.style.width=portrait?'84%':'46%';copy.style.opacity=String(enter);copy.style.transform='translateY('+((1-enter)*35*u)+'px)';
    root.querySelector('h1').textContent=p.text;root.querySelector('.sample-kicker').textContent='映流 · 镜头 ${String(index+1).padStart(2,'0')}';root.querySelector('.sample-subtitle').textContent=p.subtitle;
    root.querySelector('.sample-foot').textContent='图文资产 / 前端源码 / 本地音画制作';
    const gradient=g.createLinearGradient(0,0,w,h);gradient.addColorStop(0,p.background);gradient.addColorStop(1,'#182c39');g.fillStyle=gradient;g.fillRect(0,0,w,h);
    g.strokeStyle=p.accent;g.globalAlpha=.08;g.lineWidth=Math.max(1,u);for(let i=0;i<14;i++){g.beginPath();const x=w*(i/13)+Math.sin(time*.4+i)*w*.009;g.moveTo(x,0);g.lineTo(x-w*.2,h);g.stroke();}g.globalAlpha=1;
    const assets=ctx.assets.filter(a=>a.kind==='image'&&a.image);const a=assets[${index}%Math.max(1,assets.length)];
    if(a){const centerX=w*(Number(p.imageX)/100),centerY=h*(Number(p.imageY)/100),boxH=h*(portrait?.43:.7)*Number(p.imageScale||1),boxW=w*(portrait?.44:.28)*Number(p.imageScale||1);const scale=Math.min(boxW/a.image.naturalWidth,boxH/a.image.naturalHeight)*(1+.025*Math.sin(progress*Math.PI));const iw=a.image.naturalWidth*scale,ih=a.image.naturalHeight*scale;g.save();g.translate(centerX,centerY);g.rotate(Math.sin(progress*Math.PI)*.018);g.shadowColor='#0007';g.shadowBlur=22*u;g.fillStyle='#e9ddc6';g.fillRect(-iw/2-8*u,-ih/2-8*u,iw+16*u,ih+16*u);g.drawImage(a.image,-iw/2,-ih/2,iw,ih);g.restore();}
    g.fillStyle=p.accent;g.globalAlpha=.8;g.fillRect(w*.08,h*.92,w*.84*progress,Math.max(2,3*u));g.globalAlpha=1;
  }`
};}

async function probeAndDecode(file,target,frames,duration){
  const {stdout}=await exec(env.ffprobePath,['-v','error','-count_frames','-show_entries','stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,duration,start_time,sample_rate,channels:format=duration','-of','json',file],{maxBuffer:1_000_000});
  const info=JSON.parse(stdout),video=info.streams.find(s=>s.codec_type==='video'),audio=info.streams.filter(s=>s.codec_type==='audio');
  assert.equal(video.width,target.width);assert.equal(video.height,target.height);assert.equal(video.nb_read_frames,String(frames));assert.equal(video.r_frame_rate,target.fps.num+'/'+target.fps.den);assert.ok(Math.abs(Number(video.duration)-duration)<.002);assert.equal(audio.length,1);assert.equal(audio[0].codec_name,'aac');assert.equal(audio[0].sample_rate,'48000');assert.equal(audio[0].channels,2);assert.ok(Math.abs(Number(audio[0].start_time))<.025);assert.ok(Math.abs(Number(audio[0].duration)-duration)<.05);
  await exec(env.ffmpegPath,['-v','error','-i',file,'-f','null','-'],{maxBuffer:1_000_000});
  return {...info,fullDecode:'PASS',sha256:hash(await fs.readFile(file)),bytes:(await fs.stat(file)).size};
}
async function buildCase(name,target,frames,withNarration=false){
  const service=new StudioService(context,{baseDirectory:path.join(out,'projects',name),restoreRecent:false});services.add(service);
  const initial=await rpc(service,'create',{title:withNarration?'映流 · 图文与声音示例':name,topic:'受控源码验收：真实图片、可编辑中文分镜、确定性前端动作、系统配音及测试音轨',target,targetDuration:frames*target.fps.den/target.fps.num});
  let project=structuredClone(initial.project);const count=withNarration?5:1,titles=['让想法成为影片','三张图片，一条故事','每个镜头，都可编辑','声音跟随镜头','保存工程，继续制作'],subtitles=['从素材与文字出发，编排清晰的镜头。','图片、文字与参考资料，一起组织叙事。','按参数、自然语言与源码持续打磨。','真实中文系统配音，配合本地测试音轨。','同一运行产物，用于预览与实际 MP4。'];
  project.shots=Array.from({length:count},(_,index)=>{const shot=defaultShot(index,target.fps);shot.durationFrames=withNarration?180:frames;shot.title=titles[index];shot.intent=subtitles[index];shot.composition='中文标题左侧或上方，完整图片右侧或中下方';shot.action='标题按帧平缓进入，图片轻微角度与缩放运动，底部进度线';shot.transition='cut';shot.params={...shot.params,text:titles[index],subtitle:subtitles[index],fontSize:80,background:['#12232c','#1d262b','#24242b','#1e2c32','#152833'][index],accent:['#b9dbb9','#e6cda4','#b9c6e4','#e0bca8','#a7d2cc'][index],imageX:target.height>=target.width?52:75,imageY:target.height>=target.width?60:50,imageScale:1};return shot;});
  project.shotOrder=project.shots.map(s=>s.id);project.extensions={controlledSource:true,externalChatModel:false,lockDuration:withNarration};delete project.extensions.graphEdges;
  await rpc(service,'apply',{shots:project.shots,extensions:project.extensions});
  const oldAssets=path.join(plugin,'artifacts/examples/native-30s-project/assets'),files=(await fs.readdir(oldAssets)).filter(f=>f.endsWith('.webp')).sort();assert.equal(files.length,3);
  for(const file of files)await rpc(service,'import',{path:path.join(oldAssets,file),name:'真实图片 · '+file.slice(0,8),description:'从首版验收工程复制的历史图片；来源记录随样例保留'});
  let snapshot=await service.snapshot();const imageIds=snapshot.project.assets.filter(a=>a.kind==='image').map(a=>a.id);
  await rpc(service,'apply',{shotPatches:snapshot.project.shots.map((shot,index)=>({id:shot.id,patch:{assetIds:imageIds,referenceIds:[],params:{...shot.params,imageX:target.height>=target.width?52:75,imageY:target.height>=target.width?60:50}}})),sources:snapshot.project.shots.map((shot,index)=>({shotId:shot.id,source:source(index)}))});
  const bgm=path.join(out,'fixtures','synthetic-bgm.wav'),sfx=path.join(out,'fixtures','synthetic-sfx.wav');
  await rpc(service,'audio',{action:'import',path:bgm,name:'本地合成测试音轨 · BGM',description:'FFmpeg sine 220/330 Hz 合成的验收测试tone，不是生成音乐',role:'music',startSeconds:0,trimStart:0,trimEnd:2,volume:.18,fadeIn:.3,fadeOut:.3,loop:true});
  await rpc(service,'audio',{action:'import',path:sfx,name:'本地合成测试音效',description:'FFmpeg 880 Hz 短音，供音效定位验收',role:'sfx',startSeconds:withNarration?.2:.15,trimStart:0,trimEnd:.25,volume:.25,fadeIn:.025,fadeOut:.1});
  if(withNarration){snapshot=await service.snapshot();const shotId=snapshot.project.shots[0].id;await rpc(service,'tts',{endpoint:'local:say',model:'system',voice:'Tingting',speed:1,enabled:true});await rpc(service,'audio',{action:'synthesize',shotId,text:'映流，让每个想法成为画面。'});snapshot=await settled(service,30_000);assert.equal(snapshot.project.shots[0].durationFrames,180);assert.equal(snapshot.project.audioClips.filter(c=>c.role==='voice').length,1);await record('real Chinese local system narration fits six-second shot',{asset:snapshot.project.assets.find(a=>a.kind==='audio'&&a.name.includes('配音')),shotId});}
  snapshot=await service.snapshot();assert.equal(compileSpec(snapshot.project).durationFrames,frames);assert.ok(snapshot.audioUrl);
  const keyframes=withNarration?[0,90,179,180,270,449,450,629,630,899]:[0,Math.floor((frames-1)/2),frames-1];const captures=[];
  for(const frame of keyframes){const inspected=await rpc(service,'inspect',{frame});const targetPng=path.join(out,name,'frames',String(frame).padStart(6,'0')+'.png');await fs.mkdir(path.dirname(targetPng),{recursive:true});await fs.copyFile(inspected.frame.path,targetPng);captures.push({...inspected.frame,path:targetPng,url:undefined});}
  await rpc(service,'export');snapshot=await settled(service);const output=snapshot.project.outputs.at(-1);assert.equal(output.frameCount,frames);assert.equal(output.qa.audioStreams,1);
  const delivered=path.join(media,name+'.mp4');await fs.copyFile(output.path,delivered);const checked=await probeAndDecode(delivered,target,frames,frames*target.fps.den/target.fps.num);
  const result={name,target:snapshot.project.target,inputTarget:target,frameCount:frames,duration:frames*target.fps.den/target.fps.num,root:snapshot.root,projectId:snapshot.project.id,revision:snapshot.project.revision,media:delivered,mediaQa:checked,captures,audio:{voice:withNarration,bgm:'synthetic test tone',sfx:'synthetic test tone',plan:output.qa.audioPlan},exportQa:output.qa};
  report.cases.push(result);await json(path.join(out,name,'readback.json'),result);await record(name+' actual AAC MP4 dimensions, rational FPS, frames, duration and full decode',{file:delivered,sha256:checked.sha256,frames,duration:result.duration,target:snapshot.project.target});
  if(withNarration){
    await fs.rm(example,{recursive:true,force:true});await fs.cp(snapshot.root,example,{recursive:true});
    const portable=JSON.parse(await fs.readFile(path.join(example,'project.json'),'utf8'));for(const item of portable.outputs){item.path='exports/'+item.id+'/video.mp4';delete item.url;item.qa={status:'PASS',controlledSource:true,actualSystemSpeech:true,externalChatModel:false,width:item.width,height:item.height,frameCount:item.frameCount,duration:item.duration,audioStreams:1,audioCodec:'aac',fullDecode:'PASS'};}
    await json(path.join(example,'project.json'),portable);await fs.copyFile(path.join(oldAssets,'sources.json'),path.join(example,'assets/sources.json'));
    await fs.writeFile(path.join(example,'README-示例.md'),'# 映流 0.2 图文与声音示例\n\n这是受控源码与媒体链路验收工程，不代表真实聊天模型的创作质量。5 个镜头，每个 6 秒，共 30 秒；1920×1080、30 FPS，H.264 视频与 AAC 音频。\n\n首镜头旁白由本机已安装的 macOS Tingting 中文音色实际合成；BGM 与音效是本地 FFmpeg 正弦测试音，不是生成音乐。三张 WebP 沿用首版验收工程的历史素材，原来源及当时许可声明保存在 assets/sources.json；此次没有重新下载或在线核查。\n\n在工作台使用“打开”，选择解压后的本工程目录。镜头、参数、源码和声音片段均可继续编辑，配音 WAV 已保存在资产中，无需重复调用模型或配音服务。输出路径是项目内相对路径，重新打开时插件会重新生成本地预览 URL。\n');
    const reopened=new StudioService(context,{baseDirectory:path.join(out,'reopen'),restoreRecent:false});services.add(reopened);const opened=await rpc(reopened,'open',{path:example});assert.equal(opened.project.id,portable.id);assert.equal(opened.project.shots.length,5);assert.equal(opened.project.audioClips.length,3);assert.equal((await fetch(opened.audioUrl)).status,200);assert.equal((await fetch(opened.project.outputs[0].url,{headers:{Range:'bytes=0-63'}})).status,206);assert.deepEqual(await fs.readFile(opened.project.outputs[0].path),await fs.readFile(delivered));
    const assetHashes=[];for(const asset of opened.project.assets.filter(a=>a.path)){const bytes=await fs.readFile(path.join(example,asset.path));assetHashes.push({id:asset.id,path:asset.path,sha256:hash(bytes),kind:asset.kind});}
    await record('portable 30-second mixed project reopens with assets, source, audio and playable result',{path:example,projectId:portable.id,assets:assetHashes,relativeOutputPath:portable.outputs[0].path});await reopened.dispose();services.delete(reopened);
  }
  await service.dispose();services.delete(service);return result;
}

try{
  assert.ok(env.browserAvailable&&env.ffmpegAvailable&&env.ffprobeAvailable,'Existing Chromium, FFmpeg and FFprobe are required');await fs.mkdir(out,{recursive:true});await fs.mkdir(media,{recursive:true});await fs.mkdir(path.join(out,'fixtures'),{recursive:true});
  await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=2','-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=2','-filter_complex','[0:a][1:a]amix=inputs=2:normalize=1','-c:a','pcm_s16le',path.join(out,'fixtures/synthetic-bgm.wav')]);
  await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=0.25','-af','afade=t=in:d=0.025,afade=t=out:st=0.15:d=0.1','-c:a','pcm_s16le',path.join(out,'fixtures/synthetic-sfx.wav')]);
  await buildCase('landscape-30s-1920x1080-30fps',{width:1920,height:1080,fps:{num:30,den:1},audioMode:'none',quality:'standard'},900,true);
  await buildCase('portrait-4x5-720x900-24fps',{width:720,height:900,fps:{num:24,den:1},audioMode:'none',quality:'small'},24);
  await buildCase('square-480x480-60000_1001fps',{width:480,height:480,fps:{num:60000,den:1001},audioMode:'none',quality:'high'},60);
  await buildCase('wide-21x9-5040x2160-25fps',{width:5040,height:2160,fps:{num:25,den:1},audioMode:'none',quality:'standard'},25);
  assert.equal(modelCalls,0);report.status='PASS';report.chatModelInvocations=modelCalls;report.completedAt=new Date().toISOString();await json(path.join(out,'verification.json'),report);
}catch(error){report.status='FAIL';report.error=error.stack??String(error);await json(path.join(out,'verification.json'),report);throw error;}
finally{await Promise.allSettled([...services].map(service=>service.dispose()));report.resourcesClosed=true;await json(path.join(out,'verification.json'),report);}

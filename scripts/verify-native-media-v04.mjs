// Play and decode the actual output produced by the offline Session's real render tool.
import {chromium,request} from 'playwright-core';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const url=process.env.DSH_TEST_URL,out=path.resolve(process.env.DSH_V04_REPORT_DIR??'artifacts/verification/v0.4/native');assert.ok(url);await mkdir(out,{recursive:true});
const api=await request.newContext();await api.get(url);const base=new URL(url).origin;
async function call(endpoint,payload={}){const response=await api.post(base+'/api/video-studio/'+endpoint,{data:{type:'client-request',rpcId:randomUUID(),method:'video-studio/'+endpoint,payload}});const value=await response.json();assert.equal(value.result?.ok,true,JSON.stringify(value));return value.result.value;}
const browser=await chromium.connectOverCDP(process.env.DSH_NATIVE_CDP);const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('dsh-app://'));assert.ok(page);
try{
  const library=await call('list'),films=[];for(const item of library.projects){const film=await call('current',{projectId:item.id});if(film.project.outputs.length)films.push(film);}
  assert.ok(films.length);const film=films.at(-1),output=film.project.outputs.at(-1);
  await page.getByText('映流 · 视频工作台',{exact:true}).click();
  await page.getByLabel('搜索影片工程',{exact:true}).fill('');await page.getByLabel('按会话筛选工程',{exact:true}).selectOption('all');
  await page.locator(`[data-project-id="${film.project.id}"]`).getByRole('button',{name:'打开工作台',exact:true}).click();
  await page.getByRole('tab',{name:'历史成片',exact:true}).click();await page.locator(`[data-output-id="${output.id}"]`).getByRole('button',{name:'播放成片',exact:true}).click();
  const video=page.locator('.vs-export-player video');await video.waitFor();await video.evaluate(v=>v.play());await page.waitForTimeout(700);
  const playback=await video.evaluate(v=>({width:v.videoWidth,height:v.videoHeight,duration:v.duration,time:v.currentTime,error:v.error?.message??null}));await video.evaluate(v=>v.pause());
  assert.equal(playback.error,null);assert.ok(playback.time>0);assert.equal(playback.width,output.width);assert.equal(playback.height,output.height);
  const probe=spawnSync('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',output.path],{encoding:'utf8'});assert.equal(probe.status,0,probe.stderr);const metadata=JSON.parse(probe.stdout),stream=metadata.streams.find(s=>s.codec_type==='video');
  assert.equal(stream.codec_name,'h264');assert.equal(Number(stream.nb_read_frames),output.frameCount);
  const decode=spawnSync('ffmpeg',['-v','error','-i',output.path,'-f','null','-'],{encoding:'utf8'});assert.equal(decode.status,0,decode.stderr);
  await page.screenshot({path:path.join(out,'native-playback.png')});
  await writeFile(path.join(out,'media.json'),JSON.stringify({status:'PASS',packageSha256:process.env.DSH_PACKAGE_SHA,realProvider:false,surface:'actual local MP4 + owned DSH Desktop player',checks:[{name:'native history player decodes and advances',playback},{name:'H264 dimensions and exact frame count',width:stream.width,height:stream.height,frames:Number(stream.nb_read_frames)},{name:'full MP4 decode succeeds',outputPath:output.path}],completedAt:new Date().toISOString()},null,2)+'\n');console.log('PASS actual native MP4 playback, frame count and decode');
}finally{await api.dispose();await browser.close();}

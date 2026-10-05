// Native acceptance uses only the owned prepared application and its packaged plugin.
import {chromium,request} from 'playwright-core';
import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const prepared=JSON.parse(await readFile(process.argv[2],'utf8'));
const out=path.resolve('artifacts/verification/v0.2/native');await mkdir(out,{recursive:true});
const restart=process.env.DSH_NATIVE_RESTART==='1',mixed=path.join(prepared.projects,'native-mixed-example');
const browser=await chromium.connectOverCDP(process.env.DSH_NATIVE_CDP||'http://127.0.0.1:19408');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('dsh-app://'));
assert.ok(page,'Owned native app has no webContents');
const report={startedAt:new Date().toISOString(),surface:'owned official DSH Desktop copy, final TGZ physical installation',version:'0.2.0',archiveSha256:prepared.archive.sha256,restart,checks:[],errors:[],realProvider:false,externalTts:false};
page.on('pageerror',e=>report.errors.push(e.message));
function pass(name,evidence={}){report.checks.push({name,evidence});console.log(name);}
async function poll(check){for(let i=0;i<150;i++){const value=await check();if(value)return value;await page.waitForTimeout(100);}throw new Error('Native state did not settle');}
async function open(directory){await page.getByRole('button',{name:'打开',exact:true}).click();await page.getByLabel('打开现有项目目录',{exact:true}).fill(directory);await page.getByRole('button',{name:'打开项目',exact:true}).click();}
async function mediaState(){const video=page.locator('.vs-output-video');await video.waitFor();await poll(()=>video.evaluate(v=>v.readyState>=2));await video.evaluate(v=>v.play());await page.waitForTimeout(700);const state=await video.evaluate(v=>({time:v.currentTime,duration:v.duration,width:v.videoWidth,height:v.videoHeight,muted:v.muted,volume:v.volume,error:v.error?.message??null}));await video.evaluate(v=>v.pause());assert.ok(state.time>0);assert.equal(state.width,1920);assert.equal(state.height,1080);assert.equal(state.duration,30);assert.equal(state.error,null);return state;}
try{
 await page.getByText('映流 · 视频工作台',{exact:true}).click();
 if(!restart){
   await open(path.resolve('artifacts/examples/native-30s-project'));await page.getByRole('heading',{name:'DSH原生全流程验收',exact:true}).waitFor();assert.equal(await page.locator('.vs-shotchip').count(),5);pass('final v0.2 packaged plugin opens the existing v1 image/text silent project');
   await cp(path.resolve('artifacts/examples/v0.2-audio-project'),mixed,{recursive:true});await open(mixed);
 }
 await page.getByRole('heading',{name:'映流 · 图文与声音示例',exact:true}).waitFor();assert.equal(await page.locator('.vs-shotchip').count(),5);
 const project=JSON.parse(await readFile(path.join(mixed,'project.json'),'utf8'));assert.equal(project.audioClips.length,3);assert.equal(project.assets.filter(a=>a.kind==='audio').length,3);assert.equal(project.shots[0].narration,'映流，让每个想法成为画面。');
 pass(restart?'native restart restores mixed project, five shots, real speech and three audio clips':'native opens portable five-shot project with real images, local speech, music and SFX',{projectId:project.id,revision:project.revision});
 await page.getByRole('button',{name:'画布 100%',exact:true}).click();await page.locator('.vs-shotchip').first().click();await page.getByRole('button',{name:'聚焦选中',exact:true}).click();const metrics=await page.locator('.vs-graph-shell canvas').evaluate(c=>({dpr:devicePixelRatio,backing:[c.width,c.height],logical:[c.clientWidth,c.clientHeight],zoom:c.data.ds.scale}));assert.equal(metrics.backing[0],Math.round(metrics.logical[0]*metrics.dpr));assert.equal(metrics.zoom,1);pass('native canvas uses DPR backing pixels and readable 100 percent zoom',metrics);await page.screenshot({path:path.join(out,restart?'restart-workbench.png':'native-readable-canvas.png')});
 if(!restart){
   await page.locator('.vs-shotchip').last().click();await page.getByLabel('屏幕主文字',{exact:true}).fill('原生重启后继续编辑');await poll(async()=>JSON.parse(await readFile(path.join(mixed,'project.json'),'utf8')).shots.at(-1).params.text==='原生重启后继续编辑');
   pass('native manual parameter edit is persisted in the opened mixed project');
 }else assert.equal(project.shots.at(-1).params.text,'原生重启后继续编辑');
 await page.getByRole('tab',{name:'影片预览',exact:true}).click();
 await poll(()=>page.getByRole('button',{name:'播放',exact:true}).isEnabled());await page.getByRole('button',{name:'播放',exact:true}).click();await page.waitForTimeout(600);const audio=await page.locator('.vs-preview audio').evaluate(a=>({time:a.currentTime,paused:a.paused,readyState:a.readyState,duration:a.duration}));assert.ok(audio.time>0);assert.equal(audio.paused,false);await page.getByRole('button',{name:'暂停',exact:true}).click();pass('native actual frontend preview plays with its real mixed audio clock',audio);
 await page.getByLabel('跳转帧',{exact:true}).fill('450');await page.getByRole('button',{name:'定位',exact:true}).click();assert.equal(await page.getByTestId('current-frame').innerText(),'450');
 await poll(async()=>await page.getByTestId('current-shot-heading').getAttribute('data-shot-id')===project.shotOrder[2]);assert.match(await page.getByTestId('current-shot-local-frame').innerText(),/镜头 F90/);pass('native cross-shot frame 450 identifies actual third shot and local frame 90');
 await page.getByRole('button',{name:'播放成片',exact:true}).click();pass('native embedded 30-second AAC MP4 decodes and advances',await mediaState());await page.screenshot({path:path.join(out,restart?'restart-result.png':'native-result-with-audio.png')});
 if(!restart){
   const url=process.env.DSH_TEST_URL;assert.ok(url);const api=await request.newContext();await api.get(url);const base=new URL(url).origin;
   const call=async(endpoint,payload)=>{const response=await api.post(base+'/api/video-studio/'+endpoint,{data:{type:'client-request',rpcId:randomUUID(),method:'video-studio/'+endpoint,payload}});const value=await response.json();assert.equal(value.result.ok,true,JSON.stringify(value.result));return value.result.value;};
   try{let settings=await call('tts',{projectId:project.id,endpoint:'local:say',voice:'Tingting',speed:1,enabled:true,apiKey:'synthetic-native-credential-fixture'});assert.equal(settings.ttsConfigured,true);assert.equal(JSON.stringify(settings).includes('synthetic-native-credential-fixture'),false);settings=await call('tts',{projectId:project.id,apiKey:''});assert.equal(settings.ttsConfigured,false);assert.equal((await readFile(path.join(prepared.projects,'tts.json'),'utf8')).includes('synthetic-native-credential-fixture'),false);pass('actual native DSH credential service stores and clears synthetic TTS key without project/config echo');}finally{await api.dispose();}
 }
 assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;await page.screenshot({path:path.join(out,restart?'restart-failure.png':'failure.png')}).catch(()=>{});throw error;}
finally{report.completedAt=new Date().toISOString();await writeFile(path.join(out,restart?'restart.json':'native-acceptance.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}

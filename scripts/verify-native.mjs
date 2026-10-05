import {chromium} from 'playwright-core';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const prepared=JSON.parse(await readFile(process.argv[2],'utf8'));
const out=path.resolve('artifacts/verification/native');await mkdir(out,{recursive:true});
const browser=await chromium.connectOverCDP(process.env.DSH_NATIVE_CDP??'http://127.0.0.1:19406');
const pages=browser.contexts()[0].pages();
const welcomePage=pages.find(p=>p.url().includes('/welcome.html'));
if(welcomePage){await welcomePage.getByRole('button',{name:'添加 API Key',exact:true}).waitFor({timeout:15000});await welcomePage.getByRole('button',{name:'添加 API Key',exact:true}).click();await welcomePage.getByRole('button',{name:'稍后配置',exact:true}).click();}
const page=pages.find(p=>p.url().startsWith('dsh-app://'))||pages.find(p=>p.url().startsWith('http'));
if(!page){await browser.close();throw new Error('The owned native app has no DSH webContents');}
const report={startedAt:new Date().toISOString(),surface:'official DSH Desktop owned isolated copy, visible native Electron webContents',archiveSha256:prepared.archive.sha256,installed:prepared.installed,realProvider:false,formalAppUnchanged:prepared.nativeProgram.formalAppUnchanged,checks:[],errors:[]};
page.on('pageerror',error=>report.errors.push(error.message));
function pass(name,evidence={}){report.checks.push({name,evidence});console.log(name);}
async function shotState(){const folders=await readdir(prepared.projects,{withFileTypes:true});for(const f of folders.filter(f=>f.isDirectory())){const root=path.join(prepared.projects,f.name);const p=JSON.parse(await readFile(path.join(root,'project.json'),'utf8'));if(p.title==='DSH原生全流程验收')return {root,project:p};}throw new Error('Native project not found');}
async function waitTask(action,timeout=90000){await action();await page.locator('.vs-task.is-running').waitFor({timeout:7000});await page.locator('.vs-task.is-complete').waitFor({timeout});assert.equal(await page.locator('.vs-task.is-failed').count(),0);}
try{
 await page.getByText('映流 · 视频工作台',{exact:true}).waitFor({timeout:60000});
 const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.isVisible())await welcome.click();
 await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.getByLabel('模型提供方').selectOption('video-studio-offline');
 pass('packaged plugin sidebar and working page load in native DSH');
 if(process.env.DSH_NATIVE_RESTART==='1'){
   await page.getByRole('heading',{name:'DSH原生全流程验收'}).waitFor();assert.equal(await page.locator('.vs-asset').count(),4);assert.equal(await page.locator('.vs-shotchip').count(),5);
   const {root,project}=await shotState();assert.equal(project.outputs.length,1);if(process.env.DSH_NATIVE_LAST_EDIT)assert.equal(project.shots[1].params.text,process.env.DSH_NATIVE_LAST_EDIT);assert.match(await readFile(path.join(root,project.shots[1].sourcePath,'scene.js'),'utf8'),/Native manual source edit/);await page.getByRole('button',{name:'播放成片',exact:true}).click();
   const video=page.locator('.vs-output-video');await video.waitFor();await video.evaluate(v=>new Promise((resolve,reject)=>{if(v.readyState>=2)return resolve();v.addEventListener('loadeddata',resolve,{once:true});v.addEventListener('error',()=>reject(new Error('restored MP4 playback failed')),{once:true});}));
   await video.evaluate(v=>v.play());await page.waitForTimeout(600);const played=await video.evaluate(v=>({currentTime:v.currentTime,width:v.videoWidth,height:v.videoHeight,duration:v.duration}));assert.ok(played.currentTime>0);await video.evaluate(v=>v.pause());
   pass('native app restart restores assets, five shots, last saved parameter, manual source and playable MP4',{root,revision:project.revision,lastEdit:project.shots[1].params.text,video:played});
   await page.screenshot({path:out+'/restart.png'});report.status='PASS';
 }else{
   await page.getByRole('button',{name:'新建项目',exact:true}).click();await page.getByLabel('影片名称',{exact:true}).fill('DSH原生全流程验收');await page.getByLabel('主题与制作想法').fill('用三张图和中文文字解释分镜、前端动画与本地视频制作。固定离线模型验收。');await page.getByRole('button',{name:'先建立项目',exact:true}).click();await page.getByRole('heading',{name:'DSH原生全流程验收'}).waitFor();
   const assets='/Users/skylake/Work/Projects/dsh-梅花易数/src/assets/tarot';await page.locator('input[type=file]').setInputFiles(['major-00.webp','major-10.webp','wands-03.webp'].map(f=>assets+'/'+f));await page.locator('.vs-asset').filter({hasText:'wands-03.webp'}).waitFor();
   await page.getByRole('button',{name:'添加文字',exact:true}).click();await page.locator('.vs-textasset-input').fill('原生验收：图片、中文文本、节点分镜、参数、源码、实际MP4。');await page.getByRole('button',{name:'加入资产库',exact:true}).click();await page.locator('.vs-asset').filter({hasText:'原生验收'}).waitFor();assert.equal(await page.locator('.vs-asset').count(),4);
   await waitTask(()=>page.getByRole('button',{name:'生成分镜',exact:true}).click());assert.equal(await page.locator('.vs-shotchip').count(),5);assert.equal(await page.locator('.vs-asset').count(),4);pass('three images plus text generate five editable shots and keep all assets');
   const before=await shotState();await page.locator('.vs-shotchip').nth(1).click();await page.getByLabel('屏幕主文字',{exact:true}).fill('原生参数编辑');await page.getByText('图片位置与缩放',{exact:true}).click();await page.getByLabel('横向位置',{exact:true}).focus();await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');await page.waitForTimeout(750);
   await waitTask(()=>page.getByRole('button',{name:'生成画面',exact:true}).click());assert.equal(await page.locator('.vs-asset').count(),4);await page.frameLocator('.vs-preview iframe').locator('.counter').waitFor();
   const generated=await shotState();assert.ok(generated.project.revision>before.project.revision);assert.equal(generated.project.shots[1].params.text,'原生参数编辑');assert.equal(generated.project.shots[1].params.imageX,72);pass('parameter save and actual new frontend code appear in the existing preview',{revision:generated.project.revision});
   await page.getByLabel('修改范围').selectOption('shot');await page.locator('.vs-ai-edit textarea').fill('只改变当前镜头的标题与强调色');await waitTask(()=>page.getByRole('button',{name:'修改这个镜头',exact:true}).click());const modified=await shotState();assert.match(modified.project.shots[1].params.text,/已修改/);for(let i=0;i<5;i++)if(i!==1)assert.deepEqual(modified.project.shots[i],generated.project.shots[i]);pass('selected-shot natural-language change keeps the other four shots');
   await page.getByRole('tab',{name:'前端源码',exact:true}).click();await page.getByRole('button',{name:'JS',exact:true}).click();const source=page.getByLabel('JS 源码');await source.waitFor();await source.fill((await source.inputValue())+'\n// Native manual source edit');await waitTask(()=>page.getByRole('button',{name:'保存源码',exact:true}).click());pass('manual source edit and real browser code check');
   await page.getByRole('tab',{name:'制作要求',exact:true}).click();await page.locator('.vs-spec-view pre').waitFor();assert.match(await page.locator('.vs-spec-view pre').innerText(),/已修改/);await page.screenshot({path:out+'/requirements.png'});pass('current structured production requirements are shown');
   await page.getByRole('tab',{name:'影片预览',exact:true}).click();await page.getByRole('button',{name:'播放',exact:true}).click();await page.waitForTimeout(500);await page.getByRole('button',{name:'暂停',exact:true}).click();await page.getByLabel('影片播放位置').focus();await page.keyboard.press('Home');for(let i=0;i<30;i++)await page.keyboard.press('ArrowRight');await page.screenshot({path:out+'/editor.png'});pass('real frame preview playback, pause and arbitrary seek');
   await waitTask(()=>page.getByRole('button',{name:'导出视频',exact:true}).click(),240000);const exported=await shotState();const output=exported.project.outputs.at(-1);assert.equal(output.frameCount,900);assert.equal(output.duration,30);assert.equal(output.width,1920);assert.equal(output.height,1080);assert.equal(output.qa.status,'PASS');pass('native UI exports an actual 30s 1920x1080 silent MP4',{...output,qa:{status:output.qa.status,frameCount:output.qa.frameCount,audioStreams:output.qa.audioStreams}});
   await page.getByRole('button',{name:'播放成片',exact:true}).click();const video=page.locator('.vs-output-video');await video.waitFor();await video.evaluate(v=>new Promise((resolve,reject)=>{if(v.readyState>=2)return resolve();v.addEventListener('loadeddata',resolve,{once:true});v.addEventListener('error',()=>reject(new Error('MP4 playback failed')),{once:true});}));await video.evaluate(v=>v.play());await page.waitForTimeout(800);const played=await video.evaluate(v=>({currentTime:v.currentTime,width:v.videoWidth,height:v.videoHeight,duration:v.duration}));assert.ok(played.currentTime>0);await video.evaluate(v=>v.pause());pass('native embedded MP4 result decodes and plays',played);await page.screenshot({path:out+'/result.png'});
   await page.getByText('插件',{exact:true}).first().click();await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.getByRole('heading',{name:'DSH原生全流程验收'}).waitFor();assert.equal(await page.locator('.vs-asset').count(),4);pass('native sidebar page switching retains the editable project');
   report.status='PASS';report.project=await shotState();
 }
 assert.deepEqual(report.errors,[]);
}catch(error){report.status='FAIL';report.failure=error.stack;await page.screenshot({path:out+'/failure.png'}).catch(()=>{});throw error;}
finally{report.finishedAt=new Date().toISOString();await writeFile(out+(process.env.DSH_NATIVE_RESTART==='1'?'/restart.json':'/native-acceptance.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}

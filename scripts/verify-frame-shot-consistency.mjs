// Uses real DSH UI controls and observes runtime messages; no direct render or model calls.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const out=path.resolve('artifacts/verification/v0.2/ui');await mkdir(out,{recursive:true});
const report={startedAt:new Date().toISOString(),surface:'official isolated DSH web, actual frame controls and runtime postMessage',externalModel:false,checks:[],errors:[],clientSha256:createHash('sha256').update(await readFile('lib/client.js')).digest('hex')};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});let page,project;
async function poll(check,timeout=20000){const start=Date.now();let error;while(Date.now()-start<timeout){try{const value=await check();if(value)return value;}catch(e){error=e;}await new Promise(resolve=>setTimeout(resolve,50));}throw error||new Error('Frame consistency timed out');}
function pass(name,evidence){report.checks.push({name,status:'PASS',evidence});console.log('PASS '+name);}
async function seek(frame){await page.getByLabel('跳转帧',{exact:true}).fill(String(frame));await page.getByRole('button',{name:'定位',exact:true}).click();return consistent(frame);}
async function consistent(frame){
  const index=Math.floor(frame/300),shot=project.shots.find(s=>s.id===project.shotOrder[index]);
  const rendered=await poll(async()=>{const value=await page.evaluate(()=>window.__previewRenderedFrame);return value?.frame===frame?value:false;});
  assert.equal(Number(await page.getByTestId('current-frame').innerText()),frame);
  assert.equal(rendered.sceneId,shot.id);
  assert.equal(await page.getByTestId('current-shot-heading').getAttribute('data-shot-id'),shot.id);
  assert.equal(await page.getByTestId('current-shot-heading').innerText(),`「${shot.title}」· 帧 [${index*300}, ${(index+1)*300})`);
  assert.equal(await page.getByTestId('current-shot-local-frame').innerText(),`镜头 F${frame-index*300} · ${((frame-index*300)/30).toFixed(3)}s`);
  assert.equal(await page.locator('.vs-preview-foot>span').innerText(),shot.title);
  assert.equal(await page.getByLabel('镜头标题',{exact:true}).inputValue(),project.shots.find(s=>s.id===project.shotOrder[2]).title);
  assert.match(await page.getByTestId('keyframe-scope').innerText(),/选中「.*」的关键帧/);
  return {frame,sceneId:rendered.sceneId,heading:await page.getByTestId('current-shot-heading').innerText(),local:await page.getByTestId('current-shot-local-frame').innerText(),selectedTitle:await page.getByLabel('镜头标题',{exact:true}).inputValue()};
}
try{
 const context=await browser.newContext({viewport:{width:1700,height:1160},deviceScaleFactor:2});
 await context.addInitScript(()=>{window.addEventListener('message',event=>{if(event.data?.type==='video-studio/frame'&&event.source===document.querySelector('iframe[title="影片画面预览"]')?.contentWindow)window.__previewRenderedFrame={frame:event.data.frame,sceneId:event.data.sceneId};});});
 page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));await page.goto(process.env.DSH_TEST_URL||'http://127.0.0.1:19405/');
 const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.waitFor({state:'visible',timeout:1500}).then(()=>true).catch(()=>false))await welcome.click();
 await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.getByRole('button',{name:'新建项目',exact:true}).click();
 const title='跨镜头逐帧一致性 '+Date.now();await page.getByLabel('影片名称',{exact:true}).fill(title);await page.getByLabel('主题与制作想法',{exact:true}).fill('真实 UI 逐帧与镜头一致性验收；不调用模型。');await page.getByRole('button',{name:'先建立项目',exact:true}).click();await page.getByRole('heading',{name:title,exact:true}).waitFor();
 const item=await poll(async()=>JSON.parse(await readFile('.local/projects/recent.json','utf8')).find(p=>p.title===title));report.project=item;project=JSON.parse(await readFile(path.join(item.path,'project.json'),'utf8'));assert.deepEqual(project.shots.map(s=>s.durationFrames),[300,300,300]);
 await page.locator('.vs-shotchip').nth(2).click();await page.getByRole('button',{name:'预览',exact:true}).click();await poll(()=>page.getByRole('button',{name:'下一帧',exact:true}).isEnabled());
 pass('selected third shot starts at its own frame, before cross-shot navigation',await consistent(600));
 pass('jump 149 shows actual first shot and local frame149 while properties stay on third shot',await seek(149));await page.screenshot({path:out+'/cross-shot-frame149.png'});
 pass('jump 650 returns to actual third shot and local frame50',await seek(650));await page.screenshot({path:out+'/cross-shot-frame650.png'});
 const before=await seek(299);await page.getByRole('button',{name:'下一帧',exact:true}).click();const next=await consistent(300);await page.getByRole('button',{name:'上一帧',exact:true}).click();const previous=await consistent(299);pass('next and previous frame cross the exclusive299/300 boundary in both directions',{before,next,previous});
 await seek(590);await page.getByRole('button',{name:'播放',exact:true}).click();await poll(async()=>Number(await page.getByTestId('current-frame').innerText())>=605);await page.getByRole('button',{name:'暂停',exact:true}).click();const stopped=Number(await page.getByTestId('current-frame').innerText());assert.ok(stopped>=600&&stopped<900);pass('play then pause crosses second-to-third boundary with actual header and local frame',await consistent(stopped));
 await seek(149);await page.locator('.vs-keyframe').first().click();pass('explicit selected-shot keyframe returns to third-shot frame600',await consistent(600));
 assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;console.error(error);await page?.screenshot({path:out+'/frame-shot-consistency-failure.png'}).catch(()=>{});}
finally{report.completedAt=new Date().toISOString();await writeFile(out+'/frame-shot-consistency.json',JSON.stringify(report,null,2));await browser.close();}
if(report.status==='FAIL')process.exitCode=1;

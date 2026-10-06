// Actual official DSH Session -> Agent loop -> Tool registry -> Jobs -> plugin UI acceptance.
// Model output is an explicitly offline fixture; renderers/encoders and host runtime are real.
import {chromium,request} from 'playwright-core';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const repo=path.resolve(import.meta.dirname,'..');
const url=process.env.DSH_TEST_URL;if(!url)throw new Error('Set DSH_TEST_URL to the isolated DSH URL (including its login token if needed).');
const out=path.resolve(process.env.DSH_SESSION_REPORT_DIR??path.join(repo,'artifacts/verification/v0.2/session'));
const providerLog=path.resolve(process.env.DSH_VIDEO_SESSION_LOG??path.join(out,'provider-calls.jsonl'));
const tone=path.resolve(process.env.DSH_VIDEO_SESSION_AUDIO??path.join(repo,'.local/session-test-tone.wav'));
await mkdir(out,{recursive:true});await mkdir(path.dirname(tone),{recursive:true});
const rate=24000,samples=rate,pcm=Buffer.alloc(samples*2),header=Buffer.alloc(44);
for(let i=0;i<samples;i++)pcm.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/rate)*3200),i*2);
header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);await writeFile(tone,Buffer.concat([header,pcm]));
const report={startedAt:new Date().toISOString(),surface:process.env.DSH_NATIVE_CDP?'official isolated DSH Desktop webContents + same host Remote API':'official isolated DSH web profile',archiveSha256:process.env.DSH_PACKAGE_SHA,realProvider:false,checks:[],errors:[]};
const browser=process.env.DSH_NATIVE_CDP?await chromium.connectOverCDP(process.env.DSH_NATIVE_CDP):await chromium.launch({headless:true,executablePath:process.env.DSH_BROWSER??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=process.env.DSH_NATIVE_CDP?browser.contexts()[0]:await browser.newContext({viewport:{width:1600,height:1100},deviceScaleFactor:2});
const page=process.env.DSH_NATIVE_CDP?context.pages().find(p=>p.url().startsWith('dsh-app://')):await context.newPage();
if(!page)throw new Error('Owned native DSH page is unavailable');
const api=await request.newContext();await api.get(url);
page.on('pageerror',error=>report.errors.push(error.message));
const base=new URL(url).origin;
async function rpc(endpoint,payload,remote=false){
 const response=await api.post(base+'/api/'+endpoint,{data:{type:'client-request',rpcId:randomUUID(),method:endpoint,payload:remote?{args:payload}:payload}});
 const result=await response.json();assert.equal(response.ok(),true,`${endpoint}: ${response.status()} ${JSON.stringify(result)}`);if(!result.result?.ok)throw new Error(`${endpoint}: ${JSON.stringify(result)}`);return result.result.value;
}
const studio=(endpoint,data={})=>rpc('video-studio/'+endpoint,data);
const remote=(endpoint,request)=>rpc(endpoint,{[endpoint==='session/list'?'_request':'request']:request},true);
function pass(name,evidence={}){report.checks.push({name,evidence});console.log(name);}
let workspaceId;
async function openSession(sessionId){
 const group=page.locator(`[data-row-key="workspace:${workspaceId}"]`);
 await group.waitFor({state:'visible'});if(await group.getAttribute('aria-expanded')!=='true')await group.click();
 await page.locator(`[data-row-key="session:${sessionId}"]`).click();
}
async function prompt(sessionId,title,key,content=[]){
 await remote('session/prompt',{sessionId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:`[VS_SESSION:${key}] 离线验收：在本会话后台规范化制作、检查、导出视频。`},...content]});
 await openSession(sessionId);
 await page.getByText(`[VS_DONE:${key}]`,{exact:false}).first().waitFor({timeout:180000});
 let sessions;const settled=Date.now()+20000;do{sessions=await remote('session/list',{});if(!sessions.items.find(s=>s.sessionId===sessionId)?.running)break;await page.waitForTimeout(100);}while(Date.now()<settled);assert.equal(sessions.items.find(s=>s.sessionId===sessionId)?.running,false);
 return studio('current',{sessionId});
}
try{
 if(!process.env.DSH_NATIVE_CDP)await page.goto(url);
 const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.waitFor({state:'visible',timeout:4000}).then(()=>true).catch(()=>false))await welcome.click();
 await page.getByText('映流 · 视频工作台',{exact:true}).waitFor({timeout:60000});
 const workspace=await remote('workspace/create',{path:repo});workspaceId=workspace.workspace.workspaceId;
 const first=await remote('session/create',{workspaceId:workspace.workspace.workspaceId});await remote('session/rename',{sessionId:first.sessionId,title:'视频会话验收 A'});
 const imagePath=process.env.DSH_SESSION_IMAGE??'/Users/skylake/Work/Projects/dsh-梅花易数/src/assets/tarot/major-00.webp';
 const image=await readFile(imagePath);
 const a=await prompt(first.sessionId,'视频会话验收 A','CREATE_A',[{type:'image',mediaType:'image/webp',data:image.toString('base64'),name:path.basename(imagePath)}]);
 assert.equal(a.project.shots.length,2);assert.equal(a.project.assets.filter(v=>v.kind==='image').length,1);assert.equal(a.project.outputs.at(-1).frameCount,24);assert.equal(a.project.outputs.at(-1).duration,2);assert.ok(a.project.sessionIds.includes(first.sessionId));
 assert.ok(await page.locator('[data-video-tool=video_project]').count());assert.ok(await page.locator('[data-video-tool=video_update]').count());assert.ok(await page.locator('[data-video-tool=video_render]').count());
 await page.getByText(/^已完成，用时/).first().click();
 await page.getByText('已调用工具并搜索代码',{exact:true}).first().click();
 pass('real existing Session agent loop dispatches video tools, image attachment, actual capture and session-owned background export',{sessionId:first.sessionId,projectId:a.project.id,outputs:a.project.outputs.map(v=>({id:v.id,width:v.width,height:v.height,frameCount:v.frameCount,duration:v.duration}))});
 await page.screenshot({path:path.join(out,'session-cards.png')});
 const inspectCard=page.locator('[data-video-tool=video_inspect]').last();await inspectCard.getByRole('button',{name:'查看指定帧',exact:false}).click();
 await page.getByRole('heading',{name:'会话影片 A',exact:true}).waitFor();const focus=await studio('current');assert.equal(focus.project.id,a.project.id);assert.equal(focus.focus.frame,3);assert.equal(focus.focus.shotId,a.project.shots[0].id);
 await page.locator('.vs-shotchip').nth(1).click();await page.getByLabel('屏幕主文字',{exact:true}).fill('真人在工作台修改的镜头文字');
 const deadline=Date.now()+10000;let manual;do{await page.waitForTimeout(150);manual=await studio('current',{projectId:a.project.id});}while(manual.project.shots[1].params.text!=='真人在工作台修改的镜头文字'&&Date.now()<deadline);
 assert.equal(manual.project.shots[1].params.text,'真人在工作台修改的镜头文字');await page.screenshot({path:path.join(out,'workbench-focus.png')});
 await page.getByRole('button',{name:/^返回会话/}).click();
 const edited=await prompt(first.sessionId,'视频会话验收 A','READ_MANUAL');assert.equal(edited.project.shots[1].params.text,'真人在工作台修改的镜头文字');assert.equal(edited.project.shots[1].params.subtitle,'模型读取到：真人在工作台修改的镜头文字');assert.deepEqual(edited.project.shots[0],manual.project.shots[0]);
 await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.getByRole('heading',{name:'会话影片 A',exact:true}).waitFor();
 const refreshedAt=Date.now()+15000;while((await page.getByLabel('补充文字',{exact:true}).inputValue())!==edited.project.shots[1].params.subtitle&&Date.now()<refreshedAt)await page.waitForTimeout(100);
 assert.equal(await page.getByLabel('补充文字',{exact:true}).inputValue(),edited.project.shots[1].params.subtitle);
 pass('tool card navigates project/shot/frame; manual changes reach the same Session, and direct sidebar return refreshes its latest edits',{revision:edited.project.revision,frame:3,text:edited.project.shots[1].params.text,sidebarSubtitle:edited.project.shots[1].params.subtitle});
 const second=await remote('session/create',{workspaceId:workspace.workspace.workspaceId});await remote('session/rename',{sessionId:second.sessionId,title:'视频会话验收 B'});const b=await prompt(second.sessionId,'视频会话验收 B','CREATE_B');
 assert.notEqual(a.project.id,b.project.id);assert.equal((await studio('current',{sessionId:first.sessionId})).project.shots[1].params.text,'真人在工作台修改的镜头文字');assert.equal(b.project.outputs.at(-1).frameCount,24);
 pass('second Session creates and exports its own project without replacing first Session data',{first:first.sessionId,second:second.sessionId,projectA:a.project.id,projectB:b.project.id});
 const voiced=await prompt(first.sessionId,'视频会话验收 A','AUDIO');assert.ok(voiced.project.audioClips.length);const voicedOutput=voiced.project.outputs.at(-1);assert.equal(voicedOutput.qa.audioStreams,1);
 pass('Session video_audio imports actual audio, mixes it, and exports a playable MP4 with one audio stream',{audioClips:voiced.project.audioClips,output:{id:voicedOutput.id,audioStreams:voicedOutput.qa.audioStreams}});
 const cancelled=await prompt(second.sessionId,'视频会话验收 B','CANCEL');assert.equal(cancelled.task.status,'cancelled');assert.equal(cancelled.project.outputs.length,b.project.outputs.length);
 pass('Session job_kill cancels its background export and keeps completed output and other Session assets',{task:cancelled.task,unchangedOutputs:cancelled.project.outputs.length});
 await page.screenshot({path:path.join(out,'session-jobs.png')});
 const logs=(await readFile(providerLog,'utf8')).trim().split('\n').map(JSON.parse);
 const owned=logs.filter(row=>[first.sessionId,second.sessionId].includes(row.sessionId));assert.ok(owned.some(row=>row.names.includes('video_project')||row.videoSdkVisible));assert.ok(owned.some(row=>row.tool==='video_audio'));assert.ok(owned.some(row=>row.tool==='job_output'));assert.ok(owned.some(row=>row.tool==='job_kill'));
 pass('provider fixture receives registered tool schemas in the existing Session and uses DSH job collection/cancellation',{calls:owned.length,sessionIds:[...new Set(owned.map(r=>r.sessionId))],tools:[...new Set(owned.map(r=>r.tool).filter(Boolean))]});
 report.projects={a:voiced.root,b:cancelled.root};report.sessionIds=[first.sessionId,second.sessionId];report.status='PASS';
 assert.deepEqual(report.errors,[]);
}catch(error){report.status='FAIL';report.failure=error.stack;await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(out,'session-acceptance.json'),JSON.stringify(report,null,2)+'\n');await api.dispose();await browser.close();}

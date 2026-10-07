// Actual owned DSH Agent/subagent/Team runtime, driven by an offline model fixture.
import { chromium, request } from 'playwright-core';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const repo=path.resolve(import.meta.dirname,'..'),url=process.env.DSH_TEST_URL;
assert.ok(url,'Set DSH_TEST_URL to the isolated profile using home-team-provider.mjs.');
const out=path.resolve(process.env.DSH_V04_AGENTS_REPORT_DIR||path.join(repo,'artifacts/verification/v0.4/agents'));
await mkdir(out,{recursive:true});
const logPath=process.env.DSH_V04_AGENTS_LOG;assert.ok(logPath,'Set DSH_V04_AGENTS_LOG to the fixture log shared with the test host.');
async function providerLog(){return (await readFile(logPath,'utf8')).trim().split('\n').map(JSON.parse);}
const native=Boolean(process.env.DSH_NATIVE_CDP);
const report={version:'0.4.0',startedAt:new Date().toISOString(),surface:native?'owned isolated DSH Desktop':'official isolated DSH Web',realProvider:false,packageSha256:process.env.DSH_PACKAGE_SHA,checks:[],errors:[]};
report.libSha256=Object.fromEntries(await Promise.all(['index.js','client.js'].map(async name=>[name,createHash('sha256').update(await readFile(path.join(repo,'lib',name))).digest('hex')])));
const api=await request.newContext();await api.get(url);const base=new URL(url).origin;
const browser=native?await chromium.connectOverCDP(process.env.DSH_NATIVE_CDP):await chromium.launch({headless:true,executablePath:process.env.DSH_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=native?browser.contexts()[0]:await browser.newContext({viewport:{width:1500,height:1120},deviceScaleFactor:2});
const page=native?context.pages().find(value=>value.url().startsWith('dsh-app://')):await context.newPage();assert.ok(page);
page.on('pageerror',error=>report.errors.push(error.message));
let lead,once,teammate,rootProject,privateProject;
function pass(name,evidence={}){report.checks.push({name,evidence});console.log('PASS '+name);}
async function rpc(endpoint,payload={},remote=false){const response=await api.post(base+'/api/'+endpoint,{data:{type:'client-request',rpcId:randomUUID(),method:endpoint,payload:remote?{args:payload}:payload}});const result=await response.json();assert.equal(response.ok(),true,endpoint);assert.equal(result.result?.ok,true,`${endpoint}: ${JSON.stringify(result.result)}`);return result.result.value;}
const studio=(endpoint,payload={})=>rpc('video-studio/'+endpoint,payload);
const remote=(endpoint,payload={})=>rpc(endpoint,{[endpoint==='session/list'?'_request':'request']:payload},true);
async function poll(check,timeout=60000){const until=Date.now()+timeout;while(Date.now()<until){const value=await check();if(value)return value;await page.waitForTimeout(150);}throw new Error('Actual Agent state did not settle');}
async function home(){await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.locator('[data-video-home="true"]').waitFor();await page.getByRole('button',{name:'刷新列表',exact:true}).click();}
async function choose(projectId,sessionId,mode='continue'){
  await page.locator(`[data-project-id="${projectId}"]`).getByRole('button',{name:mode==='continue'?'继续会话':'关联会话',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:mode==='continue'?'选择继续创作的会话':'关联会话',exact:true});await dialog.waitFor();
  await dialog.getByLabel('显示子代理／团队任务',{exact:true}).check();
  await dialog.locator(`[data-session-id="${sessionId}"] input[type="radio"]`).check();return dialog;
}
async function revealTools(){const completed=page.getByText(/^已完成，用时/).first();if(await completed.isVisible().catch(()=>false))await completed.click();const tools=page.getByText('已调用工具并搜索代码',{exact:true}).first();if(await tools.isVisible().catch(()=>false))await tools.click();}
async function prompt(command){await remote('session/prompt',{sessionId:lead,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:`[VS_AGENTS:${command}] 使用离线工具模型完成真实视频协作验收。`}]});}
try{
  if(!native)await page.goto(url);else await page.reload();
  const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.waitFor({state:'visible',timeout:1500}).then(()=>true).catch(()=>false))await welcome.click();
  await page.getByText('映流 · 视频工作台',{exact:true}).waitFor({timeout:60000});
  const workspace=await remote('workspace/create',{path:repo});lead=(await remote('session/create',{workspaceId:workspace.workspace.workspaceId})).sessionId;
  const title='V04 真实协作 '+Date.now();await remote('session/rename',{sessionId:lead,title});
  const target={width:320,height:180,fps:{num:12,den:1},audioMode:'none'};
  rootProject=await studio('create',{title:title+' 主影片',topic:'子代理与团队共同编辑',target});
  const shots=rootProject.project.shots.slice(0,2).map(shot=>({...shot,durationFrames:12}));assert.equal(shots.length,2);
  rootProject=await studio('apply',{projectId:rootProject.project.id,expectedRevision:rootProject.project.revision,shots,shotOrder:shots.map(shot=>shot.id),targetDuration:2});
  privateProject=await studio('create',{title:title+' 专属影片',topic:'团队独立任务覆盖',target});
  await studio('bindSession',{projectId:rootProject.project.id,sessionId:lead,select:false,expectedCurrentProjectId:null});
  await prompt('LEAD');
  const shared=await poll(async()=>{const value=await studio('current',{projectId:rootProject.project.id});return value.project.shots[0].params.subtitle==='V04 一次性子代理完成'&&value.project.shots[1].params.subtitle==='V04 团队成员完成'?value:false;});
  const projected=await poll(async()=>{const value=await remote('session/projections',{sessionId:lead});return value?.values?.agentTeam?.members.some(member=>member.role==='teammate'&&member.phase==='active')?value:false;});
  teammate=projected.values.agentTeam.members.find(member=>member.role==='teammate'&&member.phase==='active').id;
  once=projected.values.subagentCatalog.find(child=>child.mode==='one-shot').id;
  await poll(async()=>{const list=await remote('session/list');return !list.items.find(row=>row.sessionId===lead)?.running;});
  const childRoute=await studio('current',{sessionId:once}),teamRoute=await studio('current',{sessionId:teammate});
  assert.equal(childRoute.project.id,rootProject.project.id);assert.equal(teamRoute.project.id,rootProject.project.id);
  const actualLog=await providerLog(),childReceipt=actualLog.find(row=>row.sessionId===once&&row.command==='CHILD'&&row.step===1),teamReceipt=actualLog.find(row=>row.sessionId===teammate&&row.command==='TEAM'&&row.step===1);
  assert.equal(childReceipt.callerSessionId,once);assert.equal(childReceipt.ownerSessionId,lead);assert.equal(childReceipt.routingSource,'subagent-ancestor');
  assert.equal(teamReceipt.callerSessionId,teammate);assert.equal(teamReceipt.ownerSessionId,lead);assert.equal(teamReceipt.routingSource,'subagent-ancestor');
  pass('real DSH foreground subagent and active Team member use the bound lead film through actual video tools',{lead,once,teammate,projectId:rootProject.project.id,revision:shared.project.revision,childRoute:{callerSessionId:once,ownerSessionId:lead,source:childReceipt.routingSource},teamRoute:{callerSessionId:teammate,ownerSessionId:lead,source:teamReceipt.routingSource}});

  await home();
  const onceDialog=await choose(rootProject.project.id,once);await onceDialog.getByText(/沿用「/).first().waitFor();await onceDialog.getByRole('button',{name:'进入会话',exact:true}).click();await onceDialog.waitFor({state:'hidden'});
  await page.getByText('[VS_AGENTS_DONE:CHILD]',{exact:false}).first().waitFor();
  await page.locator(`[data-conversation-session="${once}"]`).waitFor();
  await page.screenshot({path:path.join(out,'one-shot-address.png')});
  pass('homepage discovers a real one-shot child and opens its persisted conversation through a durable parent address',{childSessionId:once,mode:'one-shot'});
  await home();const teamDialog=await choose(rootProject.project.id,teammate);await teamDialog.getByRole('button',{name:'进入会话',exact:true}).click();await teamDialog.waitFor({state:'hidden'});
  await page.getByText('[VS_AGENTS_DONE:TEAM]',{exact:false}).first().waitFor();await revealTools();
  await page.locator(`[data-conversation-session="${teammate}"]`).waitFor();
  const inspect=page.locator('[data-video-tool="video_inspect"]').last();await inspect.waitFor();
  await inspect.getByRole('button',{name:'返回会话',exact:true}).click();
  await page.locator(`[data-conversation-session="${teammate}"]`).waitFor();
  await inspect.getByRole('button',{name:/^查看指定帧/}).click();
  await page.getByRole('heading',{name:rootProject.project.title,exact:true}).waitFor();
  const focus=await studio('current');assert.equal(focus.focus.shotId,shared.project.shots[1].id);assert.equal(focus.focus.frame,15);
  await page.getByRole('button',{name:'继续会话 ↗',exact:true}).click();
  const returning=page.getByRole('dialog',{name:'选择继续创作的会话',exact:true});
  await returning.getByLabel('显示子代理／团队任务',{exact:true}).check();
  await returning.locator(`[data-session-id="${teammate}"] input[type="radio"]`).check();
  await returning.getByRole('button',{name:'进入会话',exact:true}).click();
  await returning.waitFor({state:'hidden'});
  await page.locator(`[data-conversation-session="${teammate}"]`).waitFor();
  await page.getByText('[VS_AGENTS_DONE:TEAM]',{exact:false}).first().waitFor();
  await page.screenshot({path:path.join(out,'team-address-and-card-return.png')});
  pass('real teammate tool card opens its exact lead-film shot/frame and returns to the calling teammate',{teammate,frame:15,shotId:shared.project.shots[1].id});

  await home();const bind=await choose(privateProject.project.id,teammate,'associate');
  await bind.getByRole('button',{name:'为此任务关联专属工程',exact:true}).click();await bind.waitFor({state:'hidden'});
  assert.equal((await studio('current',{sessionId:teammate})).project.id,privateProject.project.id);
  assert.equal((await studio('current',{sessionId:lead})).project.id,rootProject.project.id);
  assert.equal((await studio('current',{sessionId:once})).project.id,rootProject.project.id);
  pass('explicitly assigning a teammate its own existing film leaves the lead and sibling on their original film',{bindings:(await studio('list')).bindings});
  await prompt('PRIVATE_LEAD');
  await poll(async()=>(await studio('current',{projectId:privateProject.project.id})).project.shots[0].params.subtitle==='V04 团队专属工程完成');
  assert.deepEqual((await studio('current',{projectId:rootProject.project.id})).project.shots,shared.project.shots);
  pass('actual Team message resumes its durable teammate and video tools route to the explicitly assigned private film');
  const logs=await providerLog();
  const worker=logs.filter(row=>[once,teammate].includes(row.sessionId));
  assert.ok(worker.some(row=>row.sessionId===once&&row.command==='CHILD'&&row.tool==='video_update'));
  assert.ok(worker.some(row=>row.sessionId===teammate&&row.command==='TEAM'&&row.tool==='video_update'));
  assert.ok(worker.some(row=>row.sessionId===teammate&&row.command==='TEAM_PRIVATE'&&row.projectId===privateProject.project.id));
  pass('offline provider log independently records tool dispatch in real child identities and both inherited/private routes',{calls:worker.length,callerIds:[...new Set(worker.map(row=>row.sessionId))],commands:[...new Set(worker.map(row=>row.command))]});
  report.sessions={lead,once,teammate};report.projects={shared:rootProject.project.id,private:privateProject.project.id};
  report.finalBindings=(await studio('list')).bindings;
  assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{report.completedAt=new Date().toISOString();await writeFile(path.join(out,'verification.json'),JSON.stringify(report,null,2)+'\n');await api.dispose();await browser.close();}

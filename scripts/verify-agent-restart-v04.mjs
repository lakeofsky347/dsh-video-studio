// Read persistent child addresses and project routes after restarting the owned native host.
import {chromium,request} from 'playwright-core';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const url=process.env.DSH_TEST_URL,cdp=process.env.DSH_NATIVE_CDP;
assert.ok(url&&cdp,'Set the owned native API URL and CDP address.');
const out=path.resolve(process.env.DSH_V04_AGENTS_REPORT_DIR??'artifacts/verification/v0.4/native-agents');
await mkdir(out,{recursive:true});
const baseline=JSON.parse(await readFile(path.join(out,'verification.json'),'utf8'));
assert.equal(baseline.status,'PASS');assert.equal(baseline.packageSha256,process.env.DSH_PACKAGE_SHA);
const report={status:'RUNNING',surface:'owned isolated DSH Desktop after actual process restart',packageSha256:process.env.DSH_PACKAGE_SHA,checks:[],errors:[]};
const api=await request.newContext();await api.get(url);const base=new URL(url).origin;
async function studio(endpoint,payload={}){
  const response=await api.post(base+'/api/video-studio/'+endpoint,{data:{type:'client-request',rpcId:randomUUID(),method:'video-studio/'+endpoint,payload}});
  const value=await response.json();assert.equal(value.result?.ok,true,JSON.stringify(value));return value.result.value;
}
const browser=await chromium.connectOverCDP(cdp);
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('dsh-app://'));assert.ok(page);
page.on('pageerror',error=>report.errors.push(error.message));
function pass(name,evidence={}){report.checks.push({name,evidence});console.log('PASS '+name);}
async function openChild(projectId,sessionId){
  await page.getByText('映流 · 视频工作台',{exact:true}).click();
  await page.locator('[data-video-home="true"]').waitFor();
  await page.getByLabel('按会话筛选工程',{exact:true}).selectOption('all');
  await page.getByLabel('搜索影片工程',{exact:true}).fill('');
  await page.getByRole('button',{name:'刷新列表',exact:true}).click();
  await page.locator(`[data-project-id="${projectId}"]`).getByRole('button',{name:'继续会话',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'选择继续创作的会话',exact:true});
  await dialog.getByLabel('显示子代理／团队任务',{exact:true}).check();
  await dialog.locator(`[data-session-id="${sessionId}"] input[type="radio"]`).check();
  await dialog.getByRole('button',{name:'进入会话',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor();
}
try{
  const {lead,once,teammate}=baseline.sessions,{shared,private:privateId}=baseline.projects;
  // Query the hidden child first: the host must find its durable catalog edge without a live team.
  assert.equal((await studio('current',{sessionId:once})).project.id,shared);
  pass('cold one-shot child inherits its lead film from the durable host catalog',{sessionId:once,projectId:shared});
  assert.equal((await studio('current',{sessionId:teammate})).project.id,privateId);
  assert.equal((await studio('current',{sessionId:lead})).project.id,shared);
  pass('explicit teammate film survives restart while its lead retains the shared film',{teammate,privateId,lead,shared});
  await openChild(shared,once);await page.getByText('[VS_AGENTS_DONE:CHILD]',{exact:false}).first().waitFor();
  await page.screenshot({path:path.join(out,'restart-one-shot.png')});
  pass('homepage discovers and reopens the persisted one-shot conversation after restart',{sessionId:once});
  await openChild(privateId,teammate);await page.getByText('[VS_AGENTS_DONE:TEAM_PRIVATE]',{exact:false}).first().waitFor();
  await page.screenshot({path:path.join(out,'restart-teammate.png')});
  pass('homepage reopens the teammate conversation and its private-film receipt after restart',{sessionId:teammate});
  assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;await page.screenshot({path:path.join(out,'restart-failure.png')}).catch(()=>{});throw error;}
finally{report.completedAt=new Date().toISOString();await writeFile(path.join(out,'restart.json'),JSON.stringify(report,null,2)+'\n');await browser.close();await api.dispose();}

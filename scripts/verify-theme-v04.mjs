// Isolated DSH UI verification. Theme changes use the host Settings controls.
import { chromium } from 'playwright-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const url=process.env.DSH_TEST_URL;
assert.ok(url,'Set DSH_TEST_URL to the owned isolated DSH URL.');
const out=path.resolve(process.env.DSH_THEME_REPORT_DIR||'artifacts/verification/v0.4/ui-theme');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.DSH_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1540,height:1120},deviceScaleFactor:2});
const repo=path.resolve(import.meta.dirname,'..');
const report={version:'0.4.0',surface:'official isolated DSH Web',startedAt:new Date().toISOString(),packageSha256:process.env.DSH_PACKAGE_SHA,checks:[],errors:[],realProvider:false};
report.libSha256=Object.fromEntries(await Promise.all(['index.js','client.js'].map(async name=>[name,createHash('sha256').update(await readFile(path.join(repo,'lib',name))).digest('hex')])));
page.on('pageerror',error=>report.errors.push(error.message));
let original;
async function settings(){await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'浅色',exact:true}).waitFor();}
async function theme(name){await settings();await page.getByRole('button',{name,exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click();}
function pass(name,evidence={}){report.checks.push({name,evidence});console.log('PASS '+name);}
try{
 await page.goto(url);
 await page.getByRole('button',{name:'映流 · 视频工作台',exact:true}).waitFor({timeout:60000});
 await settings();
 for(const name of ['浅色','深色','跟随系统'])if(await page.getByRole('button',{name,exact:true}).getAttribute('aria-pressed')==='true')original=name;
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'映流 · 视频工作台',exact:true}).click();
 await page.locator('[data-video-home="true"]').waitFor();
 const home=page.locator('[data-video-home="true"]');
 for(const [scheme,name] of [['dark','深色'],['light','浅色']]){
  await page.setViewportSize({width:1540,height:1120});
  await theme(name);
  await page.locator(`.vs-studio[data-scheme="${scheme}"]`).waitFor();
  await page.locator('.vs-studio').evaluate(element=>{element.scrollTop=0;});
  await page.screenshot({path:path.join(out,`home-${scheme}-wide.png`)});
  const header=await page.locator('.vs-home-shell>.vs-topbar').evaluate(element=>({text:element.textContent,modelControls:element.querySelectorAll('select').length}));
  assert.equal(header.modelControls,0);assert.equal(await page.locator('.vs-projectbar').count(),0);
  pass(`${scheme}: actual host Settings updates the independent homepage`,header);
  await page.setViewportSize({width:640,height:980});
  await page.waitForTimeout(450);
  await page.locator('.vs-studio').evaluate(element=>{element.scrollTop=0;});
  const bounds=await home.evaluate(element=>({width:element.clientWidth,scrollWidth:element.scrollWidth,documentWidth:document.documentElement.clientWidth,documentScroll:document.documentElement.scrollWidth}));
  await page.screenshot({path:path.join(out,`home-${scheme}-narrow.png`)});
  assert.ok(bounds.scrollWidth<=bounds.width+1,JSON.stringify(bounds));assert.ok(bounds.documentScroll<=bounds.documentWidth+1,JSON.stringify(bounds));
  pass(`${scheme}: homepage fits a 640px desktop window`,bounds);
  const card=page.locator('[data-project-id]').filter({has:page.getByRole('button',{name:'关联会话',exact:true})}).first();
  await card.getByRole('button',{name:'关联会话',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'关联会话',exact:true});await dialog.waitFor();
  await dialog.getByLabel('搜索会话',{exact:true}).focus();
  await page.screenshot({path:path.join(out,`session-${scheme}-narrow.png`)});
  const modal=await dialog.evaluate(element=>({width:element.clientWidth,scrollWidth:element.scrollWidth,height:element.clientHeight,viewport:window.innerHeight,top:element.getBoundingClientRect().top}));
  assert.ok(modal.scrollWidth<=modal.width+1,JSON.stringify(modal));assert.ok(modal.height<modal.viewport,JSON.stringify(modal));assert.ok(modal.top>=0,JSON.stringify(modal));
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent?.trim()),'关联会话');
  pass(`${scheme}: Session picker fits the narrow viewport and restores focus`,modal);
 }
 assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.failure=String(error.stack||error).replace(/token=[^\s&]+/g,'token=[redacted]');await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{if(original)await theme(original).catch(()=>{});report.finishedAt=new Date().toISOString();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({status:report.status,checks:report.checks.length,report:path.join(out,'report.json'),failure:report.failure}));}

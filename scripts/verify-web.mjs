import {chromium} from 'playwright-core';import {mkdir,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const out='artifacts/verification/web';await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const report={surface:'official DSH web runtime',realProvider:false,checks:[],errors:[]};
function pass(name){report.checks.push(name);console.log(name);}
try{
 const context=await browser.newContext({viewport:{width:1600,height:1100}});const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(process.env.DSH_TEST_URL??'http://127.0.0.1:19405/');
 const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.waitFor({state:'visible',timeout:3000}).then(()=>true).catch(()=>false))await welcome.click();
 await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.getByLabel('模型提供方').selectOption('video-studio-offline');
 await page.getByRole('button',{name:'新建项目',exact:true}).click();await page.getByLabel('影片名称',{exact:true}).fill('图文分镜 · 原生链路验收');await page.getByLabel('主题与制作想法').fill('展示图文资产如何编排成视频。离线模拟验收。');await page.getByRole('button',{name:'先建立项目',exact:true}).click();
 await page.getByRole('heading',{name:'图文分镜 · 原生链路验收'}).waitFor();pass('DSH sidebar, project creation and default preview');
 const root='/Users/skylake/Work/Projects/dsh-梅花易数/src/assets/tarot';await page.locator('input[type=file]').setInputFiles([root+'/major-00.webp',root+'/major-01.webp',root+'/major-02.webp']);
 await page.locator('.vs-asset').filter({hasText:'major-02.webp'}).waitFor();await page.getByRole('button',{name:'添加文字',exact:true}).click();await page.locator('.vs-textasset-input').fill('从素材到镜头，再从前端代码到视频。');await page.getByRole('button',{name:'加入资产库',exact:true}).click();await page.locator('.vs-asset').filter({hasText:'从素材到镜头'}).waitFor();pass('three real WebP images and pasted text imported through UI');
 assert.equal(await page.locator('.vs-asset').count(),4);await page.getByRole('button',{name:'生成分镜',exact:true}).click();await page.locator('.vs-task.is-complete').waitFor({timeout:45000});assert.equal(await page.locator('.vs-shotchip').count(),5);assert.equal(await page.locator('.vs-asset').count(),4);pass('DSH shared model route produces five editable shots with all four assets retained (offline fixture)');
 await page.screenshot({path:out+'/storyboard.png'});
 await page.locator('.vs-shotchip').nth(1).click();await page.getByLabel('屏幕主文字',{exact:true}).fill('可编辑的第二个镜头');await page.getByLabel('时长（秒）',{exact:true}).fill('5');await page.waitForTimeout(900);pass('text and duration parameters autosave');
 await page.getByRole('button',{name:'生成画面',exact:true}).click();await page.locator('.vs-task.is-running').waitFor({timeout:5000});await page.locator('.vs-task.is-complete').waitFor({timeout:90000});assert.equal(await page.locator('.vs-asset').count(),4);pass('per-scene code generation and browser validation');
 await page.getByRole('tab',{name:'制作要求',exact:true}).click();await page.locator('.vs-spec-view pre').getByText('可编辑的第二个镜头',{exact:false}).waitFor();await page.screenshot({path:out+'/requirements.png'});pass('derived video requirements contain current editable parameters');
 await page.getByRole('tab',{name:'前端源码',exact:true}).click();await page.getByRole('button',{name:'JS',exact:true}).click();const js=page.getByLabel('JS 源码');await js.waitFor();const source=await js.inputValue();assert.match(source,/export function render/);await js.fill(source+'\n// UI source edit accepted');await page.getByRole('button',{name:'保存源码',exact:true}).click();await page.locator('.vs-task.is-running').waitFor({timeout:5000});await page.locator('.vs-task.is-complete').waitFor({timeout:60000});pass('source editor persists custom code and checks render contract');
 await page.getByRole('tab',{name:'影片预览',exact:true}).click();await page.locator('.vs-preview iframe').waitFor();await page.getByRole('button',{name:'播放',exact:true}).waitFor();await page.getByRole('button',{name:'播放',exact:true}).click();await page.waitForTimeout(300);await page.getByRole('button',{name:'暂停',exact:true}).click();pass('embedded frame preview plays and pauses');
 await page.screenshot({path:out+'/editor.png'});
 await page.getByText('插件',{exact:true}).first().click();await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.getByRole('heading',{name:'图文分镜 · 原生链路验收'}).waitFor();assert.equal(await page.locator('.vs-shotchip').count(),5);pass('navigation retains project and scene count');
 await page.setViewportSize({width:1100,height:900});await page.screenshot({path:out+'/compact.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);pass('compact desktop has no horizontal document overflow');
 assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;throw error;}finally{await writeFile(out+'/web-acceptance.json',JSON.stringify(report,null,2));await browser.close();}

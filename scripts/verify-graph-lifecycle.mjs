// Run from the plugin root with DSH_TEST_URL set to the isolated DSH URL.
import {chromium} from 'playwright-core';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {installGraphListenerProbe} from './graph-listener-probe.mjs';

const out=path.resolve('artifacts/verification/graph');await mkdir(out,{recursive:true});
const report={surface:'official DSH isolated web runtime; actual navigation',realProvider:false,errors:[]};
const browser=await chromium.launch({executablePath:process.env.DSH_TEST_BROWSER??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1800,height:1160}});await installGraphListenerProbe(context);const page=await context.newPage();
 page.on('pageerror',error=>report.errors.push(error.message));
 await page.goto(process.env.DSH_TEST_URL??'http://127.0.0.1:19405/');
 const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.waitFor({state:'visible',timeout:3000}).then(()=>true).catch(()=>false))await welcome.click();
 await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.locator('.vs-graph-shell canvas').waitFor();
 report.before=await page.evaluate(()=>({canvases:window.__graphCanvases(),listeners:window.__graphListenerReport()}));
 await page.getByText('插件',{exact:true}).first().click();await page.waitForTimeout(800);
 report.after=await page.evaluate(()=>({canvases:window.__graphCanvases(),listeners:window.__graphListenerReport(),visibleCanvasCount:document.querySelectorAll('.vs-graph-shell canvas').length}));
 await page.screenshot({path:path.join(out,'lifecycle-after-leave.png')});
 const detached=report.after.canvases.filter(canvas=>!canvas.connected);
 assert.ok(detached.length,'navigation must actually unmount the canvas');
 assert.ok(detached.every(canvas=>!canvas.isRendering&&!canvas.eventBound&&canvas.nodes===0),'detached canvas rendering and graph must stop');
 assert.deepEqual(report.after.listeners.filter(item=>!item.connected&&item.active),[],'detached canvas and parent listeners must be removed');
 assert.deepEqual(report.after.listeners.filter(item=>item.target==='document'&&item.active),[],'owned document keyup listener must be removed');
 await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.locator('.vs-graph-shell canvas').waitFor();assert.equal(await page.locator('.vs-graph-shell canvas').count(),1);
 report.afterReopen=await page.evaluate(()=>({canvases:window.__graphCanvases(),listeners:window.__graphListenerReport()}));
 assert.deepEqual(report.errors,[]);report.status='PASS';console.log('PASS graph lifecycle: zero detached listeners, stopped rendering and unique reopened canvas');
}catch(error){report.status='FAIL';report.failure=error.stack;console.error(error);process.exitCode=1;}
finally{report.completedAt=new Date().toISOString();await writeFile(path.join(out,'lifecycle-acceptance.json'),JSON.stringify(report,null,2));await browser.close();}

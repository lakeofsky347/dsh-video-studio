// Run from the plugin root with DSH_TEST_URL set to the isolated DSH URL.
import {chromium} from 'playwright-core';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {installGraphListenerProbe} from './graph-listener-probe.mjs';
const out=path.resolve('artifacts/verification/graph');await mkdir(out,{recursive:true});
const report={surface:'official DSH isolated web runtime',realProvider:false,method:'Actual canvas pointer/wheel/keyboard events; read-only LiteGraph public canvas.data used to locate ports and observe camera; saved project.json read after each mutation.',checks:[],errors:[],limitations:[]};
const browser=await chromium.launch({executablePath:process.env.DSH_TEST_BROWSER??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let root;
async function poll(check,timeout=12000){const start=Date.now();let last;while(Date.now()-start<timeout){try{const value=await check();if(value)return value;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,150));}throw last||new Error('poll timeout');}
function pass(name,evidence){report.checks.push({name,status:'PASS',evidence});console.log('PASS '+name);}
async function saved(){return JSON.parse(await readFile(path.join(root,'project.json'),'utf8'));}
try{
 const context=await browser.newContext({viewport:{width:1800,height:1160}});
 await installGraphListenerProbe(context);
 const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
 await page.goto(process.env.DSH_TEST_URL??'http://127.0.0.1:19405/');
 const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.waitFor({state:'visible',timeout:3000}).then(()=>true).catch(()=>false))await welcome.click();
 await page.getByText('映流 · 视频工作台',{exact:true}).click();
 const title='Graph 实际交互验收 '+new Date().toISOString().replace(/[:.]/g,'-');
 await page.getByRole('button',{name:'新建项目',exact:true}).click();await page.getByLabel('影片名称',{exact:true}).fill(title);await page.getByLabel('主题与制作想法').fill('独立验证 LiteGraph 图交互；不调用模型。');await page.getByRole('button',{name:'先建立项目',exact:true}).click();
 await page.getByRole('heading',{name:title}).waitFor();
 const recent=await poll(async()=>{const all=JSON.parse(await readFile(path.join(process.env.DSH_VIDEO_PROJECTS??'.local/projects','recent.json'),'utf8'));return all.find(item=>item.title===title);});root=recent.path;report.project={title,root,id:recent.id};
 const canvas=page.locator('.vs-graph-shell canvas');await canvas.waitFor();
 async function graph(){return await canvas.evaluate(element=>{const view=element.data,rect=element.getBoundingClientRect();return {rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},scale:view.ds.scale,lowQuality:view.low_quality,lowQualityThreshold:view.low_quality_zoom_threshold,offset:[...view.ds.offset],nodes:view.graph._nodes.map(node=>({id:node.data.id,title:node.title,order:node.data.order,bodyTop:node.data.kind==='shot'?node.shotBodyTop:undefined,assetIds:node.data.shot?.assetIds,referenceIds:node.data.shot?.referenceIds,pos:[...node.pos],size:[...node.size],inputs:node.inputs.map((input,index)=>({type:input.type,name:input.name,link:input.link,pos:node.getInputPos(index)})),outputs:node.outputs.map((output,index)=>({type:output.type,name:output.name,pos:node.getOutputPos(index)}))})),selected:Object.values(view.selected_nodes||{}).map(node=>node.data.id)};});}
 function assertShotLayout(state){for(const node of state.nodes.filter(node=>typeof node.bodyTop==='number')){const lastPortY=Math.max(...node.inputs.map(input=>input.pos[1]-node.pos[1]));assert.ok(node.bodyTop>=lastPortY+20,`body below all ports: ${node.title}`);assert.ok(node.size[1]>=node.bodyTop+142,`card contains full body: ${node.title}`);}}
 async function point(id,kind='body',slot=0){const state=await graph(),node=state.nodes.find(node=>node.id===id);assert.ok(node,`node ${id}`);const world=kind==='input'?node.inputs[slot].pos:kind==='output'?node.outputs[slot].pos:[node.pos[0]+110,node.pos[1]-15];return {x:state.rect.x+(world[0]+state.offset[0])*state.scale,y:state.rect.y+(world[1]+state.offset[1])*state.scale};}
 async function drag(from,to){await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:16});await page.mouse.up();await page.waitForTimeout(800);}
 async function clickNode(id,modifiers=[]){const p=await point(id);await canvas.click({position:{x:p.x-(await canvas.boundingBox()).x,y:p.y-(await canvas.boundingBox()).y},modifiers});}
 let project=await saved();assert.equal(project.shots.length,3);assert.equal(await page.locator('.vs-shotchip').count(),3);pass('独立项目与默认 3 镜头完整链',{shotOrder:project.shotOrder});
 const fitView=await graph();assert.equal(fitView.lowQuality,false);assertShotLayout(fitView);pass('默认自动fit保留中文节点标题与端口绘制且正文与端口分离',{scale:fitView.scale,lowQuality:fitView.lowQuality,threshold:fitView.lowQualityThreshold,titles:fitView.nodes.map(node=>node.title),ports:fitView.nodes.flatMap(node=>[...node.inputs,...node.outputs].map(port=>port.name)),shotLayout:fitView.nodes.filter(node=>typeof node.bodyTop==='number').map(node=>({title:node.title,inputCount:node.inputs.length,bodyTop:node.bodyTop,height:node.size[1]}))});
 await page.screenshot({path:out+'/01-initial.png'});
 const first=project.shots[0].id,second=project.shots[1].id,third=project.shots[2].id;
 const oldPosition=[...project.graph.positions[second]];const start=await point(second);await drag(start,{x:start.x,y:start.y+125});
 project=await poll(async()=>{const value=await saved();return value.graph.positions[second][1]>oldPosition[1]+50?value:false;});pass('画布标题拖动节点并落盘位置',{before:oldPosition,after:project.graph.positions[second]});
 const beforeZoom=await graph();await page.mouse.move(beforeZoom.rect.x+beforeZoom.rect.width*.5,beforeZoom.rect.y+beforeZoom.rect.height*.5);await page.mouse.wheel(0,-180);await page.waitForTimeout(250);const afterZoom=await graph();assert.ok(afterZoom.scale>beforeZoom.scale);pass('实际滚轮缩放',{before:beforeZoom.scale,after:afterZoom.scale});await page.getByTitle('适应画布',{exact:true}).click();
 await clickNode(first);await clickNode(second,['Shift']);assert.deepEqual(new Set((await graph()).selected),new Set([first,second]));await page.getByTitle('选中节点分组',{exact:true}).click();project=await poll(async()=>{const value=await saved();return value.graph.groups.length===1?value:false;});pass('Shift 选择两镜头并创建保存分组',{group:project.graph.groups[0]});
 await page.screenshot({path:out+'/02-drag-zoom-group.png'});
 // Use an optional real image, or a browser-generated WebP fixture so this script is portable.
 const imagePath=process.env.DSH_TEST_IMAGE;
 const imageName=imagePath?path.basename(imagePath):'graph-test.webp';
 const imageInput=imagePath||{name:imageName,mimeType:'image/webp',buffer:Buffer.from(await page.evaluate(()=>{const fixture=document.createElement('canvas');fixture.width=320;fixture.height=180;const ctx=fixture.getContext('2d');ctx.fillStyle='#1d3045';ctx.fillRect(0,0,320,180);ctx.fillStyle='#7bd6bd';ctx.fillRect(35,35,250,110);return fixture.toDataURL('image/webp').split(',')[1];}),'base64')};
 report.testAsset={name:imageName,kind:imagePath?'provided local image':'browser-generated WebP fixture'};
 await page.locator('input[type=file]').setInputFiles(imageInput);await page.locator('.vs-asset').filter({hasText:imageName}).waitFor();await page.waitForTimeout(1000);
 project=await saved();assert.equal(project.assets.length,1);const assetId=project.assets[0].id;pass('导入本地图片资产保持落盘',{asset:project.assets[0].name});
 await page.getByTitle('适应画布',{exact:true}).click();const assetStart=await point(assetId);await drag(assetStart,{x:assetStart.x,y:assetStart.y+245});project=await saved();
 await page.getByTitle('适应画布',{exact:true}).click();await drag(await point(assetId,'output',0),await point(first,'input',1));
 project=await poll(async()=>{const value=await saved();return value.shots.find(shot=>shot.id===first).assetIds.includes(assetId)?value:false;});const assetLinkedGraph=await graph(),assetLinkedNode=assetLinkedGraph.nodes.find(node=>node.id===first);assert.ok(assetLinkedNode.assetIds.includes(assetId));assertShotLayout(assetLinkedGraph);assert.ok(assetLinkedNode.size[1]>fitView.nodes.find(node=>node.id===first).size[1]);pass('图片使用素材端口实际拖连至镜头并随新增端口加高',{shotId:first,assetIds:project.shots.find(shot=>shot.id===first).assetIds,layout:{inputCount:assetLinkedNode.inputs.length,bodyTop:assetLinkedNode.bodyTop,height:assetLinkedNode.size[1]}});
 await drag(await point(assetId,'output',1),await point(second,'input',2));
 project=await poll(async()=>{const value=await saved();return value.shots.find(shot=>shot.id===second).referenceIds.includes(assetId)?value:false;});pass('仅供参考端口与独立 referenceIds 同步',{shotId:second,referenceIds:project.shots.find(shot=>shot.id===second).referenceIds});
 await page.screenshot({path:out+'/03-asset-links.png'});
 const originalOrder=[...project.shotOrder];const input=await point(second,'input',0),state=await graph();await drag(input,{x:state.rect.x+state.rect.width-40,y:state.rect.y+state.rect.height-35});
 project=await poll(async()=>{const value=await saved();return !value.extensions.graphEdges?.some(edge=>edge.from===first&&edge.to===second)?value:false;});
 await page.locator('.vs-chain-note').waitFor();const disconnected={edges:project.extensions.graphEdges,shotOrder:project.shotOrder,stripCount:await page.locator('.vs-shotchip').count()};pass('从上一镜头输入端拖至空白断开主链并显示补链提示',disconnected);
 await drag(await point(first,'output',0),await point(third,'input',0));await drag(await point(third,'output',0),await point(second,'input',0));await drag(await point(second,'output',0),await point('film-output','input',0));
 project=await poll(async()=>{const value=await saved();return JSON.stringify(value.shotOrder)===JSON.stringify([first,third,second])?value:false;});assert.equal(project.extensions.graphEdges.some(edge=>edge.from===second&&edge.to==='film-output'),true);
 const stripTitles=await page.locator('.vs-shotchip span').evaluateAll(elements=>elements.map(element=>element.childNodes[0].textContent));assert.deepEqual(stripTitles,[first,third,second].map(id=>project.shots.find(shot=>shot.id===id).title));const reorderedGraph=await graph();const nodeOrders=[first,third,second].map(id=>({id,order:reorderedGraph.nodes.find(node=>node.id===id).order}));assert.deepEqual(nodeOrders.map(node=>node.order),[0,1,2]);pass('重新实际连线改变主链顺序且底部镜头条和卡内序号同步',{before:originalOrder,after:project.shotOrder,stripTitles,nodeOrders});
 await page.screenshot({path:out+'/04-reordered-chain.png'});
 await clickNode(third);await canvas.focus();await page.keyboard.press('Control+c');await page.keyboard.press('Control+v');project=await poll(async()=>{const value=await saved();return value.shots.length===4?value:false;});const copied=project.shots.find(shot=>![first,second,third].includes(shot.id));assert.ok(copied);assert.equal(await page.locator('.vs-shotchip').count(),4);pass('画布 Ctrl C / Ctrl V 复制镜头并同步镜头条',{copied:copied.id,title:copied.title,count:project.shots.length});
 await clickNode(copied.id);await canvas.focus();await page.keyboard.press('Delete');project=await poll(async()=>{const value=await saved();return value.shots.length===3?value:false;});assert.equal(await page.locator('.vs-shotchip').count(),3);pass('画布 Delete 删除镜头并同步镜头条',{count:project.shots.length});
 await page.getByTitle('撤销 · Ctrl/Cmd Z',{exact:true}).click();project=await poll(async()=>{const value=await saved();return value.shots.some(shot=>shot.id===copied.id)?value:false;});assert.equal(await page.locator('.vs-shotchip').count(),4);pass('撤销恢复删除的镜头、图节点和镜头条',{count:project.shots.length});
 await page.getByTitle('重做 · Ctrl/Cmd Shift Z',{exact:true}).click();project=await poll(async()=>{const value=await saved();return value.shots.length===3?value:false;});assert.equal(await page.locator('.vs-shotchip').count(),3);pass('重做删除且镜头条同步',{count:project.shots.length});
 await clickNode(first);await clickNode(second,['Shift']);assert.deepEqual(new Set((await graph()).selected),new Set([first,second]));await canvas.focus();await page.keyboard.press('Control+d');project=await poll(async()=>{const value=await saved();return value.shots.length===5?value:false;});const multiCopies=project.shots.filter(shot=>![first,second,third].includes(shot.id));assert.equal(multiCopies.length,2);assert.equal(await page.locator('.vs-shotchip').count(),5);pass('画布多选 Ctrl D 一次复制两个镜头且副本全部保存',{copies:multiCopies.map(shot=>({id:shot.id,title:shot.title})),count:project.shots.length});
 await page.getByTitle('撤销 · Ctrl/Cmd Z',{exact:true}).click();project=await poll(async()=>{const value=await saved();return value.shots.length===3?value:false;});pass('一次撤销移除两镜头复制事务',{count:project.shots.length});
 await page.screenshot({path:out+'/05-final-graph.png'});await writeFile(out+'/final-project.json',JSON.stringify(project,null,2));
 const beforeLeave=await page.evaluate(()=>({canvases:window.__graphCanvases(),listeners:window.__graphListenerReport()}));
 await page.getByText('插件',{exact:true}).first().click();await page.waitForTimeout(800);
 const afterLeave=await page.evaluate(()=>({canvases:window.__graphCanvases(),listeners:window.__graphListenerReport(),visibleCanvasCount:document.querySelectorAll('.vs-graph-shell canvas').length}));
 report.lifecycle={beforeLeave,afterLeave};
 const detached=afterLeave.canvases.filter(canvas=>!canvas.connected);
 if(!detached.length)report.limitations.push('DSH 页面切换未实际销毁图画布；本次导航仅验证挂载保留，不能证明 ctx.dispose 的原生桌面销毁。');
 else{const leaked=afterLeave.listeners.filter(item=>!item.connected&&item.active);const docLeaks=afterLeave.listeners.filter(item=>item.target==='document'&&item.active);report.checks.push({name:'离开工作台后 canvas、父元素、document 监听与渲染清理',status:leaked.length||docLeaks.length?'FAIL':'PASS',evidence:{detached,leaked,docLeaks}});console.log('LIFECYCLE '+JSON.stringify({detached,leaked,docLeaks}));}
 await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.getByRole('heading',{name:title}).waitFor();report.lifecycle.afterReopen=await page.evaluate(()=>({canvases:window.__graphCanvases(),listeners:window.__graphListenerReport()}));assert.equal(await page.locator('.vs-graph-shell canvas').count(),1);pass('重新进入工作台显示唯一活动画布',{canvasCount:1});
 assert.deepEqual(report.errors,[]);report.status=report.checks.some(check=>check.status==='FAIL')?'FAIL':'PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;console.error(error);}
finally{report.completedAt=new Date().toISOString();await writeFile(out+'/graph-acceptance.json',JSON.stringify(report,null,2));await browser.close();}
if(report.status==='FAIL')process.exitCode=1;

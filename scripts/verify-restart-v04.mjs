// Compare the same owned host's persistent films, relations and sources across a real restart.
import {chromium,request} from 'playwright-core';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const mode=process.argv[2],url=process.env.DSH_TEST_URL;
assert.ok(['capture','verify'].includes(mode));assert.ok(url);assert.ok(process.env.DSH_NATIVE_CDP);
const out=path.resolve(process.env.DSH_V04_REPORT_DIR??'artifacts/verification/v0.4/native');await mkdir(out,{recursive:true});
const api=await request.newContext();await api.get(url);const base=new URL(url).origin;
async function call(endpoint,payload={}){const response=await api.post(base+'/api/video-studio/'+endpoint,{data:{type:'client-request',rpcId:randomUUID(),method:'video-studio/'+endpoint,payload}});const value=await response.json();assert.equal(value.result?.ok,true,JSON.stringify(value));return value.result.value;}
async function collect(){
  const library=await call('list',{includeArchived:true}),films=[];
  for(const item of library.projects){
    if(item.archived)continue;
    const snapshot=await call('current',{projectId:item.id}),project=snapshot.project;
    const sources=[];for(const shot of project.shots){const source=await call('source',{projectId:project.id,shotId:shot.id});sources.push({shotId:shot.id,sha256:createHash('sha256').update(JSON.stringify(source)).digest('hex')});}
    const outputs=project.outputs.map(({url,...output})=>output);
    films.push({projectId:project.id,revision:project.revision,title:project.title,shots:project.shots,shotOrder:project.shotOrder,assets:project.assets,audioClips:project.audioClips??[],outputs,sources});
  }
  return {bindings:library.bindings,selected:library.selected,films};
}
try{
  const data=await collect();
  if(mode==='capture'){await writeFile(path.join(out,'restart-baseline.json'),JSON.stringify({packageSha256:process.env.DSH_PACKAGE_SHA,capturedAt:new Date().toISOString(),data},null,2)+'\n');console.log('Captured persistent native films and relations');}
  else{
    const baseline=JSON.parse(await readFile(path.join(out,'restart-baseline.json'),'utf8'));
    assert.equal(baseline.packageSha256,process.env.DSH_PACKAGE_SHA);assert.deepEqual(data,baseline.data);
    const browser=await chromium.connectOverCDP(process.env.DSH_NATIVE_CDP);
    try{
      const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('dsh-app://'));assert.ok(page);
      const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.isVisible().catch(()=>false))await welcome.click();
      await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.locator('[data-video-home="true"]').waitFor();
      for(const film of data.films)await page.locator(`[data-project-id="${film.projectId}"]`).waitFor();
      await page.screenshot({path:path.join(out,'restart-home.png')});
      await writeFile(path.join(out,'restart.json'),JSON.stringify({status:'PASS',surface:'owned isolated DSH Desktop after actual process restart',packageSha256:process.env.DSH_PACKAGE_SHA,completedAt:new Date().toISOString(),checks:[
        {name:'same current/related/empty Session bindings survive restart',count:Object.keys(data.bindings).length},
        {name:'film content, assets, audio and output records survive restart',count:data.films.length},
        {name:'editable scene source hashes and film revisions remain unchanged',count:data.films.reduce((sum,film)=>sum+film.sources.length,0)},
        {name:'re-entering native plugin starts on homepage with existing films'}]},null,2)+'\n');
      console.log('PASS native restart: relations, films, sources and homepage');
    }finally{await browser.close();}
  }
}finally{await api.dispose();}

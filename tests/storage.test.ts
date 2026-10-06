import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectStore} from '../src/host/store.ts';
import {createProject,defaultSceneSource} from '../src/core/index.ts';

async function fixture(){const baseDirectory=await mkdtemp(join(tmpdir(),'dsh-storage-'));return {baseDirectory,store:new ProjectStore({baseDirectory}),async close(){await rm(baseDirectory,{recursive:true,force:true});}};}
function source(text:string){return {...defaultSceneSource(),html:'<main>'+text+'</main>',js:'window.label='+JSON.stringify(text)+';'};}

test('a staged failure leaves project and all sources at the previous committed version',async()=>{
  const f=await fixture();try{
    const created=await f.store.create({title:'原子提交'}),project=structuredClone(created.project);project.title='应全部拒绝';project.revision=1;
    const old=await f.store.readSource(created.root,project.shots[0]!);let stages=0;
    const faulty=new ProjectStore({baseDirectory:f.baseDirectory,onCommitPhase(phase){if(phase==='staged'){stages++;throw new Error('fixture: crash before head');}}});
    await assert.rejects(faulty.commit(created.root,project,Object.fromEntries(project.shots.map((shot,i)=>[shot.id,source('新内容'+i)])),{expectedRevision:0}),/before head/);
    assert.equal(stages,1);assert.equal((await f.store.open(created.root)).title,'原子提交');
    for(const shot of project.shots)assert.deepEqual(await f.store.readSource(created.root,shot),old);
    assert.equal((await f.store.history(created.root)).canUndo,false);
    await assert.rejects(stat(join(created.root,'.studio','staging')),error=>(error as NodeJS.ErrnoException).code==='ENOENT');
  }finally{await f.close();}
});

test('committed head is authoritative even when projection is interrupted; reopen repairs every file',async()=>{
  const f=await fixture();try{
    const created=await f.store.create({title:'崩溃恢复'}),project=structuredClone(created.project);project.title='已提交完整版本';project.revision=1;
    const faulty=new ProjectStore({baseDirectory:f.baseDirectory,onCommitPhase(phase){if(phase==='committed')throw new Error('fixture: terminate before projection');}});
    await faulty.commit(created.root,project,Object.fromEntries(project.shots.map((shot,i)=>[shot.id,source('恢复镜头'+i)])),{expectedRevision:0,label:'三镜事务'});
    assert.equal(JSON.parse(await readFile(join(created.root,'project.json'),'utf8')).revision,0);
    for(let i=0;i<project.shots.length;i++)assert.equal((await f.store.readSource(created.root,project.shots[i]!)).html,source('恢复镜头'+i).html);
    const reopened=await new ProjectStore({baseDirectory:f.baseDirectory}).open(created.root);assert.equal(reopened.revision,1);assert.equal(reopened.title,project.title);
    for(let i=0;i<project.shots.length;i++)assert.equal(await readFile(join(created.root,project.shots[i]!.sourcePath,'index.html'),'utf8'),source('恢复镜头'+i).html);
    assert.equal(JSON.parse(await readFile(join(created.root,'project.json'),'utf8')).revision,1);
  }finally{await f.close();}
});

test('persistent undo/redo restores project, all sources and audio refs with monotonic revisions',async()=>{
  const f=await fixture();try{
    const project=createProject('完整历史');project.assets.push({id:'voice',kind:'audio',name:'测试音频引用',description:'storage fixture only',path:'assets/voice.wav',mime:'audio/wav',duration:1});
    const created=await f.store.create({project,assetFiles:[{path:'assets/voice.wav',dataBase64:Buffer.from('fixture-only-no-media-claim').toString('base64')}]});
    const next=structuredClone(created.project);next.title='模型与源码及音轨';next.shots[0]!.narration='模型旁白';next.target.audioMode='mixed';next.audioClips=[{id:'clip',assetId:'voice',role:'voice',shotId:next.shots[0]!.id,startSeconds:0,trimStart:0,volume:.7,fadeIn:0,fadeOut:0,loop:false}];next.revision=1;
    await f.store.commit(created.root,next,{[next.shots[0]!.id]:source('完整修改')},{expectedRevision:0,label:'一次完整变更'});
    const restarted=new ProjectStore({baseDirectory:f.baseDirectory});const before=await restarted.history(created.root);assert.equal(before.entries.length,2);assert.equal(before.cursor,1);
    const undone=await restarted.moveHistory(created.root,'undo',1);assert.equal(undone.revision,2);assert.equal(undone.title,'完整历史');assert.equal(undone.audioClips?.length??0,0);assert.equal(undone.shots[0]!.narration,created.project.shots[0]!.narration);assert.deepEqual(await restarted.readSource(created.root,undone.shots[0]!),defaultSceneSource());
    const redone=await restarted.moveHistory(created.root,'redo',2);assert.equal(redone.revision,3);assert.deepEqual(redone.audioClips,next.audioClips);assert.equal((await restarted.readSource(created.root,redone.shots[0]!)).html,source('完整修改').html);
    assert.ok((await stat(join(created.root,'assets','voice.wav'))).isFile());
    await assert.rejects(restarted.moveHistory(created.root,'undo',2),error=>error instanceof Error&&'code' in error&&error.code==='REVISION_CONFLICT');
    const secondUndo=await restarted.moveHistory(created.root,'undo',3),branch=structuredClone(secondUndo);branch.title='撤销后新的分支';branch.revision=5;await restarted.commit(created.root,branch,{}, {expectedRevision:4});assert.equal((await restarted.history(created.root)).canRedo,false);
  }finally{await f.close();}
});

test('one generation task groups several committed scene edits into one undo step',async()=>{
  const f=await fixture();try{
    const created=await f.store.create({title:'生成任务'});let project=structuredClone(created.project);
    for(let i=0;i<project.shots.length;i++){project.revision++;project=await f.store.commit(created.root,project,{[project.shots[i]!.id]:source('镜头'+i)},{expectedRevision:project.revision-1,historyGroup:'dsh-task-1'});}
    assert.equal((await f.store.history(created.root)).entries.length,2);
    const undone=await f.store.moveHistory(created.root,'undo',3);assert.equal(undone.revision,4);
    for(const shot of undone.shots)assert.deepEqual(await f.store.readSource(created.root,shot),defaultSceneSource());
    const redone=await f.store.moveHistory(created.root,'redo',4);assert.equal(redone.revision,5);
    for(let i=0;i<redone.shots.length;i++)assert.equal((await f.store.readSource(created.root,redone.shots[i]!)).html,source('镜头'+i).html);
  }finally{await f.close();}
});

test('atomic create validates every source and asset before making its project directory',async()=>{
  const f=await fixture();try{
    const project=createProject('无残留创建');const badSources=project.shots.map((shot,i)=>({shotId:shot.id,source:i===2?{html:'x',css:'',js:42} as any:source('source'+i)}));
    await assert.rejects(f.store.create({project,sources:badSources}),/strings/);assert.deepEqual(await readdir(f.baseDirectory),[]);
    project.assets.push({id:'image',kind:'image',name:'图片',description:'storage fixture only',path:'assets/a.png',mime:'image/png'});
    await assert.rejects(f.store.create({project,assetFiles:[{path:'../escape',dataBase64:'eA=='}]}),/路径/);assert.deepEqual(await readdir(f.baseDirectory),[]);
    await assert.rejects(f.store.create({project,assetFiles:[]}),/缺少/);assert.deepEqual(await readdir(f.baseDirectory),[]);
    const failed=new ProjectStore({baseDirectory:f.baseDirectory,onCommitPhase(phase){if(phase==='staged')throw new Error('fixture: new project disk failure');}});
    await assert.rejects(failed.create({project,assetFiles:[{path:'assets/a.png',dataBase64:'eA=='}]}),/disk failure/);assert.deepEqual(await readdir(f.baseDirectory),[]);
    const created=await f.store.create({project,sources:project.shots.map((shot,i)=>({shotId:shot.id,source:source('source'+i)})),assetFiles:[{path:'assets/a.png',dataBase64:'eA=='}]});
    assert.equal(created.project.revision,0);assert.equal((await f.store.readSource(created.root,created.project.shots[2]!)).html,source('source2').html);assert.equal(await readFile(join(created.root,'assets','a.png'),'utf8'),'x');
  }finally{await f.close();}
});

test('legacy plain projects migrate as an undoable baseline without overwriting edited source',async()=>{
  const f=await fixture();try{
    const root=join(f.baseDirectory,'legacy');await mkdir(root);const project=createProject('旧工程');await writeFile(join(root,'project.json'),JSON.stringify(project));
    for(const shot of project.shots)await f.store.writeSource(root,shot,source('旧编辑内容'));
    const opened=await f.store.open(root);assert.equal(opened.revision,0);assert.equal((await f.store.readSource(root,opened.shots[0]!)).html,source('旧编辑内容').html);
    const next=structuredClone(opened);next.revision=1;await f.store.commit(root,next,{[next.shots[0]!.id]:source('新版')});
    const undone=await f.store.moveHistory(root,'undo',1);assert.equal((await f.store.readSource(root,undone.shots[0]!)).html,source('旧编辑内容').html);
    await assert.rejects(f.store.writeSource(root,undone.shots[0]!,source('越过事务')),/commit/);
  }finally{await f.close();}
});

test('explicit old revision reads survive shot deletion, source path changes and grouped intermediate commits',async()=>{
  const f=await fixture();try{
    const created=await f.store.create({title:'版本绑定源码'}),original=created.project.shots[0]!;
    let next=structuredClone(created.project);next.shots[0]!.sourcePath='shots/relocated';next.revision=1;
    await f.store.commit(created.root,next,{[original.id]:source('移到新路径')},{expectedRevision:0,historyGroup:'fixture-group'});
    next.shots=next.shots.filter(shot=>shot.id!==original.id);next.shotOrder=next.shotOrder.filter(id=>id!==original.id);next.revision=2;
    await f.store.commit(created.root,next,{}, {expectedRevision:1,historyGroup:'fixture-group'});
    const restarted=new ProjectStore({baseDirectory:f.baseDirectory});
    await assert.rejects(restarted.readSource(created.root,original),error=>(error as NodeJS.ErrnoException).code==='ENOENT');
    assert.deepEqual(await restarted.readSource(created.root,original,0),defaultSceneSource());
    assert.deepEqual(await restarted.readSource(created.root,original.sourcePath,0),defaultSceneSource());
    assert.equal((await restarted.readSource(created.root,original,1)).html,source('移到新路径').html);
    assert.equal((await restarted.readSource(created.root,'shots/relocated',1)).html,source('移到新路径').html);
    await assert.rejects(restarted.readSource(created.root,original,3),/尚未提交/);
  }finally{await f.close();}
});

test('separate store instances serialize one project and preserve duplicate sources/assets without bindings/history',async()=>{
  const f=await fixture();try{
    const project=createProject('独立复制');project.sessionIds=['session-a'];project.extensions.sessionIds=['session-a'];project.assets.push({id:'image',kind:'image',name:'存储示例',description:'fixture only',path:'assets/image.png',mime:'image/png'});
    const created=await f.store.create({project,assetFiles:[{path:'assets/image.png',dataBase64:'eA=='}]}),a=structuredClone(created.project),b=structuredClone(created.project);a.title='竞争 A';b.title='竞争 B';a.revision=1;b.revision=1;
    const rival=new ProjectStore({baseDirectory:f.baseDirectory});const results=await Promise.allSettled([f.store.commit(created.root,a,{[a.shots[0]!.id]:source('保留源码')},{expectedRevision:0}),rival.commit(created.root,b,{}, {expectedRevision:0})]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const current=await f.store.open(created.root);assert.equal(current.title,'竞争 A');const copied=await f.store.duplicate(created.root,'新副本');assert.notEqual(copied.project.id,current.id);assert.equal(copied.project.title,'新副本');assert.equal(copied.project.revision,0);assert.deepEqual(copied.project.sessionIds,[]);assert.equal(copied.project.extensions.sessionIds,undefined);assert.deepEqual(copied.project.outputs,[]);assert.equal((await f.store.history(copied.root)).canUndo,false);
    assert.equal(await readFile(join(copied.root,'assets','image.png'),'utf8'),'x');assert.deepEqual(await f.store.readSource(copied.root,copied.project.shots[0]!),source('保留源码'));assert.equal(current.sessionIds![0],'session-a');
  }finally{await f.close();}
});

test('content undo/redo preserves completed outputs and current session associations across older versions and restart',async()=>{
  const f=await fixture();try{
    const created=await f.store.create({title:'内容初稿'});let project=structuredClone(created.project);project.title='内容二稿';project.revision=1;project=await f.store.commit(created.root,project,{[project.shots[0]!.id]:source('内容二稿')},{expectedRevision:0});
    project.title='内容三稿';project.revision=2;project=await f.store.commit(created.root,project,{[project.shots[0]!.id]:source('内容三稿')},{expectedRevision:1});
    project.outputs=[{id:'completed-output',path:join(created.root,'exports','completed-output','video.mp4'),createdAt:new Date().toISOString(),revision:2,width:1920,height:1080,frameCount:900,duration:30}];project.sessionIds=['current-session'];project.extensions.sessionIds=['current-session'];project.revision=3;project=await f.store.commit(created.root,project,{}, {expectedRevision:2,label:'完成产物和关联'});const outputs=structuredClone(project.outputs);
    for(const expectedTitle of ['内容三稿','内容二稿','内容初稿']){project=await f.store.moveHistory(created.root,'undo',project.revision);assert.equal(project.title,expectedTitle);assert.deepEqual(project.outputs,outputs);assert.deepEqual(project.sessionIds,['current-session']);assert.deepEqual(project.extensions.sessionIds,['current-session']);}
    const reopened=await new ProjectStore({baseDirectory:f.baseDirectory}).open(created.root);assert.deepEqual(reopened.outputs,outputs);assert.deepEqual(reopened.sessionIds,['current-session']);assert.deepEqual(reopened.extensions.sessionIds,['current-session']);assert.deepEqual(await f.store.readSource(created.root,reopened.shots[0]!),defaultSceneSource());
    const redone=await f.store.moveHistory(created.root,'redo',reopened.revision);assert.equal(redone.title,'内容二稿');assert.deepEqual(redone.outputs,outputs);assert.deepEqual(redone.sessionIds,['current-session']);assert.deepEqual(redone.extensions.sessionIds,['current-session']);
  }finally{await f.close();}
});

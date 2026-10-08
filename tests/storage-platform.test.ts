import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {syncDirectory} from '../src/host/directory-sync.ts';
import {ProjectStore} from '../src/host/store.ts';
import {defaultSceneSource} from '../src/core/index.ts';

function errno(code:string){return Object.assign(new Error('fixture: '+code),{code});}

test('Windows directory open and sync limitations are optional, and opened handles are closed',async()=>{
  for(const code of ['EINVAL','ENOTSUP','EISDIR','ENOSYS','EPERM','EACCES']){
    await syncDirectory('fixture',{platform:'win32',open:async()=>{throw errno(code);}});
  }
  for(const code of ['EINVAL','ENOTSUP','EISDIR','ENOSYS','EPERM','EACCES','EBADF']){
    let closed=0;
    await syncDirectory('fixture',{platform:'win32',open:async()=>({sync:async()=>{throw errno(code);},close:async()=>{closed++;}})});
    assert.equal(closed,1,code);
  }
});

test('Unix permission errors and real I/O errors are reported for both directory open and sync',async()=>{
  for(const platform of ['linux','darwin','win32'] as const){
    const codes=platform==='win32'?['EIO','ENOENT','ENOSPC']:['EPERM','EACCES','EBADF','EIO','ENOENT','ENOSPC'];
    for(const code of codes){
      const error=errno(code);let closed=0;
      await assert.rejects(syncDirectory('fixture',{platform,open:async()=>{throw error;}}),value=>value===error);
      await assert.rejects(syncDirectory('fixture',{platform,open:async()=>({sync:async()=>{throw error;},close:async()=>{closed++;}})}),value=>value===error);
      assert.equal(closed,1,platform+': '+code);
    }
  }
  const invalidHandle=errno('EBADF');
  await assert.rejects(syncDirectory('fixture',{platform:'win32',open:async()=>{throw invalidHandle;}}),value=>value===invalidHandle);
});

test('directory close errors remain visible, including after an unsupported directory sync',async()=>{
  for(const syncFailure of [undefined,errno('EINVAL')]){
    const closeFailure=errno('EIO');
    await assert.rejects(syncDirectory('fixture',{platform:'win32',open:async()=>({sync:async()=>{if(syncFailure)throw syncFailure;},close:async()=>{throw closeFailure;}})}),value=>value===closeFailure);
  }
});

test('saving, revision indexing, undo/redo and projection repair succeed without directory-open support',async t=>{
  const baseDirectory=await fs.mkdtemp(join(tmpdir(),'storage-platform-'));
  const originalOpen=fs.open;let directoryAttempts=0,versionAttempts=0;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    if(args[1]==='r'){
      directoryAttempts++;
      if(String(args[0]).endsWith(join('.studio','versions')))versionAttempts++;
      throw errno('EINVAL');
    }
    return originalOpen(...args);
  });
  try{
    const store=new ProjectStore({baseDirectory}),created=await store.create({title:'跨平台存储'});
    const next=structuredClone(created.project);next.revision=1;next.title='完整保存';
    const source={...defaultSceneSource(),html:'<main>已保存源码</main>'};
    await store.commit(created.root,next,{[next.shots[0]!.id]:source},{expectedRevision:0});
    const interrupted=new ProjectStore({baseDirectory,onCommitPhase(phase){if(phase==='committed')throw new Error('fixture: projection interrupted');}});
    next.revision=2;next.title='提交后恢复';
    await interrupted.commit(created.root,next,{}, {expectedRevision:1});
    assert.equal(JSON.parse(await fs.readFile(join(created.root,'project.json'),'utf8')).revision,1);
    const restarted=new ProjectStore({baseDirectory}),opened=await restarted.open(created.root);
    assert.equal(opened.title,'提交后恢复');assert.equal(opened.revision,2);
    assert.equal(await fs.readFile(join(created.root,next.shots[0]!.sourcePath,'index.html'),'utf8'),source.html);
    assert.deepEqual(await restarted.readSource(created.root,next.shots[0]!,0),defaultSceneSource());
    const undo=await restarted.moveHistory(created.root,'undo',2);assert.equal(undo.title,'完整保存');
    const redo=await restarted.moveHistory(created.root,'redo',undo.revision);assert.equal(redo.title,'提交后恢复');
    assert.equal((await restarted.history(created.root)).canUndo,true);
    assert.ok(directoryAttempts>0);assert.ok(versionAttempts>0,'revision commits also tolerate directory open limitations');
  }finally{await fs.rm(baseDirectory,{recursive:true,force:true});}
});

for(const operation of ['writeFile','sync','rename'] as const){
  test('a real file '+operation+' failure rejects saving, keeps the committed version and removes temporary files',async t=>{
    const baseDirectory=await fs.mkdtemp(join(tmpdir(),'storage-failure-'));
    try{
      const store=new ProjectStore({baseDirectory}),created=await store.create({title:'保留旧版本'});
      const originalOpen=fs.open,originalRename=fs.rename,failure=errno('EIO');let failures=0;
      const stagingSegment=sep+join('.studio','staging')+sep;
      if(operation==='rename'){
        t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{
          if(String(args[1]).includes(stagingSegment)){failures++;throw failure;}
          return originalRename(...args);
        });
      }else{
        t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
          const handle=await originalOpen(...args);
          if(args[1]==='w'&&String(args[0]).includes(stagingSegment)){
            t.mock.method(handle,operation,async()=>{failures++;throw failure;});
          }
          return handle;
        });
      }
      const next=structuredClone(created.project);next.revision=1;next.title='不得提交';
      await assert.rejects(store.commit(created.root,next,{[next.shots[0]!.id]:{...defaultSceneSource(),html:'<main>不得提交</main>'}},{expectedRevision:0}),value=>value===failure);
      assert.equal(failures,1);assert.deepEqual(await fs.readdir(join(created.root,'.studio','staging')),[]);
      t.mock.restoreAll();
      const restarted=new ProjectStore({baseDirectory}),opened=await restarted.open(created.root);
      assert.equal(opened.title,'保留旧版本');assert.equal(opened.revision,0);
      assert.deepEqual(await restarted.readSource(created.root,opened.shots[0]!),defaultSceneSource());
      assert.equal((await restarted.history(created.root)).canUndo,false);
    }finally{await fs.rm(baseDirectory,{recursive:true,force:true});}
  });
}

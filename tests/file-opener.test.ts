import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn, type ChildProcess, type SpawnOptions} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProjectFileOpener,projectOpenPath} from '../src/host/file-opener.ts';
import {StudioService} from '../src/host/service.ts';
import type {HostContext} from '../src/host/platform.ts';

const directory={isDirectory:()=>true,isSymbolicLink:()=>false};
const virtualFs={lstat:async()=>directory,realpath:async(file:string)=>file};
async function fileSymlink(t:TestContext,target:string,link:string):Promise<boolean> {
  try{await symlink(target,link,'file');return true;}
  catch(error){
    if(process.platform==='win32'&&['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??'')){
      t.skip('Windows 文件符号链接需 Developer Mode/权限；该真实符号链接边界未验收');return false;
    }
    throw error;
  }
}
class FakeChild extends EventEmitter {
  exitCode:number|null=null;signalCode:NodeJS.Signals|null=null;
  kills:NodeJS.Signals[]=[];
  constructor(private readonly closeOnKill=true){super();}
  kill(signal:NodeJS.Signals='SIGTERM'):boolean {
    this.kills.push(signal);
    if(this.closeOnKill||signal==='SIGKILL')setTimeout(()=>this.finish(null,signal),5);
    return true;
  }
  finish(code:number|null,signal:NodeJS.Signals|null=null):void {this.exitCode=code;this.signalCode=signal;this.emit('close',code,signal);}
}
function launcher(code:number|null=0,closeOnKill=true){
  const calls:{command:string;args:string[];options:SpawnOptions}[]=[],children:FakeChild[]=[];
  const spawnFake=((command:string,args:string[],options:SpawnOptions)=>{
    const child=new FakeChild(closeOnKill);calls.push({command,args,options});children.push(child);
    queueMicrotask(()=>{child.emit('spawn');if(code!==null)child.finish(code);});return child as unknown as ChildProcess;
  }) as typeof spawn;
  return {spawn:spawnFake,calls,children};
}

test('project file paths accept native Windows drives, casing and UNC roots; reject neighboring folders and other drives',async()=>{
  const options={platform:'win32' as const,fileSystem:virtualFs};
  assert.equal(await projectOpenPath('C:\\视频工程','c:\\视频工程\\exports\\成片 01.mp4',options),'c:\\视频工程\\exports\\成片 01.mp4');
  assert.equal(await projectOpenPath('C:\\视频工程\\','C:\\视频工程',options),'C:\\视频工程');
  assert.equal(await projectOpenPath('\\\\server\\share\\工程','\\\\server\\share\\工程\\成片.mp4',options),'\\\\server\\share\\工程\\成片.mp4');
  for(const target of ['C:\\视频工程-other\\成片.mp4','C:\\视频工程\\..\\外部.mp4','D:\\视频工程\\成片.mp4','\\\\server\\other\\工程\\成片.mp4']){
    await assert.rejects(projectOpenPath('C:\\视频工程',target,options),{code:'PATH_OUTSIDE_PROJECT'});
  }
  await assert.rejects(projectOpenPath('\\\\server\\share\\工程','\\\\server\\share\\工程-other\\成片.mp4',options),{code:'PATH_OUTSIDE_PROJECT'});
});

test('physical project boundaries reject neighboring files, directory links and linked project roots before launching',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'dsh-reveal-boundary-')),root=path.join(base,'工程 空格'),outside=path.join(base,'工程 空格-other');
  const fake=launcher(),opener=new ProjectFileOpener({spawn:fake.spawn});
  try{
    await mkdir(root);await mkdir(outside);await writeFile(path.join(outside,'成片.mp4'),'fixture');
    await symlink(outside,path.join(root,'linked-folder'),process.platform==='win32'?'junction':'dir');
    for(const target of [path.join(outside,'成片.mp4'),path.join(root,'linked-folder','成片.mp4')]){
      await assert.rejects(opener.open(root,target),{code:'PATH_OUTSIDE_PROJECT'});
    }
    await assert.rejects(opener.open(root,path.join(root,'missing.mp4')),{code:'ENOENT'});
    await symlink(root,path.join(base,'linked-project'),process.platform==='win32'?'junction':'dir');
    assert.equal((await lstat(path.join(base,'linked-project'))).isSymbolicLink(),true,'junction and symlink project roots must keep link semantics');
    await assert.rejects(opener.open(path.join(base,'linked-project')),{code:'PATH_OUTSIDE_PROJECT'});
    assert.equal(fake.calls.length,0);
  }finally{await opener.close();await rm(base,{recursive:true,force:true});}
});

test('physical file symlinks cannot open targets outside the project',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'dsh-reveal-file-link-')),root=path.join(base,'工程'),outside=path.join(base,'外部.mp4');
  const fake=launcher(),opener=new ProjectFileOpener({spawn:fake.spawn});
  try{
    await mkdir(root);await writeFile(outside,'fixture');const link=path.join(root,'linked.mp4');
    if(!await fileSymlink(t,outside,link))return;
    await assert.rejects(opener.open(root,link),{code:'PATH_OUTSIDE_PROJECT'});assert.equal(fake.calls.length,0);
  }finally{await opener.close();await rm(base,{recursive:true,force:true});}
});

test('native launcher opens real project directories and Chinese filenames without shell interpretation',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'dsh-reveal-argv-')),root=path.join(base,'工程 空格'),file=path.join(root,'成片 $(echo injected); &.mp4');
  const fake=launcher(),opener=new ProjectFileOpener({spawn:fake.spawn});
  try{
    await mkdir(root);await writeFile(file,'fixture');await opener.open(root);await opener.open(root,file);
    assert.deepEqual(fake.calls.map(call=>call.args),[[await realpath(root)],[await realpath(file)]]);
    const command=process.platform==='win32'?path.win32.join(process.env.SystemRoot??'C:\\Windows','explorer.exe'):process.platform==='darwin'?'/usr/bin/open':'xdg-open';
    for(const call of fake.calls){assert.equal(call.command,command);assert.equal(call.options.shell,false);assert.equal(call.options.stdio,'ignore');}
    if(process.platform!=='win32')await assert.rejects(opener.open(root,root.toUpperCase()),{code:'PATH_OUTSIDE_PROJECT'});
  }finally{await opener.close();await rm(base,{recursive:true,force:true});}
});

test('physical project-local file links hand off their verified target',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'dsh-reveal-internal-link-')),file=path.join(base,'成片.mp4'),link=path.join(base,'linked.mp4');
  const fake=launcher(),opener=new ProjectFileOpener({spawn:fake.spawn});
  try{
    await writeFile(file,'fixture');if(!await fileSymlink(t,file,link))return;
    await opener.open(base,link);assert.deepEqual(fake.calls[0]!.args,[await realpath(file)]);
  }finally{await opener.close();await rm(base,{recursive:true,force:true});}
});

for(const [platform,root,target,command] of [
  ['darwin','/项目 空格','/项目 空格/成片.mp4','/usr/bin/open'],
  ['linux','/项目 空格','/项目 空格/成片.mp4','xdg-open'],
  ['win32','C:\\项目 空格','C:\\项目 空格\\成片 & $(calc).mp4','D:\\Windows\\explorer.exe'],
] as const)test(`${platform} delegates the verified absolute filename as one argument`,async()=>{
  const fake=launcher(),opener=new ProjectFileOpener({platform,spawn:fake.spawn,fileSystem:virtualFs,systemRoot:'D:\\Windows'});
  try{
    await opener.open(root,target);assert.equal(fake.calls[0]!.command,command);assert.deepEqual(fake.calls[0]!.args,[target]);
    assert.equal(fake.calls[0]!.options.shell,false);assert.equal(fake.calls[0]!.options.windowsHide,true);
  }finally{await opener.close();}
});

test('Explorer exit 1 acknowledges system handoff; other launcher failures remain failures',async()=>{
  for(const [platform,code,ok] of [['win32',1,true],['win32',2,false],['darwin',1,false],['linux',1,false]] as const){
    const fake=launcher(code),opener=new ProjectFileOpener({platform,spawn:fake.spawn,fileSystem:virtualFs});
    try{
      const opened=opener.open(platform==='win32'?'C:\\工程':'/工程');
      if(ok)await opened;else await assert.rejects(opened,{code:'FILE_OPEN_FAILED'});
      assert.equal(fake.children[0]!.kills.length,0);
    }finally{await opener.close();}
  }
});

test('missing desktop launcher produces a readable error and releases ownership',async()=>{
  const child=new FakeChild(),spawnFake=(()=>{queueMicrotask(()=>child.emit('error',Object.assign(new Error('ENOENT'),{code:'ENOENT'})));return child as unknown as ChildProcess;}) as typeof spawn;
  const opener=new ProjectFileOpener({platform:'linux',spawn:spawnFake,fileSystem:virtualFs});
  await assert.rejects(opener.open('/工程'),{code:'FILE_OPEN_FAILED',message:'无法启动系统文件打开程序：ENOENT'});await opener.close();assert.equal(child.kills.length,0);
});

test('synchronous spawn failure does not register an undefined child or hang disposal',{timeout:1000},async()=>{
  const spawnFake=(()=>{throw new Error('synchronous spawn failure');}) as typeof spawn;
  const opener=new ProjectFileOpener({platform:'linux',spawn:spawnFake,fileSystem:virtualFs});
  await assert.rejects(opener.open('/工程'),{code:'FILE_OPEN_FAILED',message:'无法启动系统文件打开程序：synchronous spawn failure'});
  await opener.close();await assert.rejects(opener.open('/工程'),{code:'FILE_OPEN_CANCELLED'});
});

test('launcher timeout kills its owned helper and waits for close, including escalation',async()=>{
  const fake=launcher(null,false),opener=new ProjectFileOpener({platform:'linux',spawn:fake.spawn,fileSystem:virtualFs,timeoutMs:10,killGraceMs:10});
  try{
    await assert.rejects(opener.open('/工程'),{code:'FILE_OPEN_TIMEOUT'});
    assert.deepEqual(fake.children[0]!.kills,['SIGTERM','SIGKILL']);assert.equal(fake.children[0]!.signalCode,'SIGKILL');
  }finally{await opener.close();}
});

test('close cancels all owned helpers without waiting for normal handoff',async()=>{
  const fake=launcher(null),opener=new ProjectFileOpener({platform:'linux',spawn:fake.spawn,fileSystem:virtualFs,timeoutMs:30_000});
  const opened=opener.open('/工程'),rejected=assert.rejects(opened,{code:'FILE_OPEN_CANCELLED'});
  while(fake.children.length===0)await new Promise(resolve=>setTimeout(resolve,1));
  await opener.close();await rejected;assert.deepEqual(fake.children[0]!.kills,['SIGTERM']);assert.equal(fake.children[0]!.signalCode,'SIGTERM');
  await assert.rejects(opener.open('/工程'),{code:'FILE_OPEN_CANCELLED'});
});

test('closing during path validation prevents a helper from being spawned afterwards',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),fake=launcher();
  const opener=new ProjectFileOpener({platform:'linux',spawn:fake.spawn,fileSystem:{...virtualFs,realpath:async(file:string)=>{await gate;return file;}}});
  const rejected=assert.rejects(opener.open('/工程'),{code:'FILE_OPEN_CANCELLED'});await opener.close();release();await rejected;assert.equal(fake.calls.length,0);
});

test('timeout stops an actual owned subprocess without launching a desktop application',async()=>{
  const children:ChildProcess[]=[],spawnFixture=((_command:string,_args:string[],options:SpawnOptions)=>{
    const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],options);children.push(child);return child;
  }) as typeof spawn;
  const opener=new ProjectFileOpener({platform:'linux',spawn:spawnFixture,fileSystem:virtualFs,timeoutMs:60,killGraceMs:30});
  try{await assert.rejects(opener.open('/工程'),{code:'FILE_OPEN_TIMEOUT'});assert.ok(children[0]!.exitCode!==null||children[0]!.signalCode!==null);}
  finally{await opener.close();}
});

test('service reveal uses the platform helper and disposal cancels it before waiting for queued commands',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'dsh-service-reveal-')),fake=launcher(null);
  const opener=new ProjectFileOpener({spawn:fake.spawn,timeoutMs:30_000});
  const context={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('unexpected model call');}}} as unknown as HostContext;
  const service=new StudioService(context,{baseDirectory:base,restoreRecent:false,fileOpener:opener});
  service.renderer.assetBaseUrl=async()=> 'http://127.0.0.1:1/';service.renderer.preview=async()=> 'http://127.0.0.1:1/';service.renderer.audioPreview=async()=>null;
  try{
    const created=await service.rpc('create',{title:'打开工程'});assert.equal(created.ok,true);const snapshot=await service.snapshot();
    const outside=await service.rpc('reveal',{path:base});assert.equal(outside.ok,false);if(!outside.ok)assert.equal(outside.error.code,'PATH_OUTSIDE_PROJECT');
    const opened=service.rpc('reveal',{});while(fake.children.length===0)await new Promise(resolve=>setTimeout(resolve,1));
    assert.deepEqual(fake.calls[0]!.args,[await realpath(snapshot.root!)]);await service.dispose();
    const result=await opened;assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'FILE_OPEN_CANCELLED');
    assert.deepEqual(fake.children[0]!.kills,['SIGTERM']);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});

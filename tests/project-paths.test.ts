import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProject,defaultSceneSource,validateProject} from '../src/core/index.ts';
import {inspectProjectPaths,portableProjectPathReason,safeRelativeProjectPath} from '../src/core/project-paths.ts';
import {ProjectStore,projectPath,validateStoredProject} from '../src/host/store.ts';
import type {VideoProject} from '../src/shared/types.ts';

const rejectedSegments=['CON','con.txt','NUL.png','aux.tar.gz','PRN','COM1.txt','lpt9','COM¹.wav','LPT²','CONIN$','CONOUT$.txt','con .txt','bad.','bad ','a:b.png','a?.png','a*.png','a|b','a"b','a<b','a>b','control\u0001','control\u007f','control\u0085'];

test('portable paths reject Windows device names, ADS, forbidden characters and trailing dots/spaces in every segment',()=>{
  for(const segment of rejectedSegments){
    assert.ok(portableProjectPathReason('assets/'+segment),JSON.stringify(segment));
    assert.ok(portableProjectPathReason('shots/'+segment+'/scene'),JSON.stringify(segment));
  }
  for(const relative of ['assets/中文 图片.png','shots/镜头😀','assets/COM10.png','assets/conway.png','assets/.hidden','assets/v1.2/image #1.png']){
    assert.equal(portableProjectPathReason(relative),undefined,relative);
  }
  for(const relative of ['shots/bad\uD800','shots/bad\uD801','assets/bad\uDC00.png'])assert.ok(portableProjectPathReason(relative));
});

test('basic relative path safety rejects escape forms while keeping readable Unix legacy names',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'path-safety-'));
  try{
    for(const relative of ['../escape','shots/../escape','/absolute','C:/absolute','C:relative','\\\\server\\share','shots\\scene','shots//scene','shots/./scene','shots/','shots/zero\0','shots/bad\uD800','shots/bad\uD801','assets/bad\uDC00.png']){
      assert.equal(safeRelativeProjectPath(relative),false,relative);
      await assert.rejects(projectPath(root,relative),/Invalid project-relative path/);
    }
    assert.equal(safeRelativeProjectPath('shots/CON'),true);
    assert.equal(safeRelativeProjectPath('assets/local:legacy.png'),true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('case and Unicode aliases and nested source/media locations are diagnosed without assuming host filesystem behavior',()=>{
  for(const [a,b] of [['shots/Scene','shots/scene'],['shots/Scene','shots/scene/Child'],['shots/scene','shots/scene/child'],['shots/é','shots/e\u0301'],['shots/Σ','shots/ς'],['shots/I','shots/ı'],['shots/S','shots/ſ'],['shots/ẞ','shots/ß']]){
    const project=createProject('源码冲突');project.shots[0]!.sourcePath=a!;project.shots[1]!.sourcePath=b!;
    const issue=inspectProjectPaths(project).find(item=>item.code==='conflict');
    assert.ok(issue,a+' / '+b);assert.deepEqual(new Set(issue.paths),new Set([a,b]));
  }
  for(const [a,b] of [['assets/Cover.png','assets/cover.png'],['assets/Images/a.png','assets/images/b.png'],['assets/file','assets/file/child.png'],['assets/ß.png','assets/SS.png']]){
    const project=createProject('资产冲突');project.assets=[{id:'a',kind:'image',name:'A',description:'',path:a},{id:'b',kind:'image',name:'B',description:'',path:b}];
    assert.ok(inspectProjectPaths(project).some(item=>item.code==='conflict'),a+' / '+b);
  }
  const shared=createProject('同文件引用');shared.assets=[{id:'a',kind:'image',name:'A',description:'',path:'assets/shared.png'},{id:'b',kind:'image',name:'B',description:'',path:'assets/shared.png'}];
  assert.deepEqual(inspectProjectPaths(shared),[]);assert.doesNotThrow(()=>validateStoredProject(shared));
});

test('core default validation exposes legacy portability warnings; strict validation prevents new writes',()=>{
  const project=createProject('旧路径');project.shots[0]!.sourcePath='shots/CON.txt';
  const legacy=validateProject(project);assert.equal(legacy.ok,true);assert.match(legacy.warnings.join('\n'),/CON.txt.*不能跨平台/);
  assert.equal(validateProject(project,{portablePaths:true}).ok,false);
  assert.doesNotThrow(()=>validateStoredProject(project,{portablePaths:false}));
  assert.throws(()=>validateStoredProject(project),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_NOT_PORTABLE');
});

test('new project creation rejects nonportable and colliding paths before registering files or directories',async()=>{
  const baseDirectory=await fs.mkdtemp(join(tmpdir(),'path-create-')),store=new ProjectStore({baseDirectory});
  try{
    for(const segment of rejectedSegments){
      const project=createProject('拒绝创建');project.shots[0]!.sourcePath='shots/'+segment;
      await assert.rejects(store.create({project}),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_NOT_PORTABLE');
      assert.deepEqual(await fs.readdir(baseDirectory),[]);
    }
    const project=createProject('大小写冲突');project.shots[0]!.sourcePath='shots/Scene';project.shots[1]!.sourcePath='shots/scene';
    await assert.rejects(store.create({project}),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_CONFLICT');
    assert.deepEqual(await fs.readdir(baseDirectory),[]);
    project.shots[1]!.sourcePath='shots/other';project.assets=[{id:'bad',kind:'image',name:'素材',description:'',path:'assets/NUL.png'}];
    await assert.rejects(store.create({project,assetFiles:[{path:'assets/NUL.png',dataBase64:'eA=='}]}),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_NOT_PORTABLE');
    assert.deepEqual(await fs.readdir(baseDirectory),[]);
  }finally{await fs.rm(baseDirectory,{recursive:true,force:true});}
});

test('rejected path changes preserve project history, sources and media; exact shared media references remain supported',async()=>{
  const baseDirectory=await fs.mkdtemp(join(tmpdir(),'path-commit-')),store=new ProjectStore({baseDirectory});
  try{
    const project=createProject('保留工程');project.assets=[{id:'a',kind:'image',name:'A',description:'',path:'assets/shared.png'},{id:'b',kind:'image',name:'B',description:'',path:'assets/shared.png'}];
    const created=await store.create({project,assetFiles:[{path:'assets/shared.png',dataBase64:'eA=='}]}),next=structuredClone(created.project);
    next.revision=1;next.shots[0]!.sourcePath='shots/Scene';next.shots[1]!.sourcePath='shots/scene';
    await assert.rejects(store.commit(created.root,next),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_CONFLICT');
    next.shots[1]!.sourcePath='shots/other';next.assets[1]!.path='assets/SHARED.png';
    await assert.rejects(store.commit(created.root,next),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_CONFLICT');
    const reopened=await store.open(created.root);assert.deepEqual(reopened.shots,created.project.shots);assert.equal(reopened.revision,0);
    assert.deepEqual(await store.readSource(created.root,reopened.shots[0]!),defaultSceneSource());
    assert.equal((await store.history(created.root)).canUndo,false);assert.equal(await fs.readFile(join(created.root,'assets/shared.png'),'utf8'),'x');
    assert.equal((await fs.readdir(join(created.root,'.studio/versions'))).length,1);
  }finally{await fs.rm(baseDirectory,{recursive:true,force:true});}
});

async function legacySnapshot(baseDirectory:string,project:VideoProject){
  const root=join(baseDirectory,'legacy');await fs.mkdir(join(root,'.studio','versions'),{recursive:true});
  const source={...defaultSceneSource(),html:'<main>保留旧版源码</main>'};
  const record={version:1,id:'legacy',label:'既有工程',createdAt:project.createdAt,project,sources:Object.fromEntries(project.shots.map(shot=>[shot.id,source]))};
  await fs.writeFile(join(root,'.studio','versions','legacy.json'),JSON.stringify(record));
  await fs.writeFile(join(root,'.studio','state.json'),JSON.stringify({version:1,current:'legacy',undo:[],redo:[]}));
  return {root,source};
}

test('legacy snapshots remain readable with diagnostics and source reads leave every existing file unchanged',async()=>{
  const baseDirectory=await fs.mkdtemp(join(tmpdir(),'path-legacy-read-'));
  try{
    const project=createProject('旧版本读取');project.shots[0]!.sourcePath='shots/CON';project.assets=[{id:'legacy',kind:'image',name:'旧素材',description:'',path:'assets/image:legacy.png'}];
    const {root,source}=await legacySnapshot(baseDirectory,project),store=new ProjectStore({baseDirectory});
    const state=await fs.readFile(join(root,'.studio','state.json')),snapshot=await fs.readFile(join(root,'.studio','versions','legacy.json'));
    assert.deepEqual(await store.readSource(root,project.shots[0]!),source);assert.equal((await store.history(root)).entries.length,1);
    assert.deepEqual(await fs.readFile(join(root,'.studio','state.json')),state);
    assert.deepEqual(await fs.readFile(join(root,'.studio','versions','legacy.json')),snapshot);
    assert.deepEqual(await fs.readdir(root),['.studio']);assert.equal(validateProject(project).ok,true);assert.ok(validateProject(project).warnings.length>=2);
    if(process.platform!=='win32'){
      const opened=await store.open(root);assert.equal(opened.shots[0]!.sourcePath,'shots/CON');
      const next=structuredClone(opened);next.revision=1;
      await assert.rejects(store.commit(root,next),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_NOT_PORTABLE');
    }
  }finally{await fs.rm(baseDirectory,{recursive:true,force:true});}
});

test('conflicting legacy snapshots reject projection before changing source files or committed metadata',async()=>{
  const baseDirectory=await fs.mkdtemp(join(tmpdir(),'path-legacy-conflict-'));
  try{
    const project=createProject('旧版冲突');project.shots[0]!.sourcePath='shots/Scene';project.shots[1]!.sourcePath='shots/scene';
    const {root}=await legacySnapshot(baseDirectory,project);await fs.mkdir(join(root,'shots','Scene'),{recursive:true});
    await fs.writeFile(join(root,'shots','Scene','index.html'),'original source');await fs.writeFile(join(root,'project.json'),'original project projection');
    const state=await fs.readFile(join(root,'.studio','state.json')),store=new ProjectStore({baseDirectory});
    await assert.rejects(store.open(root),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_CONFLICT'&&/shots\/Scene/.test((error as Error).message)&&/shots\/scene/.test((error as Error).message));
    assert.equal(await fs.readFile(join(root,'shots','Scene','index.html'),'utf8'),'original source');
    assert.equal(await fs.readFile(join(root,'project.json'),'utf8'),'original project projection');
    assert.deepEqual(await fs.readFile(join(root,'.studio','state.json')),state);assert.deepEqual(await fs.readdir(join(root,'shots')),['Scene']);
    assert.ok((await store.readSource(root,project.shots[0]!)).html.includes('保留旧版'));
  }finally{await fs.rm(baseDirectory,{recursive:true,force:true});}
});

test('plain legacy conflicts are diagnosed before migration creates .studio metadata',async()=>{
  const baseDirectory=await fs.mkdtemp(join(tmpdir(),'path-legacy-migrate-'));
  try{
    const project=createProject('旧版未迁移');project.shots[0]!.sourcePath='shots/Scene';project.shots[1]!.sourcePath='shots/scene';
    const root=join(baseDirectory,'legacy');await fs.mkdir(root);const bytes=JSON.stringify(project);await fs.writeFile(join(root,'project.json'),bytes);
    await assert.rejects(new ProjectStore({baseDirectory}).open(root),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_CONFLICT');
    const store=new ProjectStore({baseDirectory});
    for(const operation of [()=>store.readSource(root,project.shots[0]!),()=>store.writeSource(root,project.shots[0]!,defaultSceneSource()),()=>store.markSourceGood(root,project.shots[0]!),()=>store.restorationSource(root,project.shots[0]!)]){
      await assert.rejects(operation(),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_CONFLICT');
    }
    assert.equal(await fs.readFile(join(root,'project.json'),'utf8'),bytes);assert.deepEqual(await fs.readdir(root),['project.json']);
  }finally{await fs.rm(baseDirectory,{recursive:true,force:true});}
});

test('Windows legacy nonportable paths are diagnosed before projection or plain-project migration',async()=>{
  const baseDirectory=await fs.mkdtemp(join(tmpdir(),'path-windows-read-')),descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
  try{
    const project=createProject('旧版 Windows 诊断');project.shots[0]!.sourcePath='shots/CON';
    const {root}=await legacySnapshot(baseDirectory,project);Object.defineProperty(process,'platform',{...descriptor,value:'win32'});
    for(const relative of ['shots/CON/index.html','assets/file:stream.png'])await assert.rejects(projectPath(root,relative),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_NOT_PORTABLE');
    await assert.rejects(new ProjectStore({baseDirectory}).open(root),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_NOT_PORTABLE');
    assert.deepEqual(await fs.readdir(root),['.studio']);
    const plain=join(baseDirectory,'plain');await fs.mkdir(plain);const bytes=JSON.stringify(project);await fs.writeFile(join(plain,'project.json'),bytes);
    await assert.rejects(new ProjectStore({baseDirectory}).open(plain),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_NOT_PORTABLE');
    const store=new ProjectStore({baseDirectory});
    for(const operation of [()=>store.readSource(plain,project.shots[0]!),()=>store.writeSource(plain,project.shots[0]!,defaultSceneSource()),()=>store.markSourceGood(plain,project.shots[0]!),()=>store.restorationSource(plain,project.shots[0]!)]){
      await assert.rejects(operation(),error=>(error as NodeJS.ErrnoException).code==='PROJECT_PATH_NOT_PORTABLE');
    }
    assert.deepEqual(await fs.readdir(plain),['project.json']);assert.equal(await fs.readFile(join(plain,'project.json'),'utf8'),bytes);
  }finally{Object.defineProperty(process,'platform',descriptor);await fs.rm(baseDirectory,{recursive:true,force:true});}
});

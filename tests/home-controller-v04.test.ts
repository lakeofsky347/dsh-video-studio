import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../src/client/controller.ts';
import { createProject } from '../src/core/index.ts';
import type { SessionBindings, StudioApi, StudioSnapshot } from '../src/shared/types.ts';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function fixture(){
  const project=createProject('已有影片','首页和会话'),calls:{endpoint:string;payload:any}[]=[];
  let bindings:SessionBindings={};
  let snapshot:StudioSnapshot={project,root:'/film',task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false}};
  const api={async call<T>(endpoint:string,payload:any={}):Promise<T>{
    calls.push({endpoint,payload});
    if(endpoint==='catalog'||endpoint==='current'||endpoint==='focus')return structuredClone({...snapshot,bindings}) as T;
    if(endpoint==='history')return {canUndo:false,canRedo:false,cursor:0,entries:[]} as T;
    if(endpoint==='list')return structuredClone({projects:[{id:project.id,title:project.title,path:'/film'}],bindings}) as T;
    if(endpoint==='bindSession'){bindings={...bindings,[payload.sessionId]:{currentProjectId:payload.projectId,relatedProjectIds:[payload.projectId],updatedAt:'today'}};return structuredClone({bindings,project:{...project,id:payload.projectId}}) as T;}
    if(endpoint==='unbindSession'){bindings={};return {bindings} as T;}
    if(endpoint==='save'){snapshot={...snapshot,project:payload.project};return structuredClone(snapshot) as T;}
    throw new Error(endpoint);
  }} satisfies StudioApi;
  return {api,calls,project,get bindings(){return bindings;}};
}

test('existing films start on Home; explicit frame entry survives and Home preserves that position',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();
  assert.equal(controller.getSnapshot().workspaceView,'projects');
  await controller.focusProject(f.project.id,{frame:33});assert.equal(controller.getSnapshot().workspaceView,'studio');
  await controller.showProjects();assert.equal(controller.getSnapshot().workspaceView,'projects');assert.equal(controller.getSnapshot().focusFrame,33);
  controller.showStudio();assert.equal(controller.getSnapshot().focusFrame,33);await controller.dispose();
});

test('binding a different film preserves visible dirty parameters, source drafts and frame',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();await controller.focusProject(f.project.id,{frame:10});
  controller.edit({...f.project,title:'本地未保存标题'});
  controller.setSourceDraft('draft-shot',{html:'草稿',css:'',js:'export function render(){}'});
  const before=f.calls.length;await controller.bindSession('session-A','other-film');
  assert.equal(controller.getSnapshot().snapshot?.project?.id,f.project.id);
  assert.equal(controller.getSnapshot().snapshot?.project?.title,'本地未保存标题');assert.equal(controller.getSnapshot().dirty,true);
  assert.equal(controller.getSnapshot().focusFrame,10);assert.equal(controller.getSourceDraft('draft-shot')?.source.html,'草稿');
  assert.equal(f.calls.slice(before).some(call=>call.endpoint==='save'),false);
  assert.equal(controller.getSnapshot().sessionBindings['session-A'].currentProjectId,'other-film');
  assert.equal(f.calls.find(call=>call.endpoint==='bindSession')?.payload.expectedCurrentProjectId,null);await controller.dispose();
});

test('failed relation update keeps current bindings and exposes the failure',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();await controller.bindSession('s',f.project.id);
  const base=f.api.call.bind(f.api);f.api.call=async<T>(endpoint:string,payload:any)=>{if(endpoint==='unbindSession')throw new Error('会话仍在执行');return base<T>(endpoint,payload);};
  await assert.rejects(()=>controller.unbindSession('s',f.project.id),/会话仍在执行/);
  assert.equal(controller.getSnapshot().sessionBindings.s.currentProjectId,f.project.id);
  assert.equal(controller.getSnapshot().relationPending,false);assert.equal(controller.getSnapshot().error,'会话仍在执行');await controller.dispose();
});

test('a pre-binding library reply cannot restore the previous relation',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();
  const base=f.api.call.bind(f.api),old=deferred<any>();let blocked=true;
  f.api.call=async<T>(endpoint:string,payload:any)=>{if(endpoint==='list'&&blocked){blocked=false;return old.promise as Promise<T>;}return base<T>(endpoint,payload);};
  const reading=controller.refreshProjects();await controller.bindSession('s','new-film');old.resolve({projects:[],bindings:{s:{currentProjectId:'old-film',relatedProjectIds:['old-film'],updatedAt:'old'}}});await reading;
  assert.equal(controller.getSnapshot().sessionBindings.s.currentProjectId,'new-film');assert.equal(controller.getSnapshot().projects.length,1);await controller.dispose();
});

test('a pre-binding project refresh cannot overwrite the newly selected relation',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();
  const base=f.api.call.bind(f.api),old=deferred<StudioSnapshot>();
  f.api.call=async<T>(endpoint:string,payload:any)=>endpoint==='current'?old.promise as Promise<T>:base<T>(endpoint,payload);
  const reading=controller.refreshVisibleProject();await controller.bindSession('s','new-film');
  old.resolve({...controller.getSnapshot().snapshot!,bindings:{s:{currentProjectId:'old-film',relatedProjectIds:['old-film'],updatedAt:'old'}}});await reading;
  assert.equal(controller.getSnapshot().sessionBindings.s.currentProjectId,'new-film');await controller.dispose();
});

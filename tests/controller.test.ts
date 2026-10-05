import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../src/client/controller.ts';
import { createProject } from '../src/core/index.ts';
import type { StudioApi, StudioSnapshot } from '../src/shared/types.ts';

function snapshot():StudioSnapshot{return {project:createProject('控制器回归','保存与导入'),root:'/test',task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false}};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

test('import blocks an old canvas draft and preserves imported assets for the next save',async()=>{
  let state=snapshot();const imported=deferred<StudioSnapshot>();const saved:StudioSnapshot['project'][]=[];
  const api={async call(endpoint:string,payload:any){if(endpoint==='catalog')return structuredClone(state);if(endpoint==='import')return imported.promise;if(endpoint==='save'){saved.push(payload.project);state={...state,project:payload.project};return structuredClone(state);}throw new Error(endpoint);}} as StudioApi;
  const controller=new StudioController(api);await controller.load();const before=structuredClone(controller.getSnapshot().snapshot!.project!);
  const action=controller.action('import');await Promise.resolve();
  controller.edit({...before,revision:before.revision+1,graph:{...before.graph,groups:[{id:'old',title:'旧画布事件',bounds:[0,0,100,100]}]}});
  state.project!.assets.push({id:'image-new',kind:'image',name:'新图',description:'',path:'assets/new.webp'});state.project!.revision++;
  imported.resolve(structuredClone(state));await action;
  const current=controller.getSnapshot().snapshot!.project!;controller.edit({...current,title:'继续编辑',revision:current.revision+1});await controller.flush();
  assert.equal(saved.length,1);assert.equal(saved[0]!.assets[0]!.id,'image-new');assert.equal(saved[0]!.graph.groups.length,0);await controller.dispose();
});

test('an earlier current response cannot overwrite a newer action or its task',async()=>{
  const state=snapshot(),old=deferred<StudioSnapshot>();
  const api={async call(endpoint:string){if(endpoint==='catalog')return structuredClone(state);if(endpoint==='current')return old.promise;if(endpoint==='open')return {...state,project:{...state.project!,id:'new-project',title:'新打开项目'}};throw new Error(endpoint);}} as StudioApi;
  const controller=new StudioController(api);await controller.load();const poll=(controller as any).poll();await controller.action('open');old.resolve(state);await poll;
  assert.equal(controller.getSnapshot().snapshot!.project!.id,'new-project');await controller.dispose();
});

test('disposal flushes the last edit before its debounce expires',async()=>{
  const state=snapshot();let writes=0;
  const api={async call(endpoint:string,payload:any){if(endpoint==='catalog')return structuredClone(state);if(endpoint==='save'){writes++;return {...state,project:payload.project};}throw new Error(endpoint);}} as StudioApi;
  const controller=new StudioController(api);await controller.load();controller.edit({...state.project!,title:'退出前最后一笔',revision:1});await controller.dispose();assert.equal(writes,1);
});

import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {createProject,compileSpec,defaultSceneSource,updateShot} from '../core/index.ts';
import type {VideoProject,StudioSnapshot,TaskState,EnvironmentSettings,ProviderGroup,RpcResult,SceneSource,Shot,ModelRoute} from '../shared/types.ts';
import type {HostContext} from './platform.ts';
import {ProjectStore} from './store.ts';
import {VideoRenderer,detectEnvironment} from './renderer.ts';
import {DshSceneGenerator,parseSceneSource} from './generator.ts';

export class StudioService {
  readonly store:ProjectStore;readonly renderer=new VideoRenderer();
  private project:VideoProject|null=null;private root:string|null=null;
  private task:TaskState|null=null;private controller?:AbortController;private job?:Promise<void>;
  private providers:ProviderGroup[]=[];private previewUrl:string|null=null;private previewRevision:number|null=null;private assetBaseUrl:string|null=null;
  private settings:EnvironmentSettings;private initialized:Promise<void>;private disposed=false;
  private readonly baseDirectory:string;
  constructor(private ctx:HostContext,config:{baseDirectory?:string}={}){
    this.baseDirectory=resolve(config.baseDirectory??process.env.DSH_VIDEO_PROJECTS??join(homedir(),'Documents','DSHVideoProjects'));
    this.store=new ProjectStore({baseDirectory:this.baseDirectory});
    const env=detectEnvironment();this.settings={browserPath:env.browserPath,ffmpegPath:env.ffmpegPath,ffprobePath:env.ffprobePath};
    this.initialized=this.initialize();
  }
  private async initialize(){
    try{this.settings={...this.settings,...JSON.parse(await readFile(join(this.baseDirectory,'environment.json'),'utf8'))};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const recent=await this.store.recent();
    if(recent[0])try{this.project=await this.store.open(recent[0].path);this.root=recent[0].path;await this.refreshPreview();}catch{/* Recent path may have been moved; keep the picker usable. */}
  }
  async snapshot():Promise<StudioSnapshot>{await this.initialized;return structuredClone({project:this.project,root:this.root,task:this.task,previewUrl:this.previewUrl,previewRevision:this.previewRevision,assetBaseUrl:this.assetBaseUrl,providers:this.providers,environment:detectEnvironment(this.settings),recent:await this.store.recent()});}
  private required(){if(!this.project||!this.root)throw new Error('请先新建或打开项目');return {project:this.project,root:this.root};}
  private assertIdle(){if(this.task?.status==='running')throw new Error('已有任务运行，请等待或取消');}
  private async refreshPreview(){
    if(!this.project||!this.root)return;
    for(const shot of this.project.shots){
      try{await this.store.readSource(this.root,shot);}catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        const origin=(this.project.extensions.sourceCopies as Record<string,string>|undefined)?.[shot.id];
        const source=origin?await this.store.readSource(this.root,origin):defaultSceneSource();
        await this.store.writeSource(this.root,shot,source);if(!origin)await this.store.markSourceGood(this.root,shot);
      }
    }
    this.assetBaseUrl=await this.renderer.assetBaseUrl(this.root);
    for(const output of this.project.outputs){output.path=join(this.root,'exports',output.id,'video.mp4');output.url=new URL(`exports/${encodeURIComponent(output.id)}/video.mp4`,this.assetBaseUrl).href;}
    try{compileSpec(this.project);}catch{this.previewUrl=null;this.previewRevision=null;return;}
    this.previewUrl=await this.renderer.preview(this.root,this.project);this.previewRevision=this.project.revision;
    for(const output of this.project.outputs){output.path=join(this.root,'exports',output.id,'video.mp4');output.url=new URL(`exports/${encodeURIComponent(output.id)}/video.mp4`,this.previewUrl).href;}
  }
  private async persist(){const {root,project}=this.required();this.project=await this.store.save(root,project);await this.refreshPreview();}
  private start(kind:TaskState['kind'],work:(signal:AbortSignal)=>Promise<void>,shotId?:string){
    this.assertIdle();const root=this.required().root;
    const task:TaskState={id:randomUUID(),kind,status:'running',progress:0,message:'准备中',startedAt:new Date().toISOString(),shotId};
    const controller=new AbortController();this.controller=controller;this.task=task;
    this.job=(async()=>{
      try{await work(controller.signal);controller.signal.throwIfAborted();task.status='complete';task.progress=1;task.message='已完成';}
      catch(error){task.status=controller.signal.aborted?'cancelled':'failed';task.error=error instanceof Error?error.message:String(error);task.message=task.status==='cancelled'?'已取消':task.error;}
      finally{task.finishedAt=new Date().toISOString();const logPath=join(root,'.studio','tasks',`${task.id}.json`);try{await mkdir(join(root,'.studio','tasks'),{recursive:true});task.logPath=logPath;await writeFile(logPath,JSON.stringify(task,null,2));}catch{/* The in-memory error remains available if disk writing failed. */}}
    })();
  }
  private progress(progress:number,message:string){if(this.task?.status==='running'){this.task.progress=progress;this.task.message=message;}}
  private generator(root:string){return new DshSceneGenerator(this.ctx,()=>root,text=>{if(this.task?.status==='running')this.task.message=`正在生成 · 已收到 ${text.length.toLocaleString()} 字符`;});}
  private applyPatch(shotId:string,patch:Partial<Shot>|undefined){
    if(!patch||!this.project)return;
    const current=this.project.shots.find(s=>s.id===shotId);if(!current)return;
    const safe:Partial<Shot>={};
    for(const key of ['title','intent','composition','action'] as const)if(typeof patch[key]==='string')safe[key]=patch[key];
    if(Number.isInteger(patch.durationFrames)&&patch.durationFrames!>0)safe.durationFrames=patch.durationFrames;
    if(patch.transition==='cut'||patch.transition==='fade')safe.transition=patch.transition;
    const ids=new Set(this.project.assets.map(a=>a.id));for(const key of ['assetIds','referenceIds'] as const)if(Array.isArray(patch[key]))safe[key]=patch[key]!.filter(id=>ids.has(id));
    if(patch.params&&typeof patch.params==='object')safe.params={...current.params,...patch.params};
    this.project=updateShot(this.project,shotId,safe);
  }
  private async generateScene(root:string,shotId:string,route:ModelRoute,signal:AbortSignal,instruction?:string){
    const generator=this.generator(root),initial=this.required().project,shot=initial.shots.find(s=>s.id===shotId);if(!shot)throw new Error('镜头已不存在');
    const old=await this.store.readSource(root,shot);const source=await generator.scene(initial,shot,route,signal,instruction?old:undefined,instruction);
    signal.throwIfAborted();this.applyPatch(shotId,source.shotPatch);await this.store.writeSource(root,shot,{html:source.html,css:source.css,js:source.js});this.required().project.revision++;await this.persist();
    let checked=await this.renderer.check(root,this.required().project,this.settings,signal);
    if(!checked.ok){
      this.progress(this.task?.progress??0,'发现代码错误，正在修复');
      const errors=checked.errors.filter(e=>!e.shotId||e.shotId===shotId);if(!errors.length)throw new Error(checked.errors.map(e=>e.message).join('\n'));
      const repaired=await generator.scene(this.required().project,this.required().project.shots.find(s=>s.id===shotId)!,route,signal,source,`修复运行错误，保留当前设计和可编辑参数：${JSON.stringify(errors)}`);
      signal.throwIfAborted();await this.store.writeSource(root,shot,{html:repaired.html,css:repaired.css,js:repaired.js});this.required().project.revision++;await this.persist();checked=await this.renderer.check(root,this.required().project,this.settings,signal);
    }
    if(!checked.ok)throw new Error(checked.errors.map(e=>`镜头 ${e.shotId??shotId} 帧 ${e.frame??'?'}：${e.message}`).join('\n'));
    await this.store.markSourceGood(root,shot);
  }
  async rpc(endpoint:string,payload:unknown):Promise<RpcResult>{
    try{
      await this.initialized;if(this.disposed)throw new Error('插件已停止');const data=(payload??{}) as any;
      switch(endpoint){
        case 'catalog':this.providers=await Promise.all(this.ctx.llm.listProviders().map(async p=>{try{return {...p,models:await this.ctx.llm.listModels(p.id)};}catch(error){return {...p,models:[],error:error instanceof Error?error.message:'模型目录读取失败'};}}));break;
        case 'current':break;
        case 'create':{this.assertIdle();const project=createProject(String(data.title||'未命名视频'),String(data.topic||''));const created=await this.store.create(project);this.root=created.root;this.project=created.project;this.task=null;for(const shot of this.project.shots)await this.store.markSourceGood(this.root,shot);await this.persist();break;}
        case 'open':this.assertIdle();this.root=resolve(String(data.path));this.project=await this.store.open(this.root);this.task=null;await this.refreshPreview();break;
        case 'save':{const {project}=this.required();if(!data.project||data.project.id!==project.id)throw new Error('项目已切换，请刷新后重试');this.project={...data.project,outputs:project.outputs,revision:Math.max(project.revision+1,data.project.revision),updatedAt:new Date().toISOString()};await this.persist();break;}
        case 'import':{const {root,project}=this.required();const asset=await this.store.importImageOrText(root,data);project.assets.push(asset);project.graph.positions[asset.id]=[60,80+(project.assets.length-1)*180];project.revision++;await this.persist();break;}
        case 'source':{const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');return {ok:true,value:await this.store.readSource(root,shot)};}
        case 'saveSource':{this.assertIdle();const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');const source=parseSceneSource(JSON.stringify(data.source));await this.store.writeSource(root,shot,source);project.revision++;await this.persist();this.start('preview',async signal=>{const checked=await this.renderer.check(root,this.required().project,this.settings,signal);if(!checked.ok)throw new Error(checked.errors.map(e=>e.message).join('\n'));await this.store.markSourceGood(root,shot);},shot.id);break;}
        case 'restoreSource':{this.assertIdle();const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');await this.store.restoreSource(root,shot);project.revision++;await this.persist();break;}
        case 'preview':{const {root,project}=this.required();compileSpec(project);await this.refreshPreview();this.start('preview',async signal=>{this.progress(.1,'检查资源与关键帧');const checked=await this.renderer.check(root,this.required().project,this.settings,signal);if(!checked.ok)throw new Error(checked.errors.map(e=>e.message).join('\n'));for(const shot of this.required().project.shots)await this.store.markSourceGood(root,shot);});break;}
        case 'generate':{
          const {root,project}=this.required(),route={provider:String(data.provider??''),model:String(data.model??'')},kind=data.kind as 'storyboard'|'scenes'|'modify';if(!['storyboard','scenes','modify'].includes(kind))throw new Error('生成类型无效');
          this.start(kind,async signal=>{
            if(kind==='storyboard'){
              const shots=await this.generator(root).storyboard(structuredClone(project),route,signal);signal.throwIfAborted();const current=this.required().project;
              current.shots=shots;current.shotOrder=shots.map(s=>s.id);delete current.extensions.graphEdges;current.revision++;
              for(let i=0;i<shots.length;i++){current.graph.positions[shots[i]!.id]=[420+i*340,160];await this.store.writeSource(root,shots[i]!,defaultSceneSource());}current.graph.positions['film-output']=[420+shots.length*340,160];await this.persist();
            }else{
              compileSpec(this.required().project);const ids=data.shotId?[String(data.shotId)]:[...this.required().project.shotOrder];
              for(let i=0;i<ids.length;i++){signal.throwIfAborted();this.progress(i/ids.length,`生成镜头 ${i+1}/${ids.length}`);await this.generateScene(root,ids[i]!,route,signal,kind==='modify'?String(data.instruction??'改进画面与动作，保留内容'):undefined);}
            }
          },data.shotId);break;
        }
        case 'export':{const {root,project}=this.required();compileSpec(project);const snapshot=structuredClone(project);this.start('export',async signal=>{const result=await this.renderer.export(root,snapshot,this.settings,signal,(p,m)=>this.progress(p,m));signal.throwIfAborted();const current=this.required().project;current.outputs.push(result);await this.persist();if(!result.url&&this.previewUrl)result.url=new URL(relative(root,result.path).split('/').map(encodeURIComponent).join('/'),this.previewUrl).href;});break;}
        case 'cancel':this.controller?.abort(new Error('用户已取消'));break;
        case 'environment':this.assertIdle();this.settings={...this.settings,...data};await mkdir(this.baseDirectory,{recursive:true});await writeFile(join(this.baseDirectory,'environment.json'),JSON.stringify(this.settings,null,2));break;
        case 'reveal':{const {root}=this.required(),path=resolve(String(data.path??root));if(path!==root&&!path.startsWith(root+'/'))throw new Error('请选择本项目文件');await new Promise<void>((res,rej)=>{const child=spawn('/usr/bin/open',[path],{stdio:'ignore'});child.once('error',rej);child.once('close',code=>code===0?res():rej(new Error('打开文件失败')));});break;}
        default:throw new Error('未找到插件操作');
      }
      return {ok:true,value:await this.snapshot()};
    }catch(error){return {ok:false,error:{code:'STUDIO_ERROR',message:error instanceof Error?error.message:String(error)}};}
  }
  async dispose(){this.disposed=true;this.controller?.abort(new Error('插件已停止'));await this.job;await this.renderer.close();}
}

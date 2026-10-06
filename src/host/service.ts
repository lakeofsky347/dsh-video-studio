import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,rename,open,rm} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {homedir} from 'node:os';
import {createProject,compileSpec,defaultSceneSource,updateShot,updateTarget,validateProject,reorderShots} from '../core/index.ts';
import type {VideoProject,StudioSnapshot,TaskState,EnvironmentSettings,ProviderGroup,RpcResult,SceneSource,Shot,ModelRoute,TtsSettings,AudioClip} from '../shared/types.ts';
import type {HostContext} from './platform.ts';
import {ProjectStore,projectPath,validateStoredProject,validateSources} from './store.ts';
import {VideoRenderer,detectEnvironment} from './renderer.ts';
import {DshSceneGenerator,parseSceneSource,normalizeStoryboard} from './generator.ts';
import {SpeechSynthesizer} from './audio.ts';

interface TaskRequest { endpoint:'preview'|'export'|'generate'; payload:Record<string,string> }
interface RecordedTask extends TaskState { recordVersion?:1; revision?:number; request?:TaskRequest; retryOf?:string }

export class StudioService {
  readonly store:ProjectStore;readonly renderer=new VideoRenderer();
  private project:VideoProject|null=null;private root:string|null=null;
  private task:RecordedTask|null=null;private controller?:AbortController;private job?:Promise<void>;
  private commands:Promise<unknown>=Promise.resolve();
  private providers:ProviderGroup[]=[];private previewUrl:string|null=null;private previewRevision:number|null=null;private assetBaseUrl:string|null=null;
  private settings:EnvironmentSettings;private initialized:Promise<void>;private disposed=false;
  private readonly baseDirectory:string;
  private readonly restoreRecent:boolean;
  private readonly speech=new SpeechSynthesizer();
  private audioUrl:string|null=null;
  private tts:TtsSettings={endpoint:'local:say',model:'',voice:'',speed:1,enabled:false};
  constructor(private ctx:HostContext,config:{baseDirectory?:string;restoreRecent?:boolean}={}){
    this.baseDirectory=resolve(config.baseDirectory??process.env.DSH_VIDEO_PROJECTS??join(homedir(),'Documents','DSHVideoProjects'));
    this.restoreRecent=config.restoreRecent!==false;
    this.store=new ProjectStore({baseDirectory:this.baseDirectory});
    const env=detectEnvironment();this.settings={browserPath:env.browserPath,ffmpegPath:env.ffmpegPath,ffprobePath:env.ffprobePath};
    this.initialized=this.initialize();
  }
  private async initialize(){
    try{this.settings={...this.settings,...JSON.parse(await readFile(join(this.baseDirectory,'environment.json'),'utf8'))};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{this.tts={...this.tts,...JSON.parse(await readFile(join(this.baseDirectory,'tts.json'),'utf8'))};delete this.tts.apiKey;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const recent=this.restoreRecent?await this.store.recent():[];
    if(recent[0])try{this.project=await this.store.open(recent[0].path);this.root=recent[0].path;await this.recoverTask();await this.refreshPreview();}catch{/* Recent path may have been moved; keep the picker usable. */}
  }
  async snapshot():Promise<StudioSnapshot>{await this.initialized;const credentials=this.credentials();return structuredClone({project:this.project,root:this.root,task:this.task,previewUrl:this.previewUrl,previewRevision:this.previewRevision,assetBaseUrl:this.assetBaseUrl,audioUrl:this.audioUrl,tts:{...this.tts,apiKey:undefined},ttsConfigured:!!(await credentials?.resolve('DSH_VIDEO_STUDIO_TTS_API_KEY')),providers:this.providers,environment:detectEnvironment(this.settings),recent:await this.store.recent()});}
  private required(){if(!this.project||!this.root)throw new Error('请先新建或打开项目');return {project:this.project,root:this.root};}
  private assertIdle(){if(this.task?.status==='running')throw new Error('已有任务运行，请等待或取消');}
  private async refreshPreview(){
    if(!this.project||!this.root)return;
    this.assetBaseUrl=await this.renderer.assetBaseUrl(this.root);
    for(const output of this.project.outputs){output.path=join(this.root,'exports',output.id,'video.mp4');output.url=new URL(`exports/${encodeURIComponent(output.id)}/video.mp4`,this.assetBaseUrl).href;}
    try{compileSpec(this.project);}catch{this.previewUrl=null;this.previewRevision=null;this.audioUrl=null;return;}
    this.previewUrl=await this.renderer.preview(this.root,this.project);this.previewRevision=this.project.revision;
    this.audioUrl=await this.renderer.audioPreview(this.root,this.project,this.settings);
    for(const output of this.project.outputs){output.path=join(this.root,'exports',output.id,'video.mp4');output.url=new URL(`exports/${encodeURIComponent(output.id)}/video.mp4`,this.previewUrl).href;}
  }
  private async refreshAfterCommit():Promise<void>{
    try{await this.refreshPreview();}catch(error){
      this.previewUrl=null;this.previewRevision=null;this.audioUrl=null;
      const message=await this.redact(error instanceof Error?error.message:String(error)),now=new Date().toISOString();
      const failed:RecordedTask={id:randomUUID(),kind:'preview',status:'failed',progress:0,message:'工程已保存，预览准备失败：'+message,error:message,startedAt:now,finishedAt:now,revision:this.required().project.revision,recordVersion:1,request:this.recordedRequest('preview',{})};
      // Saving during export must still acknowledge the committed edit and keep the export owner.
      if(this.task?.status!=='running')this.task=failed;
      try{await this.writeTaskJournal(this.required().root,failed);}catch{failed.message+='；任务日志写入失败，请检查工程目录权限';}
    }
  }
  private async persist(next:VideoProject,sources:Record<string,SceneSource>={},label='编辑工程',historyGroup?:string){
    const {root,project:current}=this.required();next=structuredClone(next);next.revision=current.revision+1;this.fitAudio(next);
    this.project=await this.store.commit(root,next,sources,{expectedRevision:current.revision,label,historyGroup});
    // Rendering follows the durable commit. A preview failure leaves the new version undoable.
    await this.refreshAfterCommit();
  }
  private async apply(data:any){
    this.assertIdle();const {root,project:current}=this.required();let project=structuredClone(current);
    const incoming=data.project??{};
    const metadata={...incoming,...data};
    for(const key of ['title','topic'] as const)if(typeof metadata[key]==='string')project[key]=metadata[key];
    if(metadata.targetDuration!==undefined)project.targetDuration=Number(metadata.targetDuration);
    if(metadata.target)project=updateTarget(project,metadata.target);
    if(metadata.graph)project.graph=structuredClone(metadata.graph);
    if(metadata.assets){if(!Array.isArray(metadata.assets))throw new Error('assets须为数组');project.assets=structuredClone(metadata.assets);}
    if(metadata.storyboard){project.shots=normalizeStoryboard(metadata.storyboard,project);project.shotOrder=project.shots.map(s=>s.id);delete project.extensions.graphEdges;}
    if(metadata.shots){if(!Array.isArray(metadata.shots))throw new Error('shots须为数组');project.shots=structuredClone(metadata.shots);project.shotOrder=project.shots.map(s=>s.id);delete project.extensions.graphEdges;}
    if(metadata.shotOrder)project=reorderShots(project,metadata.shotOrder);
    for(const item of metadata.shotPatches??[])project=updateShot(project,item.id??item.shotId,item.patch);
    if(metadata.audioClips!==undefined)project.audioClips=structuredClone(metadata.audioClips);
    if(metadata.sessionIds)project.sessionIds=[...new Set<string>(metadata.sessionIds)];
    if(metadata.extensions)project.extensions={...project.extensions,...metadata.extensions};
    this.fitAudio(project);
    const sources=(metadata.sources??[]).map((item:any)=>({shotId:item.shotId,source:parseSceneSource(JSON.stringify(item.source))}));
    await this.persist(project,validateSources(project,sources),String(data.label??'应用分镜与源码变更'));
  }
  private fitAudio(project:VideoProject,fitDuration=true):void{
    const check=validateProject(project);if(!check.ok)throw new Error(check.errors.join('\n'));
    if(project.target.audioMode==='none')return;
    const fps=project.target.fps.num/project.target.fps.den;
    for(const clip of project.audioClips??[]){
      if(clip.role!=='voice'||clip.loop)continue;
      const asset=project.assets.find(a=>a.id===clip.assetId)!;
      const end=clip.startSeconds+Math.min(clip.trimEnd??asset.duration!,asset.duration!)-clip.trimStart;
      if(clip.trimStart>=asset.duration!)throw new Error('旁白裁剪起点超出音频长度');
      if(clip.shotId){
        const shot=project.shots.find(s=>s.id===clip.shotId)!;
        if(end>shot.durationFrames/fps+1e-6){
          if(project.extensions.lockDuration===true||!fitDuration)throw new Error(`旁白超出镜头时长 ${(end-shot.durationFrames/fps).toFixed(2)} 秒，请调整裁剪、旁白或解除时长锁定`);
          shot.durationFrames=Math.ceil((end+.25)*fps);
        }
      }else if(end>project.shots.reduce((sum,s)=>sum+s.durationFrames/fps,0)+1e-6)throw new Error('全片旁白超出成片时长，请延长镜头或裁剪音频');
    }
  }
  private withAudioClip(project:VideoProject,assetId:string,data:any):VideoProject{
    const asset=project.assets.find(a=>a.id===assetId&&a.kind==='audio');if(!asset)throw new Error('请选择音频资产');
    const clip:AudioClip={id:randomUUID(),assetId,role:data.role??'voice',shotId:data.shotId,startSeconds:Number(data.startSeconds??0),trimStart:Number(data.trimStart??0),trimEnd:data.trimEnd,volume:Number(data.volume??1),fadeIn:Number(data.fadeIn??0),fadeOut:Number(data.fadeOut??0),loop:!!data.loop};
    project.audioClips=[...(project.audioClips??[]).filter(c=>!data.replaceVoice||c.role!=='voice'||c.shotId!==clip.shotId),clip];project.target.audioMode='mixed';
    this.fitAudio(project,data.fitDuration!==false);project.revision++;return project;
  }
  private assertRevision(data:any,required=false):void {
    const current=this.required().project;
    if(data.expectedRevision===undefined){
      if(required)throw Object.assign(new Error('修改需要 expectedRevision，请先读取最新工程'),{code:'REVISION_REQUIRED'});
      return;
    }
    if(!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision!==current.revision)
      throw Object.assign(new Error(`工程版本冲突：期望 v${data.expectedRevision}，当前 v${current.revision}；请读取最新工程后合并修改`),{code:'REVISION_CONFLICT'});
  }
  /** Every externally requested mutation and background commit shares one project queue. */
  private enqueue<T>(work:()=>Promise<T>):Promise<T>{
    const result=this.commands.then(work);this.commands=result.then(()=>undefined,()=>undefined);return result;
  }
  private credentials(){return this.ctx.get?.('credentials') as {set(ref:string,value:string):Promise<void>;unset?(ref:string):Promise<void>;resolve(ref:string):Promise<{value:string}|undefined>}|undefined;}
  private async speechSettings():Promise<TtsSettings>{try{this.tts={...this.tts,...JSON.parse(await readFile(join(this.baseDirectory,'tts.json'),'utf8'))};delete this.tts.apiKey;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const credentials=this.credentials();const key=credentials?await credentials.resolve('DSH_VIDEO_STUDIO_TTS_API_KEY'):undefined;return {...this.tts,apiKey:key?.value};}
  private async redact(text:string):Promise<string>{
    const key=(await this.credentials()?.resolve('DSH_VIDEO_STUDIO_TTS_API_KEY'))?.value;if(key)text=text.split(key).join('[redacted]');
    return text.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [redacted]').replace(/\bsk-[a-zA-Z0-9_-]{8,}/g,'[redacted]');
  }
  private async writeTaskJournal(root:string,task:RecordedTask):Promise<void>{
    const folder=await projectPath(root,'.studio/tasks');await mkdir(folder,{recursive:true});
    const file=await projectPath(root,`.studio/tasks/${task.id}.json`),temporary=file+'.tmp-'+randomUUID();
    task.logPath=file;task.message=await this.redact(task.message);if(task.error)task.error=await this.redact(task.error);
    if(task.request){task.request=this.recordedRequest(task.request.endpoint,task.request.payload);if(task.request)for(const key of Object.keys(task.request.payload))task.request.payload[key]=await this.redact(task.request.payload[key]!);}
    try{
      const handle=await open(temporary,'w');try{await handle.writeFile(JSON.stringify(task,null,2)+'\n');await handle.sync();}finally{await handle.close();}
      await rename(temporary,file);const directory=await open(folder,'r');try{await directory.sync();}catch(error){if(!['EINVAL','ENOTSUP','EISDIR','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error;}finally{await directory.close();}
    }finally{await rm(temporary,{force:true});}
  }
  private recordedRequest(endpoint:string,data:any):TaskRequest|undefined{
    if(!data||typeof data!=='object'||Array.isArray(data))return;
    if(!['preview','export','generate'].includes(endpoint))return;
    const payload:Record<string,string>={};
    if(endpoint==='generate'){
      if(!['storyboard','scenes','modify'].includes(data.kind)||typeof data.provider!=='string'||typeof data.model!=='string')return;
      for(const key of ['kind','provider','model','shotId','instruction'])if(typeof data[key]==='string')payload[key]=data[key].slice(0,key==='instruction'?100000:200);
    }
    return {endpoint:endpoint as TaskRequest['endpoint'],payload};
  }
  private async taskRecords():Promise<RecordedTask[]>{
    const {root}=this.required();let names:string[];
    try{names=await readdir(await projectPath(root,'.studio/tasks'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const tasks:RecordedTask[]=[];
    for(const name of names.filter(name=>/^[a-zA-Z0-9_-]+\.json$/.test(name))){
      try{const value=JSON.parse(await readFile(await projectPath(root,'.studio/tasks/'+name),'utf8')) as RecordedTask;
        if(!value||typeof value!=='object'||value.id+'.json'!==name||typeof value.startedAt!=='string'||!['storyboard','scenes','modify','preview','export','audio'].includes(value.kind)||!['running','complete','failed','cancelled','interrupted'].includes(value.status))continue;
        const task:RecordedTask={id:value.id,kind:value.kind,status:value.status,startedAt:value.startedAt,progress:Number.isFinite(value.progress)?value.progress:0,message:await this.redact(String(value.message??'')),logPath:await projectPath(root,'.studio/tasks/'+name),finishedAt:typeof value.finishedAt==='string'?value.finishedAt:undefined,error:typeof value.error==='string'?await this.redact(value.error):undefined,shotId:typeof value.shotId==='string'?value.shotId:undefined,recordVersion:value.recordVersion===1?1:undefined,revision:Number.isSafeInteger(value.revision)?value.revision:undefined,retryOf:typeof value.retryOf==='string'?value.retryOf:undefined};
        const request=value.recordVersion===1&&value.request?this.recordedRequest(value.request.endpoint,value.request.payload):undefined;
        if(request&&((request.endpoint==='preview'||request.endpoint==='export')?request.endpoint===value.kind:request.payload.kind===value.kind)){
          for(const key of Object.keys(request.payload))request.payload[key]=await this.redact(request.payload[key]!);task.request=request;
        }
        if(this.task?.id===task.id&&this.task.status==='running'){task.progress=this.task.progress;task.message=await this.redact(this.task.message);}
        tasks.push(task);
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    }
    return tasks.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||b.id.localeCompare(a.id));
  }
  private async recoverTask():Promise<void>{
    if(!this.root)return;const records=await this.taskRecords();
    for(const task of records)if(task.status==='running'){
      task.status='interrupted';task.message='上次任务已中断 · 请读取当前工程后明确重试';task.error='TASK_INTERRUPTED: 插件退出前任务未完成；配音任务请明确重新生成';task.finishedAt=new Date().toISOString();await this.writeTaskJournal(this.root,task);
    }
    this.task=records[0]??null;
  }
  private async start(kind:TaskState['kind'],work:(signal:AbortSignal)=>Promise<void>,shotId?:string,request?:TaskRequest,retryOf?:string):Promise<void>{
    this.assertIdle();const root=this.required().root;
    const task:RecordedTask={id:randomUUID(),kind,status:'running',progress:0,message:'准备中',startedAt:new Date().toISOString(),shotId,recordVersion:1,revision:this.required().project.revision,request,retryOf};
    const controller=new AbortController();this.controller=controller;this.task=task;
    try{await this.writeTaskJournal(root,task);}catch(error){task.status='failed';task.error='任务记录保存失败：'+String(error);task.message=task.error;throw error;}
    this.job=(async()=>{
      let status:TaskState['status']='complete',error:string|undefined;
      try{await work(controller.signal);controller.signal.throwIfAborted();}
      catch(failure){status=controller.signal.aborted?'cancelled':'failed';error=failure instanceof Error?failure.message:String(failure);}
      finally{
        const finished:RecordedTask={...task,status,error:error?await this.redact(error):undefined,progress:status==='complete'?1:task.progress,message:status==='complete'?'已完成':status==='cancelled'?'已取消':await this.redact(error??'任务失败'),finishedAt:new Date().toISOString()};
        // Readers observe terminal completion only after its durable journal is written.
        try{await this.writeTaskJournal(root,finished);Object.assign(task,finished);}catch(failure){task.status='failed';task.finishedAt=finished.finishedAt;task.error='任务结束记录保存失败：'+String(failure);task.message=task.error;}
      }
    })();
  }
  private progress(progress:number,message:string){if(this.task?.status==='running'){this.task.progress=progress;this.task.message=message;}}
  private generator(root:string){return new DshSceneGenerator(this.ctx,()=>root,text=>{if(this.task?.status==='running')this.task.message=`正在生成 · 已收到 ${text.length.toLocaleString()} 字符`;});}
  private patched(project:VideoProject,shotId:string,patch:Partial<Shot>|undefined):VideoProject{
    if(!patch)return project;
    const current=project.shots.find(s=>s.id===shotId);if(!current)return project;
    const safe:Partial<Shot>={};
    for(const key of ['title','intent','composition','action','narration'] as const)if(typeof patch[key]==='string')safe[key]=patch[key];
    if(Number.isInteger(patch.durationFrames)&&patch.durationFrames!>0)safe.durationFrames=patch.durationFrames;
    if(patch.transition==='cut'||patch.transition==='fade')safe.transition=patch.transition;
    const ids=new Set(project.assets.map(a=>a.id));for(const key of ['assetIds','referenceIds'] as const)if(Array.isArray(patch[key]))safe[key]=patch[key]!.filter(id=>ids.has(id));
    if(patch.params&&typeof patch.params==='object')safe.params={...current.params,...patch.params};
    return updateShot(project,shotId,safe);
  }
  private async generateScene(root:string,shotId:string,route:ModelRoute,signal:AbortSignal,instruction?:string){
    const generator=this.generator(root),initial=structuredClone(this.required().project),shot=initial.shots.find(s=>s.id===shotId);if(!shot)throw new Error('镜头已不存在');
    const old=await this.store.readSource(root,shot);const source=await generator.scene(initial,shot,route,signal,instruction?old:undefined,instruction);
    signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();this.assertRevision({expectedRevision:initial.revision});const next=this.patched(structuredClone(this.required().project),shotId,source.shotPatch);await this.persist(next,{[shotId]:{html:source.html,css:source.css,js:source.js}},'模型生成镜头',this.task?.id);});
    let checked=await this.renderer.check(root,this.required().project,this.settings,signal);
    if(!checked.ok){
      this.progress(this.task?.progress??0,'发现代码错误，正在修复');
      const errors=checked.errors.filter(e=>!e.shotId||e.shotId===shotId);if(!errors.length)throw new Error(checked.errors.map(e=>e.message).join('\n'));
      const repaired=await generator.scene(this.required().project,this.required().project.shots.find(s=>s.id===shotId)!,route,signal,source,`修复运行错误，保留当前设计和可编辑参数：${JSON.stringify(errors)}`);
      signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();await this.persist(this.required().project,{[shotId]:{html:repaired.html,css:repaired.css,js:repaired.js}},'模型修复镜头',this.task?.id);});checked=await this.renderer.check(root,this.required().project,this.settings,signal);
    }
    if(!checked.ok)throw new Error(checked.errors.map(e=>`镜头 ${e.shotId??shotId} 帧 ${e.frame??'?'}：${e.message}`).join('\n'));
    await this.enqueue(()=>this.store.markSourceGood(root,shot));
  }
  async rpc(endpoint:string,payload:unknown):Promise<RpcResult>{
    await this.initialized;
    if(endpoint==='cancel'){this.controller?.abort(new Error('用户已取消'));return {ok:true,value:await this.snapshot()};}
    return this.enqueue(()=>this.performRpc(endpoint,payload));
  }
  private async performRpc(endpoint:string,payload:unknown):Promise<RpcResult>{
    try{
      await this.initialized;if(this.disposed)throw new Error('插件服务已停止');const data=(payload??{}) as any;
      if(['save','apply','saveSource','restoreSource','undo','redo','rename','retry','job.retry'].includes(endpoint))this.assertRevision(data);
      else if(['import','audio','generate','export','preview'].includes(endpoint)&&data.expectedRevision!==undefined)this.assertRevision(data);
      switch(endpoint){
        case 'catalog':this.providers=await Promise.all(this.ctx.llm.listProviders().map(async p=>{try{return {...p,models:await this.ctx.llm.listModels(p.id)};}catch(error){return {...p,models:[],error:error instanceof Error?error.message:'模型目录读取失败'};}}));break;
        case 'current':break;
        case 'create':{
          this.assertIdle();let project:VideoProject;
          if(data.project){project=structuredClone(data.project);validateStoredProject(project);validateSources(project,data.sources??[]);for(const item of data.sources??[])parseSceneSource(JSON.stringify(item.source));}
          else{
            project=createProject(String(data.title||'未命名视频'),String(data.topic||''));if(data.target)project=updateTarget(project,data.target);if(data.targetDuration!==undefined)project.targetDuration=Number(data.targetDuration);
            if(data.blank===true){project.shots=[];project.shotOrder=[];project.graph={positions:{'film-output':[375,140]},groups:[]};project.extensions.graphEdges=[];}
            project.extensions.brief={profile:String(data.profile??''),preset:String(data.preset??'')};
          }
          this.fitAudio(project);const created=await this.store.create({project,sources:data.sources??[],assetFiles:data.assetFiles??[]});this.root=created.root;this.project=created.project;this.task=null;
          if(!data.project)for(const shot of this.project.shots)await this.store.markSourceGood(this.root,shot).catch(()=>{});await this.refreshAfterCommit();break;
        }
        case 'open':{this.assertIdle();const root=resolve(String(data.path)),project=await this.store.open(root);this.root=root;this.project=project;this.task=null;await this.recoverTask();await this.refreshAfterCommit();break;}
        case 'save':{if(this.task?.status==='running'&&this.task.kind!=='export')this.assertIdle();const {project}=this.required();if(!data.project||data.project.id!==project.id)throw new Error('项目已切换，请刷新后重试');const next=structuredClone(data.project) as VideoProject;this.fitAudio(next);await this.persist({...next,outputs:project.outputs}, {},'保存工程');break;}
        case 'apply':await this.apply(data);break;
        case 'import':{this.assertIdle();const {root,project}=this.required();const asset=await this.store.importAsset(root,data,this.settings);const next=structuredClone(project);next.assets.push(asset);next.graph.positions[asset.id]=[60,80+(next.assets.length-1)*180];await this.persist(next,{},'导入素材');break;}
        case 'tts':{this.assertIdle();const options:Partial<TtsSettings>={};for(const key of ['endpoint','model','voice','speed','enabled'] as const)if(data[key]!==undefined)(options as any)[key]=data[key];if(data.apiKey!==undefined){const credentials=this.credentials();if(data.apiKey){if(!credentials)throw new Error('宿主凭据服务不可用，请使用本地配音或无密钥端点');await credentials.set('DSH_VIDEO_STUDIO_TTS_API_KEY',String(data.apiKey));}else if(credentials?.unset)await credentials.unset('DSH_VIDEO_STUDIO_TTS_API_KEY');}this.tts={...this.tts,...options};await mkdir(this.baseDirectory,{recursive:true});await writeFile(join(this.baseDirectory,'tts.json'),JSON.stringify(this.tts,null,2));break;}
        case 'audio':{
          this.assertIdle();const {root,project}=this.required(),operation=data.operation??data.action;
          if(operation==='synthesize'||operation==='tts'){
            const shot=project.shots.find(s=>s.id===data.shotId);const text=String(data.text??shot?.narration??'').trim();if(!text)throw new Error('请先填写旁白');
            await this.start('audio',async signal=>{this.progress(.1,'生成配音');const asset=await this.speech.synthesize(root,{text,name:shot?shot.title+' · 配音':'配音'},await this.speechSettings(),this.settings,signal);signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();const next=structuredClone(this.required().project);next.assets.push(asset);const currentShot=next.shots.find(s=>s.id===data.shotId);if(currentShot)currentShot.narration=text;await this.persist(this.withAudioClip(next,asset.id,{...data,role:'voice',replaceVoice:true}),{},'生成配音');});},data.shotId);
          }else if(operation==='add'||operation==='bind'){await this.persist(this.withAudioClip(structuredClone(project),data.assetId??data.clip?.assetId,{...data,...data.clip}),{},'添加音轨');}
          else if(operation==='update'){const next=structuredClone(project),clip=next.audioClips?.find(c=>c.id===data.clipId);if(!clip)throw new Error('音频片段不存在');Object.assign(clip,data.patch);this.fitAudio(next,data.fitDuration!==false);await this.persist(next,{},operation==='update'?'修改音轨':'删除音轨');}
          else if(operation==='remove'){const next=structuredClone(project);next.audioClips=next.audioClips?.filter(c=>c.id!==data.clipId);await this.persist(next,{},operation==='update'?'修改音轨':'删除音轨');}
          else if(operation==='import'){const asset=await this.store.importAsset(root,data,this.settings);const next=structuredClone(project);next.assets.push(asset);await this.persist(this.withAudioClip(next,asset.id,data),{},'导入音频');}
          else throw new Error('音频操作无效');break;
        }
        case 'inspect':{const {root,project}=this.required();const spec=compileSpec(project);const shot=project.shots.find(s=>s.id===data.shotId);const source=shot&&data.includeSource?await this.store.readSource(root,shot):undefined;let frame;
          if(data.frame!==undefined)frame=await this.renderer.capture(root,project,this.settings,Number(data.frame),data.signal instanceof AbortSignal?data.signal:undefined);
          return {ok:true,value:{projectId:project.id,revision:project.revision,spec,source,frame}};
        }
        case 'source':{const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');return {ok:true,value:await this.store.readSource(root,shot)};}
        case 'saveSource':{this.assertIdle();const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');const source=parseSceneSource(JSON.stringify(data.source));await this.persist(project,{[shot.id]:source},'保存镜头源码');if(data.check!==false)await this.start('preview',async signal=>{const checked=await this.renderer.check(root,this.required().project,this.settings,signal);if(!checked.ok)throw new Error(checked.errors.map(e=>e.message).join('\n'));await this.store.markSourceGood(root,shot);},shot.id,this.recordedRequest('preview',data));break;}
        case 'restoreSource':{this.assertIdle();const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');const source=await this.store.restorationSource(root,shot);await this.persist(project,{[shot.id]:source},'恢复镜头源码');break;}
        case 'preview':{const {root,project}=this.required();compileSpec(project);await this.start('preview',async signal=>{await this.refreshPreview();signal.throwIfAborted();this.progress(.1,'检查资源与关键帧');const checked=await this.renderer.check(root,this.required().project,this.settings,signal);if(!checked.ok)throw new Error(checked.errors.map(e=>e.message).join('\n'));for(const shot of this.required().project.shots)await this.store.markSourceGood(root,shot);},undefined,this.recordedRequest('preview',data),data._retryOf);break;}
        case 'generate':{
          const {root,project}=this.required(),route={provider:String(data.provider??''),model:String(data.model??'')},kind=data.kind as 'storyboard'|'scenes'|'modify';if(!['storyboard','scenes','modify'].includes(kind))throw new Error('生成类型无效');
          await this.start(kind,async signal=>{
            if(kind==='storyboard'){
              const shots=await this.generator(root).storyboard(structuredClone(project),route,signal);signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();this.assertRevision({expectedRevision:project.revision});const current=structuredClone(this.required().project);
              current.shots=shots;current.shotOrder=shots.map(s=>s.id);delete current.extensions.graphEdges;current.revision++;
              for(let i=0;i<shots.length;i++)current.graph.positions[shots[i]!.id]=[420+i*340,160];current.graph.positions['film-output']=[420+shots.length*340,160];await this.persist(current,Object.fromEntries(shots.map(s=>[s.id,defaultSceneSource()])),'模型生成分镜',this.task?.id);});
            }else{
              compileSpec(this.required().project);const ids=data.shotId?[String(data.shotId)]:[...this.required().project.shotOrder];
              for(let i=0;i<ids.length;i++){signal.throwIfAborted();this.progress(i/ids.length,`生成镜头 ${i+1}/${ids.length}`);await this.generateScene(root,ids[i]!,route,signal,kind==='modify'?String(data.instruction??'改进画面与动作，保留内容'):undefined);}
            }
          },data.shotId,this.recordedRequest('generate',data),data._retryOf);break;
        }
        case 'export':{const {root,project}=this.required();compileSpec(project);const snapshot=structuredClone(project);await this.start('export',async signal=>{const result=await this.renderer.export(root,snapshot,this.settings,signal,(p,m)=>this.progress(p,m));signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();const current=structuredClone(this.required().project);current.outputs.push(result);await this.persist(current,{},'导出成片记录');if(!result.url&&this.previewUrl)result.url=new URL(relative(root,result.path).split('/').map(encodeURIComponent).join('/'),this.previewUrl).href;});},undefined,this.recordedRequest('export',data),data._retryOf);break;}
        case 'history':return {ok:true,value:await this.store.history(this.required().root)};
        case 'undo':case 'redo':{this.assertIdle();this.project=await this.store.moveHistory(this.required().root,endpoint,data.expectedRevision??this.required().project.revision);await this.refreshAfterCommit();break;}
        case 'rename':{this.assertIdle();if(typeof data.title!=='string'||!data.title.trim())throw new Error('工程名称不能为空');const next=structuredClone(this.required().project);next.title=data.title.trim();await this.persist(next,{},'重命名工程');break;}
        case 'duplicate':{this.assertIdle();if(data.expectedRevision!==undefined)this.assertRevision(data);return {ok:true,value:await this.store.duplicate(this.required().root,data.title)};}
        case 'tasks':case 'jobs':{const tasks=await this.taskRecords();return {ok:true,value:{tasks:tasks.map(task=>({...task,retryable:!!task.request&&task.status!=='running'}))}};}
        case 'retry':case 'job.retry':{
          this.assertIdle();const task=(await this.taskRecords()).find(task=>task.id===data.taskId);
          if(!task||!task.request||task.status==='running')throw new Error('此任务没有可重试的插件请求记录；配音请明确重新生成');
          return this.performRpc(task.request.endpoint,{...task.request.payload,expectedRevision:data.expectedRevision,_retryOf:task.id});
        }
        case 'cancel':this.controller?.abort(new Error('用户已取消'));break;
        case 'environment':this.assertIdle();for(const key of ['browserPath','ffmpegPath','ffprobePath'] as const)if(data[key]!==undefined){if(typeof data[key]!=='string')throw new Error('执行文件路径须为字符串');this.settings[key]=data[key];}await mkdir(this.baseDirectory,{recursive:true});await writeFile(join(this.baseDirectory,'environment.json'),JSON.stringify(this.settings,null,2));break;
        case 'reveal':{const {root}=this.required(),path=resolve(String(data.path??root));if(path!==root&&!path.startsWith(root+'/'))throw new Error('请选择本项目文件');await new Promise<void>((res,rej)=>{const child=spawn('/usr/bin/open',[path],{stdio:'ignore'});child.once('error',rej);child.once('close',code=>code===0?res():rej(new Error('打开文件失败')));});break;}
        default:throw new Error('未找到插件操作');
      }
      return {ok:true,value:await this.snapshot()};
    }catch(error){return {ok:false,error:{code:error instanceof Error&&'code' in error?String(error.code):'STUDIO_ERROR',message:error instanceof Error?error.message:String(error)}};}
  }
  async dispose(){this.disposed=true;this.controller?.abort(new Error('插件已停止'));await this.commands;await this.job;await this.commands;await this.speech.close();await this.renderer.close();}
}

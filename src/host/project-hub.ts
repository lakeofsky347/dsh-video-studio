import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProviderGroup, RpcResult, StudioSnapshot, VideoProject, TtsSettings } from '../shared/types.ts';
import type { HostContext } from './platform.ts';
import { StudioService } from './service.ts';

export interface StudioFocus { shotId?:string; frame?:number }
interface ProjectLocation { id:string; path:string; title:string }
interface HubIndex { version:1; selected?:string; projects:ProjectLocation[]; sessions:Record<string,string> }
type Input=Record<string,unknown>;
type HubSnapshot=StudioSnapshot & {sessionId?:string;focus?:StudioFocus;projects:ProjectLocation[]};

function record(value:unknown):Input {return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Input:{};}
function resultValue<T>(result:RpcResult):T {if(!result.ok)throw new Error(result.error.message);return result.value as T;}

/** One service per project; changing the visible page does not redirect a background render. */
export class ProjectHub {
  readonly baseDirectory:string;
  private services=new Map<string,StudioService>();
  private bootstrap:StudioService;
  private index:HubIndex={version:1,projects:[],sessions:{}};
  private initialized:Promise<void>;
  private writes:Promise<void>=Promise.resolve();
  private selectedSession?:string;
  private focus?:StudioFocus;
  private providers:ProviderGroup[]=[];
  private tts?:TtsSettings;
  private ttsConfigured?:boolean;
  constructor(private ctx:HostContext,config:{baseDirectory?:string}={}){
    this.baseDirectory=resolve(config.baseDirectory??process.env.DSH_VIDEO_PROJECTS??join(homedir(),'Documents','DSHVideoProjects'));
    this.bootstrap=this.makeService(true);
    this.initialized=this.initialize();
  }
  private makeService(restoreRecent=false){return new StudioService(this.ctx,{baseDirectory:this.baseDirectory,restoreRecent});}
  private async initialize(){
    try{
      const saved=JSON.parse(await readFile(join(this.baseDirectory,'sessions.json'),'utf8'));
      if(saved.version===1&&Array.isArray(saved.projects)&&saved.sessions&&typeof saved.sessions==='object')this.index=saved;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const current=await this.bootstrap.snapshot();
    this.providers=current.providers;this.tts=current.tts;this.ttsConfigured=current.ttsConfigured;
    for(const recent of current.recent)if(!this.index.projects.some(item=>item.id===recent.id))this.index.projects.push({id:recent.id,path:recent.path,title:recent.title});
    if(current.project&&current.root){
      this.services.set(current.project.id,this.bootstrap);
      if(!this.index.selected)this.index.selected=current.project.id;
      for(const id of this.projectSessions(current.project))if(!this.index.sessions[id])this.index.sessions[id]=current.project.id;
    }
  }
  private projectSessions(project:VideoProject):string[]{
    const values=project.sessionIds??project.extensions.sessionIds;
    return Array.isArray(values)?values.filter((item):item is string=>typeof item==='string'):[];
  }
  private saveIndex(){
    this.writes=this.writes.then(async()=>{
      await mkdir(this.baseDirectory,{recursive:true});
      const file=join(this.baseDirectory,'sessions.json'),temporary=file+'.tmp';
      await writeFile(temporary,JSON.stringify(this.index,null,2)+'\n');await rename(temporary,file);
    });return this.writes;
  }
  private async remember(snapshot:StudioSnapshot){
    if(!snapshot.project||!snapshot.root)return;
    const entry={id:snapshot.project.id,path:snapshot.root,title:snapshot.project.title};
    const previous=this.index.projects.findIndex(item=>item.id===entry.id);
    if(previous>=0&&JSON.stringify(this.index.projects[previous])===JSON.stringify(entry))return;
    if(previous<0)this.index.projects.push(entry);else this.index.projects[previous]=entry;
    await this.saveIndex();
  }
  private async service(projectId?:string):Promise<StudioService>{
    const id=projectId??this.index.selected;
    if(!id)return this.bootstrap;
    const loaded=this.services.get(id);if(loaded)return loaded;
    const location=this.index.projects.find(item=>item.id===id);if(!location)throw new Error('未找到视频工程，请先创建或打开');
    const service=this.makeService();
    try{const snapshot=resultValue<StudioSnapshot>(await service.rpc('open',{path:location.path}));if(snapshot.project?.id!==id)throw new Error('工程 ID 与保存位置不一致');this.services.set(id,service);return service;}
    catch(error){await service.dispose();throw error;}
  }
  private async bind(service:StudioService,sessionId:string){
    if(!sessionId.trim())throw new Error('请选择关联会话');
    const snapshot=await service.snapshot(),project=snapshot.project;if(!project)throw new Error('请先创建或打开视频工程');
    const sessions=[...new Set([...this.projectSessions(project),sessionId])];
    if(!this.projectSessions(project).includes(sessionId))resultValue(await service.rpc('save',{project:{...project,sessionIds:sessions,extensions:{...project.extensions,sessionIds:sessions}}}));
    this.index.sessions[sessionId]=project.id;await this.saveIndex();
  }
  private async decorate(service:StudioService,sessionId?:string):Promise<HubSnapshot>{
    const snapshot=await service.snapshot();
    const selected=snapshot.project?.id===this.index.selected;
    return {...snapshot,providers:this.providers,tts:this.tts??snapshot.tts,ttsConfigured:this.ttsConfigured??snapshot.ttsConfigured,sessionId:sessionId??(selected?this.selectedSession:undefined)??(snapshot.project?this.projectSessions(snapshot.project)[0]:undefined),focus:selected?this.focus:undefined,projects:structuredClone(this.index.projects)};
  }
  /** Resolve by explicit project or session; never silently reuse another session's project. */
  async resolveProject(input:Input,sessionId?:string):Promise<{service:StudioService;projectId:string;snapshot:StudioSnapshot}>{
    await this.initialized;
    const id=typeof input.projectId==='string'?input.projectId:sessionId?this.index.sessions[sessionId]:this.index.selected;
    if(!id)throw new Error('当前会话还没有视频工程，请先使用 video_project 创建或绑定工程');
    const service=await this.service(id),snapshot=await service.snapshot();
    if(!snapshot.project)throw new Error('视频工程尚未打开');
    return {service,projectId:snapshot.project.id,snapshot};
  }
  async call<T=HubSnapshot>(endpoint:string,input:unknown={}):Promise<T>{return resultValue<T>(await this.route(endpoint,input));}
  async route(endpoint:string,payload:unknown):Promise<RpcResult>{
    try{
      await this.initialized;const data=record(payload),sessionId=typeof data.sessionId==='string'?data.sessionId:undefined;
      const projectInput=record(data.project);
      let id=typeof data.projectId==='string'?data.projectId:typeof projectInput.id==='string'?projectInput.id:sessionId?this.index.sessions[sessionId]:this.index.selected;
      if(endpoint==='list')return {ok:true,value:{projects:structuredClone(this.index.projects),sessions:{...this.index.sessions},selected:this.index.selected}};
      if(endpoint==='create'||endpoint==='open'){
        if(endpoint==='open'&&typeof data.path==='string'){
          const requestedPath=resolve(data.path),existing=this.index.projects.find(item=>resolve(item.path)===requestedPath);
          if(existing){const service=await this.service(existing.id);if(sessionId)await this.bind(service,sessionId);if(data.select!==false){this.index.selected=existing.id;this.selectedSession=sessionId;this.focus=undefined;await this.saveIndex();}return {ok:true,value:await this.decorate(service,sessionId)};}
        }
        const service=this.makeService();
        try{
          const snapshot=resultValue<StudioSnapshot>(await service.rpc(endpoint,data));
          if(!snapshot.project)throw new Error('创建或打开工程失败');
          const previous=this.services.get(snapshot.project.id);if(previous)throw new Error('该工程已打开，请使用 projectId 选择工程');
          this.services.set(snapshot.project.id,service);if(data.select!==false){this.index.selected=snapshot.project.id;this.selectedSession=sessionId;this.focus=undefined;}
          if(sessionId)await this.bind(service,sessionId);await this.remember(await service.snapshot());
          return {ok:true,value:await this.decorate(service,sessionId)};
        }catch(error){await service.dispose();throw error;}
      }
      if(endpoint==='current'&&sessionId&&!id){
        const empty=await this.bootstrap.snapshot();return {ok:true,value:{...empty,project:null,root:null,previewUrl:null,previewRevision:null,assetBaseUrl:null,task:null,sessionId,focus:undefined,projects:this.index.projects}};
      }
      const service=await this.service(id);
      if(endpoint==='bind'||endpoint==='bindSession'){
        if(!sessionId)throw new Error('请选择关联会话');await this.bind(service,sessionId);if(data.select!==false){const snapshot=await service.snapshot();this.index.selected=snapshot.project!.id;this.selectedSession=sessionId;await this.saveIndex();}
        return {ok:true,value:await this.decorate(service,sessionId)};
      }
      if(endpoint==='focus'){
        const snapshot=await service.snapshot();if(!snapshot.project)throw new Error('请先创建视频工程');
        this.index.selected=snapshot.project.id;this.selectedSession=sessionId??this.projectSessions(snapshot.project)[0];
        this.focus={...(typeof data.shotId==='string'?{shotId:data.shotId}:{}),...(typeof data.frame==='number'?{frame:Math.max(0,Math.floor(data.frame))}:{})};
        await this.saveIndex();return {ok:true,value:await this.decorate(service,sessionId)};
      }
      const result=await service.rpc(endpoint,data);if(!result.ok)return result;
      if(['source','inspect'].includes(endpoint))return result;
      if(endpoint==='catalog')this.providers=(result.value as StudioSnapshot).providers;
      if(endpoint==='tts'){const snapshot=result.value as StudioSnapshot;this.tts=snapshot.tts;this.ttsConfigured=snapshot.ttsConfigured;}
      await this.remember(await service.snapshot());return {ok:true,value:await this.decorate(service,sessionId)};
    }catch(error){return {ok:false,error:{code:'STUDIO_ERROR',message:error instanceof Error?error.message:String(error)}};}
  }
  async dispose(){await this.initialized;await Promise.all([...new Set([this.bootstrap,...this.services.values()])].map(service=>service.dispose()));await this.writes;}
}

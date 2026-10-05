import type { ClientRpc, ModelRoute, SceneSource, StudioApi, StudioSnapshot, VideoProject } from '../shared/types.ts';

export interface StudioState {
  snapshot:StudioSnapshot|null; loading:boolean; pending:boolean; saving:boolean;
  error:string; notice:string; scheme:'light'|'dark'; selected:string|null;
  route:ModelRoute; canUndo:boolean; canRedo:boolean; localImages:Record<string,string>;focusFrame:number|null;focusSerial:number;
}

export class RpcStudioApi implements StudioApi {
  constructor(private rpc:ClientRpc,private signal?:AbortSignal) {}
  async call<T>(endpoint:string,payload:unknown={}):Promise<T> {
    const response=await this.rpc.call('/api',`video-studio/${endpoint}`,payload,this.signal);
    if(!response.ok)throw new Error(response.error.message);
    return response.value as T;
  }
}

/** One observable survives sidebar navigation; its job poller is owned by the plugin. */
export class StudioController {
  private state:StudioState={snapshot:null,loading:true,pending:false,saving:false,error:'',notice:'',scheme:'dark',selected:null,route:{provider:'',model:''},canUndo:false,canRedo:false,localImages:{},focusFrame:null,focusSerial:0};
  private listeners=new Set<()=>void>();
  private disposed=false;
  private saveTimer:ReturnType<typeof setTimeout>|undefined;
  private pollTimer:ReturnType<typeof setTimeout>|undefined;
  private history:VideoProject[]=[];
  private historyIndex=-1;
  private editSerial=0;
  private dirty=false;
  private savingPromise:Promise<void>|null=null;
  private polling=false;
  private actionEpoch=0;
  constructor(readonly api:StudioApi) {}
  getSnapshot=():StudioState=>this.state;
  subscribe=(fn:()=>void):(()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private update(patch:Partial<StudioState>):void {if(this.disposed)return;this.state={...this.state,...patch};for(const fn of this.listeners)fn();}
  private accept(snapshot:StudioSnapshot,protectDraft=true):void {
    const previous=this.state.snapshot?.project||null;
    const keepProject=protectDraft&&previous?.id===snapshot.project?.id&&(this.dirty||this.state.pending||(previous?.revision??0)>(snapshot.project?.revision??0));
    const project=keepProject?previous:snapshot.project;
    const changed=project?.id!==previous?.id;
    if(changed){this.history=project?[clone(project)]:[];this.historyIndex=project?0:-1;this.dirty=false;}
    const route=this.state.route;
    const provider=snapshot.providers.find(p=>p.id===route.provider)||snapshot.providers.find(p=>p.models.length);
    const model=provider?.models.find(m=>m.id===route.model)||provider?.models[0];
    const selected=this.state.selected;
    this.update({snapshot:{...snapshot,project},loading:false,...(changed?{selected:null,canUndo:false,canRedo:false,focusFrame:null}:{}),
      ...(!selected||project?.shots.some(s=>s.id===selected)||project?.assets.some(a=>a.id===selected)?{}:{selected:null}),
      route:{provider:provider?.id||'',model:model?.id||''}});
    if(snapshot.task?.status==='running')this.schedulePoll();
  }
  async load():Promise<void>{try{this.accept(await this.api.call<StudioSnapshot>('catalog'));this.update({error:''});}catch(e){this.update({loading:false,error:message(e)});}}
  async focusProject(project:string|{projectId?:string;path?:string;sessionId?:string;shotId?:string;frame?:number},focus:{shotId?:string;frame?:number;sessionId?:string}={}):Promise<void>{
    const payload=typeof project==='string'?{projectId:project,...focus}:project;
    await this.action('focus',payload);if(this.state.error)throw new Error(this.state.error);if(payload.projectId&&this.state.snapshot?.project?.id!==payload.projectId)throw new Error('工程定位未完成，请稍后重试');const selected=payload.shotId??this.state.snapshot?.focus?.shotId;
    if(selected)this.select(selected);
    const frame=payload.frame??this.state.snapshot?.focus?.frame;
    if(frame!==undefined)this.update({focusFrame:frame,focusSerial:this.state.focusSerial+1});
  }
  async bindSession(sessionId:string):Promise<void>{await this.action('bindSession',{sessionId},'工程已关联到会话');}
  async audio(payload:unknown):Promise<void>{await this.action('audio',payload);}
  private schedulePoll():void {
    if(this.disposed||this.polling||this.pollTimer)return;
    this.pollTimer=setTimeout(()=>{this.pollTimer=undefined;void this.poll();},700);
  }
  private async poll():Promise<void>{
    if(this.disposed||this.polling)return;this.polling=true;
    const epoch=this.actionEpoch;
    try{const snapshot=await this.api.call<StudioSnapshot>('current',{projectId:this.state.snapshot?.project?.id});if(epoch===this.actionEpoch&&!this.state.pending)this.accept(snapshot);}catch(e){this.update({error:message(e)});}
    finally{this.polling=false;if(this.state.snapshot?.task?.status==='running')this.schedulePoll();}
  }
  setScheme=(scheme:'light'|'dark'):void=>this.update({scheme});
  select=(selected:string|null):void=>this.update({selected});
  setRoute=(route:ModelRoute):void=>this.update({route});
  clearError=():void=>this.update({error:''});
  notify=(notice:string):void=>this.update({notice});
  edit=(project:VideoProject,record=true):void=>{
    if(!this.state.snapshot||this.state.pending)return;
    const task=this.state.snapshot.task;
    if(task?.status==='running'&&['storyboard','scenes','modify','audio'].includes(task.kind))return;
    this.editSerial++;this.dirty=true;
    if(record){this.history=this.history.slice(0,this.historyIndex+1);this.history.push(clone(project));if(this.history.length>50)this.history.shift();this.historyIndex=this.history.length-1;}
    this.update({snapshot:{...this.state.snapshot,project},saving:true,notice:'',canUndo:this.historyIndex>0,canRedo:this.historyIndex<this.history.length-1});
    clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>{this.saveTimer=undefined;void this.flush();},450);
  };
  undo=():void=>{if(this.historyIndex<=0)return;this.historyIndex--;this.edit(clone(this.history[this.historyIndex]!),false);};
  redo=():void=>{if(this.historyIndex>=this.history.length-1)return;this.historyIndex++;this.edit(clone(this.history[this.historyIndex]!),false);};
  async flush():Promise<void>{
    clearTimeout(this.saveTimer);this.saveTimer=undefined;
    if(this.savingPromise){await this.savingPromise;if(this.dirty)return this.flush();return;}
    const project=this.state.snapshot?.project;if(!project||!this.dirty)return;
    const serial=this.editSerial;
    this.savingPromise=(async()=>{
      try{
        const snapshot=await this.api.call<StudioSnapshot>('save',{project});
        if(serial===this.editSerial){this.dirty=false;this.accept(snapshot,false);this.update({saving:false,error:''});}
      }catch(e){this.update({saving:false,error:message(e)});}
    })();
    await this.savingPromise;this.savingPromise=null;
    if(this.dirty&&serial!==this.editSerial)await this.flush();
  }
  async action(endpoint:string,payload:unknown={},notice=''):Promise<void>{
    if(this.state.pending)return;this.actionEpoch++;this.update({pending:true,error:'',notice:''});
    try{await this.flush();if(this.dirty)throw new Error(this.state.error||'项目尚未保存，请重试保存。');const request=['create','open','focus'].includes(endpoint)?payload:{projectId:this.state.snapshot?.project?.id,...payload as object};const snapshot=await this.api.call<StudioSnapshot>(endpoint,request);this.accept(snapshot,false);
      if(snapshot.project&&['create','open','import','apply','audio','focus'].includes(endpoint)){this.history=[clone(snapshot.project)];this.historyIndex=0;this.update({canUndo:false,canRedo:false});}
      this.update({notice});
    }catch(e){this.update({error:message(e)});}finally{this.update({pending:false});}
  }
  async generate(kind:'storyboard'|'scenes'|'modify',instruction='',shotId?:string):Promise<void>{
    if(this.busy)return;if(!this.state.route.provider||!this.state.route.model){this.update({error:'先选择一个 DSH 模型，再开始生成。'});return;}
    await this.action('generate',{kind,instruction,shotId,...this.state.route});
  }
  async readSource(shotId:string):Promise<SceneSource>{return this.api.call<SceneSource>('source',{shotId,projectId:this.state.snapshot?.project?.id});}
  async saveSource(shotId:string,source:SceneSource):Promise<void>{await this.action('saveSource',{shotId,source},'源码已保存，可以刷新预览。');}
  async restoreSource(shotId:string):Promise<void>{await this.action('restoreSource',{shotId},'已恢复上次可用源码。');}
  async importFile(file:File):Promise<void>{
    if(file.type.startsWith('image/')){
      const data=await readDataUrl(file);
      await this.action('import',{name:file.name,mime:file.type,dataBase64:data.slice(data.indexOf(',')+1)});
      const asset=[...(this.state.snapshot?.project?.assets||[])].reverse().find(a=>a.name===file.name&&a.kind==='image');
      if(asset)this.update({localImages:{...this.state.localImages,[asset.id]:data}});
    }else if(file.type.startsWith('text/')||/\.(txt|md)$/i.test(file.name)){
      await this.action('import',{name:file.name,mime:'text/plain',text:await file.text()});
    }else if(file.type.startsWith('audio/')||/\.(wav|mp3|m4a|aac|flac|ogg|aiff)$/i.test(file.name)){
      const data=await readDataUrl(file);await this.action('import',{name:file.name,mime:file.type,dataBase64:data.slice(data.indexOf(',')+1)});
    }else this.update({error:'请选择图片、文字或 WAV、MP3、M4A、AAC、FLAC、OGG 音频。'});
  }
  get busy():boolean{return this.state.pending||this.state.snapshot?.task?.status==='running';}
  async dispose():Promise<void>{this.disposed=true;clearTimeout(this.saveTimer);clearTimeout(this.pollTimer);await this.flush();this.listeners.clear();}
}
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
function message(error:unknown):string{return error instanceof Error?error.message:'操作未完成';}
function readDataUrl(file:File):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('读取图片失败'));reader.readAsDataURL(file);});}

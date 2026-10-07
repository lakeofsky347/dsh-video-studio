import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
import type { StudioSnapshot } from '../shared/types.ts';
import type { HostContext } from './platform.ts';
import { ProjectHub, type ProjectRouting } from './project-hub.ts';

declare module '@deepseek-ai/dsh-jobs/view' {interface JobKindMap { video:'video' }}
type Input=Record<string,unknown>;
const pause=(signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  signal?.throwIfAborted();const timer=setTimeout(done,180);function done(){signal?.removeEventListener('abort',abort);resolve();}
  function abort(){clearTimeout(timer);reject(signal?.reason);}signal?.addEventListener('abort',abort,{once:true});
});
function record(value:unknown):Input {return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Input:{};}
function json(value:unknown):Record<string,JsonValue> {return JSON.parse(JSON.stringify(value));}
function owner(exec:ToolRunContext):string {if(!exec.agent)throw new Error('视频工具需要在 DSH 会话中调用');return exec.agent.id;}
function routeMeta(routing:ProjectRouting):Input{return {...routing,sessionId:routing.ownerSessionId??routing.callerSessionId};}
function receipt(snapshot:StudioSnapshot,extra:Input={}):Record<string,JsonValue>{
  const project=snapshot.project;if(!project)throw new Error('视频工程尚未创建');
  return json({kind:'video-studio',projectId:project.id,title:project.title,revision:project.revision,root:snapshot.root,target:project.target,
    topic:project.topic,shotCount:project.shots.length,assets:project.assets,
    shots:project.shots,shotOrder:project.shotOrder,audioClips:project.audioClips??[],
    task:snapshot.task,outputs:project.outputs,history:snapshot.history,sessionIds:snapshot.relatedSessionIds??[],...extra});
}
const output={schema:{type:'object',additionalProperties:true} as const,
  render:(_args:unknown,value:Record<string,JsonValue>)=>[{type:'text' as const,text:JSON.stringify(value)}],
  presentationMeta:(_args:unknown,value:Record<string,JsonValue>)=>value};
const projectParameter={type:'string' as const,description:'稳定的工程 ID。省略时使用调用会话当前工程；subagent / agent team 成员继承最近的已绑定委派祖先。fork 不继承。显式 ID 可用于团队协作。'};

/** Bridge session image and verbatim file references into the portable project directory. */
async function importAttachment(ctx:HostContext,hub:ProjectHub,projectId:string,item:Input,sessionId:string,signal:AbortSignal,audio=false,expectedRevision?:number){
  const attachment=record(item.attachment);let input:Input={...item};delete input.attachment;
  if(typeof attachment.attachmentId==='string'){
    if(!ctx.attachments)throw new Error('DSH 附件服务尚未加载');
    if(typeof attachment.mediaType==='string'&&attachment.mediaType.startsWith('image/')){
      if(!['image/png','image/jpeg','image/webp'].includes(attachment.mediaType)||typeof attachment.bytes!=='number'||typeof attachment.width!=='number'||typeof attachment.height!=='number')throw new Error('请传入会话已保存的完整图片附件引用');
      const reference:ImageAttachmentRef={attachmentId:attachment.attachmentId,mediaType:attachment.mediaType as ImageAttachmentRef['mediaType'],bytes:attachment.bytes,width:attachment.width,height:attachment.height,...(typeof attachment.name==='string'?{name:attachment.name}:{})};
      const stored=await ctx.attachments.readImage(reference,signal);input={...input,name:item.name??reference.name??'会话图片',mime:reference.mediaType,dataBase64:Buffer.from(stored.data).toString('base64')};
    }else{
      if(typeof attachment.name!=='string'||typeof attachment.bytes!=='number')throw new Error('请传入会话已保存的完整文件附件引用');
      const reference:FileAttachmentRef={attachmentId:attachment.attachmentId,name:attachment.name,bytes:attachment.bytes},path=ctx.attachments.fileHostPath(reference);
      if(!path)throw new Error('当前 DSH 附件服务无法提供文件路径');input={...input,path,name:item.name??reference.name};
    }
  }
  signal.throwIfAborted();return hub.call<StudioSnapshot>(audio?'audio':'import',{...input,projectId,sessionId,expectedRevision,...(audio?{action:'import'}:{})});
}

/** Reuse the DSH job roster, cancellation and durable result notices for slow local rendering. */
function startRender(ctx:HostContext,hub:ProjectHub,projectId:string,sessionId:string,endpoint:string,input:Input,exec:ToolRunContext,routing:ProjectRouting){
  if(!ctx.jobs)throw new Error('DSH 后台任务服务尚未加载');exec.signal.throwIfAborted();
  const jobId=ctx.jobs.start({kind:'video',owner:exec.agent!.id,label:typeof input.label==='string'?input.label:`视频${endpoint==='export'?'导出':'检查'} · ${projectId}`,
    run(job){
      const controller=new AbortController();let ownedTaskId:string|undefined;
      const cancelOwned=async()=>{if(!ownedTaskId)return;const snapshot=await hub.call<StudioSnapshot>('current',{projectId});if(snapshot.task?.id===ownedTaskId&&snapshot.task.status==='running')await hub.call('cancel',{projectId});};
      const done=(async():Promise<JobOutcome>=>{
        try{
          controller.signal.throwIfAborted();let snapshot=await hub.call<StudioSnapshot>(endpoint,{...input,projectId,sessionId});
          ownedTaskId=snapshot.task?.id;if(controller.signal.aborted)await cancelOwned();
          const taskId=ownedTaskId;
          while(snapshot.task?.status==='running'){
            job.updateProgress(`${Math.round(snapshot.task.progress*100)}% · ${snapshot.task.message}`);
            await pause();if(controller.signal.aborted)await cancelOwned();
            snapshot=await hub.call<StudioSnapshot>('current',{projectId,sessionId});
            if(taskId&&snapshot.task?.id!==taskId)throw new Error('视频任务已被另一任务替换');
          }
          const value=receipt(snapshot,{...routeMeta(routing),jobId:job.id,operation:endpoint});job.append(JSON.stringify(value)+'\n');
          if(snapshot.task?.status==='failed')return {status:'failed',detail:snapshot.task.error??snapshot.task.message,result:JSON.stringify(value)};
          if(controller.signal.aborted||snapshot.task?.status==='cancelled')return {status:'killed',detail:'已取消',result:JSON.stringify(value)};
          return {status:'completed',result:JSON.stringify(value)};
        }catch(error){return {status:controller.signal.aborted?'killed':'failed',detail:error instanceof Error?error.message:String(error)};}
      })();
      return {done,cancel(reason){controller.abort(new Error(reason??'用户已取消'));void cancelOwned().catch(()=>{});}};
    }});
  return json({kind:'video-studio',projectId,...routeMeta(routing),jobId,status:'running',operation:endpoint});
}

/** Model-facing tools accept the current conversation model's decisions and code; they do not start a second chat. */
export function createSessionTools(ctx:HostContext,hub:ProjectHub):ToolDefinition[]{
  return [
    defineTool({name:'video_project',description:'在当前 DSH 会话创建、打开、绑定或查看视频工程。对话模型负责导演决策，通过 video_update 提交规范化分镜和前端源码；插件负责保存、渲染和检查。用户可随时从工具卡片打开工作台看镜头与帧，不需要另一个聊天模型。',
      parameters:{action:{type:'string',enum:['create','open','get','list','bind'],required:true},projectId:projectParameter,forceNew:{type:'boolean',description:'子代理已继承工程时，默认 create 返回该工程，防止团队重复创建；明确需要独立工程时设为 true。'},path:{type:'string',description:'open 时的本地工程目录'},title:{type:'string'},topic:{type:'string'},targetDuration:{type:'number'},target:{type:'object',additionalProperties:true,description:'输出 width、height、fps:{num,den}、音频模式等；可在之后更新。'}},output,
      async execute(args,exec){
        const sessionId=owner(exec);exec.signal.throwIfAborted();
        if(args.action==='list'){const routed=await hub.sessionRouting(sessionId,exec.signal);return json({...await hub.call<Input>('list',{sessionId}),...routeMeta(routed.routing),projectId:routed.projectId});}
        if(args.action==='get'){const located=await hub.resolveProject({...args,signal:exec.signal},sessionId);return receipt(located.snapshot,routeMeta(located.routing));}
        if(args.action==='create'&&!args.forceNew){
          try{const inherited=await hub.resolveProject({signal:exec.signal},sessionId);if(inherited.routing.ownerSessionId!==sessionId)return receipt(inherited.snapshot,{...routeMeta(inherited.routing),reusedInheritedProject:true});}
          catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='PROJECT_UNBOUND'))throw error;}
        }
        const snapshot=await hub.call<StudioSnapshot>(args.action,{...args,sessionId,select:false},{callerSessionId:sessionId});
        return receipt(snapshot,routeMeta({callerSessionId:sessionId,ownerSessionId:sessionId,routingSource:'session-binding'}));
      }}),
    defineTool({name:'video_update',description:'把本会话已讨论的制作要求写入视频工程，不另调模型。update 支持 title/topic/targetDuration/target、shots(完整分镜数组)、shotOrder、shotPatches:[{id,patch}]、sources:[{shotId,source:{html,css,js}}]。源码是 ES 模块，导出 render(ctx)，可导出 async ready(ctx)；用 ctx.root/canvas/ctx2d/params/assets/localFrame/progress/time/width/height 按帧计算，不用 Date.now 或自行播放动画，保留已有镜头 ID 和可编辑参数。imports 可接收当前会话的 durable attachment 引用、已有本地图片文件或文字；先读工程取得素材和镜头 ID，再做局部修改。',
      parameters:{projectId:projectParameter,update:{type:'object',additionalProperties:true,required:true},imports:{type:'array',items:{type:'object',additionalProperties:true}},expectedRevision:{type:'integer',description:'video_project get 返回的 revision；subagent / agent team 修改必须填写。版本过期时先读取最新内容，再合并修改。'}},output,
      async execute(args,exec){
        const sessionId=owner(exec),located=await hub.resolveProject({...args,signal:exec.signal},sessionId);exec.signal.throwIfAborted();
        if(located.requiresRevision&&args.expectedRevision===undefined)throw Object.assign(new Error('子代理或团队协作修改工程需要 expectedRevision，请先 video_project get 后合并修改'),{code:'REVISION_REQUIRED'});
        if(args.expectedRevision!==undefined&&args.expectedRevision!==located.snapshot.project!.revision)throw new Error('视频工程已被用户修改，请先 video_project get 后合并修改');
        let revision=located.snapshot.project!.revision;
        for(const item of args.imports??[]){const imported=await importAttachment(ctx,hub,located.projectId,item,sessionId,exec.signal,false,revision);revision=imported.project!.revision;}
        const snapshot=await hub.call<StudioSnapshot>('apply',{...args.update,projectId:located.projectId,sessionId,expectedRevision:revision});return receipt(snapshot,routeMeta(located.routing));
      }}),
    defineTool({name:'video_inspect',description:'读取具体制作要求、源码或实际渲染的指定帧，帮助在会话中检查镜头；frame 是全片零起始整数帧。工具卡片可直接把工作台定位到工程、镜头及帧。仅检查，不会重新创作或改片。',
      parameters:{projectId:projectParameter,shotId:{type:'string'},frame:{type:'integer'},includeSource:{type:'boolean'}},output,
      async execute(args,exec){
        const sessionId=owner(exec),located=await hub.resolveProject({...args,signal:exec.signal},sessionId);exec.signal.throwIfAborted();
        const value=await hub.call('inspect',{...args,projectId:located.projectId,sessionId,signal:exec.signal});return json({kind:'video-studio',projectId:located.projectId,...routeMeta(located.routing),shotId:args.shotId,frame:args.frame,inspection:value});
      }}),
    defineTool({name:'video_render',description:'检查镜头源码、创建实际代码预览，或以当前工程快照导出 MP4。默认后台任务立即返回 jobId，使用 DSH job_output 取进度/结果、job_kill 取消；不会启动新的聊天模型。foreground:true 可等待本次运行完成。',
      parameters:{projectId:projectParameter,action:{type:'string',enum:['preview','check','export'],required:true},foreground:{type:'boolean'}},output,
      async execute(args,exec){
        const sessionId=owner(exec),located=await hub.resolveProject({...args,signal:exec.signal},sessionId),endpoint=args.action==='check'?'preview':args.action;
        if(!args.foreground)return startRender(ctx,hub,located.projectId,sessionId,endpoint,{...args,expectedRevision:located.snapshot.project!.revision},exec,located.routing);
        let ownedTaskId:string|undefined;
        const cancelOwned=async()=>{if(!ownedTaskId)return;const current=await hub.call<StudioSnapshot>('current',{projectId:located.projectId});if(current.task?.id===ownedTaskId&&current.task.status==='running')await hub.call('cancel',{projectId:located.projectId});};
        const cancel=()=>{void cancelOwned().catch(()=>{});};exec.signal.addEventListener('abort',cancel,{once:true});
        try{
          exec.signal.throwIfAborted();let snapshot=await hub.call<StudioSnapshot>(endpoint,{projectId:located.projectId,sessionId,expectedRevision:located.snapshot.project!.revision});
          ownedTaskId=snapshot.task?.id;if(exec.signal.aborted)await cancelOwned();
          while(snapshot.task?.status==='running'){await pause();if(exec.signal.aborted)await cancelOwned();snapshot=await hub.call<StudioSnapshot>('current',{projectId:located.projectId,sessionId});if(ownedTaskId&&snapshot.task?.id!==ownedTaskId)throw new Error('视频任务已被另一任务替换');}
          exec.signal.throwIfAborted();if(snapshot.task?.status==='failed')throw new Error(snapshot.task.error??snapshot.task.message);return receipt(snapshot,{...routeMeta(located.routing),operation:endpoint});
        }finally{exec.signal.removeEventListener('abort',cancel);}
      }}),
    defineTool({name:'video_audio',description:'给工程导入用户配音/音效文件、绑定音频片段、改音量和开始时间、删除片段或使用工程环境页明确配置的配音提供器合成。不会读取其它插件密钥，也不默认调用远程配音。会话上传的音频是 durable 文件附件；action=import 接收 attachment 或本地 path；其它参数放 request。',
      parameters:{projectId:projectParameter,action:{type:'string',enum:['import','add','update','remove','synthesize'],required:true},attachment:{type:'object',additionalProperties:true},path:{type:'string'},name:{type:'string'},request:{type:'object',additionalProperties:true},expectedRevision:{type:'integer',description:'读取到的工程版本；团队成员编辑音轨前先 get 并填写，版本过期需合并修改。'}},output,
      async execute(args,exec){
        const sessionId=owner(exec),located=await hub.resolveProject({...args,signal:exec.signal},sessionId);exec.signal.throwIfAborted();
        if(located.requiresRevision&&args.expectedRevision===undefined)throw Object.assign(new Error('子代理或团队协作修改音轨需要 expectedRevision，请先 video_project get 后合并修改'),{code:'REVISION_REQUIRED'});
        const expectedRevision=args.expectedRevision??located.snapshot.project!.revision;
        if(args.action==='synthesize')return startRender(ctx,hub,located.projectId,sessionId,'audio',{...args.request,expectedRevision,action:'synthesize',label:'生成视频配音'},exec,located.routing);
        const snapshot=args.action==='import'?await importAttachment(ctx,hub,located.projectId,{...args,...args.request},sessionId,exec.signal,true,expectedRevision):
          await hub.call<StudioSnapshot>('audio',{...args.request,action:args.action,projectId:located.projectId,sessionId,expectedRevision});
        return receipt(snapshot,{...routeMeta(located.routing),audioClips:snapshot.project?.audioClips});
      }})
  ];
}

export function registerSessionTools(ctx:HostContext,hub:ProjectHub){
  if(!ctx.tools)throw new Error('DSH 工具服务尚未加载');
  for(const tool of createSessionTools(ctx,hub))ctx.effect(()=>ctx.tools!.register(tool),`video-studio tool ${tool.name}`);
}

import type { ClientRpc } from '../shared/types.ts';
import { RpcStudioApi, StudioController } from './controller.ts';
import { FilmMark, Studio } from './Studio.tsx';
import css from './styles.css?inline';
import { useState, useSyncExternalStore } from 'react';

type RecordValue=Record<string,unknown>;
function object(value:unknown):RecordValue{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:{};}
interface SessionList {byId:Record<string,{id:string;retainedBy?:Record<string,number>}>}
interface VideoCardProps {toolName:string;phase:'preparing'|'start'|'result';sessionId:string;block:{meta?:unknown;argsRaw?:string;call?:{argsRaw:string}|null;content?:readonly {type:string;text?:string}[];isError?:boolean};}

interface ClientContext {
  connection:{rpc:ClientRpc};
  slots:{inject(name:string,setup:()=>unknown):unknown;register(options:object,component:unknown):unknown};
  locale:{register(namespace:string,dictionaries:object):()=>void;bind(namespace:string):(key:string)=>string};
  theme?:{getTheme():{active:{colorScheme:'light'|'dark'}}};
  layout:{selectPanel(id:string|null):void};
  uiWorkspace:{openSession(id:string):void};
  sessions:{list:{getSnapshot():SessionList;subscribe(listener:()=>void):()=>void}};
  effect(setup:()=>void|(()=>void),label?:string):unknown;
  on(event:string,listener:()=>void):()=>void;
}
export const inject=['slots','locale','connection','theme','layout','uiWorkspace','sessions'];
export function apply(ctx:ClientContext):void {
  const abort=new AbortController();
  const controller=new StudioController(new RpcStudioApi(ctx.connection.rpc,abort.signal));
  ctx.effect(()=>()=>{void controller.dispose().finally(()=>abort.abort());},'video-studio: plugin lifetime');
  ctx.effect(()=>{const flush=()=>{void controller.flush();};window.addEventListener('pagehide',flush);window.addEventListener('blur',flush);return()=>{window.removeEventListener('pagehide',flush);window.removeEventListener('blur',flush);};},'video-studio: save on leaving');
  ctx.effect(()=>ctx.locale.register('video-studio',{zh:{panel:'映流 · 视频工作台',project:'视频工程',update:'更新视频',inspect:'检查镜头与帧',render:'渲染视频',audio:'制作音频',preparing:'准备调用',running:'正在执行',submitted:'已提交后台任务',complete:'已完成',failed:'执行失败',open:'打开工作台',frame:'查看指定帧',return:'返回会话',details:'查看调用记录'},en:{panel:'Video Studio',project:'Video project',update:'Update video',inspect:'Inspect shots and frames',render:'Render video',audio:'Produce audio',preparing:'Preparing',running:'Running',submitted:'Submitted to background job',complete:'Completed',failed:'Failed',open:'Open studio',frame:'View frame',return:'Return to session',details:'Call details'}}),'video-studio: copy');
  const t=ctx.locale.bind('video-studio');
  const syncTheme=()=>controller.setScheme(ctx.theme?.getTheme().active.colorScheme||(document.body.hasAttribute('data-ds-dark-theme')?'dark':'light'));
  syncTheme();ctx.effect(()=>ctx.on('theme/change',syncTheme),'video-studio: theme');
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='dsh-video-studio';style.textContent=css;document.head.append(style);return()=>style.remove();},'video-studio: styles');
  function SessionStudio(){
    const list=useSyncExternalStore(listener=>ctx.sessions.list.subscribe(listener),()=>ctx.sessions.list.getSnapshot(),()=>ctx.sessions.list.getSnapshot());
    const current=Object.values(list.byId).find(row=>(row.retainedBy?.mainView??0)>0)?.id;
    return <Studio controller={controller} currentSessionId={current} onOpenSession={id=>ctx.uiWorkspace.openSession(id)}/>;
  }
  function VideoCard({toolName,phase,sessionId,block}:VideoCardProps){
    const [error,setError]=useState('');let args:RecordValue={};
    try{args=object(JSON.parse(block.argsRaw??block.call?.argsRaw??'{}'));}catch{/* A preparing stream may not contain complete JSON yet. */}
    let meta=object(block.meta);
    if(meta.kind!=='video-studio')for(const content of block.content??[]){try{const value=object(JSON.parse(content.text??''));if(value.kind==='video-studio'){meta=value;break;}}catch{/* Other tools and interrupted calls keep their raw record below. */}}
    const inspection=object(meta.inspection),inspectionFrame=object(inspection.frame);
    const projectId=typeof meta.projectId==='string'?meta.projectId:typeof args.projectId==='string'?args.projectId:undefined;
    const shotId=typeof meta.shotId==='string'?meta.shotId:typeof inspectionFrame.shotId==='string'?inspectionFrame.shotId:typeof args.shotId==='string'?args.shotId:undefined;
    const frame=typeof meta.frame==='number'?meta.frame:typeof inspectionFrame.frame==='number'?inspectionFrame.frame:typeof args.frame==='number'?args.frame:undefined;
    const linkedSession=typeof meta.sessionId==='string'?meta.sessionId:sessionId;
    const title=t(({video_project:'project',video_update:'update',video_inspect:'inspect',video_render:'render',video_audio:'audio'} as Record<string,string>)[toolName]??'project');
    const state=t(phase==='preparing'?'preparing':phase==='start'?'running':block.isError?'failed':meta.status==='running'&&typeof meta.jobId==='string'?'submitted':'complete');
    const open=async()=>{if(!projectId)return;try{await controller.focusProject(projectId,{shotId,frame,sessionId:linkedSession});ctx.layout.selectPanel('video-studio');setError('');}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}};
    return <section data-video-tool={toolName} data-video-project={projectId} style={{border:'1px solid var(--dsw-border-default, #7776)',borderRadius:10,padding:12,margin:'8px 0',background:'var(--dsw-surface-elevated, transparent)'}}>
      <div style={{display:'flex',gap:10,alignItems:'center'}}><strong>{title}</strong><small>{state}</small></div>
      {typeof meta.title==='string'&&<p>{meta.title} · v{String(meta.revision??'')}</p>}
      {typeof meta.jobId==='string'&&<p>Job · {meta.jobId}</p>}
      {projectId&&<div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:8}}><button type="button" onClick={()=>void open()}>{frame===undefined?t('open'):t('frame')+(frame===undefined?'':` · ${frame}`)}</button><button type="button" onClick={()=>ctx.uiWorkspace.openSession(linkedSession)}>{t('return')}</button></div>}
      {error&&<p role="alert">{error}</p>}
      <details style={{marginTop:8}}><summary>{t('details')}</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:240,overflow:'auto'}}>{(block.content??[]).map(content=>content.text??'').join('\n')||JSON.stringify(args,null,2)}</pre></details>
    </section>;
  }
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'video-studio',locale:'video-studio'},SessionStudio));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'video-studio',order:35,label:()=>t('panel'),locale:'video-studio'},FilmMark));
  ctx.slots.inject('tool.call.toolview',function*(){for(const key of ['video_project','video_update','video_inspect','video_render','video_audio'])yield ctx.slots.register({name:'tool.call.toolview',key,locale:'video-studio'},VideoCard);});
  ctx.effect(()=>ctx.on('connection/reset',()=>{void controller.load();}),'video-studio: reconnect');
  void controller.load();
}

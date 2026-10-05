import type { ClientRpc } from '../shared/types.ts';
import { RpcStudioApi, StudioController } from './controller.ts';
import { FilmMark, Studio } from './Studio.tsx';
import css from './styles.css?inline';

interface ClientContext {
  connection:{rpc:ClientRpc};
  slots:{inject(name:string,setup:()=>unknown):unknown;register(options:object,component:unknown):unknown};
  locale:{register(namespace:string,dictionaries:object):()=>void;bind(namespace:string):(key:string)=>string};
  theme?:{getTheme():{active:{colorScheme:'light'|'dark'}}};
  effect(setup:()=>void|(()=>void),label?:string):unknown;
  on(event:string,listener:()=>void):()=>void;
}
export const inject=['slots','locale','connection','theme'];
export function apply(ctx:ClientContext):void {
  const abort=new AbortController();
  const controller=new StudioController(new RpcStudioApi(ctx.connection.rpc,abort.signal));
  ctx.effect(()=>()=>{void controller.dispose().finally(()=>abort.abort());},'video-studio: plugin lifetime');
  ctx.effect(()=>{const flush=()=>{void controller.flush();};window.addEventListener('pagehide',flush);window.addEventListener('blur',flush);return()=>{window.removeEventListener('pagehide',flush);window.removeEventListener('blur',flush);};},'video-studio: save on leaving');
  ctx.effect(()=>ctx.locale.register('video-studio',{zh:{panel:'映流 · 视频工作台'},en:{panel:'Video Studio'}}),'video-studio: copy');
  const t=ctx.locale.bind('video-studio');
  const syncTheme=()=>controller.setScheme(ctx.theme?.getTheme().active.colorScheme||(document.body.hasAttribute('data-ds-dark-theme')?'dark':'light'));
  syncTheme();ctx.effect(()=>ctx.on('theme/change',syncTheme),'video-studio: theme');
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='dsh-video-studio';style.textContent=css;document.head.append(style);return()=>style.remove();},'video-studio: styles');
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'video-studio',locale:'video-studio',inject:()=>({controller})},Studio));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'video-studio',order:35,label:()=>t('panel'),locale:'video-studio'},FilmMark));
  ctx.effect(()=>ctx.on('connection/reset',()=>{void controller.load();}),'video-studio: reconnect');
  void controller.load();
}

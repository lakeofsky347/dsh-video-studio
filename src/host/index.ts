import type {HostContext} from './platform.ts';
import {StudioService} from './service.ts';
import {clientRequestSchema} from '@deepseek-ai/dsh-client-connection';
export const name='video-studio';
export const inject=['connection','llm'];
export function apply(ctx:HostContext,config:{baseDirectory?:string}={}):void{
  const service=new StudioService(ctx,config);
  ctx.effect(()=>()=>service.dispose(),'video-studio lifetime');
  for(const endpoint of ['catalog','current','create','open','save','import','source','saveSource','restoreSource','preview','generate','export','cancel','environment','reveal']){
    const method=`video-studio/${endpoint}`;
    ctx.effect(()=>ctx.connection.fetch.register({path:`/api/${method}`,methods:['POST'],requestBody:'buffered',async fetch(request){
      let raw:unknown;try{raw=await request.json();}catch{return new Response('Invalid JSON',{status:400});}
      const parsed=clientRequestSchema.safeParse(raw);
      if(!parsed.success||parsed.data.method!==method)return new Response('Invalid RPC envelope',{status:400});
      return Response.json({type:'server-response',rpcId:parsed.data.rpcId,result:await service.rpc(endpoint,parsed.data.payload)});
    }}),`video-studio ${endpoint}`);
  }
}

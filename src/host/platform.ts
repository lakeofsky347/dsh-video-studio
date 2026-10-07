import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { JobSpec, JobId } from '@deepseek-ai/dsh-jobs';
import type { ImageAttachmentRef, FileAttachmentRef } from '@deepseek-ai/dsh-attachment';

/** Cold Session catalog facts needed for routing; forks do not carry origin=subagent. */
export interface SessionDirectoryRow {
  sessionId:string;running:boolean;parentSessionId?:string;origin?:'subagent';
  projections?:{values:Record<string,unknown>};
}

export interface HostContext {
  llm:{
    listProviders():{id:string;name:string}[];
    listModels(provider:string):Promise<{id:string;name:string;inputModalities?:string[]}[]>;
    resolveModelInfo?(provider:string,model:string,signal?:AbortSignal):Promise<{inputModalities?:string[]}>;
    stream(options:{provider:string;model:string;messages:unknown[];system:string;maxTokens:number;sessionId:string;signal:AbortSignal}):AsyncIterable<{type:string;text?:string;reason?:{kind:string;failure?:{message:string}}}>;
  };
  get?(name:string):unknown;
  tools?:{register(definition:ToolDefinition):()=>void};
  jobs?:{start(spec:JobSpec):JobId};
  sessionController?:{
    list(request:Record<string,never>,signal:AbortSignal):Promise<{items:readonly SessionDirectoryRow[]}>;
    projections?(request:{sessionId:string},signal:AbortSignal):Promise<{values:Record<string,unknown>}|null>;
  };
  attachments?:{
    readImage(ref:ImageAttachmentRef,signal?:AbortSignal):Promise<{data:Uint8Array}>;
    fileHostPath(ref:FileAttachmentRef):string|undefined;
  };
  connection:{fetch:{register(route:{path:string;methods:readonly ['POST'];requestBody:'buffered';fetch(request:Request):Promise<Response>}):()=>Promise<void>}};
  effect(factory:()=>void|(()=>void|Promise<void>),label?:string):unknown;
}

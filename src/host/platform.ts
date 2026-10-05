export interface HostContext {
  llm:{
    listProviders():{id:string;name:string}[];
    listModels(provider:string):Promise<{id:string;name:string;inputModalities?:string[]}[]>;
    resolveModelInfo?(provider:string,model:string,signal?:AbortSignal):Promise<{inputModalities?:string[]}>;
    stream(options:{provider:string;model:string;messages:unknown[];system:string;maxTokens:number;sessionId:string;signal:AbortSignal}):AsyncIterable<{type:string;text?:string;reason?:{kind:string;failure?:{message:string}}}>;
  };
  get?(name:string):unknown;
  connection:{fetch:{register(route:{path:string;methods:readonly ['POST'];requestBody:'buffered';fetch(request:Request):Promise<Response>}):()=>Promise<void>}};
  effect(factory:()=>void|(()=>void|Promise<void>),label?:string):unknown;
}

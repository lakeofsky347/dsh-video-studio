/** Consumed 0.2.0-rc.2 host contracts; the Desktop runtime omits SDK declaration files. */
declare module '@deepseek-ai/dsh-util-values' {
  export type JsonValue=null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue};
}
declare module '@deepseek-ai/dsh-attachment' {
  export interface ImageAttachmentRef {attachmentId:string;mediaType:'image/png'|'image/jpeg'|'image/webp';bytes:number;width:number;height:number;name?:string}
  export interface FileAttachmentRef {attachmentId:string;name:string;bytes:number}
}
declare module '@deepseek-ai/dsh-jobs' {
  export type JobId=string;
  export interface JobOutcome {status:'completed'|'killed'|'failed';detail?:string;result?:string}
  export interface JobHandle {readonly id:JobId;append(text:string,options?:{channel?:'stdout'|'stderr'|'log'}):void;updateProgress(line:string):void}
  export interface JobHooks {cancel(reason?:string):void;done:Promise<JobOutcome>}
  export interface JobSpec {kind:string;label:string;owner?:string;run(job:JobHandle):JobHooks}
}
declare module '@deepseek-ai/dsh-jobs/view' {export interface JobKindMap {}}
declare module '@deepseek-ai/dsh-tools' {
  import type {JsonValue} from '@deepseek-ai/dsh-util-values';
  export interface ToolRunContext {
    readonly callId:string;readonly rootCallId:string;readonly name:string;readonly arguments:unknown;readonly token:symbol;readonly signal:AbortSignal;
    readonly agent?:{readonly id:string;readonly options:{provider?:string;model?:string}};
  }
  export interface ToolDefinition {name:string;description:string;parameters:unknown;output:{schema:unknown;render(args:unknown,value:Record<string,JsonValue>):{type:'text';text:string}[];presentationMeta?(args:unknown,value:Record<string,JsonValue>):JsonValue};execute(args:unknown,exec:ToolRunContext):Promise<unknown>}
  type Node={type:'string'|'number'|'integer'|'boolean'|'array'|'object'|'json';required?:true;enum?:readonly unknown[];description?:string;additionalProperties?:boolean;items?:Node;properties?:Record<string,Node>};
  type InferNode<N>=N extends {enum:readonly (infer V)[]}?V:N extends {type:'string'}?string:N extends {type:'number'|'integer'}?number:N extends {type:'boolean'}?boolean:N extends {type:'array',items:infer I}?InferNode<I>[]:N extends {type:'array'}?JsonValue[]:N extends {type:'object'}?Record<string,JsonValue>:JsonValue;
  type RequiredKeys<S>={[K in keyof S]:S[K] extends {required:true}?K:never}[keyof S];
  type Args<S>={[K in RequiredKeys<S>]:InferNode<S[K]>}&{[K in Exclude<keyof S,RequiredKeys<S>>]?:InferNode<S[K]>};
  export function defineTool<const S extends Record<string,Node>>(definition:{name:string;description:string;parameters:S;output:ToolDefinition['output'];execute(args:Args<S>,exec:ToolRunContext):Promise<Record<string,JsonValue>>}):ToolDefinition;
}

export interface ModelRoute { provider:string; model:string }
export interface Asset {
  id:string; kind:'image'|'text'|'audio'; name:string; description:string;
  path?:string; text?:string; mime?:string; width?:number; height?:number;
  duration?:number; sampleRate?:number; channels?:number;
}
export interface ShotParams {
  text:string; subtitle:string; background:string; foreground:string; accent:string;
  imageX:number; imageY:number; imageScale:number; imageFit:'cover'|'contain';
  fontSize:number; motion:'fade'|'slide'|'zoom'|'none';
  [key:string]:string|number|boolean;
}
export interface Shot {
  id:string; title:string; intent:string; composition:string; action:string;
  durationFrames:number; assetIds:string[]; referenceIds:string[];
  transition:'cut'|'fade'; params:ShotParams; sourcePath:string;
  narration?:string;
}
export interface GraphLayout {
  positions:Record<string,[number,number]>;
  groups:{id:string;title:string;bounds:[number,number,number,number]}[];
}
export interface VideoTarget { width:number; height:number; fps:{num:number;den:number}; audioMode:'none'|'mixed'; quality?:'standard'|'high'|'small' }
export interface AudioClip {
  id:string;assetId:string;role:'voice'|'music'|'sfx';shotId?:string;
  startSeconds:number;trimStart:number;trimEnd?:number;volume:number;fadeIn:number;fadeOut:number;loop?:boolean;
}
export interface TtsSettings {endpoint:string;model:string;voice:string;apiKey?:string;speed:number;enabled:boolean}
export interface ExportResult {
  id:string; path:string; url?:string; createdAt:string; revision:number;
  width:number; height:number; frameCount:number; duration:number; qa?:Record<string,unknown>;
}
export interface VideoProject {
  schemaVersion:1; id:string; title:string; topic:string; targetDuration:number;
  createdAt:string; updatedAt:string; revision:number; target:VideoTarget;
  assets:Asset[]; shots:Shot[]; shotOrder:string[]; graph:GraphLayout;
  outputs:ExportResult[]; extensions:Record<string,unknown>;
  sessionIds?:string[];audioClips?:AudioClip[];
}
export interface SpecShot extends Shot { startFrame:number; endFrame:number; assets:Asset[] }
export interface VideoSpec {
  projectId:string; title:string; topic:string; target:VideoTarget;
  durationFrames:number; durationSeconds:number; shots:SpecShot[];
}
export interface SceneSource { html:string; css:string; js:string; shotPatch?:Partial<Shot> }
export interface TaskState {
  id:string; kind:'storyboard'|'scenes'|'modify'|'preview'|'export'|'audio';
  status:'running'|'complete'|'failed'|'cancelled'; progress:number; message:string;
  startedAt:string; finishedAt?:string; error?:string; shotId?:string; logPath?:string;
}
export interface EnvironmentSettings { browserPath:string; ffmpegPath:string; ffprobePath:string }
export interface EnvironmentInfo extends EnvironmentSettings { browserAvailable:boolean; ffmpegAvailable:boolean; ffprobeAvailable:boolean }
export interface ProviderGroup { id:string; name:string; models:{id:string;name:string;inputModalities?:string[]}[]; error?:string }
export interface StudioSnapshot {
  project:VideoProject|null; root:string|null; task:TaskState|null;
  previewUrl:string|null; previewRevision:number|null; assetBaseUrl?:string|null; providers:ProviderGroup[];
  environment:EnvironmentInfo; recent:{path:string;title:string;id:string}[];
  sessionId?:string;focus?:{shotId?:string;frame?:number};audioUrl?:string|null;tts?:TtsSettings;ttsConfigured?:boolean;
}
export type RpcResult<T=unknown>={ok:true;value:T}|{ok:false;error:{code:string;message:string}};
export interface ClientRpc { call(channel:string,endpoint:string,payload:unknown,signal?:AbortSignal):Promise<RpcResult> }
export interface StudioApi { call<T=unknown>(endpoint:string,payload?:unknown):Promise<T> }

/** Keep third-party graph formats behind this interface. */
export interface GraphEditorAdapter {
  setProject(project:VideoProject,assetUrl:(asset:Asset)=>string):void;
  resize():void; dispose():void;
}
export interface SceneGenerator {
  storyboard(project:VideoProject,route:ModelRoute,signal:AbortSignal):Promise<Shot[]>;
  scene(project:VideoProject,shot:Shot,route:ModelRoute,signal:AbortSignal,current?:SceneSource,instruction?:string):Promise<SceneSource>;
}
export interface FrameRenderer {
  ready():Promise<void>;
  renderFrame(input:{frame:number;fps:{num:number;den:number}}):Promise<{frame:number;sceneId:string;declaredTexts:string[]}>;
}
export interface Exporter {
  export(root:string,project:VideoProject,settings:EnvironmentSettings,signal:AbortSignal,onProgress:(progress:number,message:string)=>void):Promise<ExportResult>;
}

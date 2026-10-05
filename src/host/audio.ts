import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {spawn, type ChildProcess} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import type {Asset, AudioClip, EnvironmentSettings, TtsSettings, VideoProject} from '../shared/types.js';
import {compileSpec} from '../core/index.js';
import {ProjectStore, projectPath} from './store.js';

export interface AudioMetadata {duration:number;sampleRate:number;channels:number;mime:string;extension:string}
export interface PlannedAudioClip extends AudioClip {path:string;start:number;duration:number;trimEnd:number}
export interface AudioPlan {duration:number;sampleRate:48000;channels:2;clips:PlannedAudioClip[]}
export interface AudioMix {path:string;duration:number;plan:AudioPlan}

function aborted(signal?:AbortSignal):void {signal?.throwIfAborted();}
export function audioExecutable(name:'ffmpeg'|'ffprobe',configured?:string):string {
  if(configured)return configured;
  const paths=['/opt/homebrew/bin','/usr/local/bin',...(process.env.PATH??'').split(path.delimiter)];
  const found=paths.map(folder=>path.join(folder,process.platform==='win32'?name+'.exe':name)).find(file=>existsSync(file));
  if(!found)throw new Error(name+' 未就绪，请在环境页配置路径');return found;
}
function stop(child:ChildProcess):void {
  if(child.exitCode!==null||child.signalCode!==null)return;
  child.kill('SIGTERM');const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1500);
  timer.unref();child.once('close',()=>clearTimeout(timer));
}
/** Owns only the subprocesses started by this audio operation. */
export class AudioProcesses {
  private children=new Set<ChildProcess>();
  run(executable:string,args:string[],signal?:AbortSignal):Promise<string>{
    aborted(signal);return new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{stdio:['ignore','pipe','pipe']});this.children.add(child);
      let output='',error='';const cancel=()=>stop(child);signal?.addEventListener('abort',cancel,{once:true});
      child.stdout?.on('data',bytes=>{output+=String(bytes);});
      child.stderr?.on('data',bytes=>{error=(error+String(bytes)).slice(-6000);});
      const finish=()=>{this.children.delete(child);signal?.removeEventListener('abort',cancel);};
      child.once('error',cause=>{finish();reject(cause);});
      child.once('close',code=>{finish();code===0&&!signal?.aborted?resolve(output):reject(new Error(signal?.aborted?'Task cancelled':'音频处理失败（'+code+'）：'+error.slice(-1400)));});
    });
  }
  async close():Promise<void>{
    await Promise.all([...this.children].map(child=>new Promise<void>(resolve=>{child.once('close',()=>resolve());stop(child);})));this.children.clear();
  }
}

export async function probeAudio(file:string,settings:Partial<EnvironmentSettings>={},signal?:AbortSignal,processes=new AudioProcesses()):Promise<AudioMetadata>{
  const text=await processes.run(audioExecutable('ffprobe',settings.ffprobePath),['-v','error','-show_entries','stream=codec_type,codec_name,sample_rate,channels,duration:format=duration,format_name','-of','json',file],signal);
  const info=JSON.parse(text),stream=info.streams?.find((item:{codec_type:string})=>item.codec_type==='audio');
  if(!stream||info.streams.some((item:{codec_type:string})=>item.codec_type==='video'))throw new Error('请选择纯音频文件：WAV、MP3、M4A、AAC、FLAC 或 OGG');
  const duration=Number(stream.duration??info.format?.duration),sampleRate=Number(stream.sample_rate),channels=Number(stream.channels);
  if(!(duration>0)||!Number.isFinite(duration)||!(sampleRate>0)||!(channels>0))throw new Error('音频时长或采样信息无法读取');
  const format=String(info.format?.format_name??'').split(',');
  const kind=format.includes('wav')?['audio/wav','.wav']:format.includes('mp3')?['audio/mpeg','.mp3']:
    format.includes('flac')?['audio/flac','.flac']:format.includes('ogg')?['audio/ogg','.ogg']:
    format.includes('aac')?['audio/aac','.aac']:format.includes('m4a')||format.includes('mov')?['audio/mp4','.m4a']:null;
  if(!kind)throw new Error('仅支持 WAV、MP3、M4A、AAC、FLAC 与 OGG 音频');
  return {duration,sampleRate,channels,mime:kind[0]!,extension:kind[1]!};
}

/** Audio anchors use seconds; shot order and rational FPS are resolved once here. */
export function compileAudioPlan(project:VideoProject):AudioPlan {
  const spec=compileSpec(project),plan:AudioPlan={duration:spec.durationSeconds,sampleRate:48000,channels:2,clips:[]};
  if(project.target.audioMode==='none')return plan;
  for(const clip of project.audioClips??[]){
    const asset=project.assets.find(item=>item.id===clip.assetId);
    if(!asset||asset.kind!=='audio'||!asset.path||!(Number(asset.duration)>0))throw new Error('音频片段 '+clip.id+' 缺少可读取的音频资产');
    const shot=clip.shotId?spec.shots.find(item=>item.id===clip.shotId):undefined;
    if(clip.shotId&&!shot)throw new Error('音频片段 '+clip.id+' 绑定的镜头不存在');
    const start=(shot?shot.startFrame*project.target.fps.den/project.target.fps.num:0)+clip.startSeconds;
    const trimEnd=Math.min(clip.trimEnd??asset.duration!,asset.duration!);
    if(![start,clip.trimStart,trimEnd,clip.volume,clip.fadeIn,clip.fadeOut].every(Number.isFinite)||start<0||clip.trimStart<0||trimEnd<=clip.trimStart||clip.volume<0||clip.fadeIn<0||clip.fadeOut<0)throw new Error('音频片段 '+clip.id+' 的裁剪、音量或定位无效');
    if(start>=plan.duration)throw new Error('音频片段 '+clip.id+' 位于成片结束之后，请调整定位或时长');
    const available=clip.role==='voice'&&shot?shot.durationFrames*project.target.fps.den/project.target.fps.num-clip.startSeconds:plan.duration-start;
    const selectedDuration=trimEnd-clip.trimStart;
    if(clip.role==='voice'&&!clip.loop&&selectedDuration>available+.000001)throw new Error('旁白超出'+(shot?'镜头':'成片')+'时长 '+(selectedDuration-available).toFixed(2)+' 秒，请延长画面或调整旁白裁剪');
    if(available<=0)throw new Error('旁白定位超出镜头时长，请调整位置或延长镜头');
    const duration=clip.loop?available:Math.min(selectedDuration,available);
    plan.clips.push({...clip,path:asset.path,start,duration,trimEnd});
  }
  return plan;
}

export class AudioMixer {
  private processes=new AudioProcesses();
  private pending=new Map<string,Promise<AudioMix>>();
  async mix(root:string,project:VideoProject,settings:Partial<EnvironmentSettings>={},signal?:AbortSignal):Promise<AudioMix|null>{
    aborted(signal);const plan=compileAudioPlan(project);if(!plan.clips.length)return null;
    const inputs=await Promise.all(plan.clips.map(async clip=>{const file=await projectPath(root,clip.path);return {file,sha:createHash('sha256').update(await fs.readFile(file)).digest('hex')};}));
    const key=createHash('sha256').update(JSON.stringify({plan,inputs:inputs.map(item=>item.sha)})).digest('hex');
    const relative='runtime/audio/mix-'+key+'.wav',destination=await projectPath(root,relative);
    try{await fs.access(destination);return {path:destination,duration:plan.duration,plan};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const pendingKey=path.resolve(root)+':'+key;let pending=this.pending.get(pendingKey);
    if(!pending){pending=this.render(destination,plan,inputs.map(item=>item.file),settings,signal);this.pending.set(pendingKey,pending);}
    try{return await pending;}finally{if(this.pending.get(pendingKey)===pending)this.pending.delete(pendingKey);}
  }
  private async render(destination:string,plan:AudioPlan,files:string[],settings:Partial<EnvironmentSettings>,signal?:AbortSignal):Promise<AudioMix>{
    await fs.mkdir(path.dirname(destination),{recursive:true});const temporary=destination+'.tmp-'+randomUUID()+'.wav';
    const filters=plan.clips.map((clip,index)=>{
      const length=clip.trimEnd-clip.trimStart,fadeIn=Math.min(clip.fadeIn,clip.duration),fadeOut=Math.min(clip.fadeOut,clip.duration);
      const parts=[`[${index}:a]atrim=start=${clip.trimStart}:end=${clip.trimEnd}`,'asetpts=PTS-STARTPTS','aresample=48000','aformat=sample_fmts=fltp:channel_layouts=stereo'];
      if(clip.loop)parts.push('aloop=loop=-1:size='+Math.max(1,Math.round(length*48000)));
      parts.push('atrim=duration='+clip.duration,'volume='+clip.volume);
      if(fadeIn)parts.push('afade=t=in:st=0:d='+fadeIn);
      if(fadeOut)parts.push('afade=t=out:st='+Math.max(0,clip.duration-fadeOut)+':d='+fadeOut);
      parts.push('adelay='+Math.round(clip.start*48000)+'S:all=1');return parts.join(',')+'[clip'+index+']';
    });
    filters.push(plan.clips.map((_,index)=>'[clip'+index+']').join('')+'amix=inputs='+plan.clips.length+':duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1,apad=whole_dur='+plan.duration+',atrim=duration='+plan.duration+'[mix]');
    try{
      await this.processes.run(audioExecutable('ffmpeg',settings.ffmpegPath),['-hide_banner','-loglevel','error','-y',...files.flatMap(file=>['-i',file]),'-filter_complex',filters.join(';'),'-map','[mix]','-ar','48000','-ac','2','-c:a','pcm_s16le',temporary],signal);
      aborted(signal);await fs.rename(temporary,destination);return {path:destination,duration:plan.duration,plan};
    }finally{await fs.rm(temporary,{force:true});}
  }
  async close():Promise<void>{await this.processes.close();}
}

export interface SpeechInput {text:string;name?:string;description?:string}
/** Speech is a separate configured capability; ctx.llm is not a TTS transport. */
export class SpeechSynthesizer {
  private processes=new AudioProcesses();
  private controllers=new Set<AbortController>();
  constructor(private store:ProjectStore=new ProjectStore()){}
  async synthesize(root:string,input:SpeechInput,settings:TtsSettings,environment:Partial<EnvironmentSettings>={},signal?:AbortSignal):Promise<Asset>{
    aborted(signal);if(!settings.enabled)throw new Error('请先启用并配置配音提供方');
    if(!input.text.trim())throw new Error('配音文本不能为空');
    if(!Number.isFinite(settings.speed)||settings.speed<.25||settings.speed>4)throw new Error('配音速度须为 0.25–4');
    if(settings.endpoint==='local:say')return this.local(root,input,settings,environment,signal);
    const endpoint=settings.endpoint.replace(/\/+$/,'');
    if(!endpoint||!settings.model||!settings.voice)throw new Error('请配置配音 endpoint、模型和音色');
    const url=new URL(endpoint.endsWith('/audio/speech')?endpoint:endpoint+'/audio/speech');
    if(!['http:','https:'].includes(url.protocol))throw new Error('配音 endpoint 须为 HTTP 或 HTTPS');
    const controller=new AbortController(),cancel=()=>controller.abort();this.controllers.add(controller);signal?.addEventListener('abort',cancel,{once:true});
    try{
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(settings.apiKey?{Authorization:'Bearer '+settings.apiKey}:{})},body:JSON.stringify({model:settings.model,voice:settings.voice,input:input.text,speed:settings.speed,response_format:'wav'}),signal:controller.signal});
      if(!response.ok)throw new Error('配音请求失败：HTTP '+response.status);
      const bytes=Buffer.from(await response.arrayBuffer());aborted(signal);
      return await this.store.importAudio(root,{dataBase64:bytes.toString('base64'),mime:response.headers.get('content-type')?.split(';')[0]||'audio/wav',name:input.name??'模型配音',description:input.description??input.text},environment,signal);
    }finally{this.controllers.delete(controller);signal?.removeEventListener('abort',cancel);}
  }
  private async local(root:string,input:SpeechInput,settings:TtsSettings,environment:Partial<EnvironmentSettings>,signal?:AbortSignal):Promise<Asset>{
    if(process.platform!=='darwin'||!existsSync('/usr/bin/say'))throw new Error('本地系统配音仅适用于已提供 say 的 macOS');
    const folder=await projectPath(root,'runtime/tts-'+randomUUID());await fs.mkdir(folder,{recursive:true});
    try{
      const textFile=path.join(folder,'narration.txt'),raw=path.join(folder,'voice.aiff'),wav=path.join(folder,'voice.wav');await fs.writeFile(textFile,input.text);
      await this.processes.run('/usr/bin/say',[...(settings.voice?['-v',settings.voice]:[]),'-r',String(Math.round(175*settings.speed)),'-f',textFile,'-o',raw],signal);
      await this.processes.run(audioExecutable('ffmpeg',environment.ffmpegPath),['-hide_banner','-loglevel','error','-y','-i',raw,'-ar','48000','-ac','2','-c:a','pcm_s16le',wav],signal);
      return await this.store.importAudio(root,{path:wav,name:input.name??'本地系统配音',description:input.description??input.text},environment,signal);
    }finally{await fs.rm(folder,{recursive:true,force:true});}
  }
  async close():Promise<void>{for(const controller of this.controllers)controller.abort();await this.processes.close();}
}

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Asset, SceneSource, Shot, VideoProject } from '../shared/types.js';
import { createProject, defaultSceneSource } from '../core/index.js';

export interface StoreOptions { baseDirectory?:string }
export interface ImportAssetInput { path?:string; dataBase64?:string; mime?:string; text?:string; name?:string; description?:string }
export interface RecentProject { path:string; title:string; id:string }

/** Resolve a project-local path and reject traversal, absolute paths and existing symlinks. */
export async function projectPath(root:string,relative:string):Promise<string> {
  if(typeof relative!=='string'||!relative||relative.includes('\\')||path.isAbsolute(relative)||relative.split('/').some(p=>p==='..'||p==='.'||!p))throw new Error('Invalid project-relative path');
  const absoluteRoot=path.resolve(root), result=path.resolve(absoluteRoot,relative);
  if(!result.startsWith(absoluteRoot+path.sep))throw new Error('Path outside project');
  let cursor=absoluteRoot;
  const rootInfo=await fs.lstat(absoluteRoot);
  if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new Error('Project directory must be a real directory');
  for(const part of relative.split('/')){
    cursor=path.join(cursor,part);
    try{if((await fs.lstat(cursor)).isSymbolicLink())throw new Error('Symlinks are not supported in project paths');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}
  }
  return result;
}

async function atomicWrite(file:string,data:string|Buffer):Promise<void> {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temporary=file+'.tmp-'+randomUUID();
  try { await fs.writeFile(temporary,data); await fs.rename(temporary,file); }
  finally { await fs.rm(temporary,{force:true}); }
}
function json(value:unknown):string { return JSON.stringify(value,null,2)+'\n'; }
function assertProjectShape(project:VideoProject):void {
  if(!project||project.schemaVersion!==1||typeof project.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(project.id)||!Array.isArray(project.assets)||!Array.isArray(project.shots)||!Array.isArray(project.shotOrder)||!project.target||!project.graph)throw new Error('Unsupported or damaged project.json');
}
function assertSource(source:SceneSource):void {
  if(!source||!['html','css','js'].every(key=>typeof source[key as keyof SceneSource]==='string'))throw new Error('Scene source requires html, css and js strings');
  if(source.html.length+source.css.length+source.js.length>2_000_000)throw new Error('Scene source exceeds 2 MB');
}
function scenePath(shot:Shot|string):string { return typeof shot==='string'?shot:shot.sourcePath; }

export class ProjectStore {
  readonly baseDirectory:string;
  constructor(options:StoreOptions={}) { this.baseDirectory=path.resolve(options.baseDirectory??path.join(os.homedir(),'Documents','DSH Video Studio')); }
  async create(input:VideoProject|{title?:string;topic?:string}={}):Promise<{root:string;project:VideoProject}> {
    const project:VideoProject='schemaVersion' in input?structuredClone(input):createProject(input.title??'未命名视频',input.topic??'');
    assertProjectShape(project);
    await fs.mkdir(this.baseDirectory,{recursive:true});
    const slug=project.title.replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-|-$/g,'').slice(0,50)||'video';
    const root=path.join(this.baseDirectory,slug+'-'+project.id);
    await fs.mkdir(root,{recursive:false});
    await fs.mkdir(path.join(root,'assets'),{recursive:true});
    for(const shot of project.shots)await this.writeSource(root,shot,defaultSceneSource());
    const saved=await this.save(root,project);
    return {root,project:saved};
  }
  async save(root:string,project:VideoProject):Promise<VideoProject> {
    assertProjectShape(project);
    const file=await projectPath(root,'project.json');
    const saved=structuredClone(project);saved.updatedAt=new Date().toISOString();
    await atomicWrite(file,json(saved));
    await this.remember(root,saved);
    return saved;
  }
  async open(root:string):Promise<VideoProject> {
    const project=JSON.parse(await fs.readFile(await projectPath(root,'project.json'),'utf8')) as VideoProject;
    assertProjectShape(project);await this.remember(root,project);return project;
  }
  async recent():Promise<RecentProject[]> {
    try {
      const items=JSON.parse(await fs.readFile(path.join(this.baseDirectory,'recent.json'),'utf8')) as RecentProject[];
      if(!Array.isArray(items))return [];
      const existing=await Promise.all(items.slice(0,20).map(async item=>{
        try { const project=JSON.parse(await fs.readFile(await projectPath(item.path,'project.json'),'utf8')) as VideoProject;assertProjectShape(project);return {path:item.path,title:project.title,id:project.id}; }
        catch{return null;}
      }));
      return existing.filter((item):item is RecentProject=>item!==null);
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  }
  private async remember(root:string,project:VideoProject):Promise<void> {
    await fs.mkdir(this.baseDirectory,{recursive:true});
    const items=await this.recent();
    await atomicWrite(path.join(this.baseDirectory,'recent.json'),json([{path:path.resolve(root),title:project.title,id:project.id},...items.filter(item=>path.resolve(item.path)!==path.resolve(root))].slice(0,20)));
  }
  async importImageOrText(root:string,input:ImportAssetInput):Promise<Asset> {
    const id=randomUUID(), description=input.description??'';
    if(typeof input.text==='string'){
      if(input.text.length>2_000_000)throw new Error('Text asset exceeds 2 MB');
      return {id,kind:'text',name:input.name??'文本素材',description,text:input.text,mime:'text/plain'};
    }
    let buffer:Buffer;
    if(input.dataBase64!==undefined){
      const base64=input.dataBase64.replace(/^data:[^;]+;base64,/, '');
      if(base64.length>28_000_000||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw new Error('Invalid or oversized image data');
      buffer=Buffer.from(base64,'base64');
    }else if(input.path){
      const info=await fs.stat(input.path);if(!info.isFile()||info.size>20_000_000)throw new Error('Image file must be at most 20 MB');
      const extension=path.extname(input.path).toLowerCase();
      if(['.txt','.md'].includes(extension)){
        if(info.size>2_000_000)throw new Error('Text asset exceeds 2 MB');
        return {id,kind:'text',name:input.name??path.basename(input.path),description,text:await fs.readFile(input.path,'utf8'),mime:'text/plain'};
      }
      buffer=await fs.readFile(input.path);
    }else throw new Error('Choose a PNG, JPEG, WebP image or text');
    if(buffer.length===0||buffer.length>20_000_000)throw new Error('Image file must be between 1 byte and 20 MB');
    const mime=sniffImage(buffer);
    if(!mime)throw new Error('Only PNG, JPEG and WebP images are supported');
    if(input.mime&&input.mime!==mime)throw new Error('Declared image MIME does not match file contents');
    const extension=mime==='image/png'?'.png':mime==='image/jpeg'?'.jpg':'.webp';
    const relative='assets/'+id+extension;
    await atomicWrite(await projectPath(root,relative),buffer);
    return {id,kind:'image',name:input.name??(input.path?path.basename(input.path):'图片素材'+extension),description,path:relative,mime,...imageSize(buffer,mime)};
  }
  async readSource(root:string,shot:Shot|string):Promise<SceneSource> {
    const folder=scenePath(shot);
    // The independent editable files are authoritative. source.json is a portable backup.
    const result:SceneSource={html:await fs.readFile(await projectPath(root,folder+'/index.html'),'utf8'),css:await fs.readFile(await projectPath(root,folder+'/style.css'),'utf8'),js:await fs.readFile(await projectPath(root,folder+'/scene.js'),'utf8')};
    assertSource(result);return result;
  }
  async writeSource(root:string,shot:Shot|string,source:SceneSource):Promise<void> {
    assertSource(source);const folder=scenePath(shot);
    try { const previous=await this.readSource(root,shot);await atomicWrite(await projectPath(root,folder+'/previous.json'),json(previous)); }
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await this.writeSourceFiles(root,folder,source);
  }
  private async writeSourceFiles(root:string,folder:string,source:SceneSource):Promise<void> {
    await atomicWrite(await projectPath(root,folder+'/source.json'),json(source));
    await atomicWrite(await projectPath(root,folder+'/index.html'),source.html);
    await atomicWrite(await projectPath(root,folder+'/style.css'),source.css);
    await atomicWrite(await projectPath(root,folder+'/scene.js'),source.js);
  }
  async markSourceGood(root:string,shot:Shot|string):Promise<void> {
    const source=await this.readSource(root,shot);await atomicWrite(await projectPath(root,scenePath(shot)+'/last-good.json'),json(source));
  }
  async restoreSource(root:string,shot:Shot|string):Promise<SceneSource> {
    const folder=scenePath(shot);let source:SceneSource;
    try{source=JSON.parse(await fs.readFile(await projectPath(root,folder+'/last-good.json'),'utf8')) as SceneSource;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;source=JSON.parse(await fs.readFile(await projectPath(root,folder+'/previous.json'),'utf8')) as SceneSource;}
    assertSource(source);await this.writeSourceFiles(root,folder,source);return source;
  }
}

function sniffImage(buffer:Buffer):string|undefined {
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return 'image/jpeg';
  if(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP')return 'image/webp';
}
function imageSize(buffer:Buffer,mime:string):{width?:number;height?:number} {
  if(mime==='image/png'&&buffer.length>=24)return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
  return {};
}

import {spawn, type ChildProcess} from 'node:child_process';
import {lstat, realpath} from 'node:fs/promises';
import path from 'node:path';

interface FileSystem {
  realpath(file:string):Promise<string>;
  lstat(file:string):Promise<{isDirectory():boolean;isSymbolicLink():boolean}>;
}
export interface FileOpenerOptions {
  /** Host-only injection for tests; these options are never accepted from RPC. */
  platform?:NodeJS.Platform;
  spawn?:typeof spawn;
  fileSystem?:FileSystem;
  systemRoot?:string;
  timeoutMs?:number;
  killGraceMs?:number;
}
function failure(code:string,message:string):Error&{code:string} {
  return Object.assign(new Error(message),{code});
}
function within(root:string,target:string,paths:typeof path.posix):boolean {
  const relative=paths.relative(root,target);
  return relative===''||(!paths.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+paths.sep));
}

/** Validates both the requested path and its existing physical destination. */
export async function projectOpenPath(root:string,target:string,options:Pick<FileOpenerOptions,'platform'|'fileSystem'>={}):Promise<string> {
  const paths=(options.platform??process.platform)==='win32'?path.win32:path.posix;
  const fs=options.fileSystem??{realpath,lstat},absoluteRoot=paths.resolve(root),absoluteTarget=paths.resolve(target);
  if(!within(absoluteRoot,absoluteTarget,paths))throw failure('PATH_OUTSIDE_PROJECT','请选择本项目文件');
  const info=await fs.lstat(absoluteRoot);
  if(!info.isDirectory()||info.isSymbolicLink())throw failure('PATH_OUTSIDE_PROJECT','项目目录须为真实目录');
  const physicalRoot=await fs.realpath(absoluteRoot),physicalTarget=await fs.realpath(absoluteTarget);
  if(!within(physicalRoot,physicalTarget,paths))throw failure('PATH_OUTSIDE_PROJECT','请选择本项目文件；链接指向项目外部');
  // Open the verified physical path, so a project-local symlink cannot be swapped afterwards.
  return physicalTarget;
}

/** Owns desktop handoff helpers only; launched desktop applications are not killed. */
export class ProjectFileOpener {
  private readonly platform:NodeJS.Platform;
  private readonly spawn:typeof spawn;
  private readonly children=new Map<ChildProcess,{cancel:()=>void;settled:Promise<void>}>();
  private closed=false;
  constructor(private readonly options:FileOpenerOptions={}) {
    this.platform=options.platform??process.platform;this.spawn=options.spawn??spawn;
  }
  async open(root:string,target=root):Promise<void> {
    if(this.closed)throw failure('FILE_OPEN_CANCELLED','文件打开服务已停止');
    const file=await projectOpenPath(root,target,{platform:this.platform,fileSystem:this.options.fileSystem});
    if(this.closed)throw failure('FILE_OPEN_CANCELLED','文件打开服务已停止');
    const command=this.platform==='darwin'?'/usr/bin/open':this.platform==='linux'?'xdg-open':this.platform==='win32'?path.win32.join(this.options.systemRoot??process.env.SystemRoot??'C:\\Windows','explorer.exe'):null;
    if(!command)throw failure('FILE_OPEN_UNSUPPORTED','当前系统暂不支持打开本地文件');
    let cancel!:()=>void;
    let child!:ChildProcess;
    const settled=new Promise<void>((resolve,reject)=>{
      try{child=this.spawn(command,[file],{stdio:'ignore',shell:false,windowsHide:true});}
      catch(error){reject(failure('FILE_OPEN_FAILED','无法启动系统文件打开程序：'+(error instanceof Error?error.message:String(error))));return;}
      let finished=false,started=false,stopped:Error|undefined;
      let killTimer:ReturnType<typeof setTimeout>|undefined;
      const finish=(error?:Error)=>{
        if(finished)return;finished=true;
        clearTimeout(timer);if(killTimer)clearTimeout(killTimer);
        this.children.delete(child);error?reject(error):resolve();
      };
      const stop=(reason:Error)=>{
        if(finished||stopped)return;stopped=reason;
        if(child.exitCode!==null||child.signalCode!==null)return;
        killTimer=setTimeout(()=>{if(!finished&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},this.options.killGraceMs??1500);
        child.kill('SIGTERM');
      };
      const timer=setTimeout(()=>stop(failure('FILE_OPEN_TIMEOUT','打开文件超时，请检查系统桌面和默认应用')),this.options.timeoutMs??15_000);
      cancel=()=>stop(failure('FILE_OPEN_CANCELLED','插件已停止，文件打开已取消'));
      child.once('spawn',()=>{started=true;});
      child.once('error',error=>finish(stopped??failure('FILE_OPEN_FAILED','无法启动系统文件打开程序：'+error.message)));
      child.once('close',(code,signal)=>{
        // Explorer may return 1 after successfully handing the request to an existing shell.
        // This acknowledges system handoff, not that a desktop window actually appeared.
        const handedOff=code===0||(this.platform==='win32'&&started&&code===1&&!signal);
        finish(stopped??(handedOff?undefined:failure('FILE_OPEN_FAILED','打开文件失败（'+(signal??code)+'），请检查默认应用')));
      });
    });
    if(child)this.children.set(child,{cancel,settled});
    return settled;
  }
  async close():Promise<void> {
    this.closed=true;
    const owned=[...this.children.values()];for(const child of owned)child.cancel();
    await Promise.allSettled(owned.map(child=>child.settled));
  }
}

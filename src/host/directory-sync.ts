import fs from 'node:fs/promises';

interface DirectoryHandle {
  sync():Promise<void>;
  close():Promise<void>;
}
interface DirectorySyncOptions {
  platform?:NodeJS.Platform;
  open?:(directory:string,flags:'r')=>Promise<DirectoryHandle>;
}

/** Directory durability is optional where the filesystem cannot open or sync directories. */
export async function syncDirectory(directory:string,options:DirectorySyncOptions={}):Promise<void> {
  const platform=options.platform??process.platform;
  let handle:DirectoryHandle|undefined;
  let phase:'open'|'sync'='open';
  try {
    handle=await (options.open??fs.open)(directory,'r');
    phase='sync';
    await handle.sync();
  }catch(error){
    const code=(error as NodeJS.ErrnoException)?.code;
    const unsupported=['EINVAL','ENOTSUP','EISDIR','ENOSYS'].includes(code??'')
      ||(platform==='win32'&&(['EPERM','EACCES'].includes(code??'')||(phase==='sync'&&code==='EBADF')));
    if(!unsupported)throw error;
  }finally{
    if(handle)await handle.close();
  }
}

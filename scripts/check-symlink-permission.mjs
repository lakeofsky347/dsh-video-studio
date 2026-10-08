import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root=await mkdtemp(path.join(os.tmpdir(),'dsh-symlink-permission-'));
try{
  const file=path.join(root,'file.txt'),directory=path.join(root,'directory');
  await writeFile(file,'symlink privilege probe');await mkdir(directory);
  await symlink(file,path.join(root,'file-link'),'file');
  await symlink(directory,path.join(root,'directory-link'),'dir');
  console.log(`Real file and directory symlink creation is available on ${process.platform}.`);
}catch(error){
  throw new Error(`Real symlink tests cannot run on ${process.platform} (${error.code??error.message}). On Windows enable Developer Mode or grant SeCreateSymbolicLinkPrivilege. CI must fail rather than count an unverified boundary as passing.`,{cause:error});
}finally{await rm(root,{recursive:true,force:true});}

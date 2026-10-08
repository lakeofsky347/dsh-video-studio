import {symlink} from 'node:fs/promises';
import type {TestContext} from 'node:test';

/** A missing Windows privilege is a reported skip, or a failure on strict CI. */
export async function createTestSymlink(t:TestContext,target:string,link:string,type:'file'|'dir'='file'):Promise<boolean>{
  try{await symlink(target,link,type);return true;}
  catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(process.platform!=='win32'||!['EPERM','EACCES'].includes(code??''))throw error;
    const reason=`Windows ${type} symlink creation requires Developer Mode or SeCreateSymbolicLinkPrivilege (${code}); the real symlink boundary was not verified.`;
    if(process.env.DSH_REQUIRE_SYMLINK_TESTS==='1')throw new Error(reason,{cause:error});
    t.skip(reason);return false;
  }
}

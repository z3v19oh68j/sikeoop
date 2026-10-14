import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Injection is limited to the write/rename operations so tests can fail at either output phase.
export async function writeDataset(output:string,buffers:Record<string,Buffer>,io:Pick<typeof fs,'writeFile'|'rename'>=fs){
 await fs.mkdir(path.dirname(output),{recursive:true});
 const tmp=output+'.tmp-'+randomUUID(),backup=output+'.previous-'+randomUUID();
 await fs.mkdir(tmp);let moved=false,installed=false;
 try{
  for(const [name,b] of Object.entries(buffers))await io.writeFile(path.join(tmp,name),b);
  try{await io.rename(output,backup);moved=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  try{await io.rename(tmp,output);installed=true;}catch(e){if(moved){await fs.rename(backup,output);moved=false;}throw e;}
 }finally{
  await fs.rm(tmp,{recursive:true,force:true});
  // Never delete the only surviving old data if rollback itself failed.
  if(moved&&installed)await fs.rm(backup,{recursive:true,force:true});
 }
}

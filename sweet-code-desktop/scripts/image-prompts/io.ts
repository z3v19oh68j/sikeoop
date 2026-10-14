import { promises as fs } from 'node:fs';
import path from 'node:path';
export const sourceReads:string[]=[];
export class SourceReader {
 root:string; constructor(root:string){this.root=path.resolve(root);}
 private async checked(file:string):Promise<string>{const root=await fs.realpath(this.root),candidate=path.resolve(file);let rel=path.relative(this.root,candidate);if(rel.startsWith('..')||path.isAbsolute(rel)){rel=path.relative(root,candidate);}if(rel.startsWith('..')||path.isAbsolute(rel)||rel.split(path.sep).some(p=>p.toLowerCase()==='.git'))throw new Error('Unsafe source path');let cur=root;for(const part of rel.split(path.sep).filter(Boolean)){cur=path.join(cur,part);if((await fs.lstat(cur)).isSymbolicLink())throw new Error('Source symlink rejected');}const real=await fs.realpath(cur),r=path.relative(root,real);if(r.startsWith('..')||path.isAbsolute(r))throw new Error('Source escapes root');return real;}
 async read(file:string):Promise<Buffer>{const real=await this.checked(file);if(!/\.(json|md|txt|jpg|jpeg|png|webp)$/i.test(real)&&!/^LICENSE(?:[.-].*)?$/i.test(path.basename(real)))throw new Error('Disallowed source extension');const stat=await fs.stat(real);if(!stat.isFile()||stat.size>64*1024*1024)throw new Error('Invalid source file');sourceReads.push(real);return fs.readFile(real);}
 async json(file:string):Promise<any>{return JSON.parse((await this.read(file)).toString());}
 async files(dir:string):Promise<string[]>{const real=await this.checked(dir),result:string[]=[];for(const e of await fs.readdir(real,{withFileTypes:true})){if(e.isSymbolicLink()||e.name.toLowerCase()==='.git')continue;const p=path.join(real,e.name);if(e.isDirectory())result.push(...await this.files(p));else if(/\.(json|md|txt|jpg|jpeg|png|webp)$/i.test(e.name))result.push(p);}return result.sort();}
}

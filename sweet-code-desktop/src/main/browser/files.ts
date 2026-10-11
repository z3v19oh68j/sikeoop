import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Existing regular files only; both lexical and resolved paths must remain in this project. */
export async function projectUploadFiles(project: string, files: string[]): Promise<string[]> {
  if (!files.length || files.length > 20) throw new Error('上传需提供 1–20 个项目文件');
  const root = await fs.realpath(project);
  const inside = (p: string) => { const rel = path.relative(root, p); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
  const result: string[] = [];
  for (const file of files) {
    const target = path.resolve(root, file);
    if (!inside(target)) throw new Error('上传文件在项目目录外');
    const real = await fs.realpath(target);
    if (!inside(real)) throw new Error('上传文件 realpath 在项目目录外');
    if (!(await fs.stat(real)).isFile()) throw new Error('上传目标不是普通文件');
    result.push(real);
  }
  return result;
}

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
export async function policyHash():Promise<string>{const hash=createHash('sha256');for(const name of ['release-policy.json','overrides.json','flag-rules.json']){const bytes=await fs.readFile(new URL(name,import.meta.url));hash.update(name+'\n'+bytes.length+'\n');hash.update(bytes);}return hash.digest('hex');}

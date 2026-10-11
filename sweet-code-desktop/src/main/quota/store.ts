import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { QuotaStore } from './service.ts';
/** Same-directory rename; writes are synchronous and serialized on the main thread. */
export function quotaStore(dir: string): QuotaStore {
  const read = (name: string): unknown => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[quota] load', name, e); return undefined; }
  };
  const write = (name: string, value: unknown) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${name}.${randomUUID()}.tmp`);
    try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(tmp, path.join(dir, name)); }
    finally { try { fs.unlinkSync(tmp); } catch { /* renamed or already absent */ } }
  };
  return { load: () => ({ settings: read('settings.json'), plans: read('plans.json') }), saveSettings: s => write('settings.json', s), savePlans: p => write('plans.json', p) };
}

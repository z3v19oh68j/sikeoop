import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResidentState, ResidentStore } from './service.ts';

/** One file, written whole through a same-directory rename; writes are synchronous on the main thread. */
export function residentStore(dir: string): ResidentStore {
  const file = path.join(dir, 'state.json');
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[resident] load', e);
        return undefined;
      }
    },
    save(state: ResidentState) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.state.json.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // Renamed, or never written.
        }
      }
    },
  };
}

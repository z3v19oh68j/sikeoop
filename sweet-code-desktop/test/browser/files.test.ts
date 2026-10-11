import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectUploadFiles } from '../../src/main/browser/files.ts';
test('upload resolves project files and rejects traversal, symlinks, directories and empty batches', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-files-'));
  try {
    const root = path.join(dir, 'project'); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'ok.txt'), 'ok');
    await fs.writeFile(path.join(dir, 'outside.txt'), 'no');
    await fs.symlink(path.join(dir, 'outside.txt'), path.join(root, 'link'));
    assert.deepEqual(await projectUploadFiles(root, ['ok.txt']), [await fs.realpath(path.join(root, 'ok.txt'))]);
    await assert.rejects(projectUploadFiles(root, ['../outside.txt']), /目录外/);
    await assert.rejects(projectUploadFiles(root, ['link']), /realpath/);
    await assert.rejects(projectUploadFiles(root, ['.']), /普通文件/);
    await assert.rejects(projectUploadFiles(root, []), /1–20/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

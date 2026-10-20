import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import type { PrivateR2Bucket } from '../../worker/index.js';

/** One process/replica per mounted volume. Never put this directory under dist. */
export async function openPrivateStorage(directory: string) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('storage_symlink');
  await chmod(root, 0o700);
  // scripts/start-railway.sh holds an OS flock for the process lifetime.
  // OS locks release even after a crash; no stale lock file prevents recovery.
  let queue = Promise.resolve<unknown>(undefined);
  const pathFor = (key: string) => join(root, `${createHash('sha256').update(key).digest('hex')}.json`);
  async function read(key: string) {
    let file;
    try { file = await open(pathFor(key), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('storage_object_invalid');
      const text = await file.readFile('utf8');
      return { size: Buffer.byteLength(text), etag: createHash('sha256').update(text).digest('hex'), text: async () => text };
    } finally { await file.close(); }
  }
  const bucket: PrivateR2Bucket = {
    get: read,
    put(key, value, options) {
      const operation = queue.then(async () => {
        if (Buffer.byteLength(value) > 4 * 1024 * 1024) throw new Error('storage_limit');
        const current = await read(key), condition = options?.onlyIf;
        if (condition?.etagDoesNotMatch === '*' && current) return null;
        if (condition?.etagMatches && current?.etag !== condition.etagMatches) return null;
        const temporary = join(root, `.pending-${randomUUID()}`);
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(value); await file.sync(); await file.close();
          await rename(temporary, pathFor(key));
          const directoryHandle = await open(root, 'r');
          try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
          return { etag: createHash('sha256').update(value).digest('hex') };
        } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
  return { bucket, async close() { await queue; } };
}

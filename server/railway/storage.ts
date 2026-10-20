import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink, chmod, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
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
  async function exportArchive(){
    const operation=queue.then(async()=>{const entries:Record<string,{sha256:string;body:string}>={};
      for(const name of await readdir(root)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
        const file=await open(join(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);try{if((await file.stat()).size>4*1024*1024)throw Error('backup_object_limit');const body=await file.readFile('utf8');entries[name]={sha256:createHash('sha256').update(body).digest('hex'),body};}finally{await file.close();}}
      const body=JSON.stringify({schemaVersion:'vds-volume-backup-1',createdAt:new Date().toISOString(),entries});return gzipSync(body);
    });queue=operation.catch(()=>{});return operation;
  }
  async function restoreArchive(bytes:Buffer){
    const operation=queue.then(async()=>{
      if((await readdir(root)).some(n=>/^[a-f0-9]{64}\.json$/.test(n)))throw Error('restore_requires_empty_volume');
      const data=JSON.parse(gunzipSync(bytes,{maxOutputLength:128*1024*1024}).toString('utf8'));
      if(data.schemaVersion!=='vds-volume-backup-1'||!data.entries||typeof data.entries!=='object'||Array.isArray(data.entries))throw Error('backup_invalid');
      const entries=Object.entries(data.entries) as [string,{sha256:string;body:string}][];
      if(!entries.length||entries.length>100000)throw Error('backup_invalid');
      for(const [name,value]of entries)if(!/^[a-f0-9]{64}\.json$/.test(name)||typeof value.body!=='string'||Buffer.byteLength(value.body)>4*1024*1024||createHash('sha256').update(value.body).digest('hex')!==value.sha256)throw Error('backup_invalid');
      for(const [name,value]of entries){const file=await open(join(root,name),'wx',0o600);try{await file.writeFile(value.body);await file.sync();}finally{await file.close();}}
      return {restoredObjects:entries.length};
    });queue=operation.catch(()=>{});return operation;
  }
  async function createCheckpoint(){
    const bytes=await exportArchive();const decoded=JSON.parse(gunzipSync(bytes,{maxOutputLength:128*1024*1024}).toString('utf8'));
    const entries=Object.entries(decoded.entries) as [string,{sha256:string;body:string}][];
    for(const [,v]of entries)if(createHash('sha256').update(v.body).digest('hex')!==v.sha256)throw Error('checkpoint_verification_failed');
    if(!entries.length)return {objects:0,created:false};
    const digest=createHash('sha256').update(bytes).digest('hex'),directory=join(root,'backups');await mkdir(directory,{mode:0o700,recursive:true});
    const file=await open(join(directory,digest+'.json.gz'),'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    return {objects:entries.length,created:true,digest};
  }
  return { bucket, exportArchive, restoreArchive, createCheckpoint, async close() { await queue; } };
}

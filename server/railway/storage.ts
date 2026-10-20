import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink, chmod, readdir, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, join } from 'node:path';
import type { PrivateR2Bucket } from '../../worker/index.js';

// A validated private volume with historical accounting versions can exceed
// 128 MiB. Keep an explicit decompression bound, large enough for the current
// 500 MB volume plus JSON escaping; retain every per-object integrity check.
export const MAX_PRIVATE_ARCHIVE_BYTES=1024*1024*1024;
const MAX_OBJECT_BYTES=4*1024*1024;
// Earlier v1 archives were a single JSON string. Keep that reader bounded below
// Node's string ceiling; newly generated archives never need a whole JSON string.
const MAX_LEGACY_ARCHIVE_BYTES=Math.min(MAX_PRIVATE_ARCHIVE_BYTES,bufferConstants.MAX_STRING_LENGTH-1);
const MAX_ENTRY_LINE_BYTES=6*MAX_OBJECT_BYTES+512;
const objectName=/^[a-f0-9]{64}\.json$/;
interface ArchiveEntry {name:string;sha256:string;body:string;}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

async function* inflateArchive(source:Readable):AsyncGenerator<Buffer>{
  const unzip=createGunzip(),finished=pipeline(source,unzip);void finished.catch(()=>{});
  try{for await(const chunk of unzip)yield chunk as Buffer;await finished;}
  finally{source.destroy();unzip.destroy();await finished.catch(()=>{});}
}

/** Read decompressed v1 bytes with bounded lines; the optional limit can only lower the production bound. */
export async function* readPrivateArchive(chunks:AsyncIterable<Uint8Array>,maximumBytes=MAX_PRIVATE_ARCHIVE_BYTES):AsyncGenerator<ArchiveEntry>{
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<0)throw Error('backup_archive_limit');
  const limit=Math.min(MAX_PRIVATE_ARCHIVE_BYTES,maximumBytes);
  let total=0,mode:'lines'|'legacy'|null=null,pending:Buffer[]=[],pendingBytes=0,footer=false,count=0;
  const names=new Set<string>();
  function validate(name:string,value:unknown):ArchiveEntry{
    if(!objectName.test(name)||!value||typeof value!=='object'||Array.isArray(value))throw Error('backup_invalid');
    const v=value as Record<string,unknown>;
    if(typeof v.body!=='string'||Buffer.byteLength(v.body)>MAX_OBJECT_BYTES||typeof v.sha256!=='string'||!/^[a-f0-9]{64}$/.test(v.sha256)||hash(v.body)!==v.sha256||names.has(name)||++count>100000)throw Error('backup_invalid');
    names.add(name);return {name,body:v.body,sha256:v.sha256};
  }
  function line(bytes:Buffer):ArchiveEntry|null{
    const text=bytes.toString('utf8');
    if(footer){if(!/^[\t\r ]*$/.test(text))throw Error('backup_invalid');return null;}
    if(text==='}}'){footer=true;return null;}
    const fragment=count?text.startsWith(',')?text.slice(1):'':text;
    const match=/^"([a-f0-9]{64}\.json)":(.*)$/s.exec(fragment);
    if(!match)throw Error('backup_invalid');
    return validate(match[1],JSON.parse(match[2]));
  }
  for await(const value of chunks){
    const chunk=Buffer.isBuffer(value)?value:Buffer.from(value.buffer,value.byteOffset,value.byteLength);
    total+=chunk.length;if(total>limit)throw Error('backup_archive_limit');
    if(mode==='legacy'){if(total>MAX_LEGACY_ARCHIVE_BYTES)throw Error('backup_archive_limit');pending.push(chunk);pendingBytes+=chunk.length;continue;}
    let offset=0;
    if(mode===null){
      const newline=chunk.indexOf(10),prefixLength=newline<0?chunk.length:newline;
      if(pendingBytes+prefixLength>512){mode='legacy';pending.push(chunk);pendingBytes+=chunk.length;if(total>MAX_LEGACY_ARCHIVE_BYTES)throw Error('backup_archive_limit');continue;}
      if(newline<0){pending.push(chunk);pendingBytes+=chunk.length;continue;}
      const first=Buffer.concat([...pending,chunk.subarray(0,newline)],pendingBytes+newline).toString('utf8');
      if(!/^\{"schemaVersion":"vds-volume-backup-1","createdAt":"[^"\\]+","entries":\{$/.test(first)){
        mode='legacy';pending.push(chunk);pendingBytes+=chunk.length;if(total>MAX_LEGACY_ARCHIVE_BYTES)throw Error('backup_archive_limit');continue;
      }
      JSON.parse(first+'}}');
      mode='lines';pending=[];pendingBytes=0;offset=newline+1;
    }
    while(offset<chunk.length){
      const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline,part=chunk.subarray(offset,end);
      pending.push(part);pendingBytes+=part.length;if(pendingBytes>MAX_ENTRY_LINE_BYTES)throw Error('backup_object_limit');
      if(newline<0)break;
      const entry=line(Buffer.concat(pending,pendingBytes));pending=[];pendingBytes=0;if(entry)yield entry;
      offset=newline+1;
    }
  }
  if(mode==='lines'){
    if(pendingBytes){const entry=line(Buffer.concat(pending,pendingBytes));if(entry)yield entry;}
    if(!footer)throw Error('backup_invalid');return;
  }
  if(total>MAX_LEGACY_ARCHIVE_BYTES)throw Error('backup_archive_limit');
  const data=JSON.parse(Buffer.concat(pending,pendingBytes).toString('utf8'));
  if(!data||data.schemaVersion!=='vds-volume-backup-1'||!data.entries||typeof data.entries!=='object'||Array.isArray(data.entries))throw Error('backup_invalid');
  for(const [name,value]of Object.entries(data.entries))yield validate(name,value);
}

/** One process/replica per mounted volume. Never put this directory under dist. */
export async function openPrivateStorage(directory: string) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('storage_symlink');
  await chmod(root, 0o700);
  const restoreMarker=join(root,'.restore-incomplete');
  async function requireComplete(){try{await lstat(restoreMarker);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}throw Error('restore_incomplete');}
  await requireComplete();
  // scripts/start-railway.sh holds an OS flock for the process lifetime.
  // OS locks release even after a crash; no stale lock file prevents recovery.
  let queue = Promise.resolve<unknown>(undefined);
  const pathFor = (key: string) => join(root, `${createHash('sha256').update(key).digest('hex')}.json`);
  async function read(key: string) {
    await requireComplete();
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
  async function syncDirectory(directory:string){const file=await open(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await file.sync();}finally{await file.close();}}
  async function* archiveChunks(){
    await requireComplete();let total=0,count=0;
    function bounded(value:string){const bytes=Buffer.from(value);total+=bytes.length;if(total>MAX_PRIVATE_ARCHIVE_BYTES)throw Error('backup_archive_limit');return bytes;}
    yield bounded('{"schemaVersion":"vds-volume-backup-1","createdAt":'+JSON.stringify(new Date().toISOString())+',"entries":{\n');
    for(const name of await readdir(root)){
      if(!objectName.test(name))continue;if(count>=100000)throw Error('backup_object_limit');
      const file=await open(join(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);
      let body:string;
      try{const stat=await file.stat();if(!stat.isFile()||stat.size>MAX_OBJECT_BYTES)throw Error('backup_object_limit');body=await file.readFile('utf8');if(Buffer.byteLength(body)>MAX_OBJECT_BYTES)throw Error('backup_object_limit');}finally{await file.close();}
      yield bounded((count?',':'')+JSON.stringify(name)+':'+JSON.stringify({sha256:hash(body),body})+'\n');count++;
    }
    yield bounded('}}\n');
  }
  async function exportArchive(){
    const operation=queue.then(async()=>{
      const chunks:Buffer[]=[];let length=0;
      await pipeline(Readable.from(archiveChunks()),createGzip(),new Writable({write(chunk:Buffer,_encoding,callback){chunks.push(chunk);length+=chunk.length;callback();}}));
      return Buffer.concat(chunks,length);
    });queue=operation.catch(()=>{});return operation;
  }
  async function restoreArchive(bytes:Buffer){
    const operation=queue.then(async()=>{
      await requireComplete();
      if((await readdir(root)).some(n=>objectName.test(n)))throw Error('restore_requires_empty_volume');
      const entries=()=>readPrivateArchive(inflateArchive(Readable.from([bytes])));
      // Reject invalid uploads before placing the durable incomplete marker.
      let count=0;for await(const _entry of entries())count++;
      if(!count)throw Error('backup_invalid');
      const marker=await open(restoreMarker,'wx',0o600);try{await marker.sync();}finally{await marker.close();}await syncDirectory(root);
      for await(const entry of entries()){
        const file=await open(join(root,entry.name),'wx',0o600);try{await file.writeFile(entry.body);await file.sync();}finally{await file.close();}
      }
      await syncDirectory(root);await unlink(restoreMarker);await syncDirectory(root);
      return {restoredObjects:count};
    });queue=operation.catch(()=>{});return operation;
  }
  async function createCheckpoint(){
    const operation=queue.then(async()=>{
      await requireComplete();
      const directory=join(root,'backups');await mkdir(directory,{mode:0o700,recursive:true});
      const stat=await lstat(directory);if(stat.isSymbolicLink())throw Error('storage_symlink');if(!stat.isDirectory())throw Error('storage_object_invalid');
      const temporary=join(directory,'.pending-'+randomUUID()),checksum=createHash('sha256');
      try{
        const output=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try{await pipeline(Readable.from(archiveChunks()),createGzip(),new Transform({transform(chunk:Buffer,_encoding,callback){checksum.update(chunk);callback(null,chunk);}}),output.createWriteStream());}finally{await output.close().catch(()=>{});}
        const file=await open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW);try{await file.sync();}finally{await file.close();}
        let count=0;
        try{const input=await open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW);try{for await(const _entry of readPrivateArchive(inflateArchive(input.createReadStream())))count++;}finally{await input.close().catch(()=>{});}}
        catch{throw Error('checkpoint_verification_failed');}
        if(!count)return {objects:0,created:false};
        const digest=checksum.digest('hex');
        // A hard link publishes without replacing or deleting a historical backup.
        await link(temporary,join(directory,digest+'.json.gz'));await unlink(temporary);await syncDirectory(directory);await syncDirectory(root);
        return {objects:count,created:true,digest};
      }finally{await unlink(temporary).catch(()=>{});}
    });queue=operation.catch(()=>{});return operation;
  }
  return { bucket, exportArchive, restoreArchive, createCheckpoint, async close() { await queue; } };
}

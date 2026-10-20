import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPrivateStorage,readPrivateArchive,MAX_PRIVATE_ARCHIVE_BYTES} from '../server/railway/storage.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const header='{"schemaVersion":"vds-volume-backup-1","createdAt":"2026-10-20T00:00:00.000Z","entries":{\n';
const footer='}}\n';
const body='Synthetic "escaped" body with é and 🛠\n'.repeat(50);
const lines=Array.from({length:9},(_,i)=>(i?',':'')+JSON.stringify(sha('synthetic-'+i)+'.json')+':'+JSON.stringify({sha256:sha(body),body})+'\n');
// Tiny chunks split UTF-8 code points, JSON escapes, entry delimiters and footer.
async function* fixture(){for(const text of [header,...lines,footer]){const bytes=Buffer.from(text);for(let i=0;i<bytes.length;i+=17)yield bytes.subarray(i,i+17);}}
async function count(chunks:AsyncIterable<Uint8Array>,limit?:number){let n=0;for await(const _entry of readPrivateArchive(chunks,limit))n++;return n;}

test('streamed archives enforce the explicit aggregate byte limit without aggregating their JSON',async()=>{
 assert.equal(MAX_PRIVATE_ARCHIVE_BYTES,1024*1024*1024);
 const bytes=[header,...lines,footer].reduce((n,text)=>n+Buffer.byteLength(text),0);
 assert.equal(await count(fixture(),bytes),lines.length);
 await assert.rejects(count(fixture(),bytes-1),/backup_archive_limit/);
 // Production callers cannot raise the fixed 1 GiB bound through the test seam.
 assert.equal(await count(fixture(),MAX_PRIVATE_ARCHIVE_BYTES+1),lines.length);
});

test('the legacy compact reader retains strict object and aggregate byte bounds',async()=>{
 const compact=Buffer.from(JSON.stringify({schemaVersion:'vds-volume-backup-1',entries:{[sha('legacy')+'.json']:{sha256:sha(body),body}}}));
 async function* chunks(){for(let i=0;i<compact.length;i+=31)yield compact.subarray(i,i+31);}
 assert.equal(await count(chunks(),compact.length),1);
 await assert.rejects(count(chunks(),compact.length-1),/backup_archive_limit/);
 const oversized='S'.repeat(4*1024*1024+1);
 async function* largeObject(){yield Buffer.from(header);yield Buffer.from(JSON.stringify(sha('oversized')+'.json')+':'+JSON.stringify({sha256:sha(oversized),body:oversized})+'\n');yield Buffer.from(footer);}
 await assert.rejects(count(largeObject()),/backup_invalid/);
});

test('a real private archive larger than 128 MiB checkpoints and restores every synthetic object',async()=>{
 const sourceRoot=await mkdtemp(join(tmpdir(),'vds-large-checkpoint-')),targetRoot=await mkdtemp(join(tmpdir(),'vds-large-restore-'));
 const source=await openPrivateStorage(sourceRoot),target=await openPrivateStorage(targetRoot);
 try{
  const value=JSON.stringify({testFixture:'X'.repeat(4*1024*1024-512)}),digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
  for(let i=0;i<33;i++)await source.bucket.put('large-test-'+i,value);
  assert.ok(Buffer.byteLength(value)*33>128*1024*1024);
  const checkpoint=await source.createCheckpoint();assert.equal(checkpoint.created,true);assert.equal(checkpoint.objects,33);
  const files=await readdir(join(sourceRoot,'backups'));assert.equal(files.length,1);
  const archive=await readFile(join(sourceRoot,'backups',files[0]));assert.equal(digest(archive),checkpoint.digest);
  assert.equal((await target.restoreArchive(archive)).restoredObjects,33);
  for(let i=0;i<33;i++)assert.equal(digest(await(await target.bucket.get('large-test-'+i))!.text()),digest(value));
  await assert.rejects(target.restoreArchive(archive),/requires_empty_volume/);
  assert.equal(await(await source.bucket.get('large-test-0'))!.text(),value);
 }finally{await source.close();await target.close();await Promise.all([sourceRoot,targetRoot].map(root=>rm(root,{recursive:true,force:true})));}
});

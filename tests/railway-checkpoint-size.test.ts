import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {openPrivateStorage} from '../server/railway/storage.js';

test('a valid private archive larger than 128 MiB survives checkpoint verification and restores every object',async()=>{
 const sourceRoot=await mkdtemp(join(tmpdir(),'vds-large-checkpoint-')),targetRoot=await mkdtemp(join(tmpdir(),'vds-large-restore-'));
 const source=await openPrivateStorage(sourceRoot),target=await openPrivateStorage(targetRoot);
 try{
  // Synthetic data only, deliberately over the former aggregate limit while
  // each immutable object remains inside the existing 4 MiB object limit.
  const body=JSON.stringify({testFixture:'X'.repeat(4*1024*1024-512)}),digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
  for(let i=0;i<33;i++)await source.bucket.put('large-test-'+i,body);
  assert.ok(Buffer.byteLength(body)*33>128*1024*1024);
  const checkpoint=await source.createCheckpoint();assert.equal(checkpoint.created,true);assert.equal(checkpoint.objects,33);
  const files=await readdir(join(sourceRoot,'backups'));assert.equal(files.length,1);
  const archive=await readFile(join(sourceRoot,'backups',files[0]));assert.equal(digest(archive),checkpoint.digest);
  assert.equal((await target.restoreArchive(archive)).restoredObjects,33);
  for(let i=0;i<33;i++)assert.equal(digest(await (await target.bucket.get('large-test-'+i))!.text()),digest(body));
  await assert.rejects(target.restoreArchive(archive),/requires_empty_volume/);
  assert.equal(await (await source.bucket.get('large-test-0'))!.text(),body);
 }finally{await source.close();await target.close();await rm(sourceRoot,{recursive:true,force:true});await rm(targetRoot,{recursive:true,force:true});}
});

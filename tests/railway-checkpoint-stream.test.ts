import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {openPrivateStorage} from '../server/railway/storage.js';

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const nameFor=(key:string)=>sha(key)+'.json';
const createdAt='2026-10-20T00:00:00.000Z';
type Entry=[string,{sha256:string;body:string}];
const entry=(key:string,body:string):Entry=>[nameFor(key),{sha256:sha(body),body}];
const streamed=(entries:Entry[])=>gzipSync('{"schemaVersion":"vds-volume-backup-1","createdAt":"'+createdAt+'","entries":{\n'+entries.map(([name,value],index)=>(index?',':'')+JSON.stringify(name)+':'+JSON.stringify(value)+'\n').join('')+'}}\n');
const roots=async(count=1)=>Promise.all(Array.from({length:count},()=>mkdtemp(join(tmpdir(),'vds-checkpoint-stream-'))));

test('streamed v1 remains valid JSON and preserves escaped UTF-8 bodies through export, checkpoint and restore',async()=>{
 const [sourceRoot,targetRoot]=await roots(2),source=await openPrivateStorage(sourceRoot),target=await openPrivateStorage(targetRoot);
 try{
  const values=new Map([
   ['escaped','Synthetic only: "quotes" \\ backslash\nnewline\rreturn\tTAB\0NUL 🛠 é 漢字\u2028\u2029'],
   ['chunked',('a'.repeat(16371)+'é🛠\n\\\0').repeat(5)],
  ]);
  for(const [key,body]of values)await source.bucket.put(key,body);
  const exported=await source.exportArchive(),text=gunzipSync(exported).toString('utf8'),decoded=JSON.parse(text);
  assert.match(text,/^\{"schemaVersion":"vds-volume-backup-1","createdAt":"[^"]+","entries":\{\n/);
  assert.ok(text.endsWith('}}\n'));
  assert.equal(decoded.schemaVersion,'vds-volume-backup-1');assert.equal(Object.keys(decoded.entries).length,values.size);
  for(const [key,body]of values)assert.deepEqual(decoded.entries[nameFor(key)],{sha256:sha(body),body});
  const checkpoint=await source.createCheckpoint();assert.equal(checkpoint.created,true);assert.equal(checkpoint.objects,values.size);
  const files=await readdir(join(sourceRoot,'backups'));assert.equal(files.length,1);
  const archived=await readFile(join(sourceRoot,'backups',files[0]));assert.equal(sha(archived),checkpoint.digest);
  assert.equal((await target.restoreArchive(archived)).restoredObjects,values.size);
  for(const [key,body]of values)assert.equal(await(await target.bucket.get(key))!.text(),body);
  await assert.rejects(target.restoreArchive(exported),/restore_requires_empty_volume/);
 }finally{await source.close();await target.close();await Promise.all([sourceRoot,targetRoot].map(root=>rm(root,{recursive:true,force:true})));}
});

test('historical compact v1 archives restore without rewriting their source bytes',async()=>{
 const [root]=await roots(),storage=await openPrivateStorage(root);
 try{
  const entries=[entry('legacy-1','{"synthetic":"historical"}'),entry('legacy-2','Legacy é\n"\\\0')];
  const compact=gzipSync(JSON.stringify({schemaVersion:'vds-volume-backup-1',createdAt,entries:Object.fromEntries(entries)}));
  assert.equal((await storage.restoreArchive(compact)).restoredObjects,2);
  for(const [key,body]of [['legacy-1',entries[0][1].body],['legacy-2',entries[1][1].body]])assert.equal(await(await storage.bucket.get(key))!.text(),body);
 }finally{await storage.close();await rm(root,{recursive:true,force:true});}
});

test('streaming validation rejects malformed archives before creating restore files or marker',async()=>{
 const valid=entry('synthetic-valid','Body with é and 🛠'),other=entry('synthetic-other','Other synthetic body');
 const good=streamed([valid,other]);
 const invalid:[string,Buffer][]=[
  ['changed body',streamed([valid,[other[0],{...other[1],body:'altered'}]])],
  ['changed digest',streamed([valid,[other[0],{...other[1],sha256:'0'.repeat(64)}]])],
  ['duplicate entry',streamed([valid,valid])],
  ['invalid object name',streamed([valid,['../escape.json',other[1]]])],
  ['truncated gzip',good.subarray(0,good.length-8)],
  ['truncated JSON',gzipSync(gunzipSync(good).subarray(0,-3))],
  ['JSON after footer',gzipSync(gunzipSync(good).toString('utf8')+'{"unexpected":true}')],
  ['unescaped TAB in header',gzipSync(gunzipSync(good).toString('utf8').replace(createdAt,createdAt+'\t'))],
  ['non-JSON whitespace after footer',gzipSync(gunzipSync(good).toString('utf8')+'\u00a0')],
 ];
 for(const [label,bytes]of invalid){
  const [root]=await roots(),storage=await openPrivateStorage(root);
  try{
   await assert.rejects(storage.restoreArchive(bytes),label);
   assert.deepEqual(await readdir(root),[],label+' must leave the empty volume usable');
   assert.equal((await storage.restoreArchive(good)).restoredObjects,2,label+' must not poison the storage queue');
  }finally{await storage.close();await rm(root,{recursive:true,force:true});}
 }
});

test('exports and checkpoints refuse object symlinks without changing their targets',async()=>{
 const [root,outside]=await roots(2),storage=await openPrivateStorage(root),body='Synthetic symlink target';
 try{
  const target=join(outside,'source.txt');await writeFile(target,body);await symlink(target,join(root,nameFor('linked')));
  await assert.rejects(storage.exportArchive());await assert.rejects(storage.createCheckpoint());
  assert.deepEqual(await readdir(join(root,'backups')),[],'failed checkpoint must remove its temporary file');
  assert.equal(await readFile(target,'utf8'),body);
 }finally{await storage.close();await Promise.all([root,outside].map(path=>rm(path,{recursive:true,force:true})));}
});

test('checkpoints refuse a symlinked backups directory and preserve its historical files',async()=>{
 const [root,outside]=await roots(2),storage=await openPrivateStorage(root);
 try{
  await storage.bucket.put('source','Synthetic source');await writeFile(join(outside,'historical.json.gz'),'Historical synthetic sentinel');
  await symlink(outside,join(root,'backups'));
  await assert.rejects(storage.createCheckpoint());
  assert.deepEqual(await readdir(outside),['historical.json.gz']);assert.equal(await readFile(join(outside,'historical.json.gz'),'utf8'),'Historical synthetic sentinel');
  assert.equal(await(await storage.bucket.get('source'))!.text(),'Synthetic source');
 }finally{await storage.close();await Promise.all([root,outside].map(path=>rm(path,{recursive:true,force:true})));}
});

test('an incomplete restore marker blocks reopening and every archive operation',async()=>{
 const [root]=await roots(),storage=await openPrivateStorage(root),marker=join(root,'.restore-incomplete');
 try{
  await writeFile(marker,'');
  await assert.rejects(openPrivateStorage(root),/restore_incomplete/);
  await assert.rejects(storage.exportArchive(),/restore_incomplete/);
  await assert.rejects(storage.createCheckpoint(),/restore_incomplete/);
  await assert.rejects(storage.restoreArchive(streamed([entry('valid','Synthetic body')])),/restore_incomplete/);
  assert.deepEqual(await readdir(root),['.restore-incomplete']);
 }finally{await storage.close();await rm(root,{recursive:true,force:true});}
});

test('queued checkpoints preserve snapshot order, historical backups and remove all temporary files',{timeout:10000},async()=>{
 const [root]=await roots(),storage=await openPrivateStorage(root);
 try{
  const before=storage.bucket.put('before','Synthetic before'),checkpoint=storage.createCheckpoint();
  const after=storage.bucket.put('after','Synthetic after'),exported=storage.exportArchive();
  await Promise.all([before,after]);const result=await checkpoint;
  assert.equal(result.objects,1);assert.equal(Object.keys(JSON.parse(gunzipSync(await exported).toString('utf8')).entries).length,2);
  const first=join(root,'backups',result.digest!+'.json.gz'),historical=await readFile(first);
  const next=await storage.createCheckpoint();assert.equal(next.objects,2);
  assert.deepEqual(await readFile(first),historical);
  const files=await readdir(join(root,'backups'));assert.equal(files.length,2);assert.ok(files.every(name=>/^[a-f0-9]{64}\.json\.gz$/.test(name)));
 }finally{await storage.close();await rm(root,{recursive:true,force:true});}
});

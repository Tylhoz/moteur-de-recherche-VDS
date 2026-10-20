import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createMaterializedAnalytics,type MaterializedAnalytics} from '../server/railway/materialized-analytics.js';
import {buildBusinessDataset,businessQuery,summarizeBusiness} from '../server/railway/business-analytics.js';
import {accountingProjection} from '../server/railway/intelligence.js';
import type {PrivateR2Bucket} from '../worker/index.js';

const prefix='vds/private/analytics-materialized/';
const malformed=' \n{"schemaVersion":"analytics-materialized-1","synthetic":"é",\n';
const originalKey='vds/private/synthetic-original.json';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(key='initial'):MaterializedAnalytics{
 const data=buildBusinessDataset([],new Map(),accountingProjection({clients:[],invoices:[{id:1,kind:'vat',income:'1',currency:'EUR',price_net:'100',price_gross:'121',paid:'0',issue_date:'2026-10-20',status:'sent'}],payments:[]},[],'synthetic-test'));
 const meta={revision:key,accountingReadAt:'2026-10-20T01:00:00Z',sheetsReadAt:null,projectionPending:false,refreshing:false,error:null,paymentsEnabled:false,readOnly:true as const};
 return {key,data,accountingReadAt:meta.accountingReadAt,sheetsReadAt:null,defaults:{account:summarizeBusiness(data,businessQuery({scope:'account'}),meta),dossiers:summarizeBusiness(data,businessQuery({}),meta)}};
}
function memory(){
 const values=new Map([[originalKey,'synthetic original: untouched']]);
 const writes:{key:string;options?:Parameters<PrivateR2Bucket['put']>[2]}[]=[];
 const state={failure:''};
 const bucket:PrivateR2Bucket={
  async get(key){
   assert.ok(key.startsWith(prefix),'Cache must only read derived objects');
   if(state.failure==='current-get'&&key.endsWith('/current.json')||state.failure==='archive-get'&&key.includes('/quarantine/'))throw new SyntaxError('synthetic_io_failure');
   const value=values.get(key);return value===undefined?null:{size:Buffer.byteLength(value),text:async()=>{
    if(state.failure==='current-text'&&key.endsWith('/current.json')||state.failure==='archive-text'&&key.includes('/quarantine/'))throw new SyntaxError('synthetic_io_failure');
    return value;
   }};
  },
  async put(key,value,options){
   assert.ok(key.startsWith(prefix),'Cache must only write derived objects');writes.push({key,options});
   if(state.failure==='archive-throw'&&key.includes('/quarantine/'))throw Error('synthetic_archive_failure');
   if(state.failure==='archive-null'&&key.includes('/quarantine/'))return null;
   if(state.failure==='version-put'&&key.includes('/versions/')||state.failure==='pointer-put'&&key.endsWith('/current.json'))throw Error('synthetic_io_failure');
   if(options?.onlyIf?.etagDoesNotMatch==='*'&&values.has(key))return null;
   values.set(key,value);return {key};
  },
 };
 return {values,writes,state,bucket};
}
async function corruptFixture(){
 const m=memory(),store=createMaterializedAnalytics(m.bucket,'synthetic-recovery');await store.save(fixture());
 const pointerKey=[...m.values.keys()].find(key=>key.endsWith('/current.json'))!;
 const archiveKey=pointerKey.replace('current.json','quarantine/current-'+hash(malformed)+'.json');
 m.values.set(pointerKey,malformed);m.writes.length=0;
 return {...m,store,pointerKey,archiveKey};
}

test('malformed derived pointer is rejected, quarantined verbatim and rebuilt without losing versions',async()=>{
 const m=await corruptFixture(),oldVersion=[...m.values].find(([key])=>key.includes('/versions/'))!;
 await assert.rejects(m.store.restore(),SyntaxError);
 const next=fixture('rebuilt'),saved=await m.store.save(next);
 assert.deepEqual(m.writes.map(write=>write.key),[m.archiveKey,m.pointerKey.replace('current.json','versions/'+saved.digest+'.json'),m.pointerKey]);
 assert.equal(m.writes[0].options?.onlyIf?.etagDoesNotMatch,'*');
 assert.equal(m.values.get(m.archiveKey),malformed);
 assert.equal(m.values.get(oldVersion[0]),oldVersion[1]);
 assert.equal(m.values.get(originalKey),'synthetic original: untouched');
 assert.equal(JSON.parse(m.values.get(m.pointerKey)!).previous,null);
 const restored=await m.store.restore();assert.ok(restored);
 assert.equal(restored.key,'rebuilt');assert.equal(restored.data.documents.length,1);
 assert.equal(restored.defaults.account.kpis.find(k=>k.id==='net')?.value,10000);
 const count=m.values.size;m.values.set(m.pointerKey,malformed);await m.store.save(next);
 assert.equal(m.values.size,count,'Identical rejected pointers reuse the immutable quarantine');
 assert.equal(m.values.get(m.archiveKey),malformed);
 assert.equal((await m.store.restore())?.key,'rebuilt');
});

test('failed or conflicting quarantine refuses reconstruction and leaves the rejected pointer untouched',async t=>{
 for(const failure of ['archive-throw','archive-null','archive-collision'])await t.test(failure,async()=>{
  const m=await corruptFixture();m.state.failure=failure;
  if(failure==='archive-collision')m.values.set(m.archiveKey,'different synthetic content');
  const before=new Map(m.values);
  await assert.rejects(m.store.save(fixture('rebuilt')),/synthetic_archive_failure|analytics_cache_quarantine_failed/);
  assert.deepEqual(m.values,before);
  assert.ok(m.writes.every(write=>write.key===m.archiveKey),'Do not publish a version or pointer after archive failure');
  await assert.rejects(m.store.restore(),SyntaxError);
 });
});

test('I/O failures remain fatal during malformed-pointer recovery',async t=>{
 for(const failure of ['current-get','current-text','archive-get','archive-text','version-put','pointer-put'])await t.test(failure,async()=>{
  const m=await corruptFixture(),oldVersion=[...m.values].find(([key])=>key.includes('/versions/'))!;
  if(failure.startsWith('archive-'))m.values.set(m.archiveKey,malformed);
  m.state.failure=failure;
  await assert.rejects(m.store.save(fixture('rebuilt')),/synthetic_io_failure/);
  assert.equal(m.values.get(m.pointerKey),malformed);
  assert.equal(m.values.get(oldVersion[0]),oldVersion[1]);
  assert.equal(m.values.get(originalKey),'synthetic original: untouched');
 });
});

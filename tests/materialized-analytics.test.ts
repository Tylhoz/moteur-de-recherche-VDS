import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaterializedAnalytics,type MaterializedAnalytics} from '../server/railway/materialized-analytics.js';
import {buildBusinessDataset,businessQuery,summarizeBusiness,pageBusinessDocuments} from '../server/railway/business-analytics.js';
import {accountingProjection} from '../server/railway/intelligence.js';
import {backgroundSchedule} from '../server/railway/background-schedule.js';
import {normalizeBusinessSummary,normalizeBusinessPage} from '../shared/business-analytics-normalize.js';
import {createRailwayApp} from '../server/railway/app.js';
import {passwordHash} from '../server/railway/auth.js';
import {randomBytes} from 'node:crypto';
import type {Client} from '../src/types.js';
import type {PrivateR2Bucket} from '../worker/index.js';
const clients:Client[]=[{id:'VDS-001',client:'TEST private dossier',contact:'',address:'',modelTeam:'',techMacon:'',finance:'',statusAction:'',category:'non_verifie',soldeAmount:null,contractHT:null}];
const invoices=Array.from({length:20161},(_,i)=>({id:i+1,client_id:1,kind:'vat',income:'1',currency:'EUR',price_net:'100',price_gross:'121',paid:'0',issue_date:'2026-10-20',number:'TEST-'+i,status:'sent'}));
const dataset=buildBusinessDataset(clients,new Map(),accountingProjection({clients:[{id:1,external_id:'VDS-001'}],invoices,payments:[]},clients,'private-test'));
const meta={revision:'cache-test',accountingReadAt:'2026-10-20T01:00:00Z',sheetsReadAt:null,projectionPending:false,refreshing:false,error:null,paymentsEnabled:false,readOnly:true as const};
function fixture():MaterializedAnalytics{return {key:meta.revision,data:dataset,accountingReadAt:meta.accountingReadAt,sheetsReadAt:null,defaults:{account:summarizeBusiness(dataset,businessQuery({scope:'account'}),meta),dossiers:summarizeBusiness(dataset,businessQuery({}),meta)}};}
function memory(){const data=new Map<string,string>();let failPointer=false;const bucket:PrivateR2Bucket={async get(key){const value=data.get(key);return value===undefined?null:{size:Buffer.byteLength(value),text:async()=>value};},async put(key,value,options){if(failPointer&&key.endsWith('/current.json'))throw Error('test_disk_failure');if(data.has(key)&&options?.onlyIf?.etagDoesNotMatch==='*')return null;data.set(key,value);return {key};}};return {data,bucket,fail:()=>{failPointer=true;}};}

test('20161 documents are restored from a private materialized cache with exact totals and bounded pages',async()=>{
 const m=memory(),store=createMaterializedAnalytics(m.bucket,'account-A'),cache=fixture();
 await store.save(cache);const restored=await createMaterializedAnalytics(m.bucket,'account-A').restore();assert.ok(restored);
 assert.equal(restored.data.documents.length,20161);assert.equal(restored.data.byId.get('VDS-001')?.name,clients[0].client);
 assert.equal(restored.defaults.account.kpis.find(k=>k.id==='net')?.value,201610000);
 assert.equal(pageBusinessDocuments(restored.data,businessQuery({scope:'account',page:2}),restored.key).items.length,50);
 assert.ok(Buffer.byteLength(JSON.stringify(restored.defaults.account))<256*1024);
 assert.equal(await createMaterializedAnalytics(m.bucket,'account-B').restore(),null,'Never reuse another account cache');
 const size=m.data.size;await store.updateDates({...cache,accountingReadAt:'2026-10-20T02:00:00Z'});assert.equal(m.data.size,size);
 assert.equal((await store.restore())?.accountingReadAt,'2026-10-20T02:00:00Z');
 await store.save(cache);assert.equal(m.data.size,size,'Identical data must not duplicate the large cached version');
});
test('corrupt derived cache is rejected and a failed pointer write leaves the previous complete version intact',async()=>{
 const m=memory(),store=createMaterializedAnalytics(m.bucket,'account-A'),cache=fixture();await store.save(cache);
 const pointerKey=[...m.data.keys()].find(k=>k.endsWith('/current.json'))!,before=m.data.get(pointerKey);
 m.fail();await assert.rejects(store.save({...cache,key:'new-revision'}),/test_disk_failure/);assert.equal(m.data.get(pointerKey),before);
 const versionKey=[...m.data.keys()].find(k=>k.includes('/versions/'))!,version=JSON.parse(m.data.get(versionKey)!);version.body=Buffer.from('corrupt').toString('base64');m.data.set(versionKey,JSON.stringify(version));await assert.rejects(store.restore());
});
test('a restarted authenticated API serves cached summaries and pages while all original sources are inaccessible',async()=>{
 const m=memory(),origin='https://cache-test.invalid',owner='owner@example.test',password=randomBytes(24).toString('base64url');
 const env={VDS_PUBLIC_ORIGIN:origin,VDS_OWNER_EMAIL:owner,VDS_PASSWORD_HASH:await passwordHash(password),VDS_SESSION_SECRET:randomBytes(48).toString('base64url'),VDS_EXPECTED_BUNDLE_SHA256:'a'.repeat(64),VDS_IMPORT_TOKEN:randomBytes(32).toString('base64url'),VDS_COMMIT_SHA:'b'.repeat(40),VDS_INVOICING_PROVIDER:'vosfactures',VDS_VOSFACTURES_ACCOUNT:'private-test',VDS_VOSFACTURES_ENABLED:'true',VDS_VOSFACTURES_API_TOKEN:'test_secret_only'};
 const binding=JSON.stringify(['business-analytics-2',owner,env.VDS_VOSFACTURES_ACCOUNT,false]);await createMaterializedAnalytics(m.bucket,binding).save(fixture());
 let sourceReads=0;const offline:PrivateR2Bucket={...m.bucket,async get(key){if(!key.startsWith('vds/private/analytics-materialized/')){sourceReads++;throw Error('test_original_source_unavailable');}return m.bucket.get(key);}};
 const app=createRailwayApp(env,offline,'dist');await app.restoreAnalyticsCache();
 const login=await app.fetch(new Request(origin+'/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:owner,password})}));const cookie=login.headers.get('set-cookie')!.split(';')[0];
 const get=(path:string)=>app.fetch(new Request(origin+path,{headers:{Cookie:cookie}}));
 assert.equal((await app.fetch(new Request(origin+'/api/analyses'))).status,401);
 const start=performance.now();const response=await get('/api/analyses'),summary=await response.json(),warmReadMilliseconds=Math.round(performance.now()-start);assert.equal(response.status,200);assert.equal(summary.totals.documents,20161);assert.equal(sourceReads,0,'Warm summary must not scan originals');
 const page=await get('/api/documents?page=2&limit=50');assert.equal(page.status,200);assert.equal((await page.json()).items.length,50);assert.equal(sourceReads,0);
 assert.equal((await get('/api/documents?page=1&limit=51')).status,400);assert.equal((await get('/api/documents?search=private_name')).status,400);
 const original=console.error;console.error=()=>{};try{await app.prepareAnalytics();}finally{console.error=original;}
 const retained=await get('/api/analyses');assert.equal(retained.status,200);const body=await retained.json();assert.equal(body.meta.error,'analytics_cache_prepare_failed');assert.equal(body.kpis.find((k:any)=>k.id==='net').value,201610000);
 console.log(JSON.stringify({materializedCacheTest:true,warmReadMilliseconds,summaryBytes:Buffer.byteLength(JSON.stringify(summary)),documentsPerPage:50}));
});
test('hourly/nightly UTC schedules coalesce concurrent jobs and failures do not cause retry storms',async()=>{
 const scheduler=backgroundSchedule({}),now=Date.parse('2026-10-20T01:15:00Z');let calls=0,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const job=async()=>{calls++;await gate;};
 const a=scheduler.run(job,now),b=scheduler.run(job,now);await Promise.resolve();assert.equal(calls,1);release();await Promise.all([a,b]);assert.equal(scheduler.nextRunAt(),'2026-10-20T02:15:00.000Z');await scheduler.run(async()=>{calls++;},now+100);assert.equal(calls,1);
 const nightly=backgroundSchedule({VDS_ACCOUNTING_SYNC_SCHEDULE:'nightly',VDS_ACCOUNTING_SYNC_UTC_HOUR:'2'});await nightly.run(async()=>{},now);assert.equal(nightly.nextRunAt(),'2026-10-20T02:00:00.000Z');await nightly.run(async()=>{},Date.parse('2026-10-20T02:00:01Z'));assert.equal(nightly.nextRunAt(),'2026-10-21T02:00:00.000Z');
 const failed=backgroundSchedule({});await assert.rejects(failed.run(async()=>{throw Error('test_network_failure');},now));await failed.run(async()=>{throw Error('should_not_retry_early');},now+1);
 assert.throws(()=>backgroundSchedule({VDS_ACCOUNTING_SYNC_SCHEDULE:'every_second'}));assert.throws(()=>backgroundSchedule({VDS_ACCOUNTING_SYNC_INTERVAL_SECONDS:'1'}));
});
test('defensive pages preserve valid rows and unknown amounts without guessing or accepting unsafe links',()=>{
 const original=pageBusinessDocuments(dataset,businessQuery({scope:'account'}),meta.revision);const broken=structuredClone(original) as any;delete broken.items[0].url;delete broken.items[0].date;broken.items[0].gross='12100';broken.items[0].paid=undefined;broken.items[1].url='https://private-test.vosfactures.fr/invoices/1?api_token=DO_NOT_LOG';broken.items[2].id=null;
 const cleaned=normalizeBusinessPage(broken,'documents');assert.equal(cleaned.items.length,49);if(cleaned.schemaVersion!=='business-documents-1')throw Error('wrong_fixture');assert.equal(cleaned.items[0].url,null);assert.equal(cleaned.items[0].date,null);assert.equal(cleaned.items[0].gross,null);assert.equal(cleaned.items[0].paid,null);assert.equal(cleaned.items[1].url,null);assert.equal(cleaned.items[3].gross,12100);assert.equal(cleaned.total,20161);assert.equal(cleaned.quality?.omitted,1);assert.ok(cleaned.quality!.repaired>=5);
 assert.throws(()=>normalizeBusinessPage({...broken,pageSize:100},'documents'),/pagination/);
 assert.throws(()=>normalizeBusinessPage({...original,invoices:[]},'documents'),/raw_collections_forbidden/);
});
test('defensive summaries flag a partial chart and an unknown KPI without rejecting valid charts or weakening the root contract',()=>{
 const broken=structuredClone(fixture().defaults.account) as any;delete broken.charts[0].note;broken.charts[1].points[0].value=null;broken.kpis.find((k:any)=>k.id==='net').value='ambiguous';delete broken.meta.sheetsReadAt;
 const normalized=normalizeBusinessSummary(broken);assert.equal(normalized.kpis.find(k=>k.id==='net')?.value,null);assert.equal(normalized.charts[1].points.length,0);assert.ok(normalized.quality!.omitted>0);assert.ok(normalized.charts.find(c=>c.id==='invoice_status')?.points.length);assert.equal(normalized.meta.sheetsReadAt,null);
 assert.throws(()=>normalizeBusinessSummary({...broken,schemaVersion:'unknown'}));assert.throws(()=>normalizeBusinessSummary({...broken,meta:{...broken.meta,readOnly:false}}));assert.throws(()=>normalizeBusinessSummary({...broken,ledger:[]}));assert.throws(()=>normalizeBusinessSummary({...broken,totals:{documents:null}}));
});

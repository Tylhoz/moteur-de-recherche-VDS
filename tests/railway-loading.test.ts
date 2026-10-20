import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {createRailwayApp} from '../server/railway/app.js';
import {passwordHash} from '../server/railway/auth.js';
import type {PrivateR2Bucket} from '../worker/index.js';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');

// The approved business fixture stays outside GitHub. Assertions never print its contents.
test('Railway dossier/source/status endpoints remain usable while one shared accounting projection loads', {skip:!process.env.VDS_RAILWAY_BUNDLE_PATH}, async()=>{
 const body=await readFile(process.env.VDS_RAILWAY_BUNDLE_PATH!,'utf8'),bundleDigest=digest(body),bundle=JSON.parse(body);
 const id=bundle.snapshot.clients[0].id;
 const versionRoot='vds/private/vosfactures/versions/',indexKey='vds/private/vosfactures/index.json';
 const client=JSON.stringify({id:1,external_id:id}),invoice=JSON.stringify({id:1,client_id:1,kind:'vat',income:'1',currency:'EUR',price_net:'100',price_gross:'121',paid:'0'});
 const values=new Map<string,string>([['vds/private/active.json',JSON.stringify({digest:bundleDigest})],[`vds/private/bundles/${bundleDigest}.json`,body],[versionRoot+digest(client)+'.json',client],[versionRoot+digest(invoice)+'.json',invoice]]);
 const index={schemaVersion:'vosfactures-1',at:'2026-01-01T00:00:00Z',lastAttemptAt:'2026-01-01T00:00:00Z',lastFullAt:'2026-01-01T00:00:00Z',error:null,collections:{clients:{'1':digest(client)},invoices:{'1':digest(invoice)},payments:{}},history:[]};values.set(indexKey,JSON.stringify(index));
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let reads=0;
 const bucket:PrivateR2Bucket={async get(key){if(key.startsWith(versionRoot)){reads++;await gate;}const v=values.get(key);return v===undefined?null:{size:Buffer.byteLength(v),text:async()=>v};},async put(key,value){values.set(key,value);return {key};}};
 const origin='https://loading-test.invalid',owner='owner@example.test',password=randomBytes(24).toString('base64url');
 const app=createRailwayApp({VDS_PUBLIC_ORIGIN:origin,VDS_OWNER_EMAIL:owner,VDS_PASSWORD_HASH:await passwordHash(password),VDS_SESSION_SECRET:randomBytes(48).toString('base64url'),VDS_EXPECTED_BUNDLE_SHA256:bundleDigest,VDS_IMPORT_TOKEN:randomBytes(32).toString('base64url'),VDS_COMMIT_SHA:'a'.repeat(40),VDS_INVOICING_PROVIDER:'vosfactures',VDS_VOSFACTURES_ACCOUNT:'private-test',VDS_VOSFACTURES_ENABLED:'true',VDS_VOSFACTURES_API_TOKEN:'test_secret_for_readonly_adapter'},bucket,'dist');
 const login=await app.fetch(new Request(origin+'/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:owner,password})}));const cookie=login.headers.get('set-cookie')!.split(';')[0];
 const request=(path:string)=>app.fetch(new Request(origin+path,{headers:{Cookie:cookie}}));
 const bounded=async<T>(p:Promise<T>)=>{let t:ReturnType<typeof setTimeout>;try{return await Promise.race([p,new Promise<T>((_,reject)=>t=setTimeout(()=>reject(Error('basic_api_waited_for_accounting')),5000))]);}finally{clearTimeout(t!);}};
 try{
  const responses=await bounded(Promise.all(['/api/v1/portal-snapshot','/api/v1/sources360','/api/v1/sync360','/api/v1/analytics'].map(request)));assert.ok(responses.every(r=>r.status===200));
  const snapshot=await responses[0].json(),status=await responses[2].json();assert.equal(snapshot.clients.length,500);assert.equal(snapshot.dataCoverage.accountingProjectionPending,true);assert.equal(status.accounting.projectionPending,true);
  const initialSummary=await responses[3].json();assert.equal(initialSummary.schemaVersion,'business-analytics-2');assert.equal(initialSummary.meta.projectionPending,true);assert.equal(initialSummary.ledger,undefined);
  const beforeETag=responses[0].headers.get('etag');
  const financial=Array.from({length:6},()=>request('/api/v1/accounting360'));
  release();
  const completed=await Promise.all(financial);assert.ok(completed.every(r=>r.status===200));assert.equal(reads,2,'Only one read per immutable accounting object across concurrent requests');
  await app.prepareAnalytics();
  const apiSummary=await (await request('/api/v1/analytics')).json();assert.equal(apiSummary.schemaVersion,'business-analytics-2');assert.equal(apiSummary.totals.matchedDossiers,1);assert.equal(apiSummary.ledger,undefined);
  for(const path of ['/api/v1/analytics/query','/api/v1/accounting360/documents','/api/v1/analytics/dossiers']){
   assert.equal((await app.fetch(new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}))).status,401);
   assert.equal((await app.fetch(new Request(origin+path,{method:'POST',headers:{Cookie:cookie,Origin:'https://wrong.invalid','Content-Type':'application/json'},body:'{}'}))).status,403);
   const response=await app.fetch(new Request(origin+path,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({scope:'account',page:1,pageSize:50})}));assert.equal(response.status,200);
  }
  const invalidPage=await app.fetch(new Request(origin+'/api/v1/accounting360/documents',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{"pageSize":1000}'}));assert.equal(invalidPage.status,400);assert.equal((await invalidPage.json()).diagnostic,'pageSize');
  const summary=await completed[0].json();assert.equal(summary.matchedDossiers.length,1);assert.equal(summary.ledger.length,1);
  const nextResponse=await request('/api/v1/portal-snapshot'),next=await nextResponse.json();assert.equal(next.dataCoverage.accountingProjectionPending,false);assert.equal(next.dataCoverage.accountingRelated,1);assert.notEqual(nextResponse.headers.get('etag'),beforeETag);assert.notEqual(next.version,snapshot.version);
  const newInvoice=JSON.stringify({...JSON.parse(invoice),price_net:'200',price_gross:'242'});values.set(versionRoot+digest(newInvoice)+'.json',newInvoice);index.collections.invoices['1']=digest(newInvoice);values.set(indexKey,JSON.stringify(index));
  const changed=await (await request('/api/v1/accounting360')).json();assert.equal(changed.ledger[0].gross,24200);assert.equal(reads,4,'A new source revision is loaded instead of returning stale cached figures');
  const repairedInvoice=JSON.stringify({...JSON.parse(invoice),price_net:'300',price_gross:'363'}),repairedKey=versionRoot+digest(repairedInvoice)+'.json';index.collections.invoices['1']=digest(repairedInvoice);values.set(indexKey,JSON.stringify(index));values.set(repairedKey,'{}');
  await app.prepareAnalytics();
  const cachedDuringRefresh=await request('/api/v1/analytics');assert.equal(cachedDuringRefresh.status,200);assert.equal((await cachedDuringRefresh.json()).meta.projectionPending,true);
  assert.equal((await request('/api/v1/accounting360')).status,503,'Corrupt new source must not fall back to stale financial figures');values.set(repairedKey,repairedInvoice);
  const recovered=await request('/api/v1/accounting360');assert.equal(recovered.status,200);assert.equal((await recovered.json()).ledger[0].gross,36300,'A failed shared read is cleared so a repaired source can be retried');
 }finally{release();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {consolidateFields,consolidateTimeline,consolidateContradictions} from '../shared/consolidation.js';
import {matchIdentity} from '../server/railway/matching.js';
import {createVosFacturesStore,cents} from '../server/railway/vosfactures.js';
import {accountingProjection} from '../server/railway/intelligence.js';
import {openPrivateStorage} from '../server/railway/storage.js';
import type {Client} from '../src/types.js';
const c:Client={id:'VDS-001',client:'Essai CRM',contact:'contact@example.test +32470123456',address:'Rue Exemple 1',modelTeam:'',techMacon:'',finance:'',statusAction:'',category:'non_verifie',soldeAmount:null,contractHT:null};
const env={VDS_INVOICING_PROVIDER:'vosfactures',VDS_VOSFACTURES_ENABLED:'true',VDS_VOSFACTURES_ACCOUNT:'private-test',VDS_VOSFACTURES_API_TOKEN:'test_secret_for_readonly_adapter'};
const field={id:'one',label:'Modèle',value:'Family 8',status:'documented' as const,sourceIds:['a'],note:null,sourceStatus:null,humanValidated:false as const};
test('visual consolidation preserves originals and sources, separates financial documents and uncertain events',()=>{
 const original=[field,{...field,id:'two',label:'Modèle · observation Sheets',sourceIds:['b']}];const before=JSON.stringify(original),result=consolidateFields(original,'technique');assert.equal(result.length,1);assert.deepEqual(result[0].sourceIds,['a','b']);assert.equal(JSON.stringify(original),before);
 const conflict={id:'a',field:'Contrat HT',existingValue:'100',observedValue:'120',sourceIds:['a'],reason:'Source contradictoire',action:'Vérifier',status:'review' as const};assert.equal(consolidateContradictions([conflict,{...conflict,id:'b',sourceIds:['b']}])[0].sourceIds.length,2);
 assert.equal(consolidateFields(original.map((f,i)=>({...f,entityKey:'invoice-'+i})),'finances').length,2);
 const e={id:'a',dateOriginal:'2026-10-20',dateUTC:null,eventDate:'2026-10-20',summary:'Visite',category:'agenda',status:'unverified' as const,sourceStatus:null,sourceIds:['a']};assert.equal(consolidateTimeline([e,{...e,id:'b'}]).length,2);assert.equal(consolidateTimeline([{...e,externalEventKey:'event1'},{...e,id:'b',externalEventKey:'event1',sourceIds:['b']}]).length,1);
});
test('matching requires corroboration, rejects name-only merges and conflicting coordinates',()=>{
 assert.equal(matchIdentity({id:'1',name:c.client},[c]).status,'uncertain');assert.equal(matchIdentity({id:'1',email:'contact@example.test'},[c]).status,'probable');assert.equal(matchIdentity({id:'1',email:'contact@example.test',phone:'+32470123456'},[c]).status,'certain');assert.notEqual(matchIdentity({id:'1',externalId:c.id,email:'other@example.test'},[c]).status,'certain');assert.notEqual(matchIdentity({id:'1',email:'contact@example.test',phone:'+32470123456'},[c,{...c,id:'VDS-002'}]).status,'certain');
});
test('VosFactures uses GET pagination across the full history; refuses partial imports and keeps last good records',async()=>{
 const root=await mkdtemp(join(tmpdir(),'vds-acc-'));const storage=await openPrivateStorage(root);let denied=false;const calls:{path:string;page:number}[]=[];
 const request:typeof fetch=async(input,init)=>{const u=new URL(String(input));assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');assert.equal(u.searchParams.get('period'),'all');assert.equal(u.searchParams.get('per_page'),'100');const page=Number(u.searchParams.get('page'));calls.push({path:u.pathname,page});if(denied&&u.pathname.includes('banking'))return new Response(null,{status:403});return Response.json(page>1?[]:[{id:1,name:'Essai',kind:'vat',income:'1',price_net:'100',price_gross:'121',paid:'0',api_token:'never_persist',updated_at:'2020-01-01T00:00:00Z'}]);};
 try{const store=createVosFacturesStore(storage.bucket,env,request,async()=>{});assert.equal((await store.synchronize() as any).accepted,true);assert.ok(calls.some(c=>c.page===2));assert.equal((await store.rows()).invoices.length,1);assert.ok(!JSON.stringify(await store.rows()).includes('never_persist'));const at=(await store.state()).at;denied=true;assert.equal((await store.synchronize() as any).accepted,false);assert.equal((await store.state()).at,at);assert.equal((await store.rows()).invoices.length,1);assert.equal((await store.state()).error,'provider_access_denied');}finally{await storage.close();await rm(root,{recursive:true,force:true});}
});
test('VosFactures errors identify the failing stage without persisting tokens, URLs or raw exceptions',async()=>{
 const cases:[string,()=>Promise<Response>][]=[
  ['provider_dns_failed',async()=>{throw Object.assign(new TypeError('fetch https://example.test?api_token=never_persist'),{cause:{code:'ENOTFOUND',message:'never_persist'}});}],
  ['provider_tls_failed',async()=>{throw {cause:{code:'CERT_HAS_EXPIRED',message:'never_persist'}};}],
  ['provider_connection_failed',async()=>{throw {cause:{code:'ECONNRESET'}};}],
  ['provider_request_timeout',async()=>{throw {cause:{code:'UND_ERR_CONNECT_TIMEOUT'}};}],
  ['provider_redirect_refused',async()=>new Response(null,{status:302,headers:{Location:'https://untrusted.example.test/?api_token=never_persist'}})],
  ['provider_endpoint_not_found',async()=>new Response(null,{status:404})],
  ['provider_invalid_response',async()=>new Response('bad json never_persist',{headers:{'Content-Type':'application/json'}})],
 ];
 for(const [expected,response]of cases){
  const root=await mkdtemp(join(tmpdir(),'vds-error-')),storage=await openPrivateStorage(root);let calls=0;
  try{
   const request:typeof fetch=async(_input,init)=>{calls++;assert.equal(init?.redirect,'manual');return response();};
   const store=createVosFacturesStore(storage.bucket,env,request,async()=>{});
   const result=await store.synchronize() as any;
   assert.equal(result.error,expected);assert.equal(result.accepted,false);assert.equal(result.diagnostic.collection,'clients');assert.equal(result.diagnostic.page,1);assert.equal(result.diagnostic.recordsRead,0);assert.equal(calls,1,'No redirect is followed and credentials are never sent to a second host');
   assert.equal((await store.state()).at,null);assert.deepEqual(await store.rows(),{clients:[],invoices:[],payments:[]});
   assert.ok(!JSON.stringify(await store.journal()).includes('never_persist'));assert.ok(!JSON.stringify(await store.journal()).includes('https://'));
   assert.equal(store.progress(),null);
  }finally{await storage.close();await rm(root,{recursive:true,force:true});}
 }
});
test('VosFactures refuses a partial financial import and reports progress without customer contents',async()=>{
 const root=await mkdtemp(join(tmpdir(),'vds-progress-')),storage=await openPrivateStorage(root);
 try{
  let store:ReturnType<typeof createVosFacturesStore>;
  const request:typeof fetch=async(input)=>{
   const url=new URL(String(input));
   if(url.pathname==='/invoices.json'){assert.equal(store.progress()?.completedCollections,1);assert.equal(store.progress()?.recordsRead,1);throw {cause:{code:'UND_ERR_HEADERS_TIMEOUT'}};}
   return Response.json(url.searchParams.get('page')==='1'?[{id:1,name:'never_persist_in_progress'}]:[]);
  };
  store=createVosFacturesStore(storage.bucket,env,request,async()=>{});
  const result=await store.synchronize() as any;
  assert.equal(result.error,'provider_request_timeout');assert.equal(result.diagnostic.collection,'invoices');assert.equal(result.diagnostic.recordsRead,1);assert.equal(result.diagnostic.completedCollections,1);
  assert.equal((await store.state()).at,null);assert.deepEqual(await store.rows(),{clients:[],invoices:[],payments:[]});
  assert.ok(!JSON.stringify(await store.journal()).includes('never_persist_in_progress'));
 }finally{await storage.close();await rm(root,{recursive:true,force:true});}
});
test('financial calculations use cents and exclude ambiguous advance/final families and unproven receipts',()=>{
 assert.equal(cents('0.10')!+cents('0,20')!,30);assert.equal(cents('1.234,56'),null);assert.equal(cents('paid'),null);
 const rows={clients:[{id:1,external_id:'VDS-001'}],invoices:[{id:10,client_id:1,kind:'advance',income:'1',price_net:'300',price_gross:'363',currency:'EUR',paid:'363'},{id:11,client_id:1,kind:'final',income:'1',price_net:'1000',price_gross:'1210',currency:'EUR',paid:'363'}],payments:[{id:20,price:'363',currency:'EUR',paid:'1'}]};
 const result=accountingProjection(rows,[c],'private-test');assert.equal(result.totals.invoicedGross,null);assert.equal(result.totals.received,null);assert.equal(result.pendingAccounting,2);assert.equal(result.ledger.length,2);assert.equal(result.matchedDossiers.length,1);
});
test('private volume export restores every object to an empty volume and refuses an overwrite',async()=>{
 const a=await mkdtemp(join(tmpdir(),'vds-backup-a-')),b=await mkdtemp(join(tmpdir(),'vds-backup-b-'));const source=await openPrivateStorage(a),target=await openPrivateStorage(b);
 try{await source.bucket.put('archive','{"preserved":true}');await source.bucket.put('reviews','{"note":"Observation conservée"}');const backup=await source.exportArchive();assert.equal((await target.restoreArchive(backup)).restoredObjects,2);assert.equal(await(await target.bucket.get('reviews'))?.text(),'{"note":"Observation conservée"}');await assert.rejects(target.restoreArchive(backup),/empty_volume/);}finally{await source.close();await target.close();await rm(a,{recursive:true,force:true});await rm(b,{recursive:true,force:true});}
});
test('commercial exceptions are versioned and never change source records or create accounting entries',async()=>{
 const {createCommercialRules}=await import('../server/railway/rules.js');const root=await mkdtemp(join(tmpdir(),'vds-rules-')),storage=await openPrivateStorage(root);
 try{const rules=createCommercialRules(storage.bucket),initial=await rules.read('VDS-001');assert.equal(initial.rule.depositRate,0.3);await rules.save('VDS-001',{depositRate:0.2,finalInvoiceLeadDays:10,reason:'Condition contractuelle spéciale',revision:initial.revision});assert.equal((await rules.read('VDS-001')).rule.depositRate,0.2);await assert.rejects(rules.save('VDS-001',{depositRate:2,finalInvoiceLeadDays:10,reason:'Invalide',revision:(await rules.read('VDS-001')).revision}),/invalid/);await assert.rejects(rules.save('VDS-001',{depositRate:0.4,finalInvoiceLeadDays:10,reason:'Ancienne version',revision:initial.revision}),/changed/);const checkpoint=await storage.createCheckpoint();assert.equal(checkpoint.created,true);assert.ok(checkpoint.objects>=3);}finally{await storage.close();await rm(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createVosFacturesStore,type AccountingState} from '../server/railway/vosfactures.js';
import type {PrivateR2Bucket} from '../worker/index.js';

const config={VDS_INVOICING_PROVIDER:'vosfactures',VDS_VOSFACTURES_ACCOUNT:'test-account',VDS_VOSFACTURES_API_TOKEN:'test_only_not_a_real_token',VDS_VOSFACTURES_ENABLED:'true'};
function fixture(count:number,corrupt=false){
 const objects=new Map<string,string>();const snapshot:AccountingState={schemaVersion:'vosfactures-1',at:'2026-10-20T00:00:00Z',lastAttemptAt:null,lastFullAt:null,error:null,collections:{clients:{},invoices:{},payments:{}},history:[],missing:{invoices:['7']}};
 for(let i=0;i<count;i++){const body=JSON.stringify({id:i,number:String(i)}),digest=createHash('sha256').update(body).digest('hex');snapshot.collections.invoices[String(i)]=digest;objects.set('vds/private/vosfactures/versions/'+digest+'.json',corrupt&&i===7?'{}':body);}
 let active=0,max=0,indexReads=0;
 const bucket:PrivateR2Bucket={async get(key){if(key.endsWith('/index.json')){indexReads++;throw Error('snapshot must be pinned');}active++;max=Math.max(max,active);try{await new Promise(r=>setTimeout(r,key.charCodeAt(key.length-8)%3));const body=objects.get(key);return body===undefined?null:{size:body.length,etag:'test',text:async()=>body};}finally{active--;}} ,async put(){throw Error('read only');}};
 return {snapshot,bucket,stats:()=>({active,max,indexReads})};
}
test('accounting version reads overlap within a fixed bound and preserve a pinned snapshot and order',async()=>{
 const f=fixture(120),store=createVosFacturesStore(f.bucket,config);const rows=await store.rows(f.snapshot);
 assert.deepEqual(rows.invoices.map(r=>r.id),Array.from({length:120},(_,i)=>i));assert.equal(rows.invoices[7]._missingFromLatestFull,true);assert.deepEqual(rows.payments,[]);
 assert.ok(f.stats().max>1);assert.ok(f.stats().max<=16);assert.equal(f.stats().active,0);assert.equal(f.stats().indexReads,0);
});
test('one corrupt accounting version rejects the whole read after in-flight readers finish',async()=>{
 const f=fixture(120,true),store=createVosFacturesStore(f.bucket,config);await assert.rejects(store.rows(f.snapshot),/accounting_version_invalid/);assert.equal(f.stats().active,0);assert.ok(f.stats().max<=16);
});

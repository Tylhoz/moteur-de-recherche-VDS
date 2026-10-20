import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {gzipSync,brotliCompressSync} from 'node:zlib';
import {createSheets360Store,buildSheetIndex,dossier360,type SheetsCapture} from '../server/railway/sheets360.js';
import {openPrivateStorage} from '../server/railway/storage.js';
import type {Snapshot} from '../src/types.js';
const client={id:'VDS-001',client:'Test source',contact:'test@example.test',address:'',modelTeam:'',techMacon:'',finance:'',statusAction:'',category:'non_verifie' as const,contractHT:null,soldeAmount:null};
const baseline={clients:[client]} as Snapshot;
function envFor(capture:SheetsCapture){const raw=JSON.stringify(capture),packed=gzipSync(raw).toString('base64');return {VDS_SHEETS_BOOTSTRAP_CHUNKS:'1',VDS_SHEETS_BOOTSTRAP_0:packed,VDS_SHEETS_BOOTSTRAP_SHA256:createHash('sha256').update(raw).digest('hex'),VDS_SHEETS_PUSH_SECRET:'s'.repeat(48)};}
function capture():SheetsCapture{return {schemaVersion:'sheets-tables-1',readAt:new Date(Date.now()-10000).toISOString(),tables:[{key:'complete',id:'spreadsheet_test_123',gid:1,tab:'Base_Centrale_360',values:[['N° Dossier','Client'],['VDS-001','Test source']]}]};}
function signed(body:unknown,secret='s'.repeat(48)){const raw=JSON.stringify(body),time=String(Date.now());return new Request('https://portal.invalid/api/sheets-sync',{method:'POST',headers:{'Content-Type':'application/json','X-VDS-Timestamp':time,'X-VDS-Signature':createHmac('sha256',secret).update(time+'.'+raw).digest('hex')},body:raw});}
test('sheets360: rejects unsigned updates, unknown sources and missing dossier IDs; retains previous version',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sheets360-'));const storage=await openPrivateStorage(root);
 try{const initial=capture(),store=createSheets360Store(storage.bucket,envFor(initial));await store.bootstrap();
 assert.equal((await store.receive(signed(initial,'x'.repeat(48)))).status,401);
 const unknown=structuredClone(initial);unknown.tables[0].id='unknown_spreadsheet';unknown.readAt=new Date().toISOString();assert.equal((await store.receive(signed(unknown))).status,409);
 const deleted=structuredClone(initial);deleted.tables[0].values.pop();deleted.readAt=new Date().toISOString();assert.equal((await store.receive(signed(deleted))).status,409);
 assert.equal((await store.state()).captures[0].tables[0].values.length,2);
 const updated=structuredClone(initial);updated.readAt=new Date().toISOString();updated.tables[0].values[1][1]='Source changed';const reply=await store.receive(signed(updated));assert.equal(reply.status,200);
 const data=await reply.json();const receipt=await store.receive(signed({schemaVersion:'sheets-heartbeat-1',versions:[{id:initial.tables[0].id,digest:data.versions[initial.tables[0].id]}]}));assert.equal(receipt.status,200);
 const compressed=envFor(initial);compressed.VDS_SHEETS_BOOTSTRAP_0=brotliCompressSync(JSON.stringify(initial)).toString('base64');
 const reopened=createSheets360Store(storage.bucket,{...compressed,VDS_SHEETS_BOOTSTRAP_ENCODING:'brotli'});await reopened.bootstrap();assert.equal((await reopened.state()).captures[0].tables[0].values[1][1],'Source changed');
 }finally{await storage.close();await rm(root,{recursive:true,force:true});}
});
test('sheets360: all dossiers get the same sections; mismatches remain visible; name-only matches stay unassigned',()=>{
 const c=capture();c.tables[0].values[1][1]='Changed name';c.tables.push({key:'sales',id:'sales_spreadsheet_1',tab:'Ventes_Verifiees_365J',gid:3,values:[['Client','Montant_HT'],['Test source','100']]});
 const index=buildSheetIndex([c],baseline);assert.equal(index.unmatched.length,1);assert.equal(index.clients[0].client,'Test source');
 const r=dossier360(client,index.rows.get(client.id)!,undefined,'revision',c.readAt,false);assert.equal(r.data.sections.length,11);assert.equal(r.data.contradictions.length,1);assert.equal(r.data.counts.humanValidated,0);
});
test('sheets360: real complete workbook covers all dossiers without turning financial labels into receipts',{skip:!process.env.VDS_SHEETS_CAPTURE},async()=>{
 const capture=JSON.parse(await readFile(process.env.VDS_SHEETS_CAPTURE!,'utf8')) as SheetsCapture;
 const original=JSON.parse(await readFile(process.env.VDS_RAILWAY_BUNDLE_PATH!,'utf8'));
 const index=buildSheetIndex([capture],original.snapshot);assert.equal(index.clients.length,510);
 for(const c of index.clients){const r=dossier360(c,index.rows.get(c.id)??[],original.pilots.find((p:any)=>p.data.id===c.id),'test',capture.readAt,false);
 assert.equal(r.data.sections.filter(s=>s.fields.length>0).length,11);assert.equal(c.contractHT,null);assert.equal(c.soldeAmount,null);assert.equal(r.data.counts.humanValidated,0);}
 assert.ok(index.modules.sav.length>100);assert.ok(index.unmatched.length>0);
 const root=await mkdtemp(join(tmpdir(),'sheets360-real-'));const storage=await openPrivateStorage(root);
 try{const raw=JSON.stringify(capture),packed=gzipSync(raw).toString('base64');const env:NodeJS.ProcessEnv={VDS_SHEETS_BOOTSTRAP_CHUNKS:String(Math.ceil(packed.length/12000)),VDS_SHEETS_BOOTSTRAP_SHA256:createHash('sha256').update(raw).digest('hex')};
 for(let i=0;i<Number(env.VDS_SHEETS_BOOTSTRAP_CHUNKS);i++)env['VDS_SHEETS_BOOTSTRAP_'+i]=packed.slice(i*12000,(i+1)*12000);
 const store=createSheets360Store(storage.bucket,env);const receipt=await store.bootstrap();assert.equal(receipt?.workbooks,6);assert.equal((await store.state()).captures.flatMap(c=>c.tables).length,41);
 console.log(JSON.stringify({dossiers:index.clients.length,sourceRows:capture.tables.reduce((n,t)=>n+t.values.length-1,0),unassigned:index.unmatched.length,duplicates:index.duplicates,modules:Object.fromEntries(Object.entries(index.modules).map(([k,v])=>[k,v.length]))}));
 }finally{await storage.close();await rm(root,{recursive:true,force:true});}
});

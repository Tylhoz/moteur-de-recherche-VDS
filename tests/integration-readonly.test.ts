import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { validateDataset, DataError, rowsFromValues, safeLink, type Dataset, type Row } from '../server/model.js';
import { GoogleSheetsProvider, PrivateFileProvider, UnconfiguredProvider, validateManifest, type Provider } from '../server/providers.js';
import { ReadonlyStore } from '../server/sync.js';
import { createApi } from '../server/api.js';
import { annotatedRow, financeView, timelineView } from '../server/views.js';

// Structural fixtures only: no customer names, contact details or demonstration UI data.
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const time='2026-10-19T00:00:00Z';
function raw(){return {schemaVersion:'1',tables:{
  CLIENTS:[{client_id:id(1),nature:'personne',etat_identite:'a_verifier',version_enregistrement:1}],
  DOSSIERS:[{dossier_id:id(2),client_id:id(1),statut_commercial:'inconnu',statut_chantier:'inconnu',statut_financier:'a_verifier',statut_sav:'inconnu',version_enregistrement:1}],
  SOURCES:[] as Row[], RELATIONS_SOURCE:[] as Row[], PAIEMENTS:[] as Row[], COMMUNICATIONS:[] as Row[], AGENDA:[] as Row[],
}};}
function source(overrides:Row={}):Row{return {source_id:id(3),type_source:'comptabilite',usage_source:'production',compte_source:'structural-test',objet_externe_id:'structural-transaction',champ_observe:'montant_centimes',valeur_type:'montant',valeur_normalisee:'1',devise:'EUR',collecte_at:time,etat_fiabilite:'confirmee',verification_at:time,verification_par:'test-runner',empreinte_sha256:'a'.repeat(64),cle_dedoublonnage:'structural-source',...overrides};}
function payment(overrides:Row={}):Row{return {paiement_id:id(4),dossier_id:id(2),systeme_financier:'structural-test',transaction_externe_id:'structural-transaction',montant_centimes:1,devise:'EUR',sens:'encaissement',comptabilise_at:time,statut_preuve:'verifie_comptable',preuve_source_id:id(3),verifie_at:time,verifie_par:'test-runner',...overrides};}
function attachTransactionProofs(r:ReturnType<typeof raw>){
  for(const [index,field] of ['sens','comptabilise_at','dossier_id'].entries()){
    const sid=id(20+index);const p=r.tables.PAIEMENTS[0];
    r.tables.SOURCES.push(source({...r.tables.SOURCES[0],source_id:sid,champ_observe:field,valeur_type:'texte',valeur_normalisee:String(p[field]),cle_dedoublonnage:field}));
    r.tables.RELATIONS_SOURCE.push({relation_source_id:id(30+index),source_id:sid,cible_table:'PAIEMENTS',cible_id:p.paiement_id,champ:field,role:'etaye',cree_at:time});
  }
}
const constant=(data:Dataset):Provider=>({kind:'private_file',async read(){return data;}});

test('schema preserves missing values and rejects ambiguous money, invalid dates, duplicates, dangling evidence and AI confirmation',()=>{
  const data=validateDataset(raw());assert.equal(data.tables.DOSSIERS[0].libelle,null);
  for(const value of ['1337.05','1,00',true,Number.MAX_SAFE_INTEGER+1]){const r=raw();r.tables.PAIEMENTS=[payment({montant_centimes:value})];r.tables.SOURCES=[source()];assert.throws(()=>validateDataset(r),DataError);}
  const badDate=raw();badDate.tables.SOURCES=[source({collecte_at:'2026-02-30T00:00:00Z'})];assert.throws(()=>validateDataset(badDate),/invalid_datetime/);
  const duplicate=raw();duplicate.tables.DOSSIERS.push(duplicate.tables.DOSSIERS[0]);assert.throws(()=>validateDataset(duplicate),/duplicate_identifier/);
  const badSource=raw();badSource.tables.SOURCES=[source({type_source:'inference_ia'})];assert.throws(()=>validateDataset(badSource),/unsubstantiated_confirmation/);
  const broken=raw();broken.tables.PAIEMENTS=[payment()];assert.throws(()=>validateDataset(broken),/broken_reference/);
  assert.throws(()=>rowsFromValues('DOSSIERS',[['dossier_id','dossier_id']]),/invalid_headers/);
});

test('document links reject credentials, signed URLs and unrelated hosts',()=>{
  assert.equal(safeLink('https://docs.google.com/document/d/resource/edit'),true);
  for(const url of ['http://docs.google.com/a','https://evil.invalid/a','https://user:pass@drive.google.com/a','https://drive.google.com/a?access_token=x','https://drive.google.com/a#signature=x','https://drive.google.com/a?api%5Fkey=x'])assert.equal(safeLink(url),false);
});

test('source discrepancy never silently confirms the canonical value',()=>{
  const r=raw();r.tables.SOURCES=[source({champ_observe:'version_enregistrement',valeur_normalisee:'2'})];
  r.tables.RELATIONS_SOURCE=[{relation_source_id:id(5),source_id:id(3),cible_table:'DOSSIERS',cible_id:id(2),champ:'version_enregistrement',role:'etaye',cree_at:time}];
  const d=validateDataset(r);const view=annotatedRow(d,'DOSSIERS',d.tables.DOSSIERS[0]);
  assert.equal(view.fields.version_enregistrement.status,'contradictoire');assert.equal(view.fields.libelle.label,'Information non retrouvée');
});

test('financial charts include only proven accounting transactions and never claim a verified balance',()=>{
  const r=raw();r.tables.SOURCES=[source()];r.tables.PAIEMENTS=[payment()];
  attachTransactionProofs(r);
  const data=validateDataset(r);const view=financeView(data);assert.equal(view.verifiedPaymentCount,1);assert.equal(view.series[0].receivedCents,1);assert.equal(view.verifiedBalance,null);assert.equal(view.contractTotal,null);
  for(const patch of [{type_source:'gmail'},{valeur_normalisee:'2'},{usage_source:'a_verifier',etat_fiabilite:'probable'},{objet_externe_id:'different-reference'}] as Row[]){
    const alternate=raw();alternate.tables.SOURCES=[source(patch)];alternate.tables.PAIEMENTS=[payment()];
    assert.equal(financeView(validateDataset(alternate)).verifiedPaymentCount,0);
  }
  assert.equal(financeView(data,undefined,false).series.length,0);
  const duplicate=raw();duplicate.tables.SOURCES=[source()];duplicate.tables.PAIEMENTS=[payment(),payment({paiement_id:id(7)})];assert.throws(()=>validateDataset(duplicate),/duplicate_transaction/);
});

test('financial proof must also establish direction, accounting date and dossier association',()=>{
  const incomplete=raw();incomplete.tables.SOURCES=[source()];incomplete.tables.PAIEMENTS=[payment()];
  assert.equal(financeView(validateDataset(incomplete)).verifiedPaymentCount,0);
  for(const change of [{sens:'remboursement'},{comptabilise_at:'2026-09-19T00:00:00Z'}] as Row[]){
    const r=raw();r.tables.SOURCES=[source()];r.tables.PAIEMENTS=[payment()];attachTransactionProofs(r);
    Object.assign(r.tables.PAIEMENTS[0],change);
    assert.equal(financeView(validateDataset(r)).verifiedPaymentCount,0);
  }
  const moved=raw();moved.tables.SOURCES=[source()];moved.tables.PAIEMENTS=[payment()];attachTransactionProofs(moved);
  moved.tables.DOSSIERS.push({...moved.tables.DOSSIERS[0],dossier_id:id(40)});moved.tables.PAIEMENTS[0].dossier_id=id(40);
  assert.equal(financeView(validateDataset(moved)).verifiedPaymentCount,0);
});

test('equal numeric amounts do not confirm a different currency or tax basis',()=>{
  const r:{schemaVersion:string;tables:Record<string,Row[]>}=raw();
  r.tables.VENTES=[{vente_id:id(40),dossier_id:id(2),statut:'confirmee',contrat_ht_centimes:1,devise:'EUR'}];
  r.tables.SOURCES=[source({type_source:'contrat_signe',champ_observe:'contrat_ht_centimes',devise:'USD',base_fiscale:'TTC'})];
  r.tables.RELATIONS_SOURCE=[{relation_source_id:id(41),source_id:id(3),cible_table:'VENTES',cible_id:id(40),champ:'contrat_ht_centimes',role:'etaye',cree_at:time}];
  let data=validateDataset(r);
  assert.equal(annotatedRow(data,'VENTES',data.tables.VENTES[0]).fields.contrat_ht_centimes.status,'contradictoire');
  r.tables.SOURCES[0].devise='EUR';r.tables.SOURCES[0].base_fiscale='HT';data=validateDataset(r);
  assert.equal(annotatedRow(data,'VENTES',data.tables.VENTES[0]).fields.contrat_ht_centimes.status,'confirmee');
});

test('secret or unprotected URLs in narrative fields are rejected rather than exposed',()=>{
  for(const link of ['https://drive.google.com/a?access_token=structural-secret','https://drive.google.com/a?sig=structural-secret','https://drive.google.com/a?api%255Fkey=structural-secret','https://external.invalid/private']){
    const r=raw();r.tables.SOURCES=[source({localisateur:`Pièce : ${link}`})];
    assert.throws(()=>validateDataset(r),/unsafe_embedded_link/);
  }
});

test('chronology orders actual instants across time zones',()=>{
  const r=raw();r.tables.SOURCES=[source({type_source:'gmail'})];
  const c:Row={communication_id:id(8),dossier_id:id(2),compte_source:'structural-test',thread_id:'thread',message_id:'message',survenu_at:'2026-10-19T10:00:00+02:00',categorie:'commercial',resume_factuel:'structural test',statut_rapprochement:'valide',source_id:id(3),statut_message:'recu',usage_source:'production',interlocuteur_type:'client'};
  r.tables.COMMUNICATIONS=[c,{...c,communication_id:id(9),message_id:'message-2',survenu_at:'2026-10-19T09:00:00Z'}];
  const timeline=timelineView(validateDataset(r),id(2));assert.equal(timeline[0].record.id,id(8));
});

test('timeline excludes drafts and tests and uses only explicit event links for deduplication',()=>{
  const r=raw();r.tables.SOURCES=[source({type_source:'gmail'})];
  const c:Row={communication_id:id(8),dossier_id:id(2),compte_source:'structural-test',thread_id:'thread',message_id:'message',survenu_at:time,categorie:'commercial',resume_factuel:'structural test',statut_rapprochement:'valide',source_id:id(3),statut_message:'recu',usage_source:'production',interlocuteur_type:'client'};
  r.tables.COMMUNICATIONS=[c,{...c,communication_id:id(9),statut_message:'brouillon'},{...c,communication_id:id(10),usage_source:'test'}];
  assert.equal(timelineView(validateDataset(r),id(2)).length,1);
  r.tables.AGENDA=[{agenda_id:id(11),dossier_id:id(2),calendrier_source_id:'calendar',evenement_externe_id:'event',journee_entiere:false,statut_source:'tentative',statut_metier:'envisagee',statut_rapprochement:'valide',debut_at:time}];
  r.tables.COMMUNICATIONS[0].agenda_id=id(11);
  const timeline=timelineView(validateDataset(r),id(2));assert.equal(timeline.length,1);assert.equal(timeline[0].relatedCommunications.length,1);assert.equal(timeline[0].record.fields.statut_metier.value,'envisagee');
});

test('synchronization is single-flight, idempotent and keeps stale data explicit after failure',async()=>{
  let calls=0;let clock=0;let fail=false;const data=validateDataset(raw());
  const provider:Provider={kind:'private_file',async read(){calls++;await new Promise(r=>setTimeout(r,10));if(fail)throw new Error('sensitive detail');return data;}};
  const store=new ReadonlyStore(provider,1000,()=>clock);await Promise.all([store.refresh(),store.refresh(),store.refresh()]);assert.equal(calls,1);
  const revision=store.status().revision;clock=1001;await store.refresh();assert.equal(store.status().revision,revision);assert.equal(store.status().changedRowVersions,0);
  fail=true;clock=2002;await store.refresh();assert.equal(store.status().state,'stale');assert.equal(store.status().error,'source_read_failed');assert.equal(store.current()?.tables.DOSSIERS.length,1);
});

test('immutable observations cannot be edited or removed by a later read',async()=>{
  let clock=0;const input=raw();input.tables.SOURCES=[source()];let current=validateDataset(input);
  const store=new ReadonlyStore({kind:'private_file',async read(){return current;}},1000,()=>clock);
  await store.refresh();const first=store.status().revision;
  input.tables.SOURCES[0].valeur_normalisee='2';current=validateDataset(input);clock=1001;await store.refresh();
  assert.equal(store.status().error,'immutable_observation_changed');assert.equal(store.status().revision,first);
  input.tables.SOURCES=[];current=validateDataset(input);clock=2002;await store.refresh();
  assert.equal(store.status().error,'immutable_history_removed');assert.equal(store.current()?.tables.SOURCES.length,1);
});

test('private file provider refuses public roots, symlink escape and permissive file modes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'vds-readonly-'));
  try{
    await mkdir(join(root,'private'));await mkdir(join(root,'public'));const file=join(root,'private','data.json');
    await writeFile(file,JSON.stringify(raw()),{mode:0o600});const provider=new PrivateFileProvider(file,join(root,'private'),[join(root,'public')]);assert.equal((await provider.read()).tables.DOSSIERS.length,1);
    await chmod(file,0o644);await assert.rejects(()=>provider.read(),/permissions/);await chmod(file,0o600);
    const publicFile=join(root,'public','data.json');await writeFile(publicFile,JSON.stringify(raw()),{mode:0o600});await assert.rejects(()=>new PrivateFileProvider(publicFile,root,[join(root,'public')]).read(),/public_data/);
    await symlink(publicFile,join(root,'private','link.json'));await assert.rejects(()=>new PrivateFileProvider(join(root,'private','link.json'),join(root,'private'),[]).read(),/outside_root/);
  }finally{await rm(root,{recursive:true,force:true});}
});

const manifest={schemaVersion:'1',ranges:[
  {table:'CLIENTS',spreadsheetId:'a'.repeat(30),range:"'CLIENTS'!A1:Z20"},
  {table:'DOSSIERS',spreadsheetId:'a'.repeat(30),range:"'DOSSIERS'!A1:Z20"},
  {table:'SOURCES',spreadsheetId:'a'.repeat(30),range:"'SOURCES'!A1:AZ20"},
  {table:'RELATIONS_SOURCE',spreadsheetId:'a'.repeat(30),range:"'RELATIONS_SOURCE'!A1:Z20"},
]};
test('Sheets provider uses only the strict manifest, GET, bounded reads and no redirects',async()=>{
  assert.throws(()=>validateManifest({...manifest,ranges:[...manifest.ranges,{...manifest.ranges[0],range:"'CLIENTS'!A:Z"}]}),/invalid_manifest/);
  const data=validateDataset(raw());const requests:string[]=[];
  const mock:typeof fetch=async(input,init)=>{
    const u=new URL(String(input));requests.push(u.href);assert.equal(u.origin,'https://sheets.googleapis.com');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    return new Response(JSON.stringify({spreadsheetId:'a'.repeat(30),valueRanges:manifest.ranges.map(entry=>{
      const rows=data.tables[entry.table];const header=rows.length?Object.keys(rows[0]):entry.table==='SOURCES'?['source_id','type_source','usage_source','compte_source','objet_externe_id','champ_observe','valeur_type','collecte_at','etat_fiabilite','empreinte_sha256','cle_dedoublonnage']:['relation_source_id','source_id','cible_table','cible_id','role','cree_at'];
      return {range:entry.range,values:[header,...rows.map(row=>header.map(h=>row[h]))]};
    })}),{status:200});
  };
  const provider=new GoogleSheetsProvider(manifest,async()=>'test-token',mock);assert.equal((await provider.read()).tables.DOSSIERS.length,1);assert.equal(requests.length,2);
  await assert.rejects(()=>new GoogleSheetsProvider(manifest,async()=>undefined,mock).read(),/credentials_missing/);
});

async function invoke(app:Server,path:string,headers:Record<string,string>={},method='GET'){
  const responseHeaders=new Map<string,string>();let status=200;let result='';
  const res={setHeader(name:string,value:string){responseHeaders.set(name.toLowerCase(),String(value));},writeHead(code:number,headers?:Record<string,string>){status=code;for(const [k,v] of Object.entries(headers??{}))responseHeaders.set(k.toLowerCase(),v);},end(value=''){result=value;}};
  const handler=app.listeners('request')[0] as (req:IncomingMessage,res:ServerResponse)=>Promise<void>;
  await handler({url:path,method,headers:Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]))} as IncomingMessage,res as unknown as ServerResponse);
  return {status,headers:responseHeaders,body:result?JSON.parse(result):null};
}

test('API rejects missing auth, writes, traversal, unknown queries and disallowed origins before reading data',async()=>{
  const token='x'.repeat(48);const hash=createHash('sha256').update(token).digest('hex');let reads=0;
  const provider:Provider={kind:'private_file',async read(){reads++;return validateDataset(raw());}};
  const app=createApi({store:new ReadonlyStore(provider),bearerSha256:hash});const auth={Authorization:`Bearer ${token}`};
  assert.equal((await invoke(app,'/api/v1/dossiers')).status,401);
  assert.equal((await invoke(app,'/api/v1/dossiers',auth,'POST')).status,405);
  assert.equal((await invoke(app,'/api/v1/dossiers',{...auth,Origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await invoke(app,'/api/v1/dossiers?limit=1000',auth)).status,400);
  assert.equal((await invoke(app,'/api/v1/dossiers?spreadsheetId=untrusted',auth)).status,400);
  assert.equal((await invoke(app,'/api/v1/../public/vds-snapshot.json',auth)).status,404);
  assert.equal((await invoke(app,'/api/v1/dossiers/%2e%2e',auth)).status,404);
  assert.equal(reads,0);
  const response=await invoke(app,'/api/v1/dossiers?page=1&limit=1',auth);assert.equal(response.status,200);assert.equal(response.body.data.total,1);assert.equal(response.body.data.items.length,1);assert.equal(response.headers.get('access-control-allow-origin'),undefined);
  const cached=await invoke(app,'/api/v1/dossiers?page=1&limit=1',{...auth,'If-None-Match':response.headers.get('etag')!});assert.equal(cached.status,304);assert.ok(cached.headers.get('x-vds-last-sync'));
  const empty=await invoke(app,'/api/v1/dossiers?page=2&limit=1',auth);assert.deepEqual(empty.body.data.items,[]);
  const unavailable=createApi({store:new ReadonlyStore(new UnconfiguredProvider())});assert.equal((await invoke(unavailable,'/api/v1/status')).status,503);
  const noData=createApi({store:new ReadonlyStore(new UnconfiguredProvider()),bearerSha256:hash});const missing=await invoke(noData,'/api/v1/dossiers',auth);assert.equal(missing.status,503);assert.equal(missing.body.error,'source_not_configured');
});

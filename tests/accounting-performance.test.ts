import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdentityMatcher,type ExternalIdentity,type Match} from '../server/railway/matching.js';
import {accountingProjection} from '../server/railway/intelligence.js';
import type {Client} from '../src/types.js';

const base:Client={id:'VDS-001',client:'Élodie Exemple',contact:'e@example.test +32470123456',address:'Rue Exemple 1',modelTeam:'',techMacon:'',finance:'',statusAction:'',category:'non_verifie',soldeAmount:null,contractHT:null};
/** The former exhaustive matcher is retained here as a regression oracle. */
function exhaustive(external:ExternalIdentity,clients:Client[]):Match{
 const norm=(v:string)=>v.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 const emails=(v:string)=>new Set(v.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)??[]);
 const phones=(v:string)=>new Set((v.match(/(?:\+|00)?\d[\d .()/\-]{7,}\d/g)??[]).map(x=>x.replace(/\D/g,'').replace(/^00/,'')).filter(x=>x.length>=9&&x.length<=15));
 const overlap=(a:Set<string>,b:Set<string>)=>[...a].some(x=>b.has(x));
 const candidates=clients.map(c=>{const reasons:string[]=[];let score=0;
  const explicit=!!external.externalId&&external.externalId===c.id,email=overlap(emails(external.email||''),emails(c.contact)),phone=overlap(phones(external.phone||''),phones(c.contact));
  const name=!!external.name&&norm(external.name)===norm(c.client),address=!!external.address&&norm(external.address)===norm(c.address);
  if(explicit){score+=100;reasons.push('Identifiant dossier explicite');}if(email){score+=45;reasons.push('E-mail concordant');}if(phone){score+=45;reasons.push('Téléphone concordant');}if(name){score+=15;reasons.push('Nom exact normalisé');}if(address){score+=15;reasons.push('Adresse exacte normalisée');}
  const blocked=(emails(external.email||'').size>0&&emails(c.contact).size>0&&!email)||(phones(external.phone||'').size>0&&phones(c.contact).size>0&&!phone);if(blocked)reasons.push('Coordonnée contradictoire : validation nécessaire');
  return {id:c.id,score,reasons,certain:!blocked&&(explicit||(email&&phone)||(email&&name)||(phone&&name))};
 }).filter(c=>c.score>0).sort((a,b)=>b.score-a.score);
 const first=candidates[0],certain=candidates.filter(c=>c.certain),unique=first&&candidates.filter(c=>c.score===first.score).length===1;
 const status:Match['status']=certain.length===1&&certain[0]===first?'certain':!first?'none':unique&&first.score>=30?'probable':'uncertain';
 return {externalId:external.id,status,dossierId:status==='certain'?first.id:null,score:first?.score??0,reasons:first?.reasons??[],candidates:candidates.slice(0,5).map(({id,score,reasons})=>({id,score,reasons}))};
}
test('indexed matching preserves exhaustive decisions, conflicts, score ties and candidate order',()=>{
 const clients=[base,{...base,id:'VDS-002',contact:'e@example.test +32470999999'}, {...base,id:'VDS-003',contact:'other@example.test',client:'Autre nom'}, {...base,id:'VDS-004',contact:'',client:'!!!',address:'---'},...Array.from({length:7},(_,i)=>({...base,id:'VDS-'+(100+i),contact:'duplicate@example.test',client:'Doublon'}))];
 const match=createIdentityMatcher(clients);
 for(const externalId of ['',base.id,'unknown'])for(const email of ['', 'E@EXAMPLE.TEST','other@example.test','duplicate@example.test','new@example.test'])for(const phone of ['','0032470123456','+32470999999'])for(const name of ['','Elodie Exemple','Doublon','???'])for(const address of ['','Rue Exemple 1','!!!']){
  const identity={id:'external',externalId,email,phone,name,address};assert.deepEqual(match(identity),exhaustive(identity,clients));
 }
});
test('a full-account projection indexes dossier coordinates once and retains every real record shape', {timeout:10000},t=>{
 let contactReads=0;
 const clients=Array.from({length:510},(_,i)=>({...base,id:'VDS-'+i,client:'Contact test '+i,get contact(){contactReads++;return `test${i}@example.test`;}}));
 const rows={clients:Array.from({length:9108},(_,i)=>({id:i+1,external_id:i<510?'VDS-'+i:'',email:`test${i}@example.test`,name:'Contact test '+i})),invoices:Array.from({length:20161},(_,i)=>({id:i+1,client_id:i%9108+1,kind:'vat',income:true,currency:'EUR',price_net:'100',price_gross:'121',paid:'0',issue_date:'2026-10-20'})),payments:[]};
 const started=performance.now(),result=accountingProjection(rows,clients,'private-test');
 assert.equal(result.matches.length,9108);assert.equal(result.ledger.length,20161);assert.equal(result.matchedDossiers.length,510);assert.equal(result.totals.invoicedGross,20161*12100);assert.equal(result.totals.received,null);assert.equal(contactReads,510*2,'Dossier coordinates are extracted twice per dossier, not for every external contact');
 t.diagnostic(`9108 contacts / 20161 documents / 510 dossiers: ${Math.round(performance.now()-started)} ms`);
});
test('payment reference indexing preserves uncertainty for missing or cross-dossier references',()=>{
 const clients=[base,{...base,id:'VDS-002'}];
 const invoice=(id:number,client_id:number)=>({id,client_id,kind:'vat',income:true,currency:'EUR',price_net:'100',price_gross:'121',paid:'0'});
 const payment=(id:number,ids:number[])=>({id,paid:true,income:true,currency:'EUR',price:'121',invoices:ids.map(id=>({id}))});
 const rows={clients:[{id:1,external_id:base.id},{id:2,external_id:'VDS-002'}],invoices:[invoice(10,1),invoice(11,2)],payments:[payment(1,[10]),payment(2,[10,99]),payment(3,[10,11])]};
 const result=accountingProjection(rows,clients,'private-test');assert.deepEqual(result.paymentEntries.map(p=>p.dossierId),[base.id,null,null]);
});

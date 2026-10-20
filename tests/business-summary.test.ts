import test from 'node:test';
import assert from 'node:assert/strict';
import {accountingProjection} from '../server/railway/intelligence.js';
import {buildBusinessDataset,businessQuery,summarizeBusiness,pageBusinessDocuments,pageBusinessDossiers} from '../server/railway/business-analytics.js';
import {validateBusinessSummary,validateBusinessPage,type BusinessSummary} from '../shared/business-analytics-contract.js';
import {safeAnalyticsSourceUrl} from '../shared/source-url.js';
import {readBusinessSummary,readBusinessDetails} from '../src/data/business-analytics-client.js';
import type {Client} from '../src/types.js';
const clients:Client[]=Array.from({length:510},(_,i)=>({id:'VDS-'+String(i+1).padStart(3,'0'),client:'Test dossier '+(i+1),contact:'',address:'',modelTeam:'',techMacon:'',finance:'',statusAction:'',category:'non_verifie',soldeAmount:null,contractHT:null}));
const source={clients:Array.from({length:54},(_,i)=>({id:i+1,external_id:clients[i].id})),invoices:Array.from({length:20161},(_,i)=>({id:i+1,client_id:i<20000?i%54+1:99999,kind:'vat',income:'1',currency:'EUR',price_net:'100.00',price_gross:'121.00',paid:i%2===0?'121.00':'0',issue_date:'2026-10-'+String(i%28+1).padStart(2,'0'),status:i%2===0?'paid':'sent',number:'TEST-'+(i+1)})),payments:[]};
const financial=accountingProjection(source,clients,'private-test');
const dataset=buildBusinessDataset(clients,new Map(),financial);
const meta:BusinessSummary['meta']={revision:'test-revision',accountingReadAt:'2026-10-20T00:00:00Z',sheetsReadAt:null,projectionPending:false,refreshing:false,error:null,paymentsEnabled:false,readOnly:true};
const query=businessQuery({scope:'account'});
const summary=summarizeBusiness(dataset,query,meta);
test('20161 accounting documents produce a bounded server summary with exact totals and no raw ledger',()=>{
 assert.equal(validateBusinessSummary(summary),summary);assert.equal(summary.totals.documents,20161);assert.equal(summary.totals.unmatched,161);assert.equal(summary.totals.matchedDossiers,54);assert.equal(summary.matchedDossiers.length,54);
 assert.equal(summary.kpis.find(k=>k.id==='net')?.value,20161*10000);assert.equal(summary.kpis.find(k=>k.id==='received')?.value,null);assert.equal(summary.charts.find(c=>c.id==='invoice_month')?.points[0].value,20161*10000);
 for(const key of ['ledger','payments','invoices','clients'])assert.equal(key in summary,false);
 assert.ok(Buffer.byteLength(JSON.stringify(summary))<64*1024,'Summary must stay small at the real deployment volume');
 assert.equal((summary.charts[1].points[0] as any).documentIds,undefined);
});
test('server-side pagination, search and chart drilldown agree without sending all documents',()=>{
 const a=pageBusinessDocuments(dataset,query,meta.revision),b=pageBusinessDocuments(dataset,businessQuery({scope:'account',page:2}),meta.revision);
 assert.equal(validateBusinessPage(a,'documents'),a);assert.equal(a.items.length,50);assert.equal(b.items.length,50);assert.equal(a.total,20161);assert.equal(new Set([...a.items,...b.items].map(d=>d.id)).size,100);
 const last=pageBusinessDocuments(dataset,businessQuery({scope:'account',page:404}),meta.revision);assert.equal(last.items.length,11);
 const searched=pageBusinessDocuments(dataset,businessQuery({scope:'account',search:'TEST-20161'}),meta.revision);assert.equal(searched.total,1);assert.equal(searched.items[0].id,'20161');
 const chart=summary.charts.find(c=>c.id==='invoice_status')!,point=chart.points.find(p=>p.id==='paid')!;
 assert.equal(pageBusinessDocuments(dataset,businessQuery({scope:'account',chart:chart.id,point:point.id}),meta.revision).total,point.documentCount);
 assert.equal(pageBusinessDocuments(dataset,businessQuery({scope:'account',from:'2026-10-03',to:'2026-10-03'}),meta.revision).items.every(d=>d.date==='2026-10-03'),true);
 assert.equal(pageBusinessDossiers(dataset,businessQuery({}),meta.revision).items.length,50);
});
test('unmatched documents are included only in explicit account scope and filters stay truthful',()=>{
 const selected=summarizeBusiness(dataset,businessQuery({}),meta);assert.equal(selected.totals.documents,20000);assert.equal(selected.totals.unmatched,0);
 assert.equal(summarizeBusiness(dataset,businessQuery({scope:'account',year:'2025'}),meta).kpis.find(k=>k.id==='net')?.value,null);
 assert.equal(summarizeBusiness(dataset,businessQuery({scope:'dossiers',model:'Absent'}),meta).totals.documents,0);
 assert.equal(summarizeBusiness(dataset,businessQuery({scope:'account',model:'Absent'}),meta).totals.documents,20161);
});
test('read-only query contract rejects invalid paging, unknown filters, malformed dates and reversed ranges',()=>{
 for(const q of [{pageSize:51},{page:0},{page:1.1},{page:'2'},{from:'2026-02-30'},{from:'2026-10-20',to:'2026-10-01'},{scope:'all'},{privateApiToken:'never_log'},{point:'x'},{chart:'unknown'},{search:'x'.repeat(121)},JSON.parse('{"__proto__":{}}')])assert.throws(()=>businessQuery(q),/Invalid analytics query/);
});
test('all parties share the source-link allowlist and reject credential-bearing or arbitrary links',()=>{
 assert.equal(safeAnalyticsSourceUrl('https://private-test.vosfactures.fr/invoices/123'),'https://private-test.vosfactures.fr/invoices/123');
 for(const url of ['http://private-test.vosfactures.fr/invoices/1','https://private-test.vosfactures.fr/invoices/1?api_token=never_log','https://private-test.vosfactures.fr.evil.test/invoices/1','https://user:secret@private-test.vosfactures.fr/invoices/1','https://example.test/invoices/1'])assert.equal(safeAnalyticsSourceUrl(url),null);
});
test('summary and page clients validate schemas and log only safe structural diagnostics',async()=>{
 const controller=new AbortController();let calls=0;
 const request:typeof fetch=async(input,init)=>{calls++;assert.equal(init?.method,'POST');assert.equal(init?.credentials,'same-origin');assert.ok(!String(input).includes('?'));return Response.json(String(input).endsWith('/documents')?pageBusinessDocuments(dataset,query,meta.revision):summary);};
 assert.equal((await readBusinessSummary(query,controller.signal,request)).totals.documents,20161);assert.equal((await readBusinessDetails('documents',query,controller.signal,request)).items.length,50);assert.equal(calls,2);
 const messages:unknown[]=[];const original=console.error;console.error=(...args:unknown[])=>{messages.push(args);};
 try{await assert.rejects(readBusinessSummary(query,controller.signal,async()=>Response.json({...summary,kpis:null,never_log_secret:'confidential@example.test'})),/pas exploitables \(kpis\)/);assert.ok(JSON.stringify(messages).includes('analytics_schema_invalid'));assert.ok(!JSON.stringify(messages).includes('confidential'));assert.ok(!JSON.stringify(messages).includes('never_log_secret'));}finally{console.error=original;}
 const corrupt={...summary,ledger:source.invoices};assert.throws(()=>validateBusinessSummary(corrupt),/raw_collections_forbidden/);
});

test('a real archived fiche enriched with an allowed VosFactures source passes the legacy validator', {skip:!process.env.VDS_RAILWAY_BUNDLE_PATH},async()=>{
 const {readFile}=await import('node:fs/promises'),{buildAnalytics}=await import('../server/analytics.js'),{appendFinancialDocuments}=await import('../server/railway/financial-fiche.js'),{validateAnalytics}=await import('../src/data/useAnalytics.js');
 const archive=JSON.parse(await readFile(process.env.VDS_RAILWAY_BUNDLE_PATH!,'utf8')),fiche=archive.pilots[0];
 const document={id:'1',dossierId:fiche.data.id,kind:'vat',number:'TEST-source-link',currency:'EUR',net:10000,gross:12100,paid:0,due:null,date:'2026-10-20',status:'sent',excludedReason:null,url:'https://private-test.vosfactures.fr/invoices/1'};
 const pilots=archive.pilots.map((p:any)=>p===fiche?appendFinancialDocuments(p,[document]):p);
 assert.doesNotThrow(()=>validateAnalytics(buildAnalytics(archive.snapshot,pilots)));
});

test('many distinct source categories are folded without dropping counts and remain drillable',()=>{
 const varied=buildBusinessDataset(clients,new Map(),financial);varied.profiles.forEach(p=>p.commercialStatus='Status '+p.id);
 const s=summarizeBusiness(varied,query,meta),pipeline=s.charts.find(c=>c.id==='pipeline')!;
 assert.equal(pipeline.points.length,32);assert.equal(pipeline.points.reduce((n,p)=>n+p.value,0),510);
 const other=pipeline.points.find(p=>p.id==='__aggregate_other__')!;assert.equal(other.value,479);const page=pageBusinessDossiers(varied,businessQuery({chart:'pipeline',point:other.id}),meta.revision);assert.equal(page.total,479);assert.equal(page.items.length,50);
});
test('long time series are aggregated on the server without losing amounts or document drilldowns',()=>{
 const entries=Array.from({length:240},(_,i)=>({...financial.ledger[0],id:String(i+1),date:String(2000+Math.floor(i/12))+'-'+String(i%12+1).padStart(2,'0')+'-01'}));
 const d=buildBusinessDataset(clients,new Map(),{...financial,ledger:entries}),s=summarizeBusiness(d,query,meta),series=s.charts.find(c=>c.id==='invoice_month')!;
 assert.equal(d.periodLength,4);assert.equal(series.points.length,20);assert.equal(series.points.reduce((n,p)=>n+p.value,0),240*10000);
 assert.equal(pageBusinessDocuments(d,businessQuery({scope:'account',chart:series.id,point:'2000'}),meta.revision).total,12);assert.equal(validateBusinessSummary(s),s);
});

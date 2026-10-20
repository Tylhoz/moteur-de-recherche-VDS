import type {Client} from '../../src/types.js';
import type {RowObservation} from './sheets360.js';
import type {LedgerEntry,ReturnTypeAccounting} from './intelligence.js';
import {safeAnalyticsSourceUrl} from '../../shared/source-url.js';
import {defaultBusinessQuery,type BusinessQuery,type BusinessSummary,type BusinessChart,type BusinessDocument,type BusinessPage,type BusinessDossierPage,type BusinessKpi} from '../../shared/business-analytics-contract.js';

export class BusinessQueryError extends Error {readonly code='analytics_query_invalid';constructor(readonly path:string){super('Invalid analytics query: '+path);}}
const day=(s:string)=>{const v=/^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10):/^\d{2}\/\d{2}\/\d{4}$/.test(s)?s.slice(6)+'-'+s.slice(3,5)+'-'+s.slice(0,2):null;if(!v)return null;const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v?v:null;};
const clip=(s:string,max=160)=>s.slice(0,max);
const normalized=(s:string)=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('fr');
const chartIds=new Set(['sale_month','invoice_month','invoice_pointage','offer_status','sale_model','invoice_status','invoice_due','pipeline','work_status','coverage']);
export function businessQuery(value:unknown):BusinessQuery{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new BusinessQueryError('root');
 const raw=value as Record<string,unknown>;for(const key of Object.keys(raw))if(!Object.hasOwn(defaultBusinessQuery,key))throw new BusinessQueryError('unknown_field');
 const q={...defaultBusinessQuery,...raw} as BusinessQuery;
 for(const key of ['year','from','to','model','status','financialStatus','search','chart','point'] as const)if(typeof q[key]!=='string'||q[key].length>(key==='search'?120:180))throw new BusinessQueryError(key);
 if(!['account','dossiers'].includes(q.scope))throw new BusinessQueryError('scope');
 if(q.year&&!/^\d{4}$/.test(q.year))throw new BusinessQueryError('year');
 for(const key of ['from','to'] as const)if(q[key]&&day(q[key])!==q[key])throw new BusinessQueryError(key);
 if(q.from&&q.to&&q.from>q.to)throw new BusinessQueryError('date_order');
 if(q.chart&&!chartIds.has(q.chart))throw new BusinessQueryError('chart');
 if(q.point&&!q.chart)throw new BusinessQueryError('point_without_chart');
 if(!Number.isSafeInteger(q.page)||q.page<1||q.page>1000000)throw new BusinessQueryError('page');
 if(!Number.isSafeInteger(q.pageSize)||q.pageSize<1||q.pageSize>50)throw new BusinessQueryError('pageSize');
 return q;
}
interface Profile {id:string;name:string;model:string;commercialStatus:string;financialStatus:string;dates:string[];offers:{id:string;status:string}[];sales:{id:string;date:string|null}[];works:{id:string;status:string;date:string|null}[];sav:{id:string;status:string}[];sourceRows:number;}
export interface BusinessDataset {documents:LedgerEntry[];profiles:Profile[];byId:Map<string,Profile>;financial:ReturnTypeAccounting;options:BusinessSummary['options'];periodLength:7|4|3|2;}
/** Build once for each immutable source revision. Documents stay in server memory only. */
export function buildBusinessDataset(clients:Client[],observations:Map<string,RowObservation[]>,financial:ReturnTypeAccounting):BusinessDataset{
 const accountingIds=new Set(financial.ledger.flatMap(l=>l.dossierId?[l.dossierId]:[]));
 const profiles=clients.map(c=>{const rows=(observations.get(c.id)??[]).filter(r=>!r.table.historicalAt),primary=rows.filter(r=>r.table.key==='complete');const tech=primary.find(r=>r.table.tab==='TECHNIQUE')?.values,commercial=primary.find(r=>r.table.tab==='DOSSIERS')?.values;
  const offers=primary.filter(r=>r.table.tab==='DEVIS'),sales=primary.filter(r=>r.table.tab==='VENTES'),work=primary.filter(r=>r.table.tab==='CHANTIERS'),sav=primary.filter(r=>r.table.tab==='SAV');
  return {id:c.id,name:clip(c.client,120),model:clip(tech?.Modele_Coque||'Modèle non renseigné'),commercialStatus:clip(commercial?.Statut_Global_Dates||'Statut non renseigné'),financialStatus:accountingIds.has(c.id)?'Documents VosFactures rattachés':'Aucun document comptable rattaché',dates:[...offers.map(r=>day(r.values.Date_Devis||'')),...sales.map(r=>day(r.values.Date_Vente||'')),...work.map(r=>day(r.values.Date_Pose_Retenue||''))].filter((v):v is string=>!!v),offers:offers.map(r=>({id:r.values.Ref_Devis||r.sourceId,status:clip(r.values.Statut_Devis||'Statut non renseigné')})),sales:sales.filter(r=>/^(?:confirm[eé]e?|accept[eé]e?|sign[eé]e?|valid[eé]e?)$/i.test(r.values.Statut_Verification||'')).map(r=>({id:r.values.ID_Vente||r.sourceId,date:day(r.values.Date_Vente||'')})),works:work.map(r=>({id:r.values.ID_Chantier||r.sourceId,status:clip(r.values.Statut_Chantier||'Statut non renseigné'),date:day(r.values.Date_Pose_Retenue||'')})),sav:sav.map(r=>({id:r.values.ID_SAV||r.sourceId,status:clip(r.values.Statut_Ticket||'Statut non renseigné')})),sourceRows:rows.length};
 });
 const unique=(v:string[])=>[...new Set(v)].sort((a,b)=>a.localeCompare(b,'fr'));
 const dates=[...financial.ledger.flatMap(l=>[l.date,l.due].filter((d):d is string=>!!d)),...profiles.flatMap(p=>p.dates)];const periodLength=([7,4,3,2] as const).find(length=>new Set(dates.map(d=>d.slice(0,length))).size<=120)??2;
 const collator=new Intl.Collator('en',{numeric:true});const documents=[...financial.ledger].sort((a,b)=>{const x=a.date||'',y=b.date||'';return x===y?collator.compare(a.id,b.id):x>y?-1:1;});
 return {documents,profiles,byId:new Map(profiles.map(p=>[p.id,p])),financial,periodLength,options:{years:unique([...financial.ledger.flatMap(l=>l.date?[l.date.slice(0,4)]:[]),...profiles.flatMap(p=>p.dates.map(d=>d.slice(0,4)))]).slice(-200),models:unique(profiles.map(p=>p.model)).slice(0,50),statuses:unique(profiles.map(p=>p.commercialStatus)).slice(0,50),financialStatuses:unique(profiles.map(p=>p.financialStatus)).slice(0,50)}};
}
const inPeriod=(d:string|null,q:BusinessQuery)=>!q.year&&!q.from&&!q.to||!!d&&(!q.year||d.startsWith(q.year))&&(!q.from||d>=q.from)&&(!q.to||d<=q.to);
const profileMatch=(p:Profile,q:BusinessQuery)=>!q.model||p.model===q.model;
function profileScope(d:BusinessDataset,q:BusinessQuery){return d.profiles.filter(p=>profileMatch(p,q)&&(!q.status||p.commercialStatus===q.status)&&(!q.financialStatus||p.financialStatus===q.financialStatus));}
const bucket=(d:BusinessDataset,date:string)=>date.slice(0,d.periodLength)+(d.periodLength===3?'0s':d.periodLength===2?'00s':'');
function selectedDocuments(d:BusinessDataset,q:BusinessQuery){const ids=new Set(profileScope(d,q).map(p=>p.id)),tokens=normalized(q.search).split(/\s+/).filter(Boolean);
 return d.documents.filter(l=>(q.scope==='account'||!!l.dossierId&&ids.has(l.dossierId))&&inPeriod(l.date,q)&&tokens.every(t=>normalized([l.number,l.status,l.id,l.dossierId||'',l.dossierId?d.byId.get(l.dossierId)?.name||'':''].join(' ')).includes(t)));
}
const statusBucket=(s:string)=>['issued','sent','paid','partial','draft','canceled','cancelled','overdue'].includes(s)?s:s?'other':'unknown';
const statusLabel=(s:string)=>({issued:'Émise',sent:'Envoyée',paid:'Déclarée payée',partial:'Partiellement pointée',draft:'Brouillon',canceled:'Annulée',cancelled:'Annulée',overdue:'Déclarée en retard',other:'Autres statuts',unknown:'Statut absent'}[s]||s);
function documentPoint(d:BusinessDataset,l:LedgerEntry,q:BusinessQuery){
 if(!q.chart||!q.point)return true;
 if(q.chart==='invoice_status')return statusBucket(l.status)===q.point;
 if(l.excludedReason)return false;
 if(q.chart==='invoice_month')return !!l.date&&bucket(d,l.date)===q.point&&l.net!==null;
 if(q.chart==='invoice_pointage'){const [type,period]=q.point.split(':');return !!l.date&&bucket(d,l.date)===period&&(type==='billed'?l.gross!==null:type==='declared'&&l.paid!==null);}
 if(q.chart==='invoice_due')return !!l.due&&bucket(d,l.due)===q.point&&l.paid!==null&&l.gross!==null&&l.gross>l.paid;
 return false;
}
interface Entry {id:string;label?:string;dossierId:string|null;documentId?:string;amount?:number;}
function chart(id:string,title:string,detail:BusinessChart['detail'],entries:Entry[],money=false,note=''):BusinessChart{
 const groups=new Map<string,{label:string;value:number;dossiers:Set<string>;documents:Set<string>}>();
 for(const e of entries){const p=groups.get(e.id)??{label:e.label??e.id,value:0,dossiers:new Set<string>(),documents:new Set<string>()};p.value+=e.amount??1;if(e.dossierId)p.dossiers.add(e.dossierId);if(e.documentId)p.documents.add(e.documentId);groups.set(e.id,p);}
 let selected=[...groups];
 if(detail==='dossiers'&&selected.length>32){const ordered=selected.sort((a,b)=>b[1].value-a[1].value||a[0].localeCompare(b[0],'fr')),tail=ordered.slice(31),rest={label:'Autres catégories · '+tail.length,value:0,dossiers:new Set<string>(),documents:new Set<string>()};for(const [,p] of tail){rest.value+=p.value;for(const id of p.dossiers)rest.dossiers.add(id);for(const id of p.documents)rest.documents.add(id);}selected=[...ordered.slice(0,31),['__aggregate_other__',rest]];}
 return {id,title,detail,money,note,points:selected.map(([id,p])=>({id,label:p.label,value:p.value,dossierCount:p.dossiers.size,documentCount:p.documents.size})).sort((a,b)=>a.id.localeCompare(b.id,'fr'))};
}
function dossierEntries(d:BusinessDataset,selected:Profile[],q:BusinessQuery):Record<string,Entry[]>{return {
 sale_month:selected.flatMap(p=>p.sales.filter(s=>s.date&&inPeriod(s.date,q)).map(s=>({id:bucket(d,s.date!),dossierId:p.id}))),
 offer_status:selected.flatMap(p=>p.offers.map(o=>({id:o.status,dossierId:p.id}))),
 sale_model:selected.filter(p=>p.sales.length>0).map(p=>({id:p.model,dossierId:p.id})),
 pipeline:selected.map(p=>({id:p.commercialStatus,dossierId:p.id})),
 work_status:selected.flatMap(p=>p.works.map(w=>({id:w.status,dossierId:p.id}))),
 coverage:selected.map(p=>({id:p.sourceRows?'present':'absent',label:p.sourceRows?'Avec observations Sheets':'Sans observation rattachée',dossierId:p.id}))};}
function total(rows:LedgerEntry[],value:(r:LedgerEntry)=>number|null){if(!rows.length)return null;let sum=0;for(const r of rows){const n=value(r);if(n===null||!Number.isSafeInteger(n)||!Number.isSafeInteger(sum+n))return null;sum+=n;}return sum;}
export function summarizeBusiness(d:BusinessDataset,q:BusinessQuery,meta:BusinessSummary['meta']):BusinessSummary{
 const selected=profileScope(d,q).filter(p=>!q.year&&!q.from&&!q.to||p.dates.some(date=>inPeriod(date,q))),ledger=selectedDocuments(d,q),eligible=ledger.filter(l=>!l.excludedReason),allOffers=selected.flatMap(p=>p.offers.map(o=>({...o,dossierId:p.id}))),offerIds=new Set(allOffers.map(o=>o.id)),accepted=allOffers.filter(o=>/^(?:sign[eé]|accept[eé]|valid[eé])e?$/i.test(o.status));
 const conversion=offerIds.size&&allOffers.every(o=>/^(?:sign[eé]|accept[eé]|valid[eé]|refus[eé]|annul[eé]|envoy[eé]|en attente)e?$/i.test(o.status))?accepted.length/offerIds.size*100:null;
 const outstanding=eligible.some(l=>l.kind==='correction')?null:total(eligible,l=>l.paid===null||l.gross===null?null:Math.max(0,l.gross-l.paid));
 const overdue=eligible.length&&!eligible.some(l=>l.kind==='correction')&&eligible.every(l=>l.paid!==null&&l.gross!==null)?eligible.filter(l=>l.due&&l.due<new Date().toISOString().slice(0,10)&&l.gross!>l.paid!).length:null;
 const kpi=(id:string,label:string,value:number|null,unit:BusinessKpi['unit']='count',note=''):BusinessKpi=>({id,label,value,unit,note});
 const kpis=[kpi('dossiers','Dossiers sélectionnés',selected.length),kpi('offers','Références de devis dans Sheets',offerIds.size),kpi('sales','Commandes déclarées acceptées',new Set(selected.flatMap(p=>p.sales.map(s=>s.id))).size),kpi('conversion','Conversion des devis',conversion,'percent','Statuts déclarés ; signatures à contrôler.'),kpi('net','Facturation HTVA · périmètre choisi',total(eligible,l=>l.net),'money','Pièces éligibles après exclusions ; distinct des contrats.'),kpi('gross','Facturation TVAC · périmètre choisi',total(eligible,l=>l.gross),'money','Périmètre partiel après exclusions.'),kpi('outstanding','Solde déclaré sur les factures',outstanding,'money','Pointages déclarés sur les factures, sans preuve bancaire.'),kpi('overdue','Factures déclarées en retard',overdue),kpi('received','Encaissements bancaires confirmés',meta.paymentsEnabled?d.financial.totals.received:null,'money',meta.paymentsEnabled?'Transactions entrantes vérifiées dans la source · hors filtres.':'Module Paiements non utilisé ; encaissements non suivis.'),kpi('works','Dates chantier renseignées',selected.filter(p=>p.works.some(w=>w.date)).length),kpi('sav','Tickets SAV référencés',new Set(selected.flatMap(p=>p.sav.map(s=>s.id))).size),kpi('accepted','Devis explicitement acceptés',accepted.length)];
 const entries=dossierEntries(d,selected,q);
 const charts=[
 chart('sale_month','Évolution des commandes déclarées acceptées','dossiers',entries.sale_month),
 chart('invoice_month','Facturation HTVA éligible','documents',eligible.filter(l=>l.date&&l.net!==null).map(l=>({id:bucket(d,l.date!),dossierId:l.dossierId,documentId:l.id,amount:l.net!})),true,'Acomptes/finales ambigus exclus. Montants des pièces éligibles uniquement.'),
 chart('invoice_pointage','Facturation et pointage des factures','documents',eligible.filter(l=>l.date).flatMap(l=>[...(l.gross===null?[]:[{id:'billed:'+bucket(d,l.date!),label:bucket(d,l.date!)+' · Facturé TTC',dossierId:l.dossierId,documentId:l.id,amount:l.gross}]),...(l.paid===null?[]:[{id:'declared:'+bucket(d,l.date!),label:bucket(d,l.date!)+' · Déclaré payé',dossierId:l.dossierId,documentId:l.id,amount:l.paid}])]),true,'Regroupement selon la date de facturation. Les pointages ne sont pas des encaissements bancaires.'),
 chart('offer_status','Statuts des devis','dossiers',entries.offer_status),
 chart('sale_model','Modèles des commandes acceptées','dossiers',entries.sale_model),
 chart('invoice_status','État des documents comptables','documents',ledger.map(l=>({id:statusBucket(l.status),label:statusLabel(statusBucket(l.status)),dossierId:l.dossierId,documentId:l.id}))),
 chart('invoice_due','Échéances déclarées restant dues','documents',eligible.filter(l=>l.due&&l.paid!==null&&l.gross!==null&&l.gross>l.paid).map(l=>({id:bucket(d,l.due!),dossierId:l.dossierId,documentId:l.id,amount:l.gross!-l.paid!})),true,'Échéancier des pièces éligibles ; sans promesse d’encaissement.'),
 chart('pipeline','Pipeline commercial déclaré dans Sheets','dossiers',entries.pipeline),
 chart('work_status','Statuts des chantiers déclarés','dossiers',entries.work_status),
 chart('coverage','Couverture des dossiers par les sources','dossiers',entries.coverage)];
 const matched=d.financial.matchedDossiers.filter(id=>d.byId.has(id));
 return {schemaVersion:'business-analytics-2',meta,scope:q.scope,totals:{dossiers:d.profiles.length,matchedDossiers:matched.length,documents:ledger.length,eligible:eligible.length,excluded:ledger.length-eligible.length,unmatched:ledger.filter(l=>!l.dossierId).length},options:d.options,kpis,charts,matchedDossiers:matched.slice(0,100).map(id=>({id,name:d.byId.get(id)!.name})),sourceBasis:'Synthèses calculées côté serveur depuis les observations Sheets et les pièces VosFactures. Les documents bruts ne sont pas transmis avec les graphiques.',limitations:[...d.financial.limits,'Les filtres dates portent sur l’émission des factures ; les graphiques commerciaux utilisent leurs propres dates sources.','Le périmètre compte inclut les pièces sans rattachement certain ; les filtres modèle et statuts portent alors uniquement sur les graphiques commerciaux.','Les répartitions de plus de 32 catégories regroupent les catégories restantes ; leur détail reste accessible.',...(d.periodLength<7?['Les séries longues sont regroupées par année, décennie ou siècle pour limiter le volume ; les filtres conservent leurs dates exactes.']:[]),...(Object.values(d.options).some(v=>v.length===50)?['Les sélecteurs affichent au maximum 50 valeurs distinctes.']:[])]};
}
export function pageBusinessDocuments(d:BusinessDataset,q:BusinessQuery,revision:string):BusinessPage{
 const rows=selectedDocuments(d,q).filter(l=>documentPoint(d,l,q));
 const items=rows.slice((q.page-1)*q.pageSize,q.page*q.pageSize).map((l):BusinessDocument=>({id:l.id,dossierId:l.dossierId,dossierName:l.dossierId?d.byId.get(l.dossierId)?.name??null:null,number:clip(l.number),kind:clip(l.kind),status:clip(l.status),date:l.date,due:l.due,net:l.net,gross:l.gross,paid:l.paid,excludedReason:l.excludedReason,url:safeAnalyticsSourceUrl(l.url)}));
 return {schemaVersion:'business-documents-1',revision,page:q.page,pageSize:q.pageSize,total:rows.length,items};
}
export function pageBusinessDossiers(d:BusinessDataset,q:BusinessQuery,revision:string):BusinessDossierPage{
 const tokens=normalized(q.search).split(/\s+/).filter(Boolean);
 const scoped=profileScope(d,q).filter(p=>!q.year&&!q.from&&!q.to||p.dates.some(date=>inPeriod(date,q)));
 let selectedIds:Set<string>|null=null;
 if(q.chart&&q.point){const entries=dossierEntries(d,scoped,q)[q.chart]??[],visible=chart(q.chart,'','dossiers',entries).points,retained=new Set(visible.filter(p=>p.id!=='__aggregate_other__').map(p=>p.id));selectedIds=new Set(entries.filter(e=>q.point==='__aggregate_other__'?!retained.has(e.id):e.id===q.point).flatMap(e=>e.dossierId?[e.dossierId]:[]));}
 const rows=scoped.filter(p=>(!selectedIds||selectedIds.has(p.id))&&tokens.every(t=>normalized(p.id+' '+p.name).includes(t))).sort((a,b)=>a.id.localeCompare(b.id,'en',{numeric:true}));
 return {schemaVersion:'business-dossiers-1',revision,page:q.page,pageSize:q.pageSize,total:rows.length,items:rows.slice((q.page-1)*q.pageSize,q.page*q.pageSize).map(p=>({id:p.id,name:p.name,model:p.model,commercialStatus:p.commercialStatus,sourceRows:p.sourceRows}))};
}

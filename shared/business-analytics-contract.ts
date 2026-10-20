/** Aggregate-only analytics. No raw accounting collections belong in this response. */
export type BusinessScope='dossiers'|'account';
export interface BusinessQuery {scope:BusinessScope;year:string;from:string;to:string;model:string;status:string;financialStatus:string;search:string;chart:string;point:string;page:number;pageSize:number;}
export const defaultBusinessQuery:BusinessQuery={scope:'dossiers',year:'',from:'',to:'',model:'',status:'',financialStatus:'',search:'',chart:'',point:'',page:1,pageSize:50};
export interface BusinessPoint {id:string;label:string;value:number;dossierCount:number;documentCount:number;}
export interface BusinessChart {id:string;title:string;money:boolean;detail:'documents'|'dossiers';note:string;points:BusinessPoint[];}
export interface BusinessKpi {id:string;label:string;value:number|null;unit:'count'|'money'|'percent';note:string;}
export interface BusinessSummary {
 schemaVersion:'business-analytics-2';
 meta:{revision:string;accountingReadAt:string|null;sheetsReadAt:string|null;projectionPending:boolean;refreshing:boolean;error:string|null;paymentsEnabled:boolean;readOnly:true};
 scope:BusinessScope;totals:{dossiers:number;matchedDossiers:number;documents:number;eligible:number;excluded:number;unmatched:number};
 options:{years:string[];models:string[];statuses:string[];financialStatuses:string[]};
 kpis:BusinessKpi[];charts:BusinessChart[];matchedDossiers:{id:string;name:string}[];
 sourceBasis:string;limitations:string[];
}
export interface BusinessDocument {id:string;dossierId:string|null;dossierName:string|null;number:string;kind:string;status:string;date:string|null;due:string|null;net:number|null;gross:number|null;paid:number|null;excludedReason:string|null;url:string|null;}
export interface BusinessPage {schemaVersion:'business-documents-1';revision:string;page:number;pageSize:number;total:number;items:BusinessDocument[];}
export interface BusinessDossierPage {schemaVersion:'business-dossiers-1';revision:string;page:number;pageSize:number;total:number;items:{id:string;name:string;model:string;commercialStatus:string;sourceRows:number}[];}
export class BusinessSchemaError extends Error {readonly code='analytics_schema_invalid';constructor(readonly path:string){super('Analytics schema invalid: '+path);}}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const money=(v:unknown)=>v===null||typeof v==='number'&&Number.isSafeInteger(v);
const text=(v:unknown)=>typeof v==='string';
const date=(v:unknown)=>v===null||typeof v==='string'&&Number.isFinite(Date.parse(v));
export function validateBusinessSummary(v:unknown):BusinessSummary{
 const require=(ok:unknown,path:string)=>{if(!ok)throw new BusinessSchemaError(path);};
 require(object(v),'root');const x=v as Record<string,any>;
 require(x.schemaVersion==='business-analytics-2','schemaVersion');
 require(!('ledger'in x)&&!('payments'in x)&&!('invoices'in x)&&!('clients'in x),'raw_collections_forbidden');
 require(object(x.meta),'meta');require(text(x.meta.revision)&&date(x.meta.accountingReadAt)&&date(x.meta.sheetsReadAt)&&typeof x.meta.projectionPending==='boolean'&&typeof x.meta.refreshing==='boolean'&&(x.meta.error===null||text(x.meta.error))&&typeof x.meta.paymentsEnabled==='boolean'&&x.meta.readOnly===true,'meta.fields');
 require(['dossiers','account'].includes(x.scope),'scope');require(object(x.totals)&&['dossiers','matchedDossiers','documents','eligible','excluded','unmatched'].every(k=>count(x.totals[k])),'totals');
 require(object(x.options),'options');for(const key of ['years','models','statuses','financialStatuses'])require(Array.isArray(x.options[key])&&x.options[key].length<=200&&x.options[key].every(text),'options.'+key);
 require(Array.isArray(x.kpis)&&x.kpis.length<=24,'kpis');for(const k of x.kpis)require(object(k)&&text(k.id)&&text(k.label)&&text(k.note)&&['count','money','percent'].includes(String(k.unit))&&(k.value===null||typeof k.value==='number'&&Number.isFinite(k.value)),'kpis.item');
 require(Array.isArray(x.charts)&&x.charts.length<=16,'charts');for(const c of x.charts){require(object(c)&&text(c.id)&&text(c.title)&&text(c.note)&&typeof c.money==='boolean'&&['documents','dossiers'].includes(String(c.detail))&&Array.isArray(c.points)&&c.points.length<=600,'charts.item');for(const p of c.points)require(object(p)&&text(p.id)&&text(p.label)&&typeof p.value==='number'&&Number.isFinite(p.value)&&count(p.dossierCount)&&count(p.documentCount),'charts.point');}
 require(Array.isArray(x.matchedDossiers)&&x.matchedDossiers.length<=100&&x.matchedDossiers.every((d:unknown)=>object(d)&&typeof d.id==='string'&&/^VDS-\d+$/.test(d.id)&&text(d.name)),'matchedDossiers');
 require(text(x.sourceBasis)&&Array.isArray(x.limitations)&&x.limitations.length<=24&&x.limitations.every(text),'limitations');return v as BusinessSummary;
}
export function validateBusinessPage(v:unknown,kind:'documents'|'dossiers'){
 const require=(ok:unknown,path:string)=>{if(!ok)throw new BusinessSchemaError(path);};require(object(v),'page');const x=v as Record<string,any>;
 require(x.schemaVersion===`business-${kind}-1`,'page.schemaVersion');require(text(x.revision)&&count(x.total)&&count(x.page)&&x.page>=1&&count(x.pageSize)&&x.pageSize>=1&&x.pageSize<=50&&Array.isArray(x.items)&&x.items.length<=x.pageSize,'page.pagination');
 for(const d of x.items){require(object(d)&&text(d.id)&&text(d.name??d.number),'page.item');if(kind==='documents')require((d.dossierId===null||text(d.dossierId))&&(d.dossierName===null||text(d.dossierName))&&date(d.date)&&date(d.due)&&money(d.net)&&money(d.gross)&&money(d.paid)&&(d.url===null||text(d.url))&&text(d.kind)&&text(d.status)&&(d.excludedReason===null||text(d.excludedReason)),'page.document');else require(/^VDS-\d+$/.test(d.id)&&text(d.model)&&text(d.commercialStatus)&&count(d.sourceRows),'page.dossier');}
 return v as BusinessPage|BusinessDossierPage;
}

import {BusinessSchemaError,validateBusinessPage,validateBusinessSummary,type BusinessQuality} from './business-analytics-contract.js';
import {safeAnalyticsSourceUrl} from './source-url.js';

const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const identifier=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=180;
const dossier=(v:unknown):v is string=>typeof v==='string'&&/^VDS-\d+$/.test(v);
function helpers(){
 const quality:BusinessQuality={repaired:0,omitted:0};
 const repair=<T>(v:T)=>{quality.repaired++;return v;};
 const text=(v:unknown,fallback='')=>typeof v==='string'?v:repair(fallback);
 const nullableText=(v:unknown)=>v===null||typeof v==='string'?v:repair(null);
 const date=(v:unknown)=>{
  if(v===null)return null;
  if(typeof v==='string'&&Number.isFinite(Date.parse(v))){
   if(/^\d{4}-\d{2}-\d{2}$/.test(v)&&new Date(v).toISOString().slice(0,10)!==v)return repair(null);
   return v;
  }
  return repair(null);
 };
 // Financial API amounts are already integer cents. Do not guess a unit or
 // convert malformed strings to zero; retain an explicit unknown value.
 const money=(v:unknown)=>v===null||typeof v==='number'&&Number.isSafeInteger(v)?v:repair(null);
 return {quality,repair,text,nullableText,date,money};
}
function header(value:unknown,schema:string){
 if(!object(value))throw new BusinessSchemaError('root');
 if(value.schemaVersion!==schema)throw new BusinessSchemaError('schemaVersion');
 for(const key of ['ledger','payments','invoices','clients'])if(key in value)throw new BusinessSchemaError('raw_collections_forbidden');
 return value;
}
export function normalizeBusinessSummary(value:unknown){
 const x=header(value,'business-analytics-2'),h=helpers();
 for(const key of ['meta','options'])if(!object(x[key]))throw new BusinessSchemaError(key);
 for(const [key,limit]of [['kpis',24],['charts',16],['matchedDossiers',100]] as const)if(!Array.isArray(x[key])||x[key].length>limit)throw new BusinessSchemaError(key);
 const unique=<T>(items:T[],id:(item:T)=>unknown,valid:(item:T)=>boolean)=>{const seen=new Set<unknown>();return items.filter(item=>{if(!valid(item)||seen.has(id(item))){h.quality.omitted++;return false;}seen.add(id(item));return true;});};
 const kpis=unique(x.kpis,(k:any)=>k?.id,(k:any)=>object(k)&&identifier(k.id)&&['count','money','percent'].includes(k.unit)).map((k:any)=>({...k,label:h.text(k.label,'Indicateur non renseigné'),note:h.text(k.note),value:k.value===null||typeof k.value==='number'&&Number.isFinite(k.value)?k.value:h.repair(null)}));
 const charts=unique(x.charts,(c:any)=>c?.id,(c:any)=>object(c)&&identifier(c.id)&&typeof c.money==='boolean'&&['documents','dossiers'].includes(c.detail)&&Array.isArray(c.points)&&c.points.length<=600).map((c:any)=>({...c,title:h.text(c.title,'Graphique non renseigné'),note:h.text(c.note),points:unique(c.points,(p:any)=>p?.id,(p:any)=>object(p)&&identifier(p.id)&&typeof p.value==='number'&&Number.isFinite(p.value)&&count(p.dossierCount)&&count(p.documentCount)).map((p:any)=>({...p,label:h.text(p.label,'Libellé non renseigné')}))}));
 const options={...x.options};for(const key of ['years','models','statuses','financialStatuses']){
  if(!Array.isArray(options[key])||options[key].length>200)throw new BusinessSchemaError('options.'+key);
  options[key]=options[key].filter((v:unknown)=>{if(typeof v==='string')return true;h.quality.omitted++;return false;});
 }
 if(!Array.isArray(x.limitations)||x.limitations.length>24)throw new BusinessSchemaError('limitations');
 return validateBusinessSummary({...x,meta:{...x.meta,accountingReadAt:h.date(x.meta.accountingReadAt),sheetsReadAt:h.date(x.meta.sheetsReadAt),error:h.nullableText(x.meta.error)},options,kpis,charts,matchedDossiers:unique(x.matchedDossiers,(d:any)=>d?.id,(d:any)=>object(d)&&dossier(d.id)).map((d:any)=>({...d,name:h.text(d.name,'Nom non renseigné')})),sourceBasis:h.text(x.sourceBasis,'Provenance à vérifier.'),limitations:x.limitations.filter((v:unknown)=>{if(typeof v==='string')return true;h.quality.omitted++;return false;}),quality:h.quality});
}
export function normalizeBusinessPage(value:unknown,kind:'documents'|'dossiers'){
 const x=header(value,`business-${kind}-1`),h=helpers();
 if(typeof x.revision!=='string'||!count(x.total)||!count(x.page)||x.page<1||!count(x.pageSize)||x.pageSize<1||x.pageSize>50||!Array.isArray(x.items)||x.items.length>x.pageSize)throw new BusinessSchemaError('page.pagination');
 const seen=new Set<string>();
 const items=x.items.flatMap<Record<string,unknown>>((item:unknown)=>{
  if(!object(item)||!identifier(item.id)||seen.has(item.id)||kind==='dossiers'&&(!dossier(item.id)||!count(item.sourceRows))){h.quality.omitted++;return [];}
  seen.add(item.id);
  if(kind==='dossiers')return [{...item,name:h.text(item.name,'Nom non renseigné'),model:h.text(item.model,'Modèle non renseigné'),commercialStatus:h.text(item.commercialStatus,'Statut non renseigné')}];
  const dossierId=item.dossierId===null?null:dossier(item.dossierId)?item.dossierId:h.repair(null);
  const url=item.url===null?null:safeAnalyticsSourceUrl(typeof item.url==='string'?item.url:null);
  if(item.url!==null&&url!==item.url)h.quality.repaired++;
  return [{...item,dossierId,dossierName:dossierId?h.nullableText(item.dossierName):null,number:h.text(item.number,'Référence non renseignée'),kind:h.text(item.kind,'Type non renseigné'),status:h.text(item.status,'Statut non renseigné'),date:h.date(item.date),due:h.date(item.due),net:h.money(item.net),gross:h.money(item.gross),paid:h.money(item.paid),excludedReason:h.nullableText(item.excludedReason),url}];
 });
 return validateBusinessPage({...x,items,quality:h.quality},kind);
}

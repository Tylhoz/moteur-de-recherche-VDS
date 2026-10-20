import {createHash} from 'node:crypto';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import type {PrivateR2Bucket} from '../../worker/index.js';
import type {BusinessDataset} from './business-analytics.js';
import {validateBusinessSummary,type BusinessSummary} from '../../shared/business-analytics-contract.js';
export interface MaterializedAnalytics {key:string;data:BusinessDataset;accountingReadAt:string|null;sheetsReadAt:string|null;defaults:Record<'account'|'dossiers',BusinessSummary>;}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const date=(v:unknown)=>v===null||typeof v==='string'&&Number.isFinite(Date.parse(v));
const compress=promisify(gzip),decompress=promisify(gunzip);
/** Private, derived cache. Raw source versions and their audit trail remain separate. */
export function createMaterializedAnalytics(bucket:PrivateR2Bucket,binding:string){
 const root='vds/private/analytics-materialized/'+digest(binding)+'/';
 async function read(key:string){const value=await bucket.get(root+key);return value?JSON.parse(await value.text()):null;}
 async function previousForSave(){
  const value=await bucket.get(root+'current.json');if(!value)return null;
  const raw=await value.text();
  try{return JSON.parse(raw);}catch(error){if(!(error instanceof SyntaxError))throw error;}
  // Preserve the rejected derived pointer verbatim before publishing any replacement.
  // Reads stay outside the parse catch so storage failures always stop the rebuild.
  const key=root+'quarantine/current-'+digest(raw)+'.json';
  if(await bucket.put(key,raw,{onlyIf:{etagDoesNotMatch:'*'}})===null){
   const archived=await bucket.get(key);
   if(!archived||await archived.text()!==raw)throw Error('analytics_cache_quarantine_failed');
  }
  return null;
 }
 return {
  async save(cache:MaterializedAnalytics){
   const {data}=cache;
   const defaults=Object.fromEntries(Object.entries(cache.defaults).map(([scope,value])=>[scope,{...value,meta:{...value.meta,accountingReadAt:null,sheetsReadAt:null,projectionPending:false,refreshing:false,error:null}}]));
   // Store documents once, without contact matching candidates, API tokens or source bodies.
   const payload=JSON.stringify({schemaVersion:'analytics-materialized-1',key:cache.key,profiles:data.profiles,documents:data.documents,options:data.options,periodLength:data.periodLength,financial:{totals:data.financial.totals,matchedDossiers:data.financial.matchedDossiers,paymentEntries:data.financial.paymentEntries,pendingAccounting:data.financial.pendingAccounting,overdue:data.financial.overdue,paymentEvidence:data.financial.paymentEvidence,limits:data.financial.limits},defaults});
   if(Buffer.byteLength(payload)>64*1024*1024)throw Error('analytics_cache_size_limit');
   const sha=digest(payload),compressed=(await compress(payload)).toString('base64');if(compressed.length>3*1024*1024)throw Error('analytics_cache_size_limit');
   const previous=await previousForSave();
   await bucket.put(root+'versions/'+sha+'.json',JSON.stringify({encoding:'gzip-base64',sha,body:compressed}),{onlyIf:{etagDoesNotMatch:'*'}});
   await bucket.put(root+'current.json',JSON.stringify({schemaVersion:'analytics-materialized-1',sha,previous:previous?.sha!==sha?previous?.sha??null:previous?.previous??null,key:cache.key,accountingReadAt:cache.accountingReadAt,sheetsReadAt:cache.sheetsReadAt}));
   return {digest:sha,documents:data.documents.length,dossiers:data.profiles.length};
  },
  async restore():Promise<MaterializedAnalytics|null>{
   const pointer=await read('current.json');if(!pointer)return null;
   if(pointer.schemaVersion!=='analytics-materialized-1'||!/^[a-f0-9]{64}$/.test(pointer.sha)||typeof pointer.key!=='string'||!date(pointer.accountingReadAt)||!date(pointer.sheetsReadAt))throw Error('analytics_cache_invalid');
   const version=await read('versions/'+pointer.sha+'.json');if(!version||version.sha!==pointer.sha||version.encoding!=='gzip-base64'||typeof version.body!=='string'||version.body.length>3*1024*1024)throw Error('analytics_cache_invalid');
   const body=(await decompress(Buffer.from(version.body,'base64'),{maxOutputLength:64*1024*1024})).toString('utf8');if(digest(body)!==pointer.sha)throw Error('analytics_cache_digest_invalid');
   const p=JSON.parse(body);if(p.schemaVersion!=='analytics-materialized-1'||p.key!==pointer.key||!Array.isArray(p.profiles)||p.profiles.length>10000||!Array.isArray(p.documents)||p.documents.length>100000||!object(p.financial)||!object(p.options)||![7,4,3,2].includes(p.periodLength)||!object(p.defaults))throw Error('analytics_cache_invalid');
   const defaults={account:validateBusinessSummary(p.defaults.account),dossiers:validateBusinessSummary(p.defaults.dossiers)};
   const ids=new Set<string>();for(const profile of p.profiles){if(!object(profile)||typeof profile.id!=='string'||!/^VDS-\d+$/.test(profile.id)||ids.has(profile.id)||typeof profile.name!=='string'||!Array.isArray(profile.dates)||!Array.isArray(profile.offers)||!Array.isArray(profile.sales)||!Array.isArray(profile.works)||!Array.isArray(profile.sav))throw Error('analytics_cache_invalid');ids.add(profile.id);}
   const data:BusinessDataset={profiles:p.profiles,byId:new Map(p.profiles.map((c:any)=>[c.id,c])),documents:p.documents,options:p.options,periodLength:p.periodLength,financial:{...p.financial,ledger:p.documents,matches:[]}};
   return {key:p.key,data,defaults,accountingReadAt:pointer.accountingReadAt,sheetsReadAt:pointer.sheetsReadAt};
  },
  async updateDates(cache:MaterializedAnalytics){
   const pointer=await read('current.json');
   if(!pointer||pointer.key!==cache.key)throw Error('analytics_cache_revision_changed');
   await bucket.put(root+'current.json',JSON.stringify({...pointer,accountingReadAt:cache.accountingReadAt,sheetsReadAt:cache.sheetsReadAt}));
  },
 };
}

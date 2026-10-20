import {createHash} from 'node:crypto';
import type {PrivateR2Bucket} from '../../worker/index.js';
const key='vds/private/commercial-rules/index.json';
export interface CommercialRule {depositRate:number;finalInvoiceLeadDays:number;reason:string;at:string;}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function createCommercialRules(bucket:PrivateR2Bucket){
 async function state(){const o=await bucket.get(key),body=o?await o.text():'{}';return {values:JSON.parse(body) as Record<string,CommercialRule>,etag:o?.etag,revision:hash(body)};}
 return {async read(id:string){const s=await state();return {dossierId:id,rule:s.values[id]??{depositRate:0.30,finalInvoiceLeadDays:7,reason:'Conditions standard, à vérifier sur le contrat.',at:null},revision:s.revision,theoreticalOnly:true,sourceWrites:0};},async save(id:string,body:unknown){
  const b=body as any;if(!b||Object.keys(b).sort().join(',')!=='depositRate,finalInvoiceLeadDays,reason,revision'||typeof b.depositRate!=='number'||!Number.isFinite(b.depositRate)||b.depositRate<=0||b.depositRate>1||!Number.isInteger(b.finalInvoiceLeadDays)||b.finalInvoiceLeadDays<0||b.finalInvoiceLeadDays>90||typeof b.reason!=='string'||b.reason.trim().length<3||b.reason.length>2000)throw Error('invalid_commercial_rule');
  const before=await state();if(before.revision!==b.revision)throw Error('commercial_rules_changed');
  const next={...before.values,[id]:{depositRate:b.depositRate,finalInvoiceLeadDays:b.finalInvoiceLeadDays,reason:b.reason.trim(),at:new Date().toISOString()}},data=JSON.stringify(next);
  await bucket.put('vds/private/commercial-rules/versions/'+hash(data)+'.json',data,{onlyIf:{etagDoesNotMatch:'*'}});await bucket.put('vds/private/commercial-rules/versions/'+hash(JSON.stringify(before.values))+'.json',JSON.stringify(before.values),{onlyIf:{etagDoesNotMatch:'*'}});
  if(await bucket.put(key,data,{onlyIf:before.etag?{etagMatches:before.etag}:{etagDoesNotMatch:'*'}})===null)throw Error('commercial_rules_changed');return {saved:true,sourceWrites:0,theoreticalOnly:true};
 }};
}

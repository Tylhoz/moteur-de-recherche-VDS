import {createHash} from 'node:crypto';
import type {PrivateR2Bucket} from '../../worker/index.js';
const key='vds/private/matching/decisions.json';
export interface LinkDecision {externalId:string;dossierId:string;externalDigest:string;at:string;actor:string;}
export function createMatchDecisions(bucket:PrivateR2Bucket){return {
 async read():Promise<LinkDecision[]>{const o=await bucket.get(key);return o?JSON.parse(await o.text()):[];},
 async save(input:LinkDecision){const old=await bucket.get(key),rows:LinkDecision[]=old?JSON.parse(await old.text()):[];if(rows.length>=10000)throw Error('decision_limit');const body=JSON.stringify([...rows,input]);
  const digest=createHash('sha256').update(body).digest('hex');await bucket.put(`vds/private/matching/versions/${digest}.json`,body,{onlyIf:{etagDoesNotMatch:'*'}});
  if(await bucket.put(key,body,{onlyIf:old?.etag?{etagMatches:old.etag}:{etagDoesNotMatch:'*'}})===null)throw Error('decision_changed');
 },
};}

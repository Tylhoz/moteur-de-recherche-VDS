import type {Client} from '../../src/types.js';
export interface ExternalIdentity {id:string;externalId?:string;email?:string;phone?:string;name?:string;address?:string;}
export interface Match {externalId:string;status:'certain'|'probable'|'uncertain'|'none';dossierId:string|null;score:number;reasons:string[];candidates:{id:string;score:number;reasons:string[]}[];}
const norm=(v:string)=>v.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const emails=(v:string)=>new Set((v.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)??[]));
const phones=(v:string)=>new Set((v.match(/(?:\+|00)?\d[\d .()/\-]{7,}\d/g)??[]).map(x=>x.replace(/\D/g,'').replace(/^00/,'')).filter(x=>x.length>=9&&x.length<=15));
const overlap=(a:Set<string>,b:Set<string>)=>[...a].some(x=>b.has(x));
/** Compile source identities once per dossier revision, never once per external contact.
 * Only positive-evidence candidates need scoring; ties retain original dossier order.
 * Contradictory coordinates still block automatic association, including explicit IDs.
 */
export function createIdentityMatcher(clients:Client[]):(external:ExternalIdentity)=>Match{
 const prepared=clients.map(c=>({id:c.id,emails:emails(c.contact),phones:phones(c.contact),name:norm(c.client),address:norm(c.address)}));
 const index={id:new Map<string,number[]>(),email:new Map<string,number[]>(),phone:new Map<string,number[]>(),name:new Map<string,number[]>(),address:new Map<string,number[]>()};
 const add=(map:Map<string,number[]>,key:string,i:number)=>{const list=map.get(key);if(list)list.push(i);else map.set(key,[i]);};
 prepared.forEach((c,i)=>{add(index.id,c.id,i);add(index.name,c.name,i);add(index.address,c.address,i);for(const v of c.emails)add(index.email,v,i);for(const v of c.phones)add(index.phone,v,i);});
 return external=>{
  const emailSet=emails(external.email||''),phoneSet=phones(external.phone||''),name=external.name?norm(external.name):null,address=external.address?norm(external.address):null;
  const possible=new Set<number>();const include=(map:Map<string,number[]>,key:string)=>{for(const i of map.get(key)??[])possible.add(i);};
  if(external.externalId)include(index.id,external.externalId);if(name!==null)include(index.name,name);if(address!==null)include(index.address,address);for(const v of emailSet)include(index.email,v);for(const v of phoneSet)include(index.phone,v);
  const candidates=[...possible].sort((a,b)=>a-b).map(i=>{const c=prepared[i],reasons:string[]=[];let score=0;
   const explicit=!!external.externalId&&external.externalId===c.id,email=overlap(emailSet,c.emails),phone=overlap(phoneSet,c.phones),sameName=name!==null&&name===c.name,sameAddress=address!==null&&address===c.address;
   if(explicit){score+=100;reasons.push('Identifiant dossier explicite');}if(email){score+=45;reasons.push('E-mail concordant');}if(phone){score+=45;reasons.push('Téléphone concordant');}if(sameName){score+=15;reasons.push('Nom exact normalisé');}if(sameAddress){score+=15;reasons.push('Adresse exacte normalisée');}
   const blocked=(emailSet.size>0&&c.emails.size>0&&!email)||(phoneSet.size>0&&c.phones.size>0&&!phone);if(blocked)reasons.push('Coordonnée contradictoire : validation nécessaire');
   return {id:c.id,score,reasons,certain:!blocked&&(explicit||(email&&phone)||(email&&sameName)||(phone&&sameName))};
  }).sort((a,b)=>b.score-a.score);
  const first=candidates[0],certain=candidates.filter(c=>c.certain),unique=first&&candidates.filter(c=>c.score===first.score).length===1;
  const status:Match['status']=certain.length===1&&certain[0]===first?'certain':!first?'none':unique&&first.score>=30?'probable':'uncertain';
  return {externalId:external.id,status,dossierId:status==='certain'?first.id:null,score:first?.score??0,reasons:first?.reasons??[],candidates:candidates.slice(0,5).map(({id,score,reasons})=>({id,score,reasons}))};
 };
}
export function matchIdentity(external:ExternalIdentity,clients:Client[]):Match{return createIdentityMatcher(clients)(external);}

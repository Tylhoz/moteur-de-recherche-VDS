import type {Client} from '../../src/types.js';
export interface ExternalIdentity {id:string;externalId?:string;email?:string;phone?:string;name?:string;address?:string;}
export interface Match {externalId:string;status:'certain'|'probable'|'uncertain'|'none';dossierId:string|null;score:number;reasons:string[];candidates:{id:string;score:number;reasons:string[]}[];}
const norm=(v:string)=>v.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const emails=(v:string)=>new Set((v.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)??[]));
const phones=(v:string)=>new Set((v.match(/(?:\+|00)?\d[\d .()/\-]{7,}\d/g)??[]).map(x=>x.replace(/\D/g,'').replace(/^00/,'')).filter(x=>x.length>=9&&x.length<=15));
const overlap=(a:Set<string>,b:Set<string>)=>[...a].some(x=>b.has(x));
export function matchIdentity(external:ExternalIdentity,clients:Client[]):Match{
 const candidates=clients.map(c=>{const reasons:string[]=[];let score=0;
  const explicit=!!external.externalId&&external.externalId===c.id;
  const email=overlap(emails(external.email||''),emails(c.contact)),phone=overlap(phones(external.phone||''),phones(c.contact));
  const name=!!external.name&&norm(external.name)===norm(c.client),address=!!external.address&&norm(external.address)===norm(c.address);
  if(explicit){score+=100;reasons.push('Identifiant dossier explicite');}if(email){score+=45;reasons.push('E-mail concordant');}if(phone){score+=45;reasons.push('Téléphone concordant');}if(name){score+=15;reasons.push('Nom exact normalisé');}if(address){score+=15;reasons.push('Adresse exacte normalisée');}
  const emailConflict=emails(external.email||'').size>0&&emails(c.contact).size>0&&!email;
  const phoneConflict=phones(external.phone||'').size>0&&phones(c.contact).size>0&&!phone;
  const blocked=emailConflict||phoneConflict;if(blocked)reasons.push('Coordonnée contradictoire : validation nécessaire');
  return {id:c.id,score,reasons,certain:!blocked&&(explicit||(email&&phone)||(email&&name)||(phone&&name)),blocked};
 }).filter(c=>c.score>0).sort((a,b)=>b.score-a.score);
 const first=candidates[0],certain=candidates.filter(c=>c.certain),unique=first&&candidates.filter(c=>c.score===first.score).length===1;
 const status:Match['status']=certain.length===1&&certain[0]===first?'certain':!first?'none':unique&&first.score>=30?'probable':'uncertain';
 return {externalId:external.id,status,dossierId:status==='certain'?first.id:null,score:first?.score??0,reasons:first?.reasons??[],candidates:candidates.slice(0,5).map(({id,score,reasons})=>({id,score,reasons}))};
}

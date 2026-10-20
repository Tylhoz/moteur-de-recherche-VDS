import type {Client} from '../../src/types.js';
import {cents,type AccountingRow} from './vosfactures.js';
import {createIdentityMatcher} from './matching.js';
export interface LedgerEntry {id:string;dossierId:string|null;kind:string;number:string;currency:string;net:number|null;gross:number|null;paid:number|null;due:string|null;date:string|null;status:string;excludedReason:string|null;url:string;}
const day=(v:unknown)=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}/.test(v))return null;const s=v.slice(0,10),d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s?s:null;};
const yes=(v:unknown)=>v===true||v===1||v==='1'||v==='true';
export function accountingProjection(rows:Record<'clients'|'invoices'|'payments',AccountingRow[]>,clients:Client[],account:string,approved:Record<string,string>={}){
 const matchIdentity=createIdentityMatcher(clients);
 const matches=rows.clients.map(r=>Object.assign(matchIdentity({id:String(r.id),externalId:String(r.external_id||''),email:String(r.email||''),phone:String(r.phone||r.mobile_phone||''),name:String(r.name||[r.first_name,r.last_name].filter(Boolean).join(' ')),address:[r.street,r.post_code,r.city].filter(Boolean).join(' ')}),{name:String(r.name||[r.first_name,r.last_name].filter(Boolean).join(' ')),url:`https://${account}.vosfactures.fr/clients/${r.id}`}));
 const approvedIds=new Set(clients.map(c=>c.id));for(const m of matches)if(approved[m.externalId]&&approvedIds.has(approved[m.externalId])){m.dossierId=approved[m.externalId];m.status='certain';m.reasons.push('Rattachement validé par le propriétaire');}
 const byId=new Map(matches.filter(m=>m.status==='certain').map(m=>[m.externalId,m.dossierId]));
 const families=new Set(rows.invoices.filter(r=>r.kind==='final').map(r=>String(r.client_id||r.buyer_id||'')));
 const ledger:LedgerEntry[]=rows.invoices.map(r=>{const buyer=String(r.client_id||r.buyer_id||''),kind=String(r.kind||''),status=String(r.status||'');let excludedReason:string|null=null;
  if(r._missingFromLatestFull)excludedReason='Document absent de la dernière lecture complète : conservé pour contrôle';else if(!yes(r.income))excludedReason='Document non identifié comme vente';else if(yes(r.test)||yes(r.deleted)||['canceled','cancelled','draft'].includes(status))excludedReason='Brouillon, test, suppression ou annulation';else if(!['vat','advance','final','correction'].includes(kind))excludedReason='Document non comptable pour le chiffre d’affaires';else if(String(r.currency||'')!=='EUR')excludedReason='Autre devise : hors agrégat EUR';else if(families.has(buyer)&&['advance','final'].includes(kind))excludedReason='Acomptes et facture finale : ventilation à vérifier avant agrégation';
  const net=cents(r.price_net),gross=cents(r.price_gross),paid=cents(r.paid);if(!excludedReason&&(net===null||gross===null))excludedReason='Montant non exploitable';if(kind==='correction'&&gross!==null&&gross>0)excludedReason='Signe de l’avoir à vérifier';
  return {id:String(r.id),dossierId:byId.get(buyer)??null,kind,number:String(r.number||r.id),currency:String(r.currency||''),net,gross,paid,due:day(r.payment_to),date:day(r.issue_date),status,excludedReason,url:`https://${account}.vosfactures.fr/invoices/${r.id}`};
 });
 const accounting=ledger.filter(l=>['vat','advance','final','correction'].includes(l.kind)&&!['draft','canceled','cancelled'].includes(l.status)&&!['Document non identifié comme vente','Brouillon, test, suppression ou annulation','Autre devise : hors agrégat EUR'].includes(l.excludedReason||''));
 const eligible=ledger.filter(l=>!l.excludedReason),pending=accounting.filter(l=>!!l.excludedReason),complete=accounting.length>0&&pending.length===0;
 const received=rows.payments.filter(p=>!p._missingFromLatestFull&&yes(p.paid)&&!yes(p.deleted)&&String(p.currency)==='EUR'&&yes(p.income));
 const ledgerById=new Map<string,LedgerEntry>();for(const entry of ledger)if(!ledgerById.has(entry.id))ledgerById.set(entry.id,entry);
 const paymentEntries=received.map(p=>{const refs=Array.isArray(p.invoices)?p.invoices.map((r:any)=>String(r.id)):p.invoice_id?[String(p.invoice_id)]:[];const dossierIds=[...new Set(refs.map(id=>ledgerById.get(id)?.dossierId).filter(Boolean))];return {id:String(p.id),amount:cents(p.price),date:day(p.paid_date),invoiceIds:refs,dossierId:dossierIds.length===1&&refs.every(id=>!!ledgerById.get(id)?.dossierId)?dossierIds[0]:null};});
 const paymentKnown=received.length>0,now=new Date().toISOString().slice(0,10);
 const total=(field:'net'|'gross')=>eligible.reduce((n,l)=>n+(l[field]??0),0);
 const sums={invoicedNet:complete?total('net'):null,invoicedGross:complete?total('gross'):null,eligibleNet:eligible.length?total('net'):null,eligibleGross:eligible.length?total('gross'):null,received:paymentKnown&&received.every(p=>cents(p.price)!==null)?received.reduce((n,p)=>n+cents(p.price)!,0):null,outstanding:complete&&!eligible.some(l=>l.kind==='correction')&&eligible.every(l=>l.paid!==null)?eligible.reduce((n,l)=>n+Math.max(0,l.gross!-l.paid!),0):null};
 return {matches,ledger,paymentEntries,totals:sums,matchedDossiers:[...new Set(matches.filter(m=>m.status==='certain').map(m=>m.dossierId!))],pendingAccounting:pending.length,overdue:eligible.filter(l=>l.due&&/^\d{4}-\d{2}-\d{2}$/.test(l.due)&&l.due<now&&l.paid!==null&&l.gross!==null&&l.gross>l.paid).length,paymentEvidence:paymentKnown?'transactions entrantes confirmées dans la source comptable':'Données insuffisantes : sens des transactions non confirmé',limits:['Les paiements pointés sur les factures ne sont pas ajoutés aux transactions bancaires.','Les familles acompte/finale non ventilées sont exclues des totaux.','Un devis ou une facture ne prouve pas une piscine vendue.']};
}

export type ReturnTypeAccounting=ReturnType<typeof accountingProjection>;

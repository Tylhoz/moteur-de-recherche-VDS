import { specByName, type Dataset, type Row, type Cell } from './model.js';

const missing='Information non retrouvée';
function rowId(table:string,row:Row){return row[specByName.get(table)!.primary_key];}
export function evidence(data:Dataset,table:string,id:Cell,field?:string){
  const links=(data.tables.RELATIONS_SOURCE??[]).filter(r=>r.cible_table===table&&r.cible_id===id&&(!field||r.champ===field||r.champ===null));
  return links.map(link=>({role:link.role,source:data.tables.SOURCES.find(s=>s.source_id===link.source_id)!}));
}
function sourceSummary(s:Row){return {id:s.source_id,type:s.type_source,externalId:s.objet_externe_id,locator:s.localisateur,date:s.survenu_at,collectedAt:s.collecte_at,verifiedAt:s.verification_at,status:s.etat_fiabilite,link:s.lien_source};}
function monetaryContext(row:Row,field:string){
  const base=field.endsWith('_ht_centimes')?'HT':field.endsWith('_ttc_centimes')?'TTC':field==='acompte_centimes'?row.acompte_base:null;
  return {currency:row.devise,base};
}
function moneyProofMatches(row:Row,field:string,source:Row){
  const context=monetaryContext(row,field);
  return typeof context.currency==='string'&&/^[A-Z]{3}$/.test(context.currency)&&source.devise===context.currency&&(!context.base||source.base_fiscale===context.base);
}
export function annotatedRow(data:Dataset,table:string,row:Row){
  return {id:rowId(table,row),table,fields:Object.fromEntries(Object.entries(row).map(([name,value])=>{
    const proof=evidence(data,table,rowId(table,row),name);
    const supports=proof.filter(p=>p.role==='etaye'&&p.source.usage_source==='production'&&p.source.champ_observe===name);
    const context=monetaryContext(row,name);
    const contradiction=proof.some(p=>p.role==='contredit'||p.source.etat_fiabilite==='contradictoire')||supports.some(p=>p.source.etat_fiabilite!=='obsolete'&&(p.source.valeur_normalisee!==String(value)||(name.endsWith('_centimes')&&((context.currency&&p.source.devise&&context.currency!==p.source.devise)||(context.base&&p.source.base_fiscale&&p.source.base_fiscale!=='INCONNUE'&&context.base!==p.source.base_fiscale)))));
    const financeField=name.endsWith('_centimes')||name==='statut_preuve';
    const confirmed=supports.some(p=>p.source.etat_fiabilite==='confirmee'&&p.source.valeur_normalisee===String(value)&&(!name.endsWith('_centimes')||moneyProofMatches(row,name,p.source))&&(!financeField||['comptabilite','banque',...(table==='VENTES'||table==='DEVIS'?['contrat_signe']:[])].includes(String(p.source.type_source))));
    const status=value===null?'manquante':contradiction?'contradictoire':confirmed?'confirmee':'a_verifier';
    return [name,{value,status,label:value===null?missing:status==='confirmee'?'Confirmée':'À vérifier',sources:proof.map(p=>({role:p.role,...sourceSummary(p.source)}))}];
  }))};
}
export function dossierView(data:Dataset,id:string){
  const dossier=data.tables.DOSSIERS.find(r=>r.dossier_id===id);if(!dossier)return null;
  const sections:Record<string,ReturnType<typeof annotatedRow>[]>={};
  for(const [table,rows] of Object.entries(data.tables)){
    if(['SOURCES','RELATIONS_SOURCE','SYNCHRONISATION','DOSSIERS'].includes(table))continue;
    const related=rows.filter(r=>(table==='CLIENTS'?r.client_id===dossier.client_id:r.dossier_id===id)&&(table!=='COMMUNICATIONS'||(r.usage_source==='production'&&r.statut_message!=='brouillon'&&r.statut_rapprochement==='valide')));
    sections[table]=related.map(r=>annotatedRow(data,table,r));
  }
  return {dossier:annotatedRow(data,'DOSSIERS',dossier),sections};
}
export function timelineView(data:Dataset,id:string){
  const communications=(data.tables.COMMUNICATIONS??[]).filter(r=>r.dossier_id===id&&r.statut_rapprochement==='valide'&&r.usage_source==='production'&&r.statut_message!=='brouillon'&&r.survenu_at);
  const events=(data.tables.AGENDA??[]).filter(r=>r.dossier_id===id&&r.statut_rapprochement==='valide'&&r.debut_at);
  // An explicit Agenda link is the only automatic cross-source deduplication key.
  const agendaIds=new Set(events.map(r=>r.agenda_id));
  const timeline=[...communications.filter(r=>!r.agenda_id||!agendaIds.has(r.agenda_id)).map(r=>({date:r.survenu_at,kind:'communication',record:annotatedRow(data,'COMMUNICATIONS',r),relatedCommunications:[]})),...events.map(r=>({date:r.debut_at,kind:'agenda',record:annotatedRow(data,'AGENDA',r),relatedCommunications:communications.filter(c=>c.agenda_id===r.agenda_id).map(c=>annotatedRow(data,'COMMUNICATIONS',c))}))];
  return timeline.sort((a,b)=>Date.parse(String(a.date))-Date.parse(String(b.date))||String(a.record.id).localeCompare(String(b.record.id)));
}
export function financeView(data:Dataset,dossierId?:string,allowAggregation=true){
  const related=(table:string)=>(data.tables[table]??[]).filter(r=>!dossierId||r.dossier_id===dossierId);
  const payments=related('PAIEMENTS');
  const verified:Row[]=[];const pending:Row[]=[];
  for(const p of payments){
    const s=data.tables.SOURCES.find(s=>s.source_id===p.preuve_source_id);
    const contradictions=evidence(data,'PAIEMENTS',p.paiement_id).some(p=>p.role==='contredit'||p.source.etat_fiabilite==='contradictoire');
    const amount=p.montant_centimes;
    // A matching amount alone cannot establish direction, accounting date or client.
    const transactionFieldProven=(field:string)=>evidence(data,'PAIEMENTS',p.paiement_id,field).some(({role,source:proof})=>
      role==='etaye'&&proof.champ_observe===field&&proof.valeur_normalisee===String(p[field])&&
      proof.usage_source==='production'&&proof.etat_fiabilite==='confirmee'&&proof.verification_at&&proof.verification_par&&
      proof.type_source===s?.type_source&&proof.compte_source===s?.compte_source&&proof.objet_externe_id===p.transaction_externe_id);
    const trusted=allowAggregation&&!contradictions&&p.dossier_id&&p.statut_preuve==='verifie_comptable'&&p.verifie_at&&p.verifie_par&&p.comptabilise_at&&p.systeme_financier&&p.transaction_externe_id&&
      typeof amount==='number'&&Number.isSafeInteger(amount)&&amount>=0&&typeof p.devise==='string'&&/^[A-Z]{3}$/.test(p.devise)&&
      s&&['comptabilite','banque'].includes(String(s.type_source))&&s.usage_source==='production'&&s.etat_fiabilite==='confirmee'&&s.verification_at&&s.verification_par&&
      s.objet_externe_id===p.transaction_externe_id&&s.champ_observe==='montant_centimes'&&s.valeur_normalisee===String(amount)&&s.devise===p.devise&&
      ['sens','comptabilise_at','dossier_id'].every(transactionFieldProven);
    (trusted?verified:pending).push(p);
  }
  const groups=new Map<string,{currency:string;month:string;receivedCents:number;refundedCents:number}>();
  for(const p of verified){
    const month=String(p.comptabilise_at).slice(0,7);const key=`${p.devise}:${month}`;
    const group=groups.get(key)??{currency:String(p.devise),month,receivedCents:0,refundedCents:0};
    const field=p.sens==='remboursement'?'refundedCents':'receivedCents';group[field]+=Number(p.montant_centimes);
    if(!Number.isSafeInteger(group[field]))throw new Error('financial_sum_overflow');groups.set(key,group);
  }
  return {
    coverage:'partielle_non_exhaustive',label:'Encaissements et remboursements identifiés avec preuve comptable',
    verifiedBalance:null,verifiedBalanceLabel:missing,
    series:[...groups.values()].sort((a,b)=>a.currency.localeCompare(b.currency)||a.month.localeCompare(b.month)),
    verifiedPaymentCount:verified.length,pendingPaymentCount:pending.length,
    verifiedPayments:verified.map(r=>annotatedRow(data,'PAIEMENTS',r)),pendingPayments:pending.map(r=>annotatedRow(data,'PAIEMENTS',r)),
    contracts:related('VENTES').map(r=>annotatedRow(data,'VENTES',r)),invoices:related('FACTURES').map(r=>annotatedRow(data,'FACTURES',r)),
    contractTotal:null,invoiceTotal:null,
    limitation:'Aucun total contractuel ou de factures calculé. Un paiement déclaré, un avoir et un remboursement sont distincts. Le solde exige un rapprochement comptable complet.',
  };
}

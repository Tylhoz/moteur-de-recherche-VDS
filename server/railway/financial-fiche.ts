import type {PilotResponse} from '../../shared/pilot-contract.js';
import type {LedgerEntry} from './intelligence.js';
export function appendFinancialDocuments(response:PilotResponse,ledger:LedgerEntry[]):PilotResponse{
 const relevant=ledger.filter(l=>l.dossierId===response.data.id);if(!relevant.length)return response;
 const data=structuredClone(response.data),section=data.sections.find(s=>s.id==='finances')!;
 for(const l of relevant){const id='vosfactures-'+l.id;data.sources.push({id,label:'VosFactures · '+l.number,url:l.url,kind:'vosfactures',occurredAt:null,dateOriginal:null,status:'read'});
  for(const [label,value]of Object.entries({'Type de document':l.kind,'Référence':l.number,'HTVA':l.net===null?null:(l.net/100).toFixed(2)+' '+l.currency,'TVAC':l.gross===null?null:(l.gross/100).toFixed(2)+' '+l.currency,'Pointage payé sur la facture':l.paid===null?null:(l.paid/100).toFixed(2)+' '+l.currency,'Émission':l.date,'Échéance':l.due,'Statut comptable':l.status,'Limite de calcul':l.excludedReason})){
   if(value===null||value==='')continue;section.fields.push({id:id+'-'+label,entityKey:id,label:l.number+' · '+label,value,status:label==='Limite de calcul'?'review':'documented',sourceIds:[id],note:label==='Pointage payé sur la facture'?'Pointage dans VosFactures ; ne pas additionner aux mouvements bancaires.':'Document lu dans la source comptable ; ne prouve pas une nouvelle vente.',sourceStatus:'API VosFactures en lecture seule',humanValidated:false});
  }
  data.documents.push({id,filename:l.number,mimeType:null,sourceIds:[id],url:l.url,contentRead:false,visuallyChecked:false,status:'unverified',note:'Métadonnées lues par API ; le PDF n’a pas été consulté.'});
 }
 data.counts={...data.counts,documented:data.sections.flatMap(s=>s.fields).filter(f=>f.status==='documented').length,review:data.sections.flatMap(s=>s.fields).filter(f=>f.status==='review').length};return {...response,data};
}

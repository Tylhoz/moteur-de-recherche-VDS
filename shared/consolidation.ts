import type {PilotField, PilotTimelineEvent, PilotDossier, PilotContradiction} from './pilot-contract.js';
const normalized=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('fr').replace(/\s+/g,' ').trim();
const labelKey=(s:string)=>{const key=normalized(s).replace(/ · observation sheets$/,'').replace(/_/g,' ');return ['nom du dossier','nom complet','nom prénom','nom prenom','nom et prénom'].includes(key)?'identité du dossier':key;};
export interface ConsolidatedField extends PilotField { originalFields: PilotField[]; }
/** Presentation only: no source record is modified. Financial entries retain their document identity. */
export function consolidateFields(fields:PilotField[],section='unknown'):ConsolidatedField[]{
 const groups=new Map<string,ConsolidatedField>();
 for(const f of fields){
  const scoped=/finances|documents|agenda|communications|actions|sources|unknown/.test(section);
  const entity=f.entityKey||(scoped?f.id:'dossier');
  const key=JSON.stringify([entity,labelKey(f.label),f.value===null?null:normalized(f.value),f.status]);
  const prior=groups.get(key);
  if(prior){prior.originalFields.push(f);prior.sourceIds=[...new Set([...prior.sourceIds,...f.sourceIds])];}
  else groups.set(key,{...f,sourceIds:[...f.sourceIds],originalFields:[f]});
 }
 return [...groups.values()];
}
export function consolidateTimeline(events:PilotTimelineEvent[]):PilotTimelineEvent[]{
 const groups=new Map<string,PilotTimelineEvent>();
 for(const e of events){
  // Same narrative/date alone cannot prove that two appointments were the same event.
  const key=e.externalEventKey?JSON.stringify([e.externalEventKey,e.dateUTC,e.eventDate,e.dateOriginal,normalized(e.summary),e.status]):e.id;
  const prior=groups.get(key);
  if(prior)prior.sourceIds=[...new Set([...prior.sourceIds,...e.sourceIds])];else groups.set(key,{...e,sourceIds:[...e.sourceIds]});
 }
 return [...groups.values()];
}
export function consolidationStats(d:PilotDossier){
 return {fields:d.sections.reduce((n,s)=>n+s.fields.length-consolidateFields(s.fields,s.id).length,0),events:d.timeline.length-consolidateTimeline(d.timeline).length,conflicts:d.contradictions.length-consolidateContradictions(d.contradictions).length};
}

export function consolidateContradictions(items:PilotContradiction[]):PilotContradiction[]{
 const groups=new Map<string,PilotContradiction>();
 for(const c of items){const key=JSON.stringify([labelKey(c.field),c.existingValue===null?null:normalized(c.existingValue),c.observedValue===null?null:normalized(c.observedValue),!c.existingValue&&!c.observedValue?c.reason:null]);const prior=groups.get(key);
  if(prior){prior.sourceIds=[...new Set([...prior.sourceIds,...c.sourceIds])];prior.reason=[...new Set([prior.reason,c.reason].filter(Boolean))].join(' · ')||null;prior.action=[...new Set([prior.action,c.action].filter(Boolean))].join(' · ')||null;}else groups.set(key,{...c,sourceIds:[...c.sourceIds]});
 }
 return [...groups.values()];
}

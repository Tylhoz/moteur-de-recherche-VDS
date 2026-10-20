import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import type { PrivateR2Bucket } from '../../worker/index.js';
import type { Client, Snapshot, RecordKind } from '../../src/types.js';
import type { PilotResponse, PilotDossier, PilotField, PilotSource } from '../../shared/pilot-contract.js';

export interface SheetTable { key: string; id: string; tab: string; gid: number; values: string[][]; }
export interface SheetsCapture { schemaVersion: 'sheets-tables-1'; readAt: string; tables: SheetTable[]; }
const prefix = 'vds/private/sheets360/';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const sections: Record<string, string> = { identite: 'Identité et coordonnées', commercial: 'Commercial', technique: 'Technique', chantier: 'Chantier', finances: 'Finances', sav: 'SAV', communications: 'Communications', agenda: 'Agenda', documents: 'Documents', actions: 'Actions et suivi', sources: 'Sources et rapprochements' };
const sectionFor: Record<string, string> = { CLIENTS:'identite', DOSSIERS:'commercial', DEVIS:'commercial', VENTES:'commercial', TECHNIQUE:'technique', CHANTIERS:'chantier', FACTURES:'finances', PAIEMENTS:'finances', SAV:'sav', COMMUNICATIONS:'communications', AGENDA:'agenda', DOCUMENTS:'documents', ACTIONS:'actions', SOURCES:'sources', VALIDATION:'actions', ALERTES:'actions', Incoherences_Detectees:'actions', Cockpit_Priorites:'actions', 'Dossiers Clients':'commercial', 'Feuille 1':'sav', Ventes_Verifiees_365J:'commercial' };
const kindFor: Record<string,RecordKind> = { DEVIS:'devis', VENTES:'ventes', CHANTIERS:'chantiers', FACTURES:'factures', SAV:'sav', 'Dossiers Clients':'devis', 'Feuille 1':'sav', Ventes_Verifiees_365J:'ventes' };
const text = (v: unknown) => v === null || v === undefined ? '' : String(v);
const populated = (v: string) => !!v.trim() && !/^(?:-|—|non renseigné|information non retrouvée|inconnu|n\/a)$/i.test(v.trim());
function safeLink(value: string): string | null {
  try { const u=new URL(value); return u.protocol==='https:' && !u.username && !u.password && !u.port &&
    (['docs.google.com','drive.google.com','mail.google.com','calendar.google.com'].includes(u.hostname) || u.hostname==='www.google.com'&&u.pathname==='/calendar/event') &&
    ![...u.searchParams.keys()].some(k=>/token|secret|password|signature|credential|api.?key/i.test(k)) ? u.href : null; } catch { return null; }
}
function rowUrl(t: SheetTable, row: number) { return `https://docs.google.com/spreadsheets/d/${t.id}/edit#gid=${t.gid}&range=A${row}:Z${row}`; }
function validateCapture(value: unknown): SheetsCapture {
  const x=value as SheetsCapture;
  if (!x || x.schemaVersion!=='sheets-tables-1' || !Number.isFinite(Date.parse(x.readAt)) || !Array.isArray(x.tables) || !x.tables.length || x.tables.length>64) throw Error('invalid_capture');
  const seen=new Set<string>();
  for(const t of x.tables){
    const k=`${t.id}:${t.tab}`;
    if(!/^[a-z]+$/.test(t.key)||!/^[A-Za-z0-9_-]{10,200}$/.test(t.id)||!t.tab||t.tab.length>100||!Number.isSafeInteger(t.gid)||t.gid<0||seen.has(k)||!Array.isArray(t.values)||t.values.length>10000)throw Error('invalid_table');
    seen.add(k);
    for(const r of t.values) if(!Array.isArray(r)||r.length>50||r.some(v=>typeof v!=='string'||v.length>30000))throw Error('invalid_cell');
  }
  return x;
}
export function createSheets360Store(bucket: PrivateR2Bucket, env: NodeJS.ProcessEnv) {
  let cache: {captures: SheetsCapture[]; digests: string[]; received: Record<string,{at:string;mode:string}>} | null=null;
  let queue=Promise.resolve<unknown>(undefined);
  async function json(key:string){const o=await bucket.get(prefix+key);return o?JSON.parse(await o.text()):null;}
  async function state(){
    const index=await json('index.json') ?? {sources:{}};
    const entries=Object.entries(index.sources) as [string,{digest:string;at:string;mode:string}][];
    const digests=entries.map(([,v])=>v.digest);
    if(cache && JSON.stringify(cache.digests)===JSON.stringify(digests))return {...cache,received:Object.fromEntries(entries.map(([k,v])=>[k,v]))};
    const captures:SheetsCapture[]=[];
    for(const digest of digests){if(!/^[a-f0-9]{64}$/.test(digest))throw Error('invalid_source_digest'); const obj=await json(`versions/${digest}.json`); if(!obj||hash(JSON.stringify(obj))!==digest)throw Error('invalid_source_version'); captures.push(validateCapture(obj));}
    return cache={captures,digests,received:Object.fromEntries(entries.map(([k,v])=>[k,v]))};
  }
  async function save(capture:SheetsCapture,mode:'manual'|'push'){
    const work=queue.then(async()=>{
      const grouped=new Map<string,SheetTable[]>();for(const t of capture.tables)grouped.set(t.id,[...(grouped.get(t.id)??[]),t]);
      const index=await json('index.json')??{sources:{}};
      for(const [id,tables] of grouped){
        const prev=index.sources[id];
        if(prev && Date.parse(capture.readAt)<Date.parse(prev.at))throw Error('older_source_rejected');
        if(mode==='push'){
          if(!prev)throw Error('source_not_authorized');
          const prior=await json(`versions/${prev.digest}.json`);
          const names=(a:SheetTable[])=>a.map(t=>`${t.key}:${t.tab}:${t.gid}`).sort().join('|');
          if(names(prior.tables)!==names(tables))throw Error('source_schema_changed');
          for(const t of tables){const before=prior.tables.find((p:SheetTable)=>p.tab===t.tab);const h=headerIndex(t);if(JSON.stringify(t.values[h])!==JSON.stringify(before.values[headerIndex(before)]))throw Error('source_headers_changed');
            if(t.tab==='Base_Centrale_360'){const oldIds=before.values.slice(1).map((r:string[])=>r[0]).filter(Boolean);const ids=t.values.slice(1).map(r=>r[0]).filter(Boolean);if(new Set(ids).size!==ids.length||oldIds.some((id:string)=>!ids.includes(id)))throw Error('source_dossiers_removed');}
          }
        }
        // Store changed source versions immutably; unchanged heartbeats update metadata only.
        const contentHash=hash(JSON.stringify(tables));
        if(prev?.contentHash===contentHash){index.sources[id]={...prev,at:capture.readAt,mode};continue;}
        const obj={schemaVersion:'sheets-tables-1',readAt:capture.readAt,tables};const body=JSON.stringify(obj),digest=hash(body);
        await bucket.put(prefix+`versions/${digest}.json`,body,{onlyIf:{etagDoesNotMatch:'*'}});
        index.sources[id]={digest,contentHash,at:capture.readAt,mode};
      }
      await bucket.put(prefix+'index.json',JSON.stringify(index));cache=null;
      return {accepted:true,sourceCount:grouped.size,sourceWrites:0,versions:Object.fromEntries([...grouped.keys()].map(id=>[id,index.sources[id].digest]))};
    });queue=work.catch(()=>{});return work;
  }
  return {
    state,
    async bootstrap(){
      const n=Number(env.VDS_SHEETS_BOOTSTRAP_CHUNKS||0);if(!n)return;
      if(!Number.isInteger(n)||n<1||n>180)throw Error('invalid_sheets_bootstrap');
      let encoded='';for(let i=0;i<n;i++){const v=env[`VDS_SHEETS_BOOTSTRAP_${i}`]??'';if(!/^[A-Za-z0-9+/=]+$/.test(v)||v.length>30000)throw Error('invalid_sheets_chunk');encoded+=v;}
      const compression=env.VDS_SHEETS_BOOTSTRAP_ENCODING||'gzip';
      if(!['gzip','brotli'].includes(compression))throw Error('invalid_sheets_encoding');
      const decode=compression==='brotli'?brotliDecompressSync:gunzipSync;
      const raw=decode(Buffer.from(encoded,'base64'),{maxOutputLength:8*1024*1024}).toString('utf8');
      if(hash(raw)!==env.VDS_SHEETS_BOOTSTRAP_SHA256)throw Error('invalid_sheets_hash');
      // Idempotent startup: never let an old bootstrap overwrite later push updates.
      const marker=prefix+'bootstrap-'+hash(raw)+'.json';
      if(!await bucket.get(marker)){await save(validateCapture(JSON.parse(raw)),'manual');await bucket.put(marker,'{}');}
      for(let i=0;i<n;i++)delete env[`VDS_SHEETS_BOOTSTRAP_${i}`];delete env.VDS_SHEETS_BOOTSTRAP_CHUNKS;
      const s=await state();return {workbooks:s.captures.length,tables:s.captures.reduce((n,c)=>n+c.tables.length,0)};
    },
    async receive(request:Request){
      const secret=env.VDS_SHEETS_PUSH_SECRET;
      if(!secret||secret.length<40)return new Response(null,{status:503});
      const time=request.headers.get('X-VDS-Timestamp')??'',signature=request.headers.get('X-VDS-Signature')??'';
      if(request.method!=='POST'||!/^\d{13}$/.test(time)||Math.abs(Date.now()-Number(time))>300000||!/^[a-f0-9]{64}$/.test(signature)||request.headers.get('Content-Type')!=='application/json')return new Response(null,{status:401});
      const raw=await request.text();if(Buffer.byteLength(raw)>4*1024*1024)return new Response(null,{status:413});
      const expected=createHmac('sha256',secret).update(time+'.'+raw).digest();
      if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))return new Response(null,{status:401});
      try{const input=JSON.parse(raw);
        if(input.schemaVersion==='sheets-heartbeat-1'){
          if(!Array.isArray(input.versions)||input.versions.length>10)throw Error('invalid_heartbeat');
          const work=queue.then(async()=>{const index=await json('index.json');if(!index)throw Error('source_missing');
            for(const v of input.versions){const prior=index.sources[v.id];if(!prior||v.digest!==prior.digest||Number(time)<Date.parse(prior.at))throw Error('source_revision_changed');}
            for(const v of input.versions)index.sources[v.id]={...index.sources[v.id],at:new Date(Number(time)).toISOString(),mode:'push'};
            await bucket.put(prefix+'index.json',JSON.stringify(index));return {accepted:true,sourceWrites:0};});queue=work.catch(()=>{});return Response.json(await work);
        }
        const capture=validateCapture(input);if(Math.abs(Date.parse(capture.readAt)-Number(time))>300000)throw Error('capture_timestamp_invalid');
        const result=await save(capture,'push');return Response.json(result);
      }catch{return Response.json({error:'source_requires_review',retainedPreviousVersion:true},{status:409});}
    },
  };
}
function headerIndex(t:SheetTable){return ['clients','sav'].includes(t.key)||t.tab==='Cockpit_Priorites'?3:0;}
export interface RowObservation {table:SheetTable; row:number; values:Record<string,string>; sourceId:string;}
export function buildSheetIndex(captures:SheetsCapture[],baseline:Snapshot){
  const tables=captures.flatMap(c=>c.tables), clients=new Map(baseline.clients.map(c=>[c.id,{...c}]));
  // Existing identities stay intact. New explicit source IDs are added, never merged by name.
  for(const t of tables.filter(t=>t.tab==='Base_Centrale_360'))for(const r of t.values.slice(1)){
    if(!/^VDS-\d{3,6}$/.test(r[0]??'')||!r[1])continue;
    if(!clients.has(r[0]))clients.set(r[0],{id:r[0],client:r[1],contact:r[2]||'',address:r[3]||'',modelTeam:r[4]||'',techMacon:r[5]||'',finance:r[6]||'',statusAction:r[7]||'',category:'non_verifie',contractHT:null,soldeAmount:null});
  }
  const rows=new Map<string,RowObservation[]>(), unmatched:RowObservation[]=[],relations=new Map<string,string|null>();
  for(const t of tables.filter(t=>t.key==='relational'&&t.tab==='DOSSIERS'))for(const r of t.values.slice(1)){
    const refs=r[2]?.match(/VDS-\d{3,6}/g)??[];const id=refs.length===1&&clients.has(refs[0])?refs[0]:null;
    for(const key of [r[0],r[1]])if(key)relations.set(`${t.id}:${key}`,id);
  }
  // Shared old references represent split/ambiguous dossiers, not proven associations.
  const inverse=new Map<string,string[]>();for(const [k,v]of relations)if(v&&k.includes(':DOS-'))inverse.set(v,[...(inverse.get(v)??[]),k]);
  for(const [v,ks]of inverse)if(ks.length>1)for(const [k,target]of relations)if(target===v)relations.set(k,null);
  const emails=new Map<string,Set<string>>();
  for(const c of clients.values())for(const e of c.contact.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)??[])emails.set(e,new Set([...(emails.get(e)??[]),c.id]));
  const seen=new Map<string,string>();let duplicates=0;
  for(const t of tables){if(t.tab==='SYNCHRONISATION')continue;const h=headerIndex(t),headers=t.values[h]??[];
    for(let n=h+1;n<t.values.length;n++){const raw=t.values[n];if(!raw.some(populated))continue;
      const values=Object.fromEntries(headers.map((k,i)=>[k,text(raw[i])])),sourceId=`sheets-${hash(`${t.id}:${t.tab}:${n+1}`).slice(0,20)}`;
      const row={table:t,row:n+1,values,sourceId};
      const references=[values.ID_Dossier,values['N° Dossier']].filter(Boolean);
      let id:string|null=null;
      if(references.length===1&&/^VDS-\d{3,6}$/.test(references[0])&&clients.has(references[0]))id=references[0];
      else if(t.key==='relational')id=relations.get(`${t.id}:${values.ID_Dossier||values.ID_Client}`)??null;
      else if(!references.length){const es=JSON.stringify(raw).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)??[];
        const candidates=new Set(es.flatMap(e=>[...(emails.get(e)??[])]));if(candidates.size===1)id=[...candidates][0];}
      if(!id){unmatched.push(row);continue;}
      const event=values.ID_Event||values.ID_Event_Google||values.ID_Thread||values.ID_Thread_Gmail;
      const dedup=event?`${id}:${t.key}:${t.tab}:${event}`:'';const content=JSON.stringify(values);
      if(dedup && seen.get(dedup)===content){duplicates++;continue;}if(dedup)seen.set(dedup,content);
      rows.set(id,[...(rows.get(id)??[]),row]);
    }
  }
  const modules:Record<string,string[]>={};for(const [id,observations]of rows)for(const r of observations){const kind=kindFor[r.table.tab];if(kind)modules[kind]=[...new Set([...(modules[kind]??[]),id])];}
  return {clients:[...clients.values()],rows,unmatched,duplicates,modules};
}
export function dossier360(client:Client,observations:RowObservation[],existing:PilotResponse|undefined,revision:string,readAt:string|null,continuous:boolean):PilotResponse{
  const data:PilotDossier=existing?structuredClone(existing.data):{id:client.id,name:client.client,scope:'Fiche 360° · informations issues des classeurs métier',summary:client.statusAction,
    matching:{status:'proposed_strong',description:'Dossier identifié par sa référence stable. Les rapprochements sans identifiant ou e-mail unique restent à vérifier.',keys:[client.id],humanValidated:false},status:'review',sections:[],sources:[],contradictions:[],nextActions:[],timeline:[],documents:[],agenda:[],counts:{documented:0,review:0,missing:0,unverified:0,excluded:0,obsolete:0,contradictions:0,humanValidated:0},lastSourceReadAt:readAt,limitations:[],productionApplied:false};
  for(const [id,label]of Object.entries(sections))if(!data.sections.some(s=>s.id===id))data.sections.push({id,label,fields:[]});
  const add=(section:string,field:PilotField)=>data.sections.find(s=>s.id===section)!.fields.push(field);
  const baseSource='original-'+client.id;
  data.sources.push({id:baseSource,label:'Archive initiale conservée · '+client.id,url:null,kind:'sheets',occurredAt:null,dateOriginal:null,status:'read'});
  for(const [section,label,value]of [['identite','Nom du dossier',client.client],['identite','Téléphone et e-mail',client.contact],['identite','Adresse du chantier',client.address],['technique','Modèle et équipe',client.modelTeam],['technique','Technique et maçonnerie',client.techMacon],['finances','Mention financière d’origine',client.finance],['commercial','Statut, dates et action d’origine',client.statusAction]]){
    add(section,{id:`base-${label}`,label,value:value||null,status:value?'unverified':'missing',sourceIds:[baseSource],note:'Valeur de l’archive conservée ; les observations plus récentes sont présentées séparément.',sourceStatus:null,humanValidated:false});
  }
  for(const o of observations){const {table:t,values:v,sourceId}=o;
    data.sources.push({id:sourceId,label:`${t.key==='complete'?'Base complète':t.key==='relational'?'Base relationnelle':t.key} · ${t.tab} · ligne ${o.row}`,url:rowUrl(t,o.row),kind:'sheets',occurredAt:readAt,dateOriginal:null,status:'read'});
    const sourceIds=[sourceId];
    for(const [label,value] of Object.entries(v)){
      const url=safeLink(value);if(!url)continue;
      const id=sourceId+'-link-'+hash(label).slice(0,8);const host=new URL(url).hostname;
      data.sources.push({id,label:label.replace(/_/g,' ')+' · référence du classeur',url,kind:host==='mail.google.com'?'gmail':url.includes('calendar')?'agenda':'attachment',occurredAt:null,dateOriginal:null,status:'identified'});sourceIds.push(id);
    }
    const section=sectionFor[t.tab];
    if(section)for(const [label,value]of Object.entries(v)){
      if(/^ID_|^Ancien_ID|^Client$/.test(label)||!populated(value))continue;
      add(section,{id:sourceId+'-'+label,label:label.replace(/_/g,' '),value,status:/finances/.test(section)?'unverified':'documented',sourceIds,
        note:section==='finances'?'Mention du classeur, sans vérification comptable ni preuve d’encaissement.':'Information transcrite du classeur ; document ou échange original non revérifié lors de cette synchronisation.',sourceStatus:'Observation Google Sheets',humanValidated:false});
    }
    if(t.tab==='Base_Centrale_360'){
      const base=[['N° Dossier','id'],['Client','client'],['Téléphone & Email','contact'],['Adresse du Chantier','address'],['Modèle, Volet & Équipe','modelTeam'],['Technique & Maçonnerie','techMacon'],['Contrat HT/TTC & Solde','finance'],['Statut, Dates & Action','statusAction']] as const;
      for(const [label,key]of base.slice(1)){const value=v[label];if(!populated(value||''))continue;
        const sec=key==='finance'?'finances':key==='techMacon'||key==='modelTeam'?'technique':['client','contact','address'].includes(key)?'identite':'commercial';
        add(sec,{id:sourceId+'-'+key,label:`${label} · observation Sheets`,value,status:key==='finance'?'unverified':'documented',sourceIds,note:'Source conservée séparément de l’archive et des autres classeurs.',sourceStatus:null,humanValidated:false});
        if(value!==client[key])data.contradictions.push({id:sourceId+'-difference-'+key,field:label,existingValue:client[key],observedValue:value,sourceIds:[baseSource,sourceId],reason:'La source actuelle diffère de l’archive conservée.',action:'Vérifier la valeur applicable ; aucune valeur contractuelle validée n’est écrasée.',status:'review'});
      }
      for(const label of ['Resume_Intelligent_360','Chronologie_Dossier','Qualification_Financiere','References_Documents'])if(populated(v[label]||''))add(label.includes('Financiere')?'finances':'commercial',{id:sourceId+label,label:label.replace(/_/g,' '),value:v[label],status:'unverified',sourceIds,note:'Synthèse figurant dans le classeur, non validation indépendante des sources.',sourceStatus:null,humanValidated:false});
    }
    if(['ALERTES','VALIDATION','Incoherences_Detectees'].includes(t.tab))data.contradictions.push({id:sourceId,field:v.Type_Anomalie||v.Objet_Arbitrage_Humain||v.Type_Validation_Humaine||'Contrôle de cohérence',existingValue:v.Source_A||v.Valeur_Option_A||v.Donnees_Retenues||null,observedValue:v.Source_B||v.Valeur_Option_B||v.Element_Financier||null,sourceIds,reason:v.Detail_Incoherence_Detectee||v.Description_Contradiction_ou_Risque||v.Detail_Ecart_Constates||v.Question_Pour_Equipe_VDS||null,action:v.Action_Corrective_Recommandee||v.Action_Humaine_Attendue||v.Resolution_Appliquee_ou_Requise||'Validation humaine nécessaire',status:'review'});
    for(const [k,val]of Object.entries(v))if(/Prochaine_Action|Action_Concrete|Action_Immediate|Action à faire|Prochaine Action/.test(k)&&populated(val))data.nextActions.push(val);
    if(['COMMUNICATIONS','AGENDA'].includes(t.tab)){
      const date=v.Date_Dernier_Message||v.Date_Heure_ISO||v.Date_Evenement||v.Date_Jour_Reelle||null;
      data.timeline.push({id:sourceId,dateOriginal:date,dateUTC:date&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(date)?date:null,eventDate:date&&/^\d{4}-\d{2}-\d{2}$/.test(date)?date:null,summary:v.Objet_Conversation||v.Objet_Mail||v.Intitule_Complet_Agenda||v.Titre_Complet_Summary||t.tab,category:t.tab==='AGENDA'?'agenda':'gmail',status:'unverified',sourceStatus:'Événement mentionné dans Sheets ; source originale non relue',sourceIds});
    }
    if(t.tab==='DOCUMENTS'){
      const url=safeLink(v.URL_Directe||v.Lien_Acces_Direct||'');
      if(url && !/calendar/.test(url))data.documents.push({id:sourceId,filename:v.Reference_Officielle||v.Nom_Fichier_ou_Ref||v.Categorie_Document||'Référence documentaire',mimeType:null,sourceIds,url,contentRead:false,visuallyChecked:false,status:'unverified',note:'Référence du classeur ; contenu non consulté. Un lien Agenda n’est pas compté comme document.'});
    }
    if(t.tab==='AGENDA')data.agenda.push({id:sourceId,title:v.Intitule_Complet_Agenda||v.Titre_Complet_Summary||'Événement mentionné',start:v.Date_Evenement||v.Date_Jour_Reelle||null,end:null,location:v.Lieu_Extrait||null,url:safeLink(v.Lien_Google_Calendar||v.Lien_Event_Calendar||''),sourceIds,status:'review',sourceStatus:v.Qualification_Date||v.Statut_Date||null,issues:['Association issue du classeur ; vérifier l’événement original et les éventuels reports.'],associationApproved:false,clientApprovalVerified:false,completionVerified:false});
  }
  data.nextActions=[...new Set(data.nextActions)];data.lastSourceReadAt=readAt;
  data.limitations=[...new Set([...data.limitations,'Les observations des classeurs sont affichées avec leur source, sans validation automatique des contrats, paiements ou dates.','Les rapprochements ambigus sont exclus de la fiche et restent dans la file « Sources à rapprocher ».'])];
  for(const section of data.sections)if(!section.fields.length)section.fields.push({id:section.id+'-missing',label:section.label,value:null,status:'missing',sourceIds:[],note:'Aucune information rattachée de façon suffisamment sûre dans les sources consultées.',sourceStatus:null,humanValidated:false});
  data.counts={documented:0,review:0,missing:0,unverified:0,excluded:0,obsolete:0,contradictions:data.contradictions.length,humanValidated:0};for(const s of data.sections)for(const f of s.fields)data.counts[f.status]++;
  return {data,meta:{lastReadAt:new Date().toISOString(),lastSourceReadAt:readAt,state:'ready',readOnly:true,revision,sourceMode:'sheets_observations',continuous}};
}

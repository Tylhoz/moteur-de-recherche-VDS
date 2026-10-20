import {useEffect, useState} from 'react';
import {AUTHENTICATION_REQUIRED_EVENT} from '../data/api-client';
interface SourceState {dossiers:number;fiches360:number;continuous:boolean;lastReadAt:string|null;duplicateRows:number;sources:{spreadsheetId:string;readAt:string;mode:string;tables:{name:string;rows:number}[]}[];unassigned:{id:string;table:string;source:string;row:number;url:string;values:Record<string,string>}[];}
export default function SheetsSources(){
 const [state,setState]=useState<SourceState|null>(null),[error,setError]=useState(false),[query,setQuery]=useState(''),[limit,setLimit]=useState(15);
 useEffect(()=>{let active=true,denied=false,pending=false;const controller=new AbortController();
  const purge=()=>{denied=true;setState(null);controller.abort();};
  const read=async()=>{if(pending||denied||document.visibilityState==='hidden')return;pending=true;try{const r=await fetch('/api/v1/sources360',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});if(r.status===401||r.status===403){purge();window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));return;}if(!r.ok)throw Error();const x=await r.json();if(!Array.isArray(x.sources)||!Array.isArray(x.unassigned)||!Number.isInteger(x.dossiers))throw Error();if(active){setState(x);setError(false);}}catch{if(active&&!denied)setError(true);}finally{pending=false;}};
  void read();const timer=setInterval(read,30000);window.addEventListener(AUTHENTICATION_REQUIRED_EVENT,purge);return()=>{active=false;clearInterval(timer);controller.abort();window.removeEventListener(AUTHENTICATION_REQUIRED_EVENT,purge);};},[]);
 if(!state)return <section className="connections-card"><h3>Sources des fiches 360°</h3><p>{error?'La lecture des sources est indisponible.':'Lecture des sources privées…'}</p></section>;
 const rows=state.unassigned.filter(r=>JSON.stringify(r.values).toLocaleLowerCase('fr').includes(query.toLocaleLowerCase('fr')));
 return <section className="connections-card"><h3>Google Sheets · fiches 360°</h3>
 <p><strong>{state.fiches360} fiches 360°</strong> · {state.sources.length} classeurs · {state.sources.reduce((n,s)=>n+s.tables.length,0)} onglets consultés.</p>
 <p>{state.continuous?'Synchronisation active : contrôle des sources chaque minute, affichage sous 30 secondes supplémentaires.':'Copie réelle disponible. Le script Google doit encore être autorisé pour activer les mises à jour automatiques.'}</p>
 <p>Dernière lecture commune des sources : {state.lastReadAt?new Date(state.lastReadAt).toLocaleString('fr-FR',{timeZone:'Asia/Bangkok'})+' · Bangkok':'non disponible'}. Aucun changement apporté aux feuilles sources.</p>
 <details><summary>Voir les classeurs et les onglets</summary>{state.sources.map(s=><div key={s.spreadsheetId}><a href={`https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit`} target="_blank" rel="noopener noreferrer">Ouvrir le classeur source</a><ul>{s.tables.map(t=><li key={t.name}>{t.name} · {Math.max(0,t.rows-1)} lignes après la première ligne</li>)}</ul></div>)}</details>
 <details><summary>Sources à rapprocher · {state.unassigned.length} lignes</summary>
 <p>Ces lignes sont conservées mais ne sont pas affectées à une fiche : identifiant absent, plusieurs dossiers possibles ou correspondance insuffisante. Aucun rapprochement fondé uniquement sur un nom.</p>
 <label>Rechercher une information<input value={query} onChange={e=>{setQuery(e.target.value);setLimit(15);}} placeholder="Nom, référence, e-mail…" /></label>
 {rows.slice(0,limit).map(r=><details key={r.id}><summary>{r.table} · ligne {r.row} · {Object.values(r.values).find(v=>v.length>5)?.slice(0,80)}</summary><dl>{Object.entries(r.values).filter(([,v])=>v).map(([k,v])=><div key={k}><dt>{k.replace(/_/g,' ')}</dt><dd style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{v}</dd></div>)}</dl><a href={r.url} target="_blank" rel="noopener noreferrer">Vérifier la ligne source</a></details>)}
 {rows.length>limit&&<button type="button" onClick={()=>setLimit(n=>n+15)}>Afficher 15 lignes supplémentaires</button>}</details>
 <p>{state.duplicateRows} répétitions strictement identiques regroupées dans l’affichage. Les versions sources sont conservées.</p>
 </section>;
}

import { DataError, digest, validateDataset, type Dataset } from './model.js';
import type { Provider } from './providers.js';

export class ReadonlyStore {
  private snapshot:Dataset|null=null;
  private inflight:Promise<void>|null=null;
  private lastAttemptMs=-Infinity;
  private revision:string|null=null;
  private lastSuccessAt:string|null=null;
  private lastChangedAt:string|null=null;
  private error:string|null=null;
  private changedRows=0;
  constructor(private provider:Provider, private refreshMs=30000,private now:()=>number=Date.now){
    if(!Number.isFinite(refreshMs)||refreshMs<1000)throw new Error('invalid_refresh_interval');
  }
  async refresh():Promise<void>{
    if(this.inflight)return this.inflight;
    if(this.now()-this.lastAttemptMs<this.refreshMs)return;
    this.lastAttemptMs=this.now();
    this.inflight=(async()=>{
      try {
        const next=validateDataset(await this.provider.read());
        for(const table of ['SOURCES','VALIDATION']){
          const key=table==='SOURCES'?'source_id':'validation_id';
          for(const old of this.snapshot?.tables[table]??[]){
            const current=next.tables[table]?.find(row=>row[key]===old[key]);
            if(!current)throw new DataError('immutable_history_removed');
            if(digest(current)!==digest(old))throw new DataError('immutable_observation_changed');
          }
        }
        const revision=digest(next);
        const timestamp=new Date(this.now()).toISOString();
        if(revision!==this.revision){
          const previous=new Set(Object.entries(this.snapshot?.tables??{}).flatMap(([t,rows])=>rows.map(r=>`${t}:${digest(r)}`)));
          const current=new Set(Object.entries(next.tables).flatMap(([t,rows])=>rows.map(r=>`${t}:${digest(r)}`)));
          this.changedRows=[...current].filter(r=>!previous.has(r)).length+[...previous].filter(r=>!current.has(r)).length;
          this.snapshot=next;this.revision=revision;this.lastChangedAt=timestamp;
        }else this.changedRows=0;
        this.lastSuccessAt=timestamp;this.error=null;
      }catch(e){this.error=e instanceof DataError?e.code:'source_read_failed';}
      finally{this.inflight=null;}
    })();
    return this.inflight;
  }
  status(){return {
    mode:'lecture_seule', provider:this.provider.kind,
    state:this.error?(this.snapshot?'stale':'unavailable'):(this.snapshot?'ready':'not_synchronized'),
    sourceConnected:this.provider.kind==='google_sheets'&&this.lastSuccessAt!==null&&this.error===null,
    liveSync:false, refreshStrategy:'lecture_a_la_demande', refreshIntervalMs:this.refreshMs,
    lastAttemptAt:Number.isFinite(this.lastAttemptMs)?new Date(this.lastAttemptMs).toISOString():null,
    lastSuccessAt:this.lastSuccessAt,lastChangedAt:this.lastChangedAt,revision:this.revision,
    changedRowVersions:this.changedRows,error:this.error,
    vosFactures:{connected:false,enabled:false},
  };}
  current():Dataset|null{return this.snapshot;}
}

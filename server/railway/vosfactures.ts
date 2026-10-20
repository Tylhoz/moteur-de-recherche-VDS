import {createHash} from 'node:crypto';
import type {PrivateR2Bucket} from '../../worker/index.js';
export type AccountingRow=Record<string,unknown> & {id:string|number};
export type AccountingCollection='clients'|'invoices'|'payments';
export interface AccountingState {schemaVersion:'vosfactures-1';at:string|null;lastAttemptAt:string|null;lastFullAt:string|null;error:string|null;collections:Record<AccountingCollection,Record<string,string>>;history:string[];runs?:string[];missing?:Partial<Record<AccountingCollection,string[]>>;}
const root='vds/private/vosfactures/';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const empty=():AccountingState=>({schemaVersion:'vosfactures-1',at:null,lastAttemptAt:null,lastFullAt:null,error:null,collections:{clients:{},invoices:{},payments:{}},history:[]});
interface ReadProgress {collection:AccountingCollection|null;page:number;recordsRead:number;completedCollections:number;elapsedMs:number;}
/** Never retain error messages or URLs: fetch errors can contain the API token. */
function networkCode(error:unknown,run:AbortSignal,request:AbortSignal):string{
 if(run.aborted)return 'provider_sync_timeout';
 if(request.aborted)return 'provider_request_timeout';
 const e=error as {name?:string;code?:string;cause?:{code?:string}};
 const code=e?.cause?.code??e?.code;
 if(['ENOTFOUND','EAI_AGAIN'].includes(code||''))return 'provider_dns_failed';
 if(['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code||''))return 'provider_tls_failed';
 if(['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code||'')||e?.name==='TimeoutError')return 'provider_request_timeout';
 if(['ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','UND_ERR_SOCKET'].includes(code||''))return 'provider_connection_failed';
 return 'provider_network_failed';
}
export function accountingConfiguration(env:NodeJS.ProcessEnv){return {configured:env.VDS_INVOICING_PROVIDER==='vosfactures'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(env.VDS_VOSFACTURES_ACCOUNT||'')&&!['app','www','aide','sugester'].includes(env.VDS_VOSFACTURES_ACCOUNT||'')&&!!env.VDS_VOSFACTURES_API_TOKEN&&env.VDS_VOSFACTURES_API_TOKEN.length>=16,enabled:env.VDS_VOSFACTURES_ENABLED==='true'};}
function sanitized(value:unknown):unknown{
 if(Array.isArray(value))return value.map(sanitized);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(?:token|password|secret|bank_account|swift|iban|view_url|payment_url)/i.test(k)).map(([k,v])=>[k,sanitized(v)]));
 return value;
}
async function boundedJson(r:Response){
 if(!r.headers.get('content-type')?.includes('application/json'))throw Error('provider_invalid_response');
 const reader=r.body?.getReader();if(!reader)throw Error('provider_invalid_response');let total=0;const parts:Uint8Array[]=[];
 try{for(;;){const x=await reader.read();if(x.done)break;total+=x.value.length;if(total>4*1024*1024)throw Error('provider_response_limit');parts.push(x.value);}return JSON.parse(Buffer.concat(parts).toString('utf8'));}finally{await reader.cancel().catch(()=>{});}
}
/** Only allowlisted GET list endpoints. There is no invoice write or send method. */
export function createVosFacturesStore(bucket:PrivateR2Bucket,env:NodeJS.ProcessEnv,request:typeof fetch=fetch,wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))){
 let running:Promise<unknown>|null=null;
 let started=0,progress:ReadProgress={collection:null,page:0,recordsRead:0,completedCollections:0,elapsedMs:0};
 const diagnostic=()=>({...progress,elapsedMs:started?Date.now()-started:0});
 const read=async(key:string)=>{const o=await bucket.get(root+key);return o?JSON.parse(await o.text()):null;};
 const state=async():Promise<AccountingState>=>await read('index.json')??empty();
 async function list(kind:AccountingCollection,previous:AccountingState,full:boolean,signal:AbortSignal){
  const path=kind==='payments'?'/banking/payments.json':`/${kind}.json`;
  const rows=new Map<string,AccountingRow>();const pages=new Set<string>();
  for(let page=1;page<=1000;page++){
   progress={...progress,collection:kind,page};
   if(signal.aborted)throw Error('provider_sync_timeout');
   const url=new URL(`https://${env.VDS_VOSFACTURES_ACCOUNT}.vosfactures.fr${path}`);
   url.searchParams.set('api_token',env.VDS_VOSFACTURES_API_TOKEN!);url.searchParams.set('page',String(page));url.searchParams.set('per_page','100');url.searchParams.set('period','all');if(kind!=='payments')url.searchParams.set('order','updated_at.desc');else url.searchParams.set('include','invoices');
   let response:Response|undefined;let body:unknown;
   for(let attempt=0;attempt<4;attempt++){
    // Bound each HTTP request, including its body, separately from the full import.
    // Manual redirects expose the status without forwarding credentials elsewhere.
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),30000);
    const requestSignal=AbortSignal.any([signal,timeout.signal]);
    let retryDelay:number|null=null;
    try{
     try{response=await request(url,{method:'GET',redirect:'manual',headers:{Accept:'application/json'},signal:requestSignal});}catch(error){throw Error(networkCode(error,signal,requestSignal));}
     if(response.status>=300&&response.status<400){await response.body?.cancel();throw Error('provider_redirect_refused');}
     if(response.status===429||response.status>=500){
      const retry=response.headers.get('retry-after');await response.body?.cancel();if(attempt===3)throw Error('provider_temporarily_unavailable');
      retryDelay=retry&&/^\d+$/.test(retry)?Math.min(Number(retry)*1000,30000):1000*2**attempt;
     }else{
      if(!response.ok){await response.body?.cancel();throw Error(response.status===401||response.status===403?'provider_access_denied':response.status===404?'provider_endpoint_not_found':'provider_read_failed');}
      try{body=await boundedJson(response);}catch(error){if(error instanceof SyntaxError)throw Error('provider_invalid_response');if(error instanceof Error&&/^provider_/.test(error.message))throw error;throw Error(networkCode(error,signal,requestSignal));}
     }
    }finally{clearTimeout(timer);}
    if(retryDelay===null)break;
    await wait(retryDelay);
   }
   if(!Array.isArray(body)||body.length>100)throw Error('provider_invalid_response');if(!body.length)return [...rows.values()];
   const signature=sha(JSON.stringify(body.map(v=>v.id)));if(pages.has(signature))throw Error('provider_pagination_stalled');pages.add(signature);
   let orderedOld=!full&&kind!=='payments'&&!!previous.at;
   for(const value of body){
    if(!value||typeof value!=='object'||!/^\d+$/.test(String(value.id)))throw Error('provider_record_invalid');
    const row=sanitized(value) as AccountingRow,id=String(row.id),prior=rows.get(id);
    if(prior&&JSON.stringify(prior)!==JSON.stringify(row))throw Error('provider_changed_during_read');rows.set(id,row);
    if(!prior)progress.recordsRead++;
    const changed=Date.parse(String(value.updated_at||''));if(!Number.isFinite(changed)||changed>=Date.parse(previous.at!)-86400000)orderedOld=false;
   }
   if(orderedOld)return [...rows.values()];
   await wait(200);
  }
  throw Error('provider_page_limit');
 }
 return {state,progress:()=>running?diagnostic():null,async journal(){const s=await state();return Promise.all((s.runs??[]).slice(-50).reverse().map(id=>read(`runs/${id}.json`)));},configuration:()=>accountingConfiguration(env),running:()=>!!running,
  async rows(){const s=await state();const out={clients:[],invoices:[],payments:[]} as Record<AccountingCollection,AccountingRow[]>;for(const k of Object.keys(out) as AccountingCollection[])for(const digest of Object.values(s.collections[k])){const value=await read(`versions/${digest}.json`);if(!value||sha(JSON.stringify(value))!==digest)throw Error('accounting_version_invalid');out[k].push({...value,...(s.missing?.[k]?.includes(String(value.id))?{_missingFromLatestFull:true}:{})});}return out;},
  async synchronize(){if(running)return running;const configuration=accountingConfiguration(env);if(!configuration.configured||!configuration.enabled)return {accepted:false,error:'vosfactures_not_configured',sourceWrites:0};
   started=Date.now();progress={collection:null,page:0,recordsRead:0,completedCollections:0,elapsedMs:0};
   running=(async()=>{const before=await state(),attempt=new Date().toISOString(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15*60000);const next=structuredClone(before);next.lastAttemptAt=attempt;const runId=sha(attempt+Math.random());const runKey=`runs/${runId}.json`;
    await bucket.put(root+runKey,JSON.stringify({at:attempt,state:'running',sourceWrites:0}));
    try{const full=!before.lastFullAt||Date.now()-Date.parse(before.lastFullAt)>86400000;let changed=0;
     for(const kind of ['clients','invoices','payments'] as AccountingCollection[]){const records=await list(kind,before,full,controller.signal);if(!records.length&&Object.keys(before.collections[kind]).length)throw Error('provider_empty_collection_requires_review');
      next.missing??={};const seen=new Set(records.map(r=>String(r.id)));next.missing[kind]=full?Object.keys(before.collections[kind]).filter(id=>!seen.has(id)):(before.missing?.[kind]??[]).filter(id=>!seen.has(id));for(const row of records){if(controller.signal.aborted)throw Error('provider_sync_timeout');const body=JSON.stringify(row),digest=sha(body);if(before.collections[kind][String(row.id)]!==digest){await bucket.put(root+`versions/${digest}.json`,body,{onlyIf:{etagDoesNotMatch:'*'}});changed++;}next.collections[kind][String(row.id)]=digest;}progress.completedCollections++;}
     next.at=attempt;next.error=null;next.runs=[...(before.runs??[]),runId];await bucket.put(root+runKey,JSON.stringify({at:attempt,state:'success',changed,sourceWrites:0}));if(full)next.lastFullAt=attempt;const checkpoint=JSON.stringify(before),checkpointHash=sha(checkpoint);await bucket.put(root+`checkpoints/${checkpointHash}.json`,checkpoint,{onlyIf:{etagDoesNotMatch:'*'}});next.history=[...new Set([...before.history,checkpointHash])];await bucket.put(root+'index.json',JSON.stringify(next));return {accepted:true,changed,counts:Object.fromEntries(Object.entries(next.collections).map(([k,v])=>[k,Object.keys(v).length])),sourceWrites:0};
    }catch(error){const code=error instanceof Error&&/^(provider_|accounting_)[a-z_]+$/.test(error.message)?error.message:'provider_sync_failed';const details=diagnostic();await bucket.put(root+runKey,JSON.stringify({at:attempt,state:'error',code,diagnostic:details,retainedPreviousVersion:true,sourceWrites:0}));await bucket.put(root+'index.json',JSON.stringify({...before,lastAttemptAt:attempt,error:code,runs:[...(before.runs??[]),runId]}));return {accepted:false,error:code,diagnostic:details,retainedPreviousVersion:true,sourceWrites:0};}finally{clearTimeout(timer);}
   })();try{return await running;}finally{running=null;}
  },
 };
}
/** Parse decimal amounts to integer cents. Invalid, ambiguous formats never become zero. */
export function cents(value:unknown):number|null{
 if(typeof value!=='string'&&typeof value!=='number')return null;const s=String(value).trim();if(!/^-?\d{1,12}(?:[.,]\d{1,2})?$/.test(s))return null;const negative=s.startsWith('-'),[whole,fraction='']=s.replace('-','').replace(',','.').split('.');const n=Number(whole)*100+Number(fraction.padEnd(2,'0'));return Number.isSafeInteger(n)?negative?-n:n:null;
}

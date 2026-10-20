import {BusinessSchemaError,validateBusinessSummary,validateBusinessPage,type BusinessQuery,type BusinessSummary,type BusinessPage,type BusinessDossierPage} from '../../shared/business-analytics-contract';
import {PortalApiError} from './api-client';
async function read(path:string,query:Partial<BusinessQuery>,signal:AbortSignal,fetcher:typeof fetch){
 const timeout=AbortSignal.timeout(15000),combined=AbortSignal.any([signal,timeout]);
 let response:Response;
 try{response=await fetcher(path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(query),credentials:'same-origin',cache:'no-store',redirect:'error',signal:combined});}
 catch{if(!signal.aborted)console.error('[VDS analytics]',{code:timeout.aborted?'analytics_timeout':'analytics_network_failed',endpoint:path});throw new PortalApiError('La synthèse est momentanément indisponible. La dernière lecture complète est conservée.');}
 if([401,403].includes(response.status))throw new PortalApiError('Votre session doit être renouvelée.',response.status);
 if(!response.ok){console.error('[VDS analytics]',{code:'analytics_http_error',endpoint:path,status:response.status});throw new PortalApiError(response.status===400?'Les filtres demandés ne sont pas valides.':'L’API d’analyse ne répond pas correctement.',response.status);}
 let value:unknown;
 try{const body=await response.text();if(new TextEncoder().encode(body).byteLength>300*1024)throw new BusinessSchemaError('response_size');value=JSON.parse(body);}catch(error){const path=error instanceof BusinessSchemaError?error.path:'json';console.error('[VDS analytics]',{code:'analytics_response_invalid',path});throw new PortalApiError('La réponse de synthèse est illisible ('+path+').');}
 return value;
}
function validated<T>(action:()=>T):T{try{return action();}catch(error){const path=error instanceof BusinessSchemaError?error.path:'schema';console.error('[VDS analytics]',{code:'analytics_schema_invalid',path});throw new PortalApiError('Les données d’analyse reçues ne sont pas exploitables ('+path+').');}}
export async function readBusinessSummary(query:Partial<BusinessQuery>,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<BusinessSummary>{const value=await read('/api/v1/analytics/query',query,signal,fetcher);return validated(()=>validateBusinessSummary(value));}
export async function readBusinessDetails(kind:'documents'|'dossiers',query:Partial<BusinessQuery>,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<BusinessPage|BusinessDossierPage>{const value=await read(kind==='documents'?'/api/v1/accounting360/documents':'/api/v1/analytics/dossiers',query,signal,fetcher);return validated(()=>validateBusinessPage(value,kind));}

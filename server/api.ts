import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ReadonlyStore } from './sync.js';
import { annotatedRow, dossierView, financeView, timelineView } from './views.js';
import { digest, uuid } from './model.js';
import type { PortalStore } from './portal.js';
import { buildAnalytics } from './analytics.js';
import type { PilotResponse } from '../shared/pilot-contract.js';

export interface ApiOptions { store:ReadonlyStore; portal?:PortalStore; bearerSha256?:string; allowedOrigins?:string[]; }
export function createApi({store,portal,bearerSha256,allowedOrigins=[]}:ApiOptions){
  if(bearerSha256&&!/^[a-f0-9]{64}$/i.test(bearerSha256))throw new Error('invalid_auth_configuration');
  for(const o of allowedOrigins){const u=new URL(o);if(u.protocol!=='https:'||u.origin!==o||u.username||u.password)throw new Error('invalid_origin_configuration');}
  function send(res:ServerResponse,status:number,body:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));}
  return createServer({maxHeaderSize:8192,requestTimeout:15000,headersTimeout:10000},async(req:IncomingMessage,res:ServerResponse)=>{
    res.setHeader('Cache-Control','private, no-cache, max-age=0, must-revalidate');res.setHeader('Vary','Authorization, Origin');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    try{
      if(!bearerSha256){send(res,503,{error:'authentication_not_configured'});return;}
      const supplied=req.headers.authorization;
      if(!supplied||!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(supplied)||!timingSafeEqual(createHash('sha256').update(supplied.slice(7)).digest(),Buffer.from(bearerSha256,'hex'))){res.setHeader('WWW-Authenticate','Bearer');send(res,401,{error:'authentication_required'});return;}
      const origin=req.headers.origin;
      if(origin&&!allowedOrigins.includes(origin)){send(res,403,{error:'origin_not_allowed'});return;}
      if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
      if(req.method!=='GET'){res.setHeader('Allow','GET');send(res,405,{error:'read_only_api'});return;}
      if(req.headers['transfer-encoding']||Number(req.headers['content-length']??0)>0){res.setHeader('Connection','close');send(res,400,{error:'request_body_not_allowed'});return;}
      const raw=req.url??'';const rawPath=raw.split('?')[0];
      if(!rawPath.startsWith('/api/v1/')||/%|\\|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)){send(res,404,{error:'not_found'});return;}
      const url=new URL(raw,'http://readonly.invalid');
      const pilotMatch=/^\/api\/v1\/pilot\/(VDS-\d{3})$/.exec(url.pathname);
      if(['/api/v1/portal-snapshot','/api/v1/pilot','/api/v1/connections','/api/v1/analytics'].includes(url.pathname)||pilotMatch){
        if(url.search){send(res,400,{error:'unsupported_query'});return;}
        if(!portal){send(res,503,{error:'portal_source_not_configured',message:'Source non connectée'});return;}
        await portal.refresh();
        const snapshot=portal.current();let body:unknown;
        if(url.pathname==='/api/v1/connections')body={sheets:portal.status(),pilot:portal.pilotSummary(),gmail:{continuousConnection:false,mode:'private_audit_snapshot'},agenda:{continuousConnection:false,mode:'private_audit_snapshot'},drive:{continuousConnection:false,mode:'references_only'},vosfactures:{connected:false,label:'Source non connectée'}};
        else if(!snapshot){send(res,503,{error:'portal_source_unavailable',message:'Synchronisation indisponible',synchronization:portal.status()});return;}
        else if(url.pathname==='/api/v1/portal-snapshot')body=snapshot;
        else if(url.pathname==='/api/v1/pilot')body=portal.pilotSummary();
        else if(url.pathname==='/api/v1/analytics')body=buildAnalytics(snapshot,
          (snapshot.enrichedClientIds??[]).map(id=>portal.pilot(id)).filter((pilot):pilot is PilotResponse=>!!pilot),
          {sourceAuditDate:portal.pilotSummary().auditDate});
        else {body=portal.pilot(pilotMatch![1]);if(!body){send(res,404,{error:'pilot_not_available_or_identity_requires_review',message:'Information non retrouvée ou identité à vérifier'});return;}}
        const sourceState=snapshot?.sourceState;
        if(sourceState?.lastReadAt)res.setHeader('X-VDS-Last-Read-At',sourceState.lastReadAt);
        if(sourceState?.lastAttemptAt)res.setHeader('X-VDS-Last-Attempt-At',sourceState.lastAttemptAt);
        res.setHeader('X-VDS-Source-Stale',String(sourceState?.stale??true));
        let etag:string;
        if(url.pathname==='/api/v1/portal-snapshot'&&snapshot){
          // Reading again is not a business-data change. Preserve every record and
          // state transition in the validator; only transport timestamps move to
          // headers. A weak ETag is required because those JSON bytes may differ.
          const {fetchedAt,...content}=snapshot;
          const {lastReadAt:_,lastAttemptAt:__,...state}=snapshot.sourceState??{};
          res.setHeader('X-VDS-Fetched-At',fetchedAt);
          etag=`W/"${digest({...content,sourceState:state})}"`;
        }else etag=`"${digest(body)}"`;
        res.setHeader('ETag',etag);
        if(req.headers['if-none-match']===etag){res.writeHead(304);res.end();return;}
        send(res,200,body);return;
      }
      const list=url.pathname==='/api/v1/dossiers';
      const params=[...url.searchParams.keys()];
      if(params.some(p=>!list||!['page','limit'].includes(p))||new Set(params).size!==params.length){send(res,400,{error:'unsupported_query'});return;}
      const pageText=url.searchParams.get('page')??'1';const limitText=url.searchParams.get('limit')??'25';
      if(!/^[1-9]\d{0,5}$/.test(pageText)||!/^[1-9]\d{0,2}$/.test(limitText)||Number(limitText)>100){send(res,400,{error:'invalid_pagination'});return;}
      const page=Number(pageText),limit=Number(limitText);
      const match=/^\/api\/v1\/dossiers\/([^/]+)(?:\/(timeline|documents|alertes|finances))?$/.exec(url.pathname);
      if(!['/api/v1/status','/api/v1/dossiers','/api/v1/finances'].includes(url.pathname)&&(!match||!uuid.test(match[1]))){send(res,404,{error:'not_found'});return;}
      await store.refresh();const status=store.status();
      if(status.lastSuccessAt)res.setHeader('X-VDS-Last-Sync',status.lastSuccessAt);
      res.setHeader('X-VDS-Sync-State',status.state);
      let body:unknown;
      if(url.pathname==='/api/v1/status')body=status;
      else{
        const data=store.current();if(!data){send(res,503,{error:status.error??'information_not_found',message:'Information non retrouvée',synchronization:status});return;}
        let result:unknown;
        if(list)result={items:data.tables.DOSSIERS.slice((page-1)*limit,page*limit).map(r=>annotatedRow(data,'DOSSIERS',r)),page,limit,total:data.tables.DOSSIERS.length};
        else if(url.pathname==='/api/v1/finances')result=financeView(data,undefined,status.state==='ready');
        else if(match){
          const id=match[1];if(!data.tables.DOSSIERS.some(r=>r.dossier_id===id)){send(res,404,{error:'dossier_not_found'});return;}
          if(match[2]==='timeline')result=timelineView(data,id);
          else if(match[2]==='documents'||match[2]==='alertes'){const table=match[2]==='documents'?'DOCUMENTS':'ALERTES';result=(data.tables[table]??[]).filter(r=>r.dossier_id===id).map(r=>annotatedRow(data,table,r));}
          else if(match[2]==='finances')result=financeView(data,id,status.state==='ready');
          else result=dossierView(data,id);
        }
        body={data:result,meta:{revision:status.revision,lastChangedAt:status.lastChangedAt,state:status.state,readOnly:true,missingValueLabel:'Information non retrouvée'}};
      }
      const etag=`"${digest(body)}"`;res.setHeader('ETag',etag);
      if(req.headers['if-none-match']===etag){res.writeHead(304);res.end();return;}
      send(res,200,body);
    }catch{send(res,500,{error:'internal_read_error'});}
  });
}

import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createWorker, readActive, type WorkerEnv } from '../../worker/index.js';
import { authenticatedRequest } from '../../worker/access.js';
import { handleIntegrationRequest, type ConnectedEnv } from '../../worker/integration-router.js';
import { createOwnerAuth } from './auth.js';
import { loginPage } from './login.js';
import { createSheets360Store, buildSheetIndex, dossier360 } from './sheets360.js';
import { createHash } from 'node:crypto';
import {createCommercialRules} from './rules.js';
import { appendFinancialDocuments } from './financial-fiche.js';
import { buildBusinessDataset,businessQuery,summarizeBusiness,pageBusinessDocuments,pageBusinessDossiers,BusinessQueryError,type BusinessDataset } from './business-analytics.js';
import {validateBusinessSummary,BusinessSchemaError,type BusinessSummary} from '../../shared/business-analytics-contract.js';
import { createVosFacturesStore } from './vosfactures.js';
import { accountingProjection } from './intelligence.js';
import { createMatchDecisions } from './approvals.js';
import { createMaterializedAnalytics, type MaterializedAnalytics } from './materialized-analytics.js';
import { consolidationStats, consolidateContradictions } from '../../shared/consolidation.js';
import { handleReviewRequest } from '../../worker/review-router.js';
import type { Snapshot } from '../../src/types.js';
import type { PrivateR2Bucket } from '../../worker/index.js';

const security = {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  // Keep Origin on same-origin HTML form POSTs; no-referrer makes some
  // browsers send Origin:null and breaks the login/logout CSRF check.
  'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status: number, failed = false) => new Response(loginPage(failed), { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
export function createRailwayApp(values: NodeJS.ProcessEnv, bucket: PrivateR2Bucket, assetsDirectory: string, maintenance?: {exportArchive:()=>Promise<Buffer>;restoreArchive:(bytes:Buffer)=>Promise<unknown>}) {
  const origin = values.VDS_PUBLIC_ORIGIN || (values.RAILWAY_PUBLIC_DOMAIN ? `https://${values.RAILWAY_PUBLIC_DOMAIN}` : '');
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('https_origin_required');
  const owner = values.VDS_OWNER_EMAIL || '';
  const auth = createOwnerAuth(owner, values.VDS_PASSWORD_HASH || '', values.VDS_SESSION_SECRET || '');
  const commit = values.RAILWAY_GIT_COMMIT_SHA || values.VDS_COMMIT_SHA || '';
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('release_commit_required');
  if (!/^[a-f0-9]{64}$/.test(values.VDS_EXPECTED_BUNDLE_SHA256 || '') ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(values.VDS_IMPORT_TOKEN || '')) throw new Error('private_import_configuration_required');
  const dist = resolve(assetsDirectory);
  const assets = { async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!['/', '/index.html'].includes(path) && !/^\/assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(path)) return json(404, { error: 'not_found' });
    const file = resolve(dist, path === '/' ? 'index.html' : path.slice(1));
    if (!mime[extname(file)]) return json(404, { error: 'not_found' });
    try {
      if (await realpath(file) !== file || !(await stat(file)).isFile()) return json(404, { error: 'not_found' });
      return new Response(await readFile(file), { headers: { 'Content-Type': mime[extname(file)] } });
    } catch { return json(404, { error: 'not_found' }); }
  } };
  const env: ConnectedEnv = { ...values, BUCKET: bucket, ASSETS: assets, VDS_PUBLIC_ORIGIN: origin,
    VDS_OWNER_EMAIL: owner, VDS_RELEASE_ID: 'vds-railway-2026-10', VDS_COMMIT_SHA: commit };
  const coreEnv: WorkerEnv = { ...env, BUCKET: bucket, ASSETS: assets, VDS_PUBLIC_ORIGIN: origin, VDS_OWNER_PRIVATE: 'true' };
  const worker = createWorker();
  const sheets360 = createSheets360Store(bucket, values);
  const accounting=createVosFacturesStore(bucket,values);
  const decisions=createMatchDecisions(bucket);
  const commercialRules=createCommercialRules(bucket);
  let viewCache: {key: string; index: ReturnType<typeof buildSheetIndex>} | null = null;
  const identity = { email: owner.toLowerCase(), subject: 'vds-owner' };
  let activeCache: Awaited<ReturnType<typeof readActive>> = null;
  let activeFlight: Promise<Awaited<ReturnType<typeof readActive>>> | null = null;
  async function activeView(){
    // readActive still checks the pointer and hashes the private bytes on every read.
    // Only the already validated projection is reused; concurrent reads share that work.
    if(activeFlight)return activeFlight;
    activeFlight=readActive(coreEnv,activeCache??undefined).then(active=>{activeCache=active;return active;});
    try{return await activeFlight;}finally{activeFlight=null;}
  }
  async function view(){
    const active=await activeView();if(!active)return null;const state=await sheets360.state();const key=active.digest+':'+state.digests.join(':');
    if(!viewCache||viewCache.key!==key)viewCache={key,index:buildSheetIndex(state.captures,active.bundle.snapshot,state.historyCaptures)};
    const index={...viewCache.index,rows:new Map(viewCache.index.rows),unmatched:[...viewCache.index.unmatched]};
    const links=await decisions.read();for(const link of links.filter(l=>l.externalId.startsWith('sheet:'))){const row=index.unmatched.find(r=>'sheet:'+r.sourceId===link.externalId);if(row&&createHash('sha256').update(JSON.stringify(row.values)).digest('hex')===link.externalDigest&&index.clients.some(c=>c.id===link.dossierId)){index.rows.set(link.dossierId,[...(index.rows.get(link.dossierId)??[]),row]);index.unmatched=index.unmatched.filter(r=>r!==row);}}
    const receipts=Object.values(state.received),continuous=receipts.length>0&&receipts.every(r=>r.mode==='push'&&Date.now()-Date.parse(r.at)<180000);
    const readAt=receipts.length?receipts.map(r=>r.at).sort()[0]:active.bundle.snapshot.sourceState?.lastReadAt??null;
    const financialState=await accounting.state();
    const financialKeyValue=financialKey(financialState,links,index.clients);
    const financialReady=financialCache?.key===financialKeyValue;
    const projectionPending=!!financialState.at&&accounting.configuration().enabled&&!financialReady;
    // Loading the dossier list or source status must never wait for 29,000 accounting objects.
    if(projectionPending)void financialView(index.clients).catch(()=>{});
    const revision=createHash('sha256').update(key).update(JSON.stringify(links)).update(JSON.stringify(financialState.collections)).update(projectionPending?'pending':'ready').digest('hex');
    const snapshot:Snapshot={...active.bundle.snapshot,clients:index.clients,enrichedClientIds:index.clients.map(c=>c.id),moduleClientIds:index.modules,dataCoverage:{historical:active.bundle.pilots.length,format360:index.clients.length,sheetsRelated:index.clients.filter(c=>index.rows.has(c.id)).length,sheetsContinuous:continuous,accountingRelated:financialReady?financialCache!.data.matchedDossiers.length:0,accountingProjectionPending:projectionPending,accountingConnected:!!financialState.at&&!financialState.error&&accounting.configuration().enabled,humanVerified:0},version:'sheets360:'+revision,fetchedAt:readAt||active.bundle.snapshot.fetchedAt,sourceState:{status:continuous?'ready':'not_connected',stale:!continuous,lastReadAt:readAt,lastAttemptAt:readAt,revision},connection:{mode:'readonly-api',intervalMs:30000,sheetReady:continuous,label:continuous?'Google Sheets · observations actualisées automatiquement':'Google Sheets · copie consultée · actualisation continue à activer'}};
    return {active,state,index,readAt,continuous,revision,snapshot};
  }
  type FinancialProjection=ReturnType<typeof accountingProjection>;
  let financialCache:{key:string;data:FinancialProjection;at:string|null}|null=null;
  let projectionError:string|null=null;
  let financialFlight:{key:string;promise:Promise<FinancialProjection>}|null=null;
  const emptyFinancial=accountingProjection({clients:[],invoices:[],payments:[]},[],values.VDS_VOSFACTURES_ACCOUNT||'unconfigured');
  function financialKey(state:Awaited<ReturnType<typeof accounting.state>>,links:Awaited<ReturnType<typeof decisions.read>>,clients:Snapshot['clients']){
    return createHash('sha256').update(JSON.stringify([values.VDS_VOSFACTURES_ACCOUNT,state.collections,state.missing,accounting.configuration().paymentsEnabled,links,clients.map(c=>[c.id,c.contact,c.client,c.address])])).digest('hex');
  }
  async function financialView(clients:Snapshot['clients']):Promise<FinancialProjection>{
    const state=await accounting.state(),links=await decisions.read(),key=financialKey(state,links,clients);
    if(financialCache?.key===key)return financialCache.data;
    if(financialFlight){
      if(financialFlight.key===key)return financialFlight.promise;
      // A newer source revision waits for the existing reader, then reads the current state.
      // There is never one full disk scan per concurrent browser request.
      await financialFlight.promise.catch(()=>{});
      return financialView(clients);
    }
    const promise=(async()=>{
      const rows=await accounting.rows(state),approved:Record<string,string>={};
      const byId=new Map(rows.clients.map(row=>[String(row.id),row]));
      for(const link of links){const row=byId.get(link.externalId);if(row&&createHash('sha256').update(JSON.stringify(row)).digest('hex')===link.externalDigest)approved[link.externalId]=link.dossierId;}
      const data=accountingProjection(rows,clients,values.VDS_VOSFACTURES_ACCOUNT||'unconfigured',approved);
      financialCache={key,data,at:state.at};projectionError=null;return data;
    })();
    financialFlight={key,promise};
    try{return await promise;}catch(error){projectionError=error instanceof Error&&error.message==='accounting_version_invalid'?'accounting_version_invalid':'accounting_projection_failed';console.error(JSON.stringify({event:'accounting_projection_failed',code:projectionError}));throw error;}finally{if(financialFlight?.promise===promise)financialFlight=null;}
  }
  // Binding prevents a cache from another account/owner/configuration being reused.
  const materialized=createMaterializedAnalytics(bucket,JSON.stringify(['business-analytics-2',owner.toLowerCase(),values.VDS_VOSFACTURES_ACCOUNT||'',accounting.configuration().paymentsEnabled]));
  let businessCache:MaterializedAnalytics|null=null;
  const summaries=new Map<string,BusinessSummary>();
  let restoreFlight:Promise<void>|null=null,prepareFlight:Promise<void>|null=null;
  let prepareQueued=false,lastPrepared=0,cachePending=true,cacheError:string|null=null;
  let sourceError:string|null=null;
  async function restoreAnalyticsCache(){
    if(!restoreFlight)restoreFlight=(async()=>{
      try{businessCache=await materialized.restore();}
      catch{cacheError='analytics_cache_invalid';console.error(JSON.stringify({event:'analytics_cache_restore_failed',code:cacheError}));}
    })();
    return restoreFlight;
  }
  function requestAnalyticsPreparation(){
    if(prepareQueued)return;
    prepareQueued=true;
    setImmediate(()=>{prepareQueued=false;if(prepareFlight)void prepareFlight.then(requestAnalyticsPreparation);else void prepareAnalytics();});
  }
  function checkedSummary(data:BusinessDataset,query:ReturnType<typeof businessQuery>,meta:BusinessSummary['meta']){
    const summary=validateBusinessSummary(summarizeBusiness(data,query,meta));
    if(Buffer.byteLength(JSON.stringify(summary))>256*1024)throw new BusinessSchemaError('summary_payload_limit');
    return summary;
  }
  async function prepareAnalytics(){
    if(prepareFlight)return prepareFlight;
    prepareFlight=(async()=>{
      await restoreAnalyticsCache();
      try{
        let current=await view();if(!current)throw new Error('private_sources_unavailable');
        let source=await accounting.state();sourceError=source.error;
        let expectedKey=financialKey(source,await decisions.read(),current.index.clients);
        cachePending=!businessCache||financialCache?.key!==expectedKey;
        const financial=await financialView(current.index.clients);
        // A source may advance while immutable records are being read. Publish only
        // a coherent revision, and schedule another pass if it changed meanwhile.
        current=await view();if(!current)throw new Error('private_sources_unavailable');
        source=await accounting.state();sourceError=source.error;
        expectedKey=financialKey(source,await decisions.read(),current.index.clients);
        if(financialCache?.key!==expectedKey||financialCache.data!==financial){cachePending=true;requestAnalyticsPreparation();return;}
        const revision=createHash('sha256').update(current.state.digests.join(':')).update(current.active.digest).update(expectedKey).update(JSON.stringify((await decisions.read()).filter(l=>l.externalId.startsWith('sheet:')))).update(new Date().toISOString().slice(0,10)).digest('hex');
        if(businessCache?.key===revision){businessCache.accountingReadAt=source.at;businessCache.sheetsReadAt=current.readAt;await materialized.updateDates(businessCache);}
        else{
          const data=buildBusinessDataset(current.index.clients,current.index.rows,financial);
          const meta:BusinessSummary['meta']={revision,accountingReadAt:source.at,sheetsReadAt:current.readAt,projectionPending:false,refreshing:false,error:null,paymentsEnabled:accounting.configuration().paymentsEnabled,readOnly:true};
          const defaults={account:checkedSummary(data,businessQuery({scope:'account'}),meta),dossiers:checkedSummary(data,businessQuery({}),meta)};
          const next:MaterializedAnalytics={key:revision,data,defaults,accountingReadAt:source.at,sheetsReadAt:current.readAt};
          await materialized.save(next); // Atomically switch only after the complete cache is durable.
          businessCache=next;summaries.clear();
        }
        cachePending=false;cacheError=null;lastPrepared=Date.now();
      }catch{
        cacheError=projectionError||'analytics_cache_prepare_failed';cachePending=true;lastPrepared=Date.now();
        console.error(JSON.stringify({event:'analytics_background_failed',code:cacheError,previousRetained:!!businessCache}));
      }
    })();
    try{await prepareFlight;}finally{prepareFlight=null;}
  }
  async function analyticsContext(){
    await restoreAnalyticsCache();
    if(!prepareFlight&&(!lastPrepared||Date.now()-lastPrepared>=60000))requestAnalyticsPreparation();
    const stored=businessCache;
    // Warm requests never scan source records or contact providers. Even a broken
    // new source leaves the last fully materialized dataset available here.
    if(stored)return {data:stored.data,defaults:stored.defaults,meta:{revision:stored.key,accountingReadAt:stored.accountingReadAt,sheetsReadAt:stored.sheetsReadAt,projectionPending:cachePending,refreshing:accounting.running()||cachePending,error:cacheError||sourceError,paymentsEnabled:accounting.configuration().paymentsEnabled,readOnly:true} as BusinessSummary['meta']};
    const current=await view();if(!current)return null;
    const data=buildBusinessDataset(current.index.clients,current.index.rows,emptyFinancial);
    const meta:BusinessSummary['meta']={revision:'preparing:'+current.revision,accountingReadAt:null,sheetsReadAt:current.readAt,projectionPending:true,refreshing:true,error:cacheError||projectionError,paymentsEnabled:accounting.configuration().paymentsEnabled,readOnly:true};
    return {data,defaults:null,meta};
  }
  async function readAnalyticsQuery(request:Request){
    if(request.method==='GET'){
      const url=new URL(request.url);if(url.pathname!=='/api/documents')return businessQuery({});
      const query:Record<string,unknown>={scope:'account'};
      for(const [key,value]of url.searchParams){if(!['page','limit'].includes(key)||url.searchParams.getAll(key).length!==1||!/^\d+$/.test(value))throw new BusinessQueryError('pagination');query[key==='limit'?'pageSize':'page']=Number(value);}
      return businessQuery(query);
    }
    if(request.method!=='POST')throw new BusinessQueryError('method');
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new BusinessQueryError('content_type');
    const body=await request.text();if(Buffer.byteLength(body)>8192)throw new BusinessQueryError('request_size');
    let value:unknown;try{value=JSON.parse(body);}catch{throw new BusinessQueryError('json');}return businessQuery(value);
  }
  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== origin || /%|\\|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(url.pathname) || url.search&&url.pathname!=='/api/documents') return json(400, { error: 'invalid_request' });
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return json(405, { error: 'method_not_allowed' });
    if (url.pathname === '/api/sheets-sync') {const result=await sheets360.receive(request);if(result.ok)requestAnalyticsPreparation();return result;}
    if (request.method === 'POST' && request.headers.get('Origin') !== origin) return json(403, { error: 'same_origin_required' });
    if (url.pathname === '/auth/login') {
      if (request.method !== 'POST') return html(200);
      if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return json(415, { error: 'form_required' });
      const body = await request.text();
      if (body.length > 8192) return json(413, { error: 'body_too_large' });
      const form = new URLSearchParams(body);
      const cookie = await auth.login(form.get('email') || '', form.get('password') || '');
      return cookie ? new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': cookie } }) : html(401, true);
    }
    if (!auth.verify(request)) return url.pathname.startsWith('/api/') ?
      json(401, { error: 'authentication_required' }) : new Response(null, { status: 303, headers: { Location: '/auth/login' } });
    if (url.pathname === '/auth/logout') return request.method === 'POST' ?
      new Response(null, { status: 303, headers: { Location: '/auth/login', 'Set-Cookie': auth.clear } }) : json(405, { error: 'method_not_allowed' });
    if (url.pathname.startsWith('/api/internal/')) return json(404, { error: 'not_found' });
    if (url.pathname === '/api/v1/release') return request.method === 'POST' ? json(405, { error: 'method_not_allowed' }) :
      json(200, { runtime: 'railway-node', authentication: 'owner-session', release: env.VDS_RELEASE_ID, commit, authenticated: true });
    if (url.pathname === '/api/v1/setup') {
      if (request.method === 'POST') return json(405, { error: 'method_not_allowed' });
      const active = await activeView();
      const sheetState = await sheets360.state();
      const sheetIndex = active && sheetState.captures.length ? buildSheetIndex(sheetState.captures, active.bundle.snapshot) : null;
      return json(200, {
        schemaVersion: 'cloudflare-setup-1', runtime: 'railway-node', authentication: 'owner-session',
        authenticated: true, ownerAuthorized: true, ready: !!active,
        configuration: { access: true, origin: true, assets: true, storage: true, importToken: true, expectedBundle: true, release: true },
        storage: { state: active ? 'ready' : 'empty', dossiers: sheetIndex?.clients.length ?? active?.bundle.snapshot.clients.length ?? null, enriched: sheetIndex?.clients.length ?? active?.bundle.pilots.length ?? null },
        release: { id: env.VDS_RELEASE_ID, commit }, sourceWrites: 0,
      });
    }
    const rule=/^\/api\/v1\/commercial-rules\/(VDS-\d{3,6})$/.exec(url.pathname);if(rule){const current=await view();if(!current?.index.clients.some(c=>c.id===rule[1]))return json(404,{error:'dossier_not_found'});if(request.method==='GET')return json(200,await commercialRules.read(rule[1]));if(request.method!=='POST'||request.headers.get('X-VDS-Action')!=='commercial-rule')return json(400,{error:'explicit_rule_required'});try{return json(200,await commercialRules.save(rule[1],await request.json()));}catch{return json(409,{error:'invalid_rule_or_version_changed'});}}
    if(url.pathname==='/api/v1/backups/export'){
      if(request.method!=='GET')return json(405,{error:'method_not_allowed'});if(!maintenance)return json(503,{error:'backup_not_available'});
      const bytes=await maintenance.exportArchive();return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/gzip','Content-Disposition':'attachment; filename="VDS-volume-private-backup.json.gz"','X-VDS-Backup-SHA256':createHash('sha256').update(bytes).digest('hex')}});
    }
    if(url.pathname==='/api/v1/backups/restore'){
      if(request.method!=='POST'||request.headers.get('X-VDS-Action')!=='restore-empty-volume')return json(400,{error:'explicit_empty_restore_required'});
      if(!maintenance)return json(503,{error:'backup_not_available'});const bytes=Buffer.from(await request.arrayBuffer());
      if(bytes.length>64*1024*1024||request.headers.get('X-VDS-Backup-SHA256')!==createHash('sha256').update(bytes).digest('hex'))return json(400,{error:'backup_digest_invalid'});
      try{return json(200,await maintenance.restoreArchive(bytes));}catch{return json(409,{error:'restore_refused_volume_must_be_empty_or_backup_invalid'});}
    }
    if(url.pathname==='/api/v1/sync360'){
      if(request.method==='POST'){
        if(request.headers.get('X-VDS-Action')!=='synchronize')return json(400,{error:'explicit_sync_required'});
        const refresh=await sheets360.requestRefresh();
        if(!accounting.configuration().configured||!accounting.configuration().enabled)return json(202,{accepted:true,accounting:'not_configured',sheets:'refresh_requested_waiting_google_script',...refresh,sourceWrites:0});
        void accounting.synchronize().finally(requestAnalyticsPreparation).catch(()=>{});return json(202,{accepted:true,state:'running',sourceWrites:0});
      }
      if(request.method!=='GET')return json(405,{error:'method_not_allowed'});
      const current=await view();if(!current)return json(503,{error:'private_data_not_loaded'});const {active,index,state,continuous,revision,readAt}=current;
      const accountingState=await accounting.state(),currentFinancialKey=financialKey(accountingState,await decisions.read(),index.clients);
      const projectionPending=financialCache?.key!==currentFinancialKey&&!!accountingState.at;
      const financial=financialCache?.key===currentFinancialKey?financialCache.data:emptyFinancial;
      const fiches=index.clients.map(c=>dossier360(c,index.rows.get(c.id)??[],active.bundle.pilots.find(p=>p.data.id===c.id),revision,readAt,continuous));
      const stats=fiches.map(f=>consolidationStats(f.data));
      return json(200,{schemaVersion:'sync360-1',revision,dossiers:index.clients.length,historicalEnriched:active.bundle.pilots.length,format360:fiches.length,sheetsRelated:index.clients.filter(c=>index.rows.has(c.id)).length,accountingRelated:financial.matchedDossiers.length,humanVerified:0,sheets:{continuous,lastReadAt:readAt,workbooks:state.captures.length,tabs:state.captures.flatMap(c=>c.tables).length,history:await sheets360.history(),refreshRequest:await sheets360.refreshStatus()},accounting:{...accounting.configuration(),projectionPending,running:accounting.running(),progress:accounting.progress(),connected:!!accountingState.at&&!accountingState.error&&accounting.configuration().enabled,lastReadAt:accountingState.at,lastAttemptAt:accountingState.lastAttemptAt,error:accountingState.error,sourceWrites:0,journal:await accounting.journal()},consolidated:stats.reduce((n,s)=>n+s.fields+s.events+s.conflicts,0),conflicts:fiches.reduce((n,f)=>n+consolidateContradictions(f.data.contradictions).length,0),rawConflicts:fiches.reduce((n,f)=>n+f.data.contradictions.length,0),matches:financial.matches,unassignedSheets:index.unmatched.map(r=>({id:'sheet:'+r.sourceId,table:r.table.tab,row:r.row,name:r.values.Client||null,url:`https://docs.google.com/spreadsheets/d/${r.table.id}/edit#gid=${r.table.gid}&range=A${r.row}:Z${r.row}`})),validatedLinks:(await decisions.read()).length});
    }
    if(url.pathname==='/api/v1/matching/approve'){
      if(request.method!=='POST'||request.headers.get('X-VDS-Action')!=='approve-link')return json(400,{error:'explicit_matching_required'});
      const body=await request.json() as any;const current=await view();if(!current||body.revision!==current.revision)return json(409,{error:'source_version_changed'});
      if(typeof body.externalId!=='string'||typeof body.dossierId!=='string'||!current.index.clients.some(c=>c.id===body.dossierId))return json(400,{error:'invalid_match'});
      const row=body.externalId.startsWith('sheet:')?current.index.unmatched.find(r=>'sheet:'+r.sourceId===body.externalId)?.values:(await accounting.rows()).clients.find(r=>String(r.id)===body.externalId);
      if(!row)return json(409,{error:'external_source_changed'});
      await decisions.save({externalId:body.externalId,dossierId:body.dossierId,externalDigest:createHash('sha256').update(JSON.stringify(row)).digest('hex'),at:new Date().toISOString(),actor:createHash('sha256').update(owner).digest('hex')});requestAnalyticsPreparation();return json(200,{saved:true,sourceWrites:0});
    }
    if(url.pathname==='/api/v1/reviews'){const current=await view();return await handleReviewRequest(request,coreEnv,identity,async()=>current?.snapshot??null)??json(404,{error:'not_found'});}
    if(url.pathname.startsWith('/api/v1/sources360/version/')){if(request.method!=='GET')return json(405,{error:'method_not_allowed'});const version=await sheets360.version(url.pathname.split('/').at(-1)!);return version?json(200,version):json(404,{error:'version_not_found'});}
    if(['/api/analyses','/api/documents','/api/v1/analytics','/api/v1/intelligence360','/api/v1/analytics/query','/api/v1/accounting360/documents','/api/v1/analytics/dossiers'].includes(url.pathname)){
      if(!['GET','POST'].includes(request.method))return json(405,{error:'method_not_allowed'});
      const query=await readAnalyticsQuery(request),context=await analyticsContext();if(!context)return json(503,{error:'private_data_not_loaded'});
      const {data,meta}=context;
      if(['/api/documents','/api/v1/accounting360/documents'].includes(url.pathname))return json(200,{...pageBusinessDocuments(data,query,meta.revision),meta});
      if(url.pathname==='/api/v1/analytics/dossiers')return json(200,{...pageBusinessDossiers(data,query,meta.revision),meta});
      const cacheKey=JSON.stringify([meta.revision,query]);let body=summaries.get(cacheKey);
      const isDefault=!query.year&&!query.from&&!query.to&&!query.model&&!query.status&&!query.financialStatus&&!query.search&&!query.chart&&!query.point;
      if(!body){body=isDefault&&context.defaults?context.defaults[query.scope]:checkedSummary(data,query,meta);if(summaries.size>=30)summaries.delete(summaries.keys().next().value!);summaries.set(cacheKey,body);}
      body={...body,meta};
      const response=json(200,body);response.headers.set('ETag','"'+createHash('sha256').update(JSON.stringify(body)).digest('hex')+'"');return response;
    }
    if(url.pathname==='/api/v1/accounting360'){
      if(request.method!=='GET')return json(405,{error:'method_not_allowed'});const current=await view();if(!current)return json(503,{error:'private_data_not_loaded'});
      // Compatibility view is also bounded. Immutable records remain only on the private volume.
      const financial=await financialView(current.index.clients),dataset=buildBusinessDataset(current.index.clients,current.index.rows,financial),page=pageBusinessDocuments(dataset,businessQuery({scope:'account'}),financialCache!.key),source=await accounting.state();
      return json(200,{schemaVersion:'accounting-page-1',ledger:page.items,total:page.total,page:page.page,pageSize:page.pageSize,matchedDossiers:financial.matchedDossiers.slice(0,100),totals:financial.totals,sourceState:{at:source.at,lastAttemptAt:source.lastAttemptAt,error:source.error},sourceWrites:0});
    }
    const detail = /^\/api\/v1\/pilot\/(VDS-\d{3,6})$/.exec(url.pathname);
    if (request.method === 'GET' && (detail || ['/api/v1/portal-snapshot', '/api/v1/sources360'].includes(url.pathname))) {
      const current=await view();if(!current)return json(503,{error:'private_data_not_loaded'});
      const {active,state,index,continuous,readAt,revision,snapshot}=current;
      let body: unknown;
      if (detail) {
        const client = index.clients.find(c=>c.id===detail[1]);
        if (!client) return json(404,{error:'dossier_not_found'});
        body = appendFinancialDocuments(dossier360(client,index.rows.get(client.id)??[],active.bundle.pilots.find(p=>p.data.id===client.id),revision,readAt,continuous),(await financialView(index.clients)).ledger);
      } else if(url.pathname==='/api/v1/sources360') {
        body = {dossiers:index.clients.length, fiches360:index.clients.length, continuous, lastReadAt:readAt, intervalSeconds:60,
          duplicateRows:index.duplicates, unassigned:index.unmatched.map(r=>({id:r.sourceId,table:r.table.tab,source:r.table.key,row:r.row,
            url:`https://docs.google.com/spreadsheets/d/${r.table.id}/edit#gid=${r.table.gid}&range=A${r.row}:Z${r.row}`,values:r.values})),
          sources:state.captures.map(c=>({spreadsheetId:c.tables[0].id,readAt:state.received[c.tables[0].id]?.at,mode:state.received[c.tables[0].id]?.mode,
            tables:c.tables.map(t=>({name:t.tab,rows:t.values.length,source:t.key}))})),sourceWrites:0};
      } else {
        body = snapshot;
      }
      const response=json(200,body);
      response.headers.set('ETag','"'+createHash('sha256').update(JSON.stringify(body)).digest('hex')+'"');
      return response;
    }
    const verified = authenticatedRequest(request, identity);
    return await handleIntegrationRequest(verified, env, identity) ?? await worker.fetch(verified, coreEnv);
  }
  return { origin, env, sheets360, accounting, restoreAnalyticsCache, prepareAnalytics, async auditSummary(){const current=await view();if(!current)return {dossiers:0};const financial=await financialView(current.index.clients);return {dossiers:current.index.clients.length,historicalAudited:current.active.bundle.pilots.length,matchedSheets:current.index.clients.filter(c=>current.index.rows.has(c.id)).length,matchedAccounting:financial.matchedDossiers.length,unassignedSourceRows:current.index.unmatched.length,sourceWrites:0};}, async fetch(request: Request) {
    let response: Response;
    try { response = await route(request); } catch(error) { const queryError=error instanceof BusinessQueryError;const schemaError=error instanceof BusinessSchemaError;console.error(JSON.stringify({event:'private_api_error',code:queryError?error.code:schemaError?error.code:'private_service_unavailable',...(queryError||schemaError?{path:error.path}:{})}));response = json(queryError?400:503, { error:queryError?'analytics_query_invalid':'private_service_unavailable',...(queryError||schemaError?{diagnostic:error.path}:{}) }); }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(security)) headers.set(key, value);
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  } };
}

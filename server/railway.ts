import { createServer } from 'node:http';
import { resolve, relative } from 'node:path';
import { openPrivateStorage } from './railway/storage.js';
import { createRailwayApp } from './railway/app.js';
import { runScheduledSync } from '../worker/integration-router.js';
import { bootstrapPrivateArchive } from './railway/bootstrap.js';
import { backgroundSchedule } from './railway/background-schedule.js';

let startupStage='configuration';
async function start() {
  const root = resolve(process.env.VDS_PRIVATE_DATA_ROOT || '/data');
  const dist = resolve('dist');
  if (!relative(dist, root).startsWith('..') || !relative(process.cwd(), root).startsWith('..'))
    throw new Error('private_volume_must_be_outside_application');
  if (process.env.VDS_VOLUME_LOCKED !== 'true') throw new Error('start_with_volume_lock');
  startupStage='private_storage_open';
  const storage = await openPrivateStorage(root);
  startupStage='private_checkpoint';
  console.log(JSON.stringify({event:'startup_stage',stage:startupStage}));
  const checkpoint=await storage.createCheckpoint();
  console.log(JSON.stringify({privateCheckpointVerified:true,objects:checkpoint.objects,created:checkpoint.created}));
  startupStage='application_configuration';
  const app = createRailwayApp(process.env, storage.bucket, dist, storage);
  startupStage='archive_bootstrap';
  const archive = await bootstrapPrivateArchive({ ...app.env, BUCKET: storage.bucket, ASSETS: app.env.ASSETS!,
    VDS_PUBLIC_ORIGIN: app.origin, VDS_OWNER_PRIVATE: 'true' }, process.env);
  if (archive) console.log(JSON.stringify({ privateArchiveReady: true, dossiers: archive.dossiers, enriched: archive.enriched }));
  startupStage='sheets_bootstrap';
  const sheetImport = await app.sheets360.bootstrap();
  if (sheetImport) console.log(JSON.stringify({sheetsObservationsReady: true, ...sheetImport}));
  startupStage='analytics_cache_restore';
  await app.restoreAnalyticsCache();
  startupStage='http_configuration';
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.url === '/healthz' && ['GET', 'HEAD'].includes(incoming.method || '')) {
        outgoing.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        outgoing.end(incoming.method === 'HEAD' ? '' : 'ok'); return;
      }
      if (incoming.headers.host !== new URL(app.origin).host || !incoming.url?.startsWith('/') || incoming.url.startsWith('//'))
        { outgoing.writeHead(400); outgoing.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > (incoming.url === '/api/v1/backups/restore' ? 64 : 4) * 1024 * 1024) { outgoing.writeHead(413); outgoing.end(); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const method = incoming.method || 'GET';
      const request = new Request(`${app.origin}${incoming.url}`, { method, headers,
        ...(!['GET', 'HEAD'].includes(method) ? { body: Buffer.concat(chunks) } : {}) });
      const response = await app.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.maxHeadersCount = 64;
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port_invalid');
  const synchronizeAccounting=async()=>{
    try{
      const result=await app.accounting.synchronize() as {accepted?:boolean;error?:string;counts?:Record<string,number>;diagnostic?:unknown};
      console.log(JSON.stringify({accountingReadOnly:true,accepted:result.accepted===true,error:result.error??null,counts:result.counts??null,diagnostic:result.diagnostic??null}));
    }finally{await app.prepareAnalytics();}
  };
  startupStage='background_schedule';
  const schedule=backgroundSchedule(process.env);
  const ingest=()=>{if(app.accounting.configuration().enabled&&app.accounting.configuration().configured)void schedule.run(synchronizeAccounting).catch(()=>{});};
  server.listen(port, '0.0.0.0', () => {
    startupStage='ready';
    console.log('VDS Railway server ready');
    console.log(JSON.stringify({accountingBackgroundSchedule:schedule.mode,intervalSeconds:schedule.intervalSeconds,utcHour:schedule.utcHour}));
    // Prepare the already stored sources independently of slow external APIs.
    void app.prepareAnalytics();ingest();
  });
  const sync = setInterval(ingest,60_000);
  const local = setInterval(()=>{void app.prepareAnalytics();},60_000);
  const sheets = setInterval(()=>{void runScheduledSync(app.env).then(()=>app.prepareAnalytics()).catch(()=>{});},5*60_000);
  sync.unref();local.unref();sheets.unref();
  const stop = () => { clearInterval(sync);clearInterval(local);clearInterval(sheets); server.close(() => void storage.close().then(() => process.exit(0))); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
start().catch((error:unknown) => {
  const codes=new Set(['private_volume_must_be_outside_application','start_with_volume_lock','storage_symlink','storage_object_invalid','restore_incomplete','backup_object_limit','backup_archive_limit','checkpoint_verification_failed','https_origin_required','owner_auth_configuration_required','release_commit_required','private_import_configuration_required','port_invalid','background_schedule_invalid']);
  const systemCode=error&&typeof error==='object'&&'code'in error?String(error.code):'';
  const code=/^[A-Z][A-Z0-9_]{1,63}$/.test(systemCode)?systemCode:error instanceof Error&&codes.has(error.message)?error.message:'startup_failed';
  // No raw exception, file path, configuration value or customer content.
  console.error(JSON.stringify({event:'startup_refused',stage:startupStage,code}));process.exitCode=1;
});

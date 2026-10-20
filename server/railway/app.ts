import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createWorker, readActive, type WorkerEnv } from '../../worker/index.js';
import { authenticatedRequest } from '../../worker/access.js';
import { handleIntegrationRequest, type ConnectedEnv } from '../../worker/integration-router.js';
import { createOwnerAuth } from './auth.js';
import { loginPage } from './login.js';
import { createSheets360Store, buildSheetIndex, dossier360 } from './sheets360.js';
import { createHash } from 'node:crypto';
import { buildAnalytics } from '../analytics.js';
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
export function createRailwayApp(values: NodeJS.ProcessEnv, bucket: PrivateR2Bucket, assetsDirectory: string) {
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
  let viewCache: {key: string; index: ReturnType<typeof buildSheetIndex>} | null = null;
  const identity = { email: owner.toLowerCase(), subject: 'vds-owner' };
  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== origin || /%|\\|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(url.pathname) || url.search) return json(400, { error: 'invalid_request' });
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return json(405, { error: 'method_not_allowed' });
    if (url.pathname === '/api/sheets-sync') return sheets360.receive(request);
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
      const active = await readActive(coreEnv);
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
    const detail = /^\/api\/v1\/pilot\/(VDS-\d{3,6})$/.exec(url.pathname);
    if (request.method === 'GET' && (detail || ['/api/v1/portal-snapshot', '/api/v1/sources360', '/api/v1/analytics'].includes(url.pathname))) {
      const active = await readActive(coreEnv);
      if (!active) return json(503, {error: 'private_data_not_loaded'});
      const state = await sheets360.state();
      const key = active.digest + ':' + state.digests.join(':');
      if (!viewCache || viewCache.key !== key) viewCache = {key, index: buildSheetIndex(state.captures, active.bundle.snapshot)};
      const index = viewCache.index;
      const receipts = Object.values(state.received);
      const continuous = receipts.length > 0 && receipts.every(r => r.mode === 'push' && Date.now()-Date.parse(r.at)<180000);
      const readAt = receipts.length ? receipts.map(r=>r.at).sort()[0] : active.bundle.snapshot.sourceState?.lastReadAt ?? null;
      const revision = createHash('sha256').update(key).digest('hex');
      const snapshot:Snapshot = {...active.bundle.snapshot, clients:index.clients, enrichedClientIds:index.clients.map(c=>c.id),moduleClientIds:index.modules,
        version:'sheets360:'+revision, fetchedAt:readAt||active.bundle.snapshot.fetchedAt,
        sourceState:{status:continuous?'ready':'not_connected',stale:!continuous,lastReadAt:readAt,lastAttemptAt:readAt,revision},
        connection:{mode:'readonly-api',intervalMs:30000,sheetReady:continuous,label:continuous?'Google Sheets · observations actualisées automatiquement':'Google Sheets · copie consultée · actualisation continue à activer'}};
      let body: unknown;
      if(url.pathname==='/api/v1/analytics') {
        const fiches=index.clients.map(client=>dossier360(client,index.rows.get(client.id)??[],active.bundle.pilots.find(p=>p.data.id===client.id),revision,readAt,continuous));
        const analytics=buildAnalytics(snapshot,fiches);
        analytics.meta.sourceMode='sheets_observations';
        analytics.limitations=analytics.limitations.filter(s=>!s.includes('audit privé daté'));
        analytics.limitations.push('Les observations Sheets complètent les archives conservées. Les e-mails, documents et événements référencés ne sont pas automatiquement relus.');
        body=analytics;
      } else if (detail) {
        const client = index.clients.find(c=>c.id===detail[1]);
        if (!client) return json(404,{error:'dossier_not_found'});
        body = dossier360(client,index.rows.get(client.id)??[],active.bundle.pilots.find(p=>p.data.id===client.id),revision,readAt,continuous);
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
  return { origin, env, sheets360, async fetch(request: Request) {
    let response: Response;
    try { response = await route(request); } catch { response = json(503, { error: 'private_service_unavailable' }); }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(security)) headers.set(key, value);
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  } };
}

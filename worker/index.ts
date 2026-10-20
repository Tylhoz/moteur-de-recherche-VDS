import { sha256Text, validateWorkerBundle, WORKER_BUNDLE_MAX_BYTES, type WorkerPrivateBundle } from '../shared/worker-bundle.js';

export interface PrivateR2Object { text(): Promise<string>; size: number; etag?: string; }
export interface PrivateR2Bucket {
  get(key: string): Promise<PrivateR2Object | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string }; onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string } }): Promise<unknown>;
}
export interface WorkerEnv {
  BUCKET: PrivateR2Bucket;
  ASSETS: { fetch(request: Request): Promise<Response> };
  VDS_PUBLIC_ORIGIN: string;
  /** This adapter is deployed behind Sites Dispatch, never on a directly public Worker URL. */
  VDS_OWNER_PRIVATE: string;
  VDS_IMPORT_TOKEN_SHA256?: string;
  VDS_EXPECTED_BUNDLE_SHA256?: string;
  VDS_RELEASE_ID?: string;
  VDS_COMMIT_SHA?: string;
}
const pointerKey = 'vds/private/active.json';
const digestPattern = /^[a-f0-9]{64}$/;
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Cookie, Origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const security = { ...jsonHeaders, 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com" };
const reply = (status: number, body: unknown, extra: Record<string,string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...security, ...extra } });
function config(env: WorkerEnv): URL | null {
  try { const u = new URL(env.VDS_PUBLIC_ORIGIN); return u.protocol === 'https:' && u.origin === env.VDS_PUBLIC_ORIGIN && !u.username && !u.password && env.VDS_OWNER_PRIVATE === 'true' ? u : null; } catch { return null; }
}
function sameOrigin(request: Request, origin: URL) {
  const url = new URL(request.url), supplied = request.headers.get('Origin'), site = request.headers.get('Sec-Fetch-Site');
  // Following a link from ChatGPT (or opening its preview iframe) is a normal
  // navigation. Permit only the generic entry page; auth is still checked below.
  const entryNavigation = !supplied && ['GET', 'HEAD'].includes(request.method) && ['/', '/index.html'].includes(url.pathname)
    && request.headers.get('Sec-Fetch-Mode') === 'navigate' && ['document', 'iframe'].includes(request.headers.get('Sec-Fetch-Dest') || '');
  return url.origin === origin.origin && !url.username && !url.password && (!supplied || supplied === origin.origin)
    && (!site || ['same-origin', 'none'].includes(site) || entryNavigation);
}
function identity(request: Request) {
  const id = request.headers.get('oai-authenticated-user-id'), email = request.headers.get('oai-authenticated-user-email');
  return !!id && /^[^\s\x00-\x1f\x7f]{1,256}$/.test(id) && !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length < 320;
}
async function importAuthorized(request: Request, env: WorkerEnv) {
  const h = request.headers.get('Authorization');
  if (!env.VDS_IMPORT_TOKEN_SHA256 || !digestPattern.test(env.VDS_IMPORT_TOKEN_SHA256) || !h || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(h)) return false;
  const actual = await sha256Text(h.slice(7)); let different = 0;
  for (let i=0; i<64; i++) different |= actual.charCodeAt(i) ^ env.VDS_IMPORT_TOKEN_SHA256.charCodeAt(i);
  return different === 0;
}
async function boundedBody(request: Request): Promise<string> {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > WORKER_BUNDLE_MAX_BYTES)) throw new Error('size');
  if (!request.body) throw new Error('body');
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > WORKER_BUNDLE_MAX_BYTES) throw new Error('size'); text += decoder.decode(chunk.value, { stream: true }); } return text + decoder.decode(); }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
}
type ValidatedBundle = { digest: string; bundle: WorkerPrivateBundle };
export async function readActive(env: WorkerEnv, validated?: ValidatedBundle): Promise<ValidatedBundle | null> {
  const pointer = await env.BUCKET.get(pointerKey); if (!pointer) return null;
  if (pointer.size > 256) throw new Error('invalid_pointer');
  const raw = JSON.parse(await pointer.text());
  if (!raw || typeof raw.digest !== 'string' || !digestPattern.test(raw.digest)) throw new Error('invalid_pointer');
  if (!env.VDS_EXPECTED_BUNDLE_SHA256 || raw.digest !== env.VDS_EXPECTED_BUNDLE_SHA256) throw new Error('unapproved_bundle');
  const object = await env.BUCKET.get(`vds/private/bundles/${raw.digest}.json`);
  if (!object || object.size > WORKER_BUNDLE_MAX_BYTES) throw new Error('bundle_missing');
  const text = await object.text(); if (await sha256Text(text) !== raw.digest) throw new Error('invalid_digest');
  // The bytes are verified on every request. Reuse only their already checked
  // projection, avoiding hundreds of repeated source/identity checks per page.
  if (validated && validated.digest === raw.digest) return validated;
  return { digest: raw.digest, bundle: validateWorkerBundle(JSON.parse(text)) };
}

/** Fetch API adapter. Native session enforcement stays at Sites Dispatch plus each protected route. */
export function createWorker() {
  let validated: ValidatedBundle | undefined;
  return { async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      const origin = config(env); if (!origin) return reply(503, { error: 'private_hosting_not_configured' });
      if (!sameOrigin(request, origin)) return reply(403, { error: 'same_origin_required' });
      const url = new URL(request.url);
      if (/%|\\|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(url.pathname)) return reply(404, { error: 'not_found' });
      if (url.search) return reply(400, { error: 'unsupported_query' });
      if (url.pathname === '/api/internal/import' || url.pathname === '/api/internal/import-status') {
        if (!await importAuthorized(request, env)) return reply(401, { error: 'import_authentication_required' });
        if (!env.BUCKET || !env.VDS_EXPECTED_BUNDLE_SHA256 || !digestPattern.test(env.VDS_EXPECTED_BUNDLE_SHA256)) return reply(503, { error: 'private_storage_not_configured' });
        if (url.pathname.endsWith('import-status')) {
          if (request.method !== 'GET') return reply(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
          const active = await readActive(env, validated); if (active) validated = active;
          return reply(200, { ready: !!active, digest: active?.digest ?? null, dossiers: active?.bundle.snapshot.clients.length ?? 0, enriched: active?.bundle.pilots.length ?? 0 });
        }
        if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
        if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '') || request.headers.get('Content-Encoding')) return reply(415, { error: 'json_required' });
        let text: string;
        try { text = await boundedBody(request); } catch { return reply(413, { error: 'invalid_or_oversized_import' }); }
        const digest = await sha256Text(text); if (digest !== env.VDS_EXPECTED_BUNDLE_SHA256) return reply(409, { error: 'unexpected_bundle_digest' });
        let bundle: WorkerPrivateBundle; try { bundle = validateWorkerBundle(JSON.parse(text)); } catch { return reply(422, { error: 'invalid_private_bundle' }); }
        const key = `vds/private/bundles/${digest}.json`, existing = await env.BUCKET.get(key);
        if (existing && (existing.size > WORKER_BUNDLE_MAX_BYTES || await sha256Text(await existing.text()) !== digest)) return reply(409, { error: 'immutable_bundle_conflict' });
        if (!existing) {
          await env.BUCKET.put(key, text, { httpMetadata: { contentType: 'application/json' }, onlyIf: { etagDoesNotMatch: '*' } });
          const stored = await env.BUCKET.get(key);
          if (!stored || stored.size > WORKER_BUNDLE_MAX_BYTES || await sha256Text(await stored.text()) !== digest) throw new Error('immutable_write_failed');
        }
        // Complete immutable object first; one small pointer write is the activation boundary.
        await env.BUCKET.put(pointerKey, JSON.stringify({ digest }), { httpMetadata: { contentType: 'application/json' } });
        validated = { digest, bundle };
        return reply(200, { imported: true, digest, dossiers: bundle.snapshot.clients.length, enriched: bundle.pilots.length, sourceWrites: 0 });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply(405, { error: 'read_only_application' }, { Allow: 'GET, HEAD' });
      if (request.body || Number(request.headers.get('Content-Length') || '0') > 0) return reply(400, { error: 'request_body_not_allowed' });
      if (url.pathname === '/release' || url.pathname === '/api/v1/release') return reply(200, {
        release: env.VDS_RELEASE_ID || 'unconfigured', commit: /^[a-f0-9]{40}$/.test(env.VDS_COMMIT_SHA || '') ? env.VDS_COMMIT_SHA : null,
        runtime: 'cloudflare-worker', authentication: 'sites-native', source: 'private-dated-archive', sourceWrites: 0,
      });
      if (!identity(request)) return reply(401, { error: 'authentication_required', signInPath: '/signin-with-chatgpt' });
      if (url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET') return reply(405, { error: 'read_only_api' }, { Allow: 'GET' });
        const pilotMatch = /^\/api\/v1\/pilot\/(VDS-\d{3})$/.exec(url.pathname);
        if (!['/api/v1/portal-snapshot','/api/v1/pilot','/api/v1/connections','/api/v1/analytics'].includes(url.pathname) && !pilotMatch) return reply(404, { error: 'not_found' });
        if (!env.BUCKET) return reply(503, { error: 'private_storage_not_configured' });
        const active = await readActive(env, validated); if (!active) return reply(503, { error: 'private_data_not_loaded' });
        validated = active;
        const { bundle } = active;
        const body = pilotMatch ? bundle.pilots.find(p => p.data.id === pilotMatch[1])
          : url.pathname === '/api/v1/portal-snapshot' ? bundle.snapshot : url.pathname === '/api/v1/pilot' ? bundle.summary
          : url.pathname === '/api/v1/connections' ? bundle.connections : bundle.analytics;
        if (!body) return reply(404, { error: 'pilot_not_available_or_identity_requires_review' });
        const serialized = JSON.stringify(body), etag = `"${await sha256Text(serialized)}"`;
        const extra: Record<string,string> = { ETag: etag, 'X-VDS-Source-Stale': String(bundle.snapshot.sourceState!.stale), 'X-VDS-Release': env.VDS_RELEASE_ID || 'unconfigured', 'X-VDS-Fetched-At': bundle.snapshot.fetchedAt };
        if (bundle.snapshot.sourceState!.lastReadAt) extra['X-VDS-Last-Read-At'] = bundle.snapshot.sourceState!.lastReadAt!;
        if (bundle.snapshot.sourceState!.lastAttemptAt) extra['X-VDS-Last-Attempt-At'] = bundle.snapshot.sourceState!.lastAttemptAt!;
        if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ...security, ...extra } });
        return new Response(serialized, { status: 200, headers: { ...security, ...extra } });
      }
      if (url.pathname !== '/' && url.pathname !== '/index.html' && !/^\/assets\/[A-Za-z0-9._-]+\.(?:js|css|png|jpe?g|svg|webp|ico|woff2?)$/.test(url.pathname)) return reply(404, { error: 'not_found' });
      if (!env.ASSETS) return reply(503, { error: 'frontend_not_configured' });
      const asset = await env.ASSETS.fetch(request), headers = new Headers(asset.headers);
      for (const [key,value] of Object.entries(security)) if (key !== 'Content-Type') headers.set(key,value);
      headers.set('X-VDS-Release', env.VDS_RELEASE_ID || 'unconfigured');
      return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, headers });
    } catch { return reply(503, { error: 'private_service_unavailable' }); }
  } };
}
export default createWorker();

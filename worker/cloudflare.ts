import { createWorker, type PrivateR2Bucket, type WorkerEnv } from './index.js';
import { AccessFailure, authenticatedRequest, createAccessVerifier, readAccessConfig, type AccessEnv, type AccessVerifierOptions, type VerifiedAccessIdentity } from './access.js';
import { handleIntegrationRequest, runScheduledSync, type ConnectedEnv } from './integration-router.js';
import { release as builtRelease } from './release.generated.js';

/** Direct Cloudflare bindings. No platform-specific global or Node types required. */
export interface CloudflareEnv extends AccessEnv {
  BUCKET?: PrivateR2Bucket;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  VDS_PUBLIC_ORIGIN?: string;
  VDS_IMPORT_TOKEN_SHA256?: string;
  VDS_IMPORT_TOKEN?: string;
  VDS_EXPECTED_BUNDLE_SHA256?: string;
  VDS_RELEASE_ID?: string;
  VDS_COMMIT_SHA?: string;
}
export interface CloudflareSetup {
  schemaVersion: 'cloudflare-setup-1'; runtime: 'cloudflare-worker'; authentication: 'cloudflare-access';
  authenticated: true; ownerAuthorized: true; ready: boolean;
  configuration: { access: true; origin: true; assets: boolean; storage: boolean; importToken: boolean; expectedBundle: boolean; release: boolean };
  storage: { state: 'not_configured' | 'unavailable' | 'empty' | 'ready'; dossiers: number | null; enriched: number | null };
  release: { id: string | null; commit: string | null }; sourceWrites: 0;
}
export interface CloudflareWorkerOptions extends AccessVerifierOptions {
  /** Trusted application extension: invoked only after owner authentication and origin checks. */
  handleAuthorized?: (request: Request, env: CloudflareEnv, identity: VerifiedAccessIdentity) => Promise<Response | null>;
}
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Cookie, Origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" };
function reply(status: number, body: unknown, extra: Record<string, string> = {}) { return new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } }); }
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function release(env: CloudflareEnv) {
  return { id: /^[A-Za-z0-9._-]{1,80}$/.test(env.VDS_RELEASE_ID || '') ? env.VDS_RELEASE_ID! : null,
    commit: /^[a-f0-9]{40}$/.test(env.VDS_COMMIT_SHA || '') ? env.VDS_COMMIT_SHA! : null };
}
function publicOrigin(env: CloudflareEnv) {
  try { const url = new URL(env.VDS_PUBLIC_ORIGIN!);
    if (url.protocol !== 'https:' || url.origin !== env.VDS_PUBLIC_ORIGIN || url.username || url.password || url.port) throw new Error(); return url;
  } catch { throw new AccessFailure(503, 'private_hosting_not_configured'); }
}
function allowedRequest(request: Request, origin: URL) {
  const url = new URL(request.url), supplied = request.headers.get('Origin'), site = request.headers.get('Sec-Fetch-Site');
  const navigation = !supplied && ['GET', 'HEAD'].includes(request.method) && ['/', '/index.html'].includes(url.pathname)
    && request.headers.get('Sec-Fetch-Mode') === 'navigate' && ['document', 'iframe'].includes(request.headers.get('Sec-Fetch-Dest') || '');
  return url.origin === origin.origin && !url.username && !url.password && (!supplied || supplied === origin.origin)
    && (!site || ['same-origin', 'none'].includes(site) || navigation);
}

/** Authenticated direct entry; use this (not index.ts) as Wrangler's main. */
export function createCloudflareWorker(options: CloudflareWorkerOptions = {}) {
  const runtime = createWorker(); const verifier = createAccessVerifier(options);
  return { async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    try {
      const config = readAccessConfig(env), origin = publicOrigin(env);
      if (!allowedRequest(request, origin)) return reply(403, { error: 'same_origin_required' });
      const identity = await verifier.verify(request, config);
      const authorized = authenticatedRequest(request, identity);
      const url = new URL(authorized.url);
      if (/%|\\|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(url.pathname)) return reply(404, { error: 'not_found' });
      if (url.search) return reply(400, { error: 'unsupported_query' });
      const inner: WorkerEnv = { BUCKET: env.BUCKET!, ASSETS: env.ASSETS!, VDS_PUBLIC_ORIGIN: origin.origin, VDS_OWNER_PRIVATE: 'true',
        VDS_IMPORT_TOKEN_SHA256: env.VDS_IMPORT_TOKEN_SHA256, VDS_EXPECTED_BUNDLE_SHA256: env.VDS_EXPECTED_BUNDLE_SHA256,
        VDS_RELEASE_ID: release(env).id ?? undefined, VDS_COMMIT_SHA: release(env).commit ?? undefined };
      if (url.pathname === '/api/v1/setup') {
        if (request.method !== 'GET') return reply(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        const version = release(env);
        const configuration: CloudflareSetup['configuration'] = { access: true, origin: true, assets: typeof env.ASSETS?.fetch === 'function',
          storage: typeof env.BUCKET?.get === 'function' && typeof env.BUCKET?.put === 'function',
          importToken: digest(env.VDS_IMPORT_TOKEN_SHA256) || /^[A-Za-z0-9_-]{32,256}$/.test(env.VDS_IMPORT_TOKEN || ''),
          expectedBundle: digest(env.VDS_EXPECTED_BUNDLE_SHA256), release: !!version.id && !!version.commit };
        const storage: CloudflareSetup['storage'] = { state: 'not_configured', dossiers: null, enriched: null };
        if (configuration.storage && configuration.expectedBundle) {
          const probe = new Request(new URL('/api/v1/portal-snapshot', origin), { headers: authorized.headers });
          const response = await options.handleAuthorized?.(probe, env, identity) ?? await runtime.fetch(probe, inner);
          const body = await response.json() as { clients?: unknown[]; enrichedClientIds?: string[]; error?: string };
          if (response.status === 200 && Array.isArray(body.clients) && Array.isArray(body.enrichedClientIds)) {
            storage.state = 'ready'; storage.dossiers = body.clients.length; storage.enriched = body.enrichedClientIds.length;
          } else storage.state = body.error === 'private_data_not_loaded' ? 'empty' : 'unavailable';
        }
        const result: CloudflareSetup = { schemaVersion: 'cloudflare-setup-1', runtime: 'cloudflare-worker', authentication: 'cloudflare-access',
          authenticated: true, ownerAuthorized: true, ready: configuration.assets && configuration.release && storage.state === 'ready',
          configuration, storage, release: version, sourceWrites: 0 };
        return reply(200, result);
      }
      if (url.pathname === '/release' || url.pathname === '/api/v1/release') {
        if (!['GET', 'HEAD'].includes(request.method)) return reply(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
        const version = release(env);
        const response = reply(200, { release: version.id, commit: version.commit, runtime: 'cloudflare-worker', authentication: 'cloudflare-access',
          source: 'private-dated-archive', sourceWrites: 0 });
        return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
      }
      // Administrative imports always retain the existing digest + secret checks.
      if (!url.pathname.startsWith('/api/internal/')) {
        const handled = await options.handleAuthorized?.(authorized, env, identity);
        if (handled) {
          const protectedHeaders = new Headers(handled.headers);
          for (const [key, value] of Object.entries(headers)) if (key !== 'Content-Type' && key !== 'Content-Security-Policy') protectedHeaders.set(key, value);
          return new Response(handled.body, { status: handled.status, headers: protectedHeaders });
        }
      }
      return await runtime.fetch(authorized, inner);
    } catch (error) {
      if (error instanceof AccessFailure) return reply(error.status, { error: error.code, authentication: 'cloudflare-access', ...(error.status === 401 ? { signInPath: '/' } : {}) });
      return reply(503, { error: 'private_service_unavailable' });
    }
  } };
}
const application = createCloudflareWorker({ handleAuthorized: handleIntegrationRequest });
export default {
  fetch(request: Request, env: CloudflareEnv) {
    return application.fetch(request, { ...env, VDS_RELEASE_ID: builtRelease.id, VDS_COMMIT_SHA: builtRelease.commit });
  },
  scheduled(_controller: unknown, env: ConnectedEnv, context: { waitUntil(promise: Promise<unknown>): void }) {
    context.waitUntil(runScheduledSync(env));
  },
};

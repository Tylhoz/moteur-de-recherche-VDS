import type { CloudflareEnv } from './cloudflare.js';
import type { VerifiedAccessIdentity } from './access.js';
import { createWorker, readActive, type WorkerEnv } from './index.js';
import { sha256Text } from '../shared/worker-bundle.js';
import { validatePortalSnapshot } from '../src/data/api-client.js';
import type { Snapshot } from '../src/types.js';
import { createSheetsReader, integrationConfiguration, IntegrationError, type IntegrationsEnv, type SheetsProposal } from './integrations.js';
import { handleReviewRequest } from './review-router.js';

export type ConnectedEnv = CloudflareEnv & IntegrationsEnv & { VDS_IMPORT_TOKEN?: string };
const approvedKey = 'vds/private/sheets/approved.json';
const proposalKey = 'vds/private/sheets/proposal.json';
const statusKey = 'vds/private/sheets/status.json';
const maxBytes = 4 * 1024 * 1024;
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Origin' };
const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers });
const innerEnv = (env: ConnectedEnv): WorkerEnv => ({ ...env, BUCKET: env.BUCKET!, ASSETS: env.ASSETS!,
  VDS_PUBLIC_ORIGIN: env.VDS_PUBLIC_ORIGIN!, VDS_OWNER_PRIVATE: 'true' });
async function jsonObject(env: ConnectedEnv, key: string, limit = maxBytes): Promise<{ data: any; etag?: string } | null> {
  const object = await env.BUCKET!.get(key);
  if (!object) return null;
  if (object.size > limit) throw new Error('private_storage_invalid');
  const text = await object.text();
  if (new TextEncoder().encode(text).length > limit) throw new Error('private_storage_invalid');
  return { data: JSON.parse(text), etag: object.etag };
}
async function save(env: ConnectedEnv, key: string, value: unknown) {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error('private_storage_limit');
  await env.BUCKET!.put(key, text, { httpMetadata: { contentType: 'application/json' } });
}
/** Approved overlays never replace the original archive or change a client's identity. */
async function current(env: ConnectedEnv) {
  if (!env.BUCKET) return null;
  const original = await readActive(innerEnv(env));
  if (!original) return null;
  const pointer = await jsonObject(env, approvedKey, 512);
  if (!pointer) return { original, snapshot: original.bundle.snapshot, pointer: null };
  if (!/^[a-f0-9]{64}$/.test(pointer.data.digest)) throw new Error('private_storage_invalid');
  const stored = await jsonObject(env, `vds/private/sheets/versions/${pointer.data.digest}.json`);
  if (!stored || await sha256Text(JSON.stringify(stored.data)) !== pointer.data.digest
    || stored.data.archiveDigest !== original.digest) throw new Error('private_storage_invalid');
  const snapshot = validatePortalSnapshot(stored.data.snapshot);
  if (!sameIdentities(snapshot, original.bundle.snapshot)) throw new Error('identity_review_required');
  return { original, snapshot, pointer };
}
async function pendingProposal(env: ConnectedEnv): Promise<SheetsProposal | null> {
  if (!env.BUCKET) return null;
  const proposal = (await jsonObject(env, proposalKey))?.data as SheetsProposal | undefined;
  if (!proposal) return null;
  const state = await current(env);
  // Keep the immutable proposal history, but never offer an already applied or obsolete revision again.
  return state && proposal.baseVersion === state.snapshot.version ? proposal : null;
}
function sameIdentities(candidate: Snapshot, baseline: Snapshot) {
  const clients = new Map(baseline.clients.map(c => [c.id, c]));
  return candidate.clients.length === baseline.clients.length && candidate.clients.every(c => {
    const original = clients.get(c.id);
    return original && ['client', 'contact', 'address'].every(k => c[k as keyof typeof c] === original[k as keyof typeof original])
      && c.category === 'non_verifie' && c.contractHT === null && c.soldeAmount === null;
  });
}
async function activate(env: ConnectedEnv, proposal: SheetsProposal, actor: string) {
  const state = await current(env);
  if (!state || proposal.baseVersion !== state.snapshot.version) return reply(409, { error: 'source_version_changed' });
  if (!sameIdentities(proposal.snapshot, state.original.bundle.snapshot)) return reply(409, { error: 'identity_review_required' });
  const snapshot = validatePortalSnapshot({ ...proposal.snapshot, enrichedClientIds: state.original.bundle.snapshot.enrichedClientIds,
    links: [...new Map([...(state.original.bundle.snapshot.links ?? []), ...(proposal.snapshot.links ?? [])].map(l => [l.url, l])).values()] });
  const envelope = { archiveDigest: state.original.digest, snapshot, decision: {
    approvedAt: new Date().toISOString(), actor, proposalRevision: proposal.revision,
    previousVersion: state.snapshot.version, changedFields: proposal.changes.length, sourceWrites: 0,
  } };
  const text = JSON.stringify(envelope), digest = await sha256Text(text);
  await env.BUCKET!.put(`vds/private/sheets/versions/${digest}.json`, text,
    { httpMetadata: { contentType: 'application/json' }, onlyIf: { etagDoesNotMatch: '*' } });
  const stored = await env.BUCKET!.get(`vds/private/sheets/versions/${digest}.json`);
  if (!stored || await sha256Text(await stored.text()) !== digest) throw new Error('private_write_failed');
  if (state.pointer && !state.pointer.etag) throw new Error('storage_concurrency_unavailable');
  const result = await env.BUCKET!.put(approvedKey, JSON.stringify({ digest }), {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: state.pointer ? { etagMatches: state.pointer.etag! } : { etagDoesNotMatch: '*' },
  });
  if (result === null) return reply(409, { error: 'source_version_changed' });
  return reply(200, { applied: true, revision: proposal.revision, dossiers: snapshot.clients.length,
    enriched: snapshot.enrichedClientIds?.length ?? 0, sourceWrites: 0, financialTotalsVerified: false });
}
async function preview(env: ConnectedEnv): Promise<SheetsProposal> {
  if (!env.BUCKET) throw new IntegrationError('private_storage_not_configured');
  const baseline = await current(env);
  if (!baseline) throw new IntegrationError('private_data_not_loaded');
  const reader = createSheetsReader(env);
  try {
    const proposal = await reader.readProposal(baseline.snapshot);
    await save(env, `vds/private/sheets/proposals/${proposal.revision}.json`, proposal);
    await save(env, proposalKey, proposal);
    // Refresh dates automatically only when there is no change to any dossier value.
    if (!proposal.requiresValidation) await activate(env, proposal, 'unchanged-source-read');
    await save(env, statusKey, reader.status());
    return proposal;
  } catch (error) {
    await save(env, statusKey, reader.status());
    throw error;
  }
}
let scheduledPending: Promise<void> | null = null;
export async function runScheduledSync(env: ConnectedEnv): Promise<void> {
  if (!env.BUCKET || !integrationConfiguration(env).sheets.configured) return;
  if (scheduledPending) return scheduledPending;
  scheduledPending = (async () => { try { await preview(env); } catch { /* Status is private and persisted by preview. */ } })();
  try { await scheduledPending; } finally { scheduledPending = null; }
}
async function smallBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json') || request.headers.get('Content-Encoding')) throw new Error('invalid_request');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_request');
  let text = '', size = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
  try { while (true) { const part = await reader.read(); if (part.done) break;
    size += part.value.length; if (size > 2048) throw new Error('invalid_request'); text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode(); const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_request'); return body;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** The Cloudflare entry invokes this handler only after verified owner authentication. */
export async function handleIntegrationRequest(request: Request, rawEnv: CloudflareEnv, identity: VerifiedAccessIdentity): Promise<Response | null> {
  const env = rawEnv as ConnectedEnv, path = new URL(request.url).pathname;
  if (path === '/api/v1/reviews') return handleReviewRequest(request, innerEnv(env), identity, async () => (await current(env))?.snapshot ?? null);
  if (path !== '/api/v1/portal-snapshot' && !path.startsWith('/api/v1/integrations') && path !== '/api/v1/setup/import') return null;
  try {
    if (request.method === 'POST' && request.headers.get('Origin') !== env.VDS_PUBLIC_ORIGIN)
      return reply(403, { error: 'same_origin_required' });
    if (path === '/api/v1/setup/import') {
      if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
      if (request.headers.get('X-VDS-Action') !== 'import') return reply(400, { error: 'explicit_import_required' });
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.VDS_IMPORT_TOKEN || '')) return reply(503, { error: 'private_import_not_configured' });
      const digest = await sha256Text(env.VDS_IMPORT_TOKEN!);
      if (env.VDS_IMPORT_TOKEN_SHA256 && env.VDS_IMPORT_TOKEN_SHA256 !== digest) return reply(503, { error: 'private_import_not_configured' });
      const auth = new Headers(request.headers); auth.set('Authorization', `Bearer ${env.VDS_IMPORT_TOKEN}`);
      const internal = new Request(new URL('/api/internal/import', env.VDS_PUBLIC_ORIGIN), {
        method: 'POST', headers: auth, body: request.body, duplex: 'half',
      } as RequestInit);
      return createWorker().fetch(internal, { ...innerEnv(env), VDS_IMPORT_TOKEN_SHA256: digest });
    }
    if (path === '/api/v1/portal-snapshot') {
      if (request.method !== 'GET') return null;
      const state = await current(env); if (!state) return null;
      const body = JSON.stringify(state.snapshot), etag = `"${await sha256Text(body)}"`;
      const outputHeaders = { ...headers, ETag: etag, 'X-VDS-Source-Stale': String(state.snapshot.sourceState!.stale),
        'X-VDS-Fetched-At': state.snapshot.fetchedAt, 'X-VDS-Last-Read-At': state.snapshot.sourceState!.lastReadAt || '',
        'X-VDS-Last-Attempt-At': state.snapshot.sourceState!.lastAttemptAt || '' };
      return new Response(request.headers.get('If-None-Match') === etag ? null : body,
        { status: request.headers.get('If-None-Match') === etag ? 304 : 200, headers: outputHeaders });
    }
    if (path === '/api/v1/integrations' && request.method === 'GET') {
      const config = integrationConfiguration(env);
      const saved = env.BUCKET && config.sheets.configured ? await jsonObject(env, statusKey, 4096) : null;
      const pending = config.sheets.configured ? await pendingProposal(env) : null;
      return reply(200, { ...config, sheets: { ...config.sheets, ...(saved?.data ?? {}),
        ...(saved?.data?.connected && !pending?.requiresValidation ? { state: 'ready' } : {}),
        configured: config.sheets.configured, missing: config.sheets.missing, invalid: config.sheets.invalid },
        sourceWrites: 0, automaticIntervalMinutes: 5 });
    }
    if (path === '/api/v1/integrations/sheets/preview') {
      if (request.method === 'GET') return reply(200, { proposal: await pendingProposal(env) });
      if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
      const result = await preview(env);
      return reply(200, result);
    }
    if (path === '/api/v1/integrations/sheets/approve') {
      if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
      const body = await smallBody(request);
      if (!/^[a-f0-9]{64}$/.test(String(body.revision)) || body.confirm !== true) return reply(400, { error: 'explicit_confirmation_required' });
      if (!env.BUCKET) return reply(503, { error: 'private_storage_not_configured' });
      const proposal = (await jsonObject(env, proposalKey))?.data as SheetsProposal | undefined;
      if (!proposal || proposal.revision !== body.revision) return reply(409, { error: 'proposal_changed' });
      // A second source read prevents applying a proposal that has since become obsolete.
      const latest = await preview(env);
      if (latest.revision !== proposal.revision || latest.baseVersion !== proposal.baseVersion) return reply(409, { error: 'proposal_changed' });
      return activate(env, latest, identity.subject);
    }
    return reply(404, { error: 'not_found' });
  } catch (error) {
    return reply(503, {
      error: error instanceof IntegrationError ? error.code : 'private_integration_unavailable',
    });
  }
}

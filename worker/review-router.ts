import { readActive, type WorkerEnv } from './index.js';
import type { VerifiedAccessIdentity } from './access.js';
import { sha256Text } from '../shared/worker-bundle.js';
import { clientIdentityKey } from '../src/lib/clients.js';
import type { Client, Snapshot } from '../src/types.js';

export interface PersistedReviewEvent {
  id: string; kind: 'note' | 'marked' | 'unmarked'; at: string; text: string; source: string;
  actorHash: string; requestHash: string; baseVersion: string;
}
export interface PersistedReview { clientId: string; identity: string; marked: boolean; events: PersistedReviewEvent[]; }
interface ReviewStore { schemaVersion: 'private-reviews-1'; revision: string; entries: Record<string, PersistedReview>; }
const KEY = 'vds/private/reviews/index.json';
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 2000;
const MAX_REQUEST_BYTES = 64 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sourceIdentity = (c: Client) => JSON.stringify([c.id, c.client, c.contact, c.contractHT, c.soldeAmount, c.finance, c.statusAction]);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie, Origin',
} });
function parseStore(text: string): ReviewStore {
  const s: unknown = JSON.parse(text);
  if (!object(s) || s.schemaVersion !== 'private-reviews-1' || typeof s.revision !== 'string' || !uuid.test(s.revision)
    || !object(s.entries) || Object.keys(s.entries).length > 1000) throw new Error('invalid_store');
  let count = 0; const seen = new Set<string>();
  for (const [key, r] of Object.entries(s.entries)) {
    if (!/^VDS-\d{3}:[a-f0-9]{64}$/.test(key) || !object(r) || typeof r.clientId !== 'string' || !key.startsWith(`${r.clientId}:`)
      || typeof r.identity !== 'string' || r.identity.length > 25_000 || typeof r.marked !== 'boolean' || !Array.isArray(r.events)) throw new Error('invalid_store');
    let marked = false;
    for (const event of r.events) {
      if (!object(event) || typeof event.id !== 'string' || !uuid.test(event.id) || seen.has(event.id)
        || !['note', 'marked', 'unmarked'].includes(String(event.kind)) || typeof event.at !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.at) || Number.isNaN(Date.parse(event.at))
        || typeof event.text !== 'string' || !event.text.trim() || event.text.length > 2000 || controls.test(event.text)
        || typeof event.source !== 'string' || event.source.length > 60_000
        || typeof event.actorHash !== 'string' || !digest.test(event.actorHash)
        || typeof event.requestHash !== 'string' || !digest.test(event.requestHash)
        || typeof event.baseVersion !== 'string' || event.baseVersion.length > 200) throw new Error('invalid_store');
      seen.add(event.id); count++;
      if (event.kind === 'marked') marked = true;
      if (event.kind === 'unmarked') marked = false;
    }
    if (marked !== r.marked || count > MAX_EVENTS) throw new Error('invalid_store');
  }
  return s as unknown as ReviewStore;
}
async function loadStore(env: WorkerEnv) {
  const stored = await env.BUCKET.get(KEY);
  if (!stored) return { store: { schemaVersion: 'private-reviews-1', revision: crypto.randomUUID(), entries: {} } as ReviewStore, etag: null };
  if (!stored.etag || stored.size > MAX_STORE_BYTES) throw new Error('invalid_store');
  return { store: parseStore(await stored.text()), etag: stored.etag };
}
function projection(store: ReviewStore, clients: Client[], baseVersion: string) {
  const identities = new Map(clients.map(c => [c.id, clientIdentityKey(c)]));
  const reviews: Record<string, { identity: string; marked: boolean; events: Omit<PersistedReviewEvent, 'actorHash' | 'requestHash'>[] }> = {};
  for (const r of Object.values(store.entries)) {
    if (identities.get(r.clientId) !== r.identity) continue;
    reviews[r.clientId] = { identity: r.identity, marked: r.marked,
      events: r.events.map(({ actorHash: _actor, requestHash: _request, ...event }) => event) };
  }
  return { schemaVersion: 'private-reviews-1', persistent: true, baseVersion, revision: store.revision, reviews, sourceWrites: 0 };
}
async function body(request: Request): Promise<unknown> {
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) throw new Error('body_size');
  if (!request.body) throw new Error('body_missing');
  const reader = request.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > MAX_REQUEST_BYTES) throw new Error('body_size'); parts.push(chunk.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
}
/** Called only after verified Access identity AND owner authorization. This route never changes source facts. */
export async function handleReviewRequest(request: Request, env: WorkerEnv, identity: VerifiedAccessIdentity | null,
  resolveSnapshot?: () => Promise<Snapshot | null>): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/v1/reviews') return null;
  try {
    if (!identity?.subject || !identity.email) return json(401, { error: 'authentication_required' });
    if (!env.BUCKET || !env.VDS_PUBLIC_ORIGIN) return json(503, { error: 'private_storage_not_configured' });
    if (url.origin !== env.VDS_PUBLIC_ORIGIN || url.search || url.hash || url.username || url.password
      || (request.headers.has('Origin') && request.headers.get('Origin') !== env.VDS_PUBLIC_ORIGIN)
      || (request.headers.has('Sec-Fetch-Site') && !['same-origin', 'none'].includes(request.headers.get('Sec-Fetch-Site')!))) return json(403, { error: 'same_origin_required' });
    if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'method_not_allowed' });
    if (request.method === 'GET' && (request.body || Number(request.headers.get('Content-Length') || '0') > 0)) return json(400, { error: 'request_body_not_allowed' });
    if (request.method === 'POST' && request.headers.get('Origin') !== env.VDS_PUBLIC_ORIGIN) return json(403, { error: 'same_origin_required' });
    if (request.method === 'POST' && (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '') || request.headers.has('Content-Encoding'))) return json(415, { error: 'json_required' });
    const snapshot = resolveSnapshot ? await resolveSnapshot() : (await readActive(env))?.bundle.snapshot;
    if (!snapshot) return json(503, { error: 'private_data_not_loaded' });
    const current = await loadStore(env);
    if (request.method === 'GET') return json(200, projection(current.store, snapshot.clients, snapshot.version));
    let input: unknown; try { input = await body(request); } catch { return json(400, { error: 'invalid_review_request' }); }
    if (!object(input) || Object.keys(input).sort().join(',') !== 'action,baseVersion,clientId,idempotency,identityKey,text'
      || typeof input.clientId !== 'string' || !/^VDS-\d{3}$/.test(input.clientId)
      || typeof input.identityKey !== 'string' || input.identityKey.length > 25_000
      || !['note', 'flag', 'unflag'].includes(String(input.action)) || typeof input.text !== 'string' || input.text.length > 2000 || controls.test(input.text)
      || typeof input.idempotency !== 'string' || !uuid.test(input.idempotency) || typeof input.baseVersion !== 'string') return json(400, { error: 'invalid_review_request' });
    if (input.baseVersion !== snapshot.version) return json(409, { error: 'source_version_changed' });
    const client = snapshot.clients.find(c => c.id === input.clientId);
    if (!client || clientIdentityKey(client) !== input.identityKey) return json(409, { error: 'client_identity_changed' });
    const action = input.action as 'note' | 'flag' | 'unflag';
    const text = action === 'note' ? input.text.trim() : action === 'flag' ? 'Dossier marqué pour vérification.' : 'Marqueur de vérification retiré.';
    if (!text || (action !== 'note' && input.text !== '')) return json(400, { error: 'invalid_review_request' });
    const actorHash = await sha256Text(identity.subject);
    const requestHash = await sha256Text(JSON.stringify([input.clientId, input.identityKey, action, text, input.baseVersion, actorHash]));
    const allEvents = Object.values(current.store.entries).flatMap(r => r.events);
    const previousRequest = allEvents.find(e => e.id === input.idempotency);
    if (previousRequest) return previousRequest.requestHash === requestHash
      ? json(200, { ...projection(current.store, snapshot.clients, snapshot.version), saved: true, replayed: true })
      : json(409, { error: 'idempotency_conflict' });
    if (allEvents.length >= MAX_EVENTS) return json(507, { error: 'review_journal_limit_reached' });
    const key = `${client.id}:${await sha256Text(input.identityKey)}`;
    const previous = current.store.entries[key] ?? { clientId: client.id, identity: input.identityKey, marked: false, events: [] };
    const event: PersistedReviewEvent = { id: input.idempotency, kind: action === 'note' ? 'note' : action === 'flag' ? 'marked' : 'unmarked',
      at: new Date().toISOString(), text, source: sourceIdentity(client), actorHash, requestHash, baseVersion: snapshot.version };
    const next: ReviewStore = { schemaVersion: 'private-reviews-1', revision: crypto.randomUUID(), entries: {
      ...current.store.entries, [key]: { ...previous, marked: action === 'flag' ? true : action === 'unflag' ? false : previous.marked, events: [...previous.events, event] },
    } };
    if (Object.keys(next.entries).length > 1000) return json(507, { error: 'review_journal_limit_reached' });
    const serialized = JSON.stringify(next);
    if (new TextEncoder().encode(serialized).length > MAX_STORE_BYTES) return json(507, { error: 'review_journal_limit_reached' });
    const written = await env.BUCKET.put(KEY, serialized, { httpMetadata: { contentType: 'application/json' },
      onlyIf: current.etag ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' } });
    if (!written) return json(409, { error: 'review_changed_retry' });
    const confirmed = await loadStore(env);
    if (!Object.values(confirmed.store.entries).some(r => r.events.some(e => e.id === input.idempotency && e.requestHash === requestHash))) throw new Error('write_unconfirmed');
    return json(200, { ...projection(confirmed.store, snapshot.clients, snapshot.version), saved: true, replayed: false });
  } catch { return json(503, { error: 'private_review_service_unavailable' }); }
}

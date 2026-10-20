import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { handleReviewRequest } from '../worker/review-router.js';
import type { PrivateR2Bucket, WorkerEnv } from '../worker/index.js';
import type { WorkerPrivateBundle } from '../shared/worker-bundle.js';
import { clientIdentityKey } from '../src/lib/clients.js';

const ROOT = process.env.VDS_REAL_CHAIN_DATA_ROOT;
const key = 'vds/private/reviews/index.json';
const origin = 'https://review-test.example.invalid';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const actor = { subject: 'verified-isolated-test-owner', email: 'owner@example.invalid' };
class ReviewR2 implements PrivateR2Bucket {
  entries = new Map<string, string>();
  writes: string[] = [];
  rejectNextWrite = false;
  failWrites = false;
  gateReads = false;
  gate: { count: number; promise: Promise<void>; release: () => void } | null = null;
  async get(name: string) {
    const text = this.entries.get(name);
    if (name === key && this.gateReads) {
      if (!this.gate) { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); this.gate = { count: 0, promise, release }; }
      const gate = this.gate; gate.count++;
      if (gate.count === 2) { this.gateReads = false; gate.release(); }
      await gate.promise;
    }
    return text === undefined ? null : { text: async () => text, size: new TextEncoder().encode(text).length, etag: hash(text) };
  }
  async put(name: string, value: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    if (this.failWrites) throw new Error('test-private-storage-diagnostic');
    if (this.rejectNextWrite) { this.rejectNextWrite = false; return null; }
    const previous = this.entries.get(name);
    if (options?.onlyIf?.etagDoesNotMatch === '*' && previous !== undefined) return null;
    if (options?.onlyIf?.etagMatches && (previous === undefined || hash(previous) !== options.onlyIf.etagMatches)) return null;
    this.entries.set(name, value); this.writes.push(name); return { etag: hash(value) };
  }
}
async function fixture() {
  const raw = await readFile(resolve(ROOT!, 'worker-preview.private.json'), 'utf8');
  const bundle = JSON.parse(raw) as WorkerPrivateBundle;
  const bucket = new ReviewR2(); const digest = hash(raw);
  bucket.entries.set('vds/private/active.json', JSON.stringify({ digest }));
  bucket.entries.set(`vds/private/bundles/${digest}.json`, raw);
  const env: WorkerEnv = { BUCKET: bucket, ASSETS: { fetch: async () => new Response('') }, VDS_PUBLIC_ORIGIN: origin, VDS_OWNER_PRIVATE: 'true', VDS_EXPECTED_BUNDLE_SHA256: digest };
  const client = bundle.snapshot.clients[0];
  const payload = (changes: Record<string, unknown> = {}) => ({ clientId: client.id, identityKey: clientIdentityKey(client), action: 'note', text: 'Point de contrôle technique isolé', baseVersion: bundle.snapshot.version, idempotency: randomUUID(), ...changes });
  const get = () => handleReviewRequest(new Request(`${origin}/api/v1/reviews`), env, actor);
  const post = (input: unknown, headers: Record<string, string> = {}) => handleReviewRequest(new Request(`${origin}/api/v1/reviews`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
  }), env, actor);
  return { bucket, bundle, client, env, payload, get, post, digest, raw };
}

test('review route refuses unverified identity and cross-origin access before private storage', async () => {
  const env = { VDS_PUBLIC_ORIGIN: origin, BUCKET: { get() { throw new Error('must not read'); } } } as unknown as WorkerEnv;
  assert.equal(await handleReviewRequest(new Request(`${origin}/unrelated`), env, null), null);
  assert.equal((await handleReviewRequest(new Request(`${origin}/api/v1/reviews`), env, null))!.status, 401);
  assert.equal((await handleReviewRequest(new Request(`${origin}/api/v1/reviews`, { headers: { Origin: 'https://other.invalid' } }), env, actor))!.status, 403);
  assert.equal((await handleReviewRequest(new Request(`${origin}/api/v1/reviews`, { method: 'POST' }), env, actor))!.status, 403);
  assert.equal((await handleReviewRequest(new Request(`${origin}/api/v1/reviews`, { method: 'DELETE' }), env, actor))!.status, 405);
});

test('private notes and flags survive a new handler call and never change the 500 dossier source', { skip: !ROOT }, async () => {
  const f = await fixture();
  const initial = await (await f.get())!.json(); assert.deepEqual(initial.reviews, {}); assert.equal(initial.baseVersion, f.bundle.snapshot.version);
  const note = f.payload(); const saved = await f.post(note); assert.equal(saved!.status, 200);
  const result = await saved!.json(); assert.equal(result.saved, true); assert.equal(result.reviews[f.client.id].events.length, 1);
  assert.equal(result.reviews[f.client.id].events[0].text, note.text);
  assert.ok(!JSON.stringify(result).includes('actorHash')); assert.ok(!JSON.stringify(result).includes('requestHash'));
  const flag = await f.post(f.payload({ action: 'flag', text: '' })); assert.equal(flag!.status, 200);
  const fresh = await (await f.get())!.json(); assert.equal(fresh.reviews[f.client.id].marked, true); assert.equal(fresh.reviews[f.client.id].events.length, 2);
  const unflag = await f.post(f.payload({ action: 'unflag', text: '' })); assert.equal(unflag!.status, 200);
  assert.equal((await (await f.get())!.json()).reviews[f.client.id].marked, false);
  assert.deepEqual(new Set(f.bucket.writes), new Set([key]));
  assert.equal(hash(f.bucket.entries.get(`vds/private/bundles/${f.digest}.json`) || ''), hash(f.raw));
  assert.equal(f.bucket.entries.get('vds/private/active.json'), JSON.stringify({ digest: f.digest }));
});

test('review idempotency prevents duplicate notes and rejects reused tokens or stale identities and sources', { skip: !ROOT }, async () => {
  const f = await fixture(); const note = f.payload();
  assert.equal((await f.post(note))!.status, 200); const count = f.bucket.writes.length;
  const replay = await f.post(note); assert.equal(replay!.status, 200); assert.equal((await replay!.json()).replayed, true); assert.equal(f.bucket.writes.length, count);
  assert.equal((await f.post({ ...note, text: 'Different operation' }))!.status, 409);
  assert.equal((await f.post(f.payload({ identityKey: 'different identity' })))!.status, 409);
  assert.equal((await f.post(f.payload({ baseVersion: 'obsolete-source' })))!.status, 409);
  assert.equal((await f.post(f.payload({ text: 'x'.repeat(2001) })))!.status, 400);
  assert.equal((await f.post(f.payload({ action: 'flag', text: 'not permitted' })))!.status, 400);
  assert.equal(f.bucket.writes.length, count);
});

test('concurrent review updates use R2 compare-and-swap and retry without losing either note', { skip: !ROOT }, async () => {
  const f = await fixture(); assert.equal((await f.post(f.payload()))!.status, 200);
  f.bucket.gateReads = true;
  const a = f.payload({ text: 'Concurrent isolated note A' }); const b = f.payload({ text: 'Concurrent isolated note B' });
  const results = await Promise.all([f.post(a), f.post(b)]);
  assert.deepEqual(results.map(r => r!.status).sort(), [200, 409]);
  const failed = results[0]!.status === 409 ? a : b;
  assert.equal((await f.post(failed))!.status, 200);
  const stored = await (await f.get())!.json();
  assert.equal(stored.reviews[f.client.id].events.length, 3);
  assert.equal(new Set(stored.reviews[f.client.id].events.map((e: { id: string }) => e.id)).size, 3);
});

test('failed review writes never announce success and old identity notes remain hidden but preserved', { skip: !ROOT }, async () => {
  const f = await fixture(); f.bucket.rejectNextWrite = true;
  assert.equal((await f.post(f.payload()))!.status, 409); assert.equal(f.bucket.entries.has(key), false);
  f.bucket.failWrites = true;
  const failed = await f.post(f.payload()); assert.equal(failed!.status, 503); assert.ok(!(await failed!.text()).includes('test-private-storage-diagnostic'));
  f.bucket.failWrites = false; assert.equal((await f.post(f.payload()))!.status, 200);
  const s = JSON.parse(f.bucket.entries.get(key)!); const entryKey = Object.keys(s.entries)[0]; const entry = s.entries[entryKey];
  entry.identity += ':former-identity'; delete s.entries[entryKey]; s.entries[`${f.client.id}:${hash(entry.identity)}`] = entry;
  f.bucket.entries.set(key, JSON.stringify(s));
  assert.deepEqual((await (await f.get())!.json()).reviews, {});
  assert.equal((await f.post(f.payload()))!.status, 200);
  assert.equal(Object.keys(JSON.parse(f.bucket.entries.get(key)!).entries).length, 2);
});

test('full review journals refuse new entries without silently pruning history', { skip: !ROOT }, async () => {
  const f = await fixture(); assert.equal((await f.post(f.payload()))!.status, 200);
  const s = JSON.parse(f.bucket.entries.get(key)!); const entry = s.entries[Object.keys(s.entries)[0]];
  entry.events = Array.from({ length: 2000 }, () => ({ ...entry.events[0], id: randomUUID(), text: 'Isolated journal capacity fixture' }));
  f.bucket.entries.set(key, JSON.stringify(s)); const before = f.bucket.entries.get(key);
  assert.equal((await f.post(f.payload()))!.status, 507); assert.equal(f.bucket.entries.get(key), before);
});


test('review interface accepts the actual persistent projection and announces loading before confirmation', { skip: !ROOT }, async () => {
  const f = await fixture(); await f.post(f.payload());
  const payload = await (await f.get())!.json();
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'silent' });
  try {
    const { createElement } = await import('react'); const { renderToStaticMarkup } = await import('react-dom/server');
    const module = await vite.ssrLoadModule('/src/components/RealValidationCenter.tsx');
    assert.equal(module.validatePrivateReviews(payload).reviews[f.client.id].events.length, 1);
    assert.throws(() => module.validatePrivateReviews({ ...payload, persistent: false }));
    const html = renderToStaticMarkup(createElement(module.default, { clients: f.bundle.snapshot.clients, snapshotAt: f.bundle.snapshot.fetchedAt }));
    assert.ok(html.includes('Chargement du journal privé'));
    assert.ok(html.includes('Journal privé de revue'));
    assert.ok(!html.includes('conservés en mémoire uniquement'));
    assert.ok(!html.includes('Note enregistrée dans le journal privé'));
  } finally { await vite.close(); }
});


test('review resolver uses the approved source revision while preserving earlier notes and their source snapshots', { skip: !ROOT }, async () => {
  const f = await fixture(); assert.equal((await f.post(f.payload()))!.status, 200);
  const updated = { ...f.bundle.snapshot, version: f.bundle.snapshot.version + ':approved-test', clients: f.bundle.snapshot.clients.map(c => c.id === f.client.id ? { ...c, finance: 'Approved technical test observation' } : c) };
  const get = await handleReviewRequest(new Request(`${origin}/api/v1/reviews`), f.env, actor, async () => updated);
  const current = await get!.json(); assert.equal(current.baseVersion, updated.version); assert.equal(current.reviews[f.client.id].events.length, 1);
  const oldSourceHash = hash(current.reviews[f.client.id].events[0].source);
  const post = (baseVersion: string) => handleReviewRequest(new Request(`${origin}/api/v1/reviews`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(f.payload({ baseVersion })) }), f.env, actor, async () => updated);
  assert.equal((await post(f.bundle.snapshot.version))!.status, 409);
  const accepted = await post(updated.version); assert.equal(accepted!.status, 200);
  const events = (await accepted!.json()).reviews[f.client.id].events;
  assert.equal(events.length, 2); assert.equal(hash(events[0].source), oldSourceHash); assert.notEqual(hash(events[1].source), oldSourceHash);
});

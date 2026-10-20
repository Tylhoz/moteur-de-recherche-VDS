import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PortalStore, PrivateNativeReadProvider } from '../server/portal.js';
import { buildAnalytics } from '../server/analytics.js';
import { createWorker, type PrivateR2Bucket, type WorkerEnv } from '../worker/index.js';
import { sha256Text, validateWorkerBundle, WORKER_BUNDLE_MAX_BYTES, type WorkerPrivateBundle } from '../shared/worker-bundle.js';

// The business fixtures are read from the protected audit directory, never committed.
const privateRoot = process.env.VDS_REAL_CHAIN_DATA_ROOT;
let sourceBundle: Promise<WorkerPrivateBundle> | undefined;
function realBundle() {
  return sourceBundle ??= (async () => {
    const root = resolve(privateRoot!);
    const portal = new PortalStore({ provider: new PrivateNativeReadProvider(resolve(root, 'native-sheet-read.private.json'), root),
      privateRoot: root, pilotFile: resolve(root, 'pilot-10.private.json'), identityBaselineFile: resolve(root, 'portal-original.private.json') });
    await portal.refresh();
    const snapshot = portal.current()!;
    const pilots = snapshot.enrichedClientIds!.map(id => portal.pilot(id)!);
    const summary = portal.pilotSummary();
    return validateWorkerBundle({ schemaVersion: 'worker-private-1', snapshot, pilots, summary,
      connections: { sheets: portal.status(), pilot: summary,
        gmail: { continuousConnection: false, mode: 'private_audit_snapshot' }, agenda: { continuousConnection: false, mode: 'private_audit_snapshot' },
        drive: { continuousConnection: false, mode: 'references_only' }, vosfactures: { connected: false, label: 'Source non connectée' } },
      analytics: buildAnalytics(snapshot, pilots, { sourceAuditDate: summary.auditDate }) });
  })();
}
class MemoryR2 implements PrivateR2Bucket {
  values = new Map<string, string>();
  gets = 0;
  writes: string[] = [];
  failWrites = false;
  silentlyDropWrites = false;
  async get(key: string) {
    this.gets++;
    const value = this.values.get(key);
    return value === undefined ? null : { size: new TextEncoder().encode(value).length, text: async () => value };
  }
  async put(key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
    if (this.failWrites) throw new Error('private-storage-diagnostic-must-not-leak');
    if (this.silentlyDropWrites) return null;
    if (options?.onlyIf?.etagDoesNotMatch === '*' && this.values.has(key)) return null;
    this.writes.push(key); this.values.set(key, value); return { key };
  }
}
const origin = 'https://private-worker-test.chatgpt.site';
// These are trusted-Dispatch headers in tests, not a replacement for Sites authentication.
const identity = { 'oai-authenticated-user-id': 'test-session-subject', 'oai-authenticated-user-email': 'test-session@example.invalid' };
async function fixture(withBundle = false) {
  const bucket = new MemoryR2();
  const token = randomBytes(48).toString('base64url');
  let assetsRead = 0;
  const env: WorkerEnv = { BUCKET: bucket, ASSETS: { async fetch() { assetsRead++; return new Response('<!doctype html><main id="root"></main>', { headers: { 'Content-Type': 'text/html' } }); } },
    VDS_PUBLIC_ORIGIN: origin, VDS_OWNER_PRIVATE: 'true', VDS_IMPORT_TOKEN_SHA256: await sha256Text(token),
    VDS_EXPECTED_BUNDLE_SHA256: '0'.repeat(64), VDS_RELEASE_ID: 'vds-workers-test-release', VDS_COMMIT_SHA: 'a'.repeat(40) };
  const worker = createWorker();
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`${origin}${path}`, init), env);
  let body = '';
  if (withBundle) { body = JSON.stringify(await realBundle()); env.VDS_EXPECTED_BUNDLE_SHA256 = await sha256Text(body); }
  const upload = (value = body, headers: Record<string, string> = {}) => request('/api/internal/import', { method: 'POST', body: value,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers } });
  return { env, bucket, token, request, upload, body, assetsRead: () => assetsRead };
}

test('Worker denies unauthenticated and cross-origin reads before touching private storage or static assets', async () => {
  const f = await fixture();
  for (const path of ['/', '/index.html', '/assets/app.js', '/api/v1/portal-snapshot', '/api/v1/pilot', '/api/v1/analytics']) {
    assert.equal((await f.request(path)).status, 401);
    assert.equal((await f.request(path, { headers: { Cookie: 'session=unverified', 'X-User-Id': 'unverified' } })).status, 401);
    assert.equal((await f.request(path, { headers: { ...identity, Origin: 'https://unrelated.invalid' } })).status, 403);
    assert.equal((await f.request(path, { headers: { ...identity, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  }
  assert.equal((await f.request('/', { headers: { 'oai-authenticated-user-id': 'only-id' } })).status, 401);
  assert.equal(f.bucket.gets, 0); assert.equal(f.assetsRead(), 0);
  f.env.VDS_OWNER_PRIVATE = 'false';
  assert.equal((await f.request('/', { headers: identity })).status, 503);
  f.env.VDS_OWNER_PRIVATE = 'true'; f.env.VDS_PUBLIC_ORIGIN = 'http://private-worker-test.chatgpt.site';
  assert.equal((await f.request('/', { headers: identity })).status, 503);
});

test('Worker exposes only non-personal release metadata and serves generic assets after native session checks', async () => {
  const f = await fixture();
  const release = await (await f.request('/release')).json();
  assert.equal(release.release, f.env.VDS_RELEASE_ID); assert.equal(release.commit, f.env.VDS_COMMIT_SHA);
  assert.equal(release.runtime, 'cloudflare-worker'); assert.equal(release.sourceWrites, 0);
  assert.ok(!JSON.stringify(release).includes(f.token));
  for (const path of ['/vds-snapshot.json', '/private/pilot-10.private.json', '/assets/data.json', '/assets/app.js.map', '/server/index.ts']) {
    assert.equal((await f.request(path, { headers: identity })).status, 404);
  }
  const page = await f.request('/', { headers: identity });
  assert.equal(page.status, 200); assert.match(page.headers.get('Cache-Control')!, /private, no-store/);
  assert.equal(page.headers.get('Content-Type'), 'text/html'); assert.match(page.headers.get('Content-Security-Policy')!, /connect-src 'self'/);
  assert.equal(page.headers.get('X-VDS-Release'), f.env.VDS_RELEASE_ID);
  assert.equal(await (await f.request('/', { method: 'HEAD', headers: identity })).text(), '');
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal((await f.request('/', { headers: { ...identity, ...navigation } })).status, 200);
  assert.equal((await f.request('/', { headers: navigation })).status, 401);
  assert.equal((await f.request('/api/v1/portal-snapshot', { headers: { ...identity, ...navigation } })).status, 403);
  assert.equal((await f.request('/', { headers: { ...identity, ...navigation, Origin: 'https://unrelated.invalid' } })).status, 403);
  assert.equal(f.bucket.gets, 0);
  assert.equal((await f.request('/api/v1/portal-snapshot', { method: 'POST', headers: identity })).status, 405);
  assert.equal((await f.request('/api/v1/analytics?token=untrusted', { headers: identity })).status, 400);
});

test('Worker import requires a separate secret, configured digest, JSON and a bounded body', async () => {
  const f = await fixture();
  assert.equal((await f.request('/api/internal/import', { method: 'POST', headers: identity })).status, 401);
  assert.equal((await f.upload('{}', { Authorization: `Bearer ${randomBytes(48).toString('base64url')}` })).status, 401);
  assert.equal((await f.upload('{}', { Origin: 'https://unrelated.invalid' })).status, 403);
  assert.equal((await f.upload('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.upload('{}', { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await f.upload('{}', { 'Content-Length': String(WORKER_BUNDLE_MAX_BYTES + 1) })).status, 413);
  assert.equal((await f.upload('x'.repeat(WORKER_BUNDLE_MAX_BYTES + 1))).status, 413);
  assert.equal((await f.upload('{}')).status, 409);
  f.env.VDS_EXPECTED_BUNDLE_SHA256 = await sha256Text('{}');
  assert.equal((await f.upload('{}')).status, 422);
  assert.equal(f.bucket.writes.length, 0);
  delete f.env.VDS_EXPECTED_BUNDLE_SHA256;
  assert.equal((await f.upload('{}')).status, 503);
});

test('actual 500 dossiers and 10 enriched fiches import once and cross the protected Worker API unchanged', { skip: !privateRoot }, async () => {
  const f = await fixture(true); const original = await realBundle();
  assert.equal((await f.request('/api/v1/portal-snapshot', { headers: identity })).status, 503);
  const imported = await f.upload(); assert.equal(imported.status, 200);
  const report = await imported.json(); assert.equal(report.dossiers, 500); assert.equal(report.enriched, 10); assert.equal(report.sourceWrites, 0);
  assert.equal(f.bucket.values.size, 2);
  const immutableKey = `vds/private/bundles/${f.env.VDS_EXPECTED_BUNDLE_SHA256}.json`;
  assert.equal((await f.upload()).status, 200);
  assert.equal(f.bucket.writes.filter(key => key === immutableKey).length, 1);
  for (const [path, expected] of [
    ['/api/v1/portal-snapshot', original.snapshot], ['/api/v1/pilot', original.summary], ['/api/v1/connections', original.connections], ['/api/v1/analytics', original.analytics],
    ...original.pilots.map(p => [`/api/v1/pilot/${p.data.id}`, p]),
  ] as [string, unknown][]) {
    const response = await f.request(path, { headers: identity });
    assert.equal(response.status, 200);
    assert.ok(JSON.stringify(await response.json()) === JSON.stringify(expected), 'Protected API must preserve the exact sourced projection');
    assert.equal(response.headers.get('X-VDS-Source-Stale'), 'true');
    assert.equal(response.headers.get('X-VDS-Last-Read-At'), original.snapshot.sourceState!.lastReadAt);
    const etag = response.headers.get('ETag')!;
    assert.equal((await f.request(path, { headers: { ...identity, 'If-None-Match': etag } })).status, 304);
    assert.equal((await f.request(path, { headers: { 'If-None-Match': etag } })).status, 401);
  }
  const absent = original.snapshot.clients.find(c => !original.snapshot.enrichedClientIds!.includes(c.id))!;
  assert.equal((await f.request(`/api/v1/pilot/${absent.id}`, { headers: identity })).status, 404);
  const status = await f.request('/api/internal/import-status', { headers: { Authorization: `Bearer ${f.token}` } });
  assert.equal(status.status, 200); const statusBody = await status.json();
  assert.equal(statusBody.ready, true); assert.equal(statusBody.dossiers, 500);
  assert.ok(!JSON.stringify(statusBody).includes(original.pilots[0].data.name));
  assert.ok(!JSON.stringify(report).includes(f.token));
});

test('Worker never activates an incomplete or corrupt private R2 object and hides storage diagnostics', { skip: !privateRoot }, async () => {
  const f = await fixture(true);
  f.bucket.failWrites = true;
  const failed = await f.upload(); assert.equal(failed.status, 503);
  assert.equal(await failed.text(), '{"error":"private_service_unavailable"}');
  assert.equal(f.bucket.values.has('vds/private/active.json'), false);
  f.bucket.failWrites = false; f.bucket.silentlyDropWrites = true;
  assert.equal((await f.upload()).status, 503);
  assert.equal(f.bucket.values.has('vds/private/active.json'), false);
  f.bucket.silentlyDropWrites = false;
  assert.equal((await f.upload()).status, 200);
  const key = `vds/private/bundles/${f.env.VDS_EXPECTED_BUNDLE_SHA256}.json`;
  f.bucket.values.set(key, '{"untrusted":"corrupt"}');
  assert.equal((await f.upload()).status, 409);
  assert.equal((await f.request('/api/v1/portal-snapshot', { headers: identity })).status, 503);
  f.bucket.values.set(key, f.body);
  f.bucket.values.set('vds/private/active.json', JSON.stringify({ digest: 'f'.repeat(64) }));
  assert.equal((await f.request('/api/v1/portal-snapshot', { headers: identity })).status, 503);
});

test('private bundle rejects changed identities, source links, counts, and financial certainty', { skip: !privateRoot }, async () => {
  const original = await realBundle();
  const rejects = (change: (bundle: WorkerPrivateBundle) => void) => {
    const modified = structuredClone(original); change(modified);
    assert.throws(() => validateWorkerBundle(modified), /invalid_private_bundle|Invalid/);
  };
  rejects(b => { b.snapshot.clients.pop(); });
  rejects(b => { b.pilots.pop(); });
  rejects(b => { b.snapshot.clients.find(c => c.id === b.pilots[0].data.id)!.contact = ''; });
  rejects(b => { b.pilots[0].data.name = b.pilots[1].data.name; });
  rejects(b => { b.pilots[0].data.sections[0].fields[0].sourceIds = ['unknown-source']; });
  rejects(b => { b.pilots[0].data.sources[0].url = 'https://drive.google.com/document?access_token=private'; });
  rejects(b => { b.pilots[0].data.sources[0].url = 'https://untrusted.invalid/document'; });
  rejects(b => { b.pilots[0].data.productionApplied = true as false; });
  rejects(b => { b.analytics.totals.documents++; });
  rejects(b => { b.analytics.meta.sourceRevision += '-changed'; });
  rejects(b => { b.analytics.finance.contractsTotal = 1 as unknown as null; });
  rejects(b => { b.snapshot.clients[0].contractHT = 1; });
  rejects(b => { b.snapshot.connection.sheetReady = true; });
  rejects(b => { b.snapshot.sourceState!.stale = false; });
  rejects(b => { b.pilots[0].data.summary += ' /workspace/private/file'; });
  assert.equal(original.snapshot.clients.length, 500);
});

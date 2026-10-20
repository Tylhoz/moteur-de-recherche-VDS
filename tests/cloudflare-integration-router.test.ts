import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createCloudflareWorker } from '../worker/cloudflare.js';
import { handleIntegrationRequest, type ConnectedEnv } from '../worker/integration-router.js';
import { SHEETS_HEADERS, SHEETS_READONLY_SCOPE } from '../worker/integrations.js';
import type { PrivateR2Bucket } from '../worker/index.js';
import { validateWorkerBundle, type WorkerPrivateBundle } from '../shared/worker-bundle.js';

// Actual records stay outside Git. Changes used to exercise approval exist only
// in isolated memory; no test writes a source archive or contacts a real service.
const root = process.env.VDS_REAL_CHAIN_DATA_ROOT;
const privateTest = { skip: !root, concurrency: false };
const origin = 'https://vds-router-test.workers.dev';
const issuer = 'https://vds-router-test.cloudflareaccess.com';
const audience = 'e'.repeat(64);
const owner = 'owner-router@example.invalid';
const importSecret = 'test-only-private-import-secret-0123456789';
const clock = new Date('2026-10-20T12:00:00Z');
const rsa = generateKeyPair('RS256', { extractable: true });
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
let source: Promise<{ body: string; bundle: WorkerPrivateBundle; digest: string }> | undefined;
function actual() {
  return source ??= (async () => {
    const body = await readFile(resolve(root!, 'worker-preview.private.json'), 'utf8');
    return { body, bundle: validateWorkerBundle(JSON.parse(body)), digest: hash(body) };
  })();
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
type Conditions = NonNullable<Parameters<PrivateR2Bucket['put']>[2]>;

/** Conditions are checked immediately before the synchronous map mutation. */
class MemoryR2 implements PrivateR2Bucket {
  entries = new Map<string, { body: string; etag: string }>();
  writes: { key: string; conditions?: Conditions; succeeded: boolean }[] = [];
  beforeCompare?: (key: string, conditions?: Conditions) => Promise<void>;
  async get(key: string) {
    const value = this.entries.get(key);
    return value ? { size: Buffer.byteLength(value.body), etag: value.etag, text: async () => value.body } : null;
  }
  async put(key: string, body: string, conditions?: Conditions) {
    await this.beforeCompare?.(key, conditions);
    const current = this.entries.get(key), condition = conditions?.onlyIf;
    if (condition?.etagDoesNotMatch === '*' && current || condition?.etagMatches && current?.etag !== condition.etagMatches) {
      this.writes.push({ key, conditions, succeeded: false }); return null;
    }
    const value = { body, etag: hash(body) };
    this.entries.set(key, value); this.writes.push({ key, conditions, succeeded: true }); return { etag: value.etag };
  }
  businessWrites() { return this.writes.filter(write => write.succeeded && /^vds\/private\/(?:active\.json|bundles\/|sheets\/(?:approved\.json|versions\/))/.test(write.key)); }
}
async function fixture() {
  const original = await actual(), bucket = new MemoryR2();
  const publicKey = await exportJWK((await rsa).publicKey);
  const env: ConnectedEnv = { BUCKET: bucket, ASSETS: { async fetch() { return new Response('<main id="root"></main>'); } },
    VDS_PUBLIC_ORIGIN: origin, VDS_ACCESS_TEAM_DOMAIN: issuer, VDS_ACCESS_AUD: audience, VDS_OWNER_EMAIL: owner,
    VDS_IMPORT_TOKEN: importSecret, VDS_IMPORT_TOKEN_SHA256: hash(importSecret), VDS_EXPECTED_BUNDLE_SHA256: original.digest,
    VDS_RELEASE_ID: 'vds-router-test', VDS_COMMIT_SHA: 'f'.repeat(40) };
  const app = createCloudflareWorker({ handleAuthorized: handleIntegrationRequest, now: () => clock,
    fetcher: async input => { assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`);
      return json({ keys: [{ ...publicKey, kid: 'router-test-key', alg: 'RS256', use: 'sig' }] }); } });
  async function token(email = owner) {
    const time = Math.floor(clock.getTime() / 1000);
    return new SignJWT({ email, type: 'app' }).setProtectedHeader({ typ: 'JWT', alg: 'RS256', kid: 'router-test-key' })
      .setIssuer(issuer).setAudience(audience).setSubject('owner-router-test-subject').setIssuedAt(time - 60).setExpirationTime(time + 3600).sign((await rsa).privateKey);
  }
  const signed = await token();
  const request = (path: string, init: RequestInit = {}, jwt: string | null = signed) => {
    const headers = new Headers(init.headers); if (jwt) headers.set('Cf-Access-Jwt-Assertion', jwt);
    return app.fetch(new Request(`${origin}${path}`, { ...init, headers }), env);
  };
  const post = (path: string, value?: unknown, extra: Record<string, string> = {}) => request(path, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...extra }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
  const upload = (body = original.body, extra: Record<string, string> = {}, jwt: string | null = signed) => request('/api/v1/setup/import', {
    method: 'POST', body, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-VDS-Action': 'import', ...extra },
  }, jwt);
  const snapshot = async () => { const response = await request('/api/v1/portal-snapshot'); assert.equal(response.status, 200); return response.json(); };
  const importReady = async () => { const response = await upload(); assert.equal(response.status, 200); return response.json(); };
  // Hash comparisons also prevent failure diagnostics from dumping client data.
  const originalBytes = () => ({ pointer: hash(bucket.entries.get('vds/private/active.json')?.body || ''),
    bundle: hash(bucket.entries.get(`vds/private/bundles/${original.digest}.json`)?.body || '') });
  return { original, bucket, env, token, signed, request, post, upload, snapshot, importReady, originalBytes };
}
function googleRows(bundle: WorkerPrivateBundle) {
  return [Array.from(SHEETS_HEADERS), ...bundle.snapshot.clients.map(c => [c.id, c.client, c.contact, c.address, c.modelTeam, c.techMacon, c.finance, c.statusAction])];
}
const googleEnv = {
  VDS_GOOGLE_CLIENT_ID: 'router-test-client.apps.googleusercontent.com', VDS_GOOGLE_CLIENT_SECRET: 'test-only-google-secret',
  VDS_GOOGLE_REFRESH_TOKEN: 'test-only-google-refresh-token', VDS_LEGACY_SPREADSHEET_ID: 'router-test-spreadsheet-id',
};
async function withGoogleMock<T>(rows: string[][] | null, callback: (mock: {
  calls: { url: URL; method: string }[]; replace(next: string[][]): void;
}) => Promise<T>) {
  const previous = globalThis.fetch, calls: { url: URL; method: string }[] = [];
  let currentRows = rows;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, method: init.method || 'GET' });
    if (!currentRows) throw new Error('Network must not be used with unconfigured integrations');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    if (url.href === 'https://oauth2.googleapis.com/token') {
      assert.equal(init.method, 'POST');
      return json({ access_token: 'test-only-google-access-token', token_type: 'Bearer', expires_in: 3600, scope: SHEETS_READONLY_SCOPE });
    }
    assert.equal(url.origin, 'https://sheets.googleapis.com'); assert.equal(init.method, 'GET', 'Source APIs must remain read-only');
    if (url.pathname.endsWith('/values:batchGet')) return json({ spreadsheetId: googleEnv.VDS_LEGACY_SPREADSHEET_ID,
      valueRanges: [{ range: 'Base_Centrale_360!A1:H501', majorDimension: 'ROWS', values: currentRows }] });
    assert.equal(url.pathname, `/v4/spreadsheets/${googleEnv.VDS_LEGACY_SPREADSHEET_ID}`);
    return json({ spreadsheetId: googleEnv.VDS_LEGACY_SPREADSHEET_ID, sheets: [{ properties: {
      sheetId: 1, title: 'Base_Centrale_360', gridProperties: { rowCount: 501, columnCount: 8 },
    } }] });
  };
  try { return await callback({ calls, replace(next) { currentRows = next; } }); }
  finally { globalThis.fetch = previous; }
}

test('owner UI imports actual 500/10 without an administrative secret in browser headers', privateTest, async () => {
  const f = await fixture();
  await withGoogleMock(null, async mock => {
    const report = await f.importReady(); assert.equal(report.dossiers, 500); assert.equal(report.enriched, 10); assert.equal(report.sourceWrites, 0);
    assert.ok(!JSON.stringify(report).includes(importSecret)); assert.equal(mock.calls.length, 0);
    assert.equal(hash(JSON.stringify(await f.snapshot())), hash(JSON.stringify(f.original.bundle.snapshot)));
    assert.equal(f.originalBytes().bundle, f.original.digest);
    for (const pilot of f.original.bundle.pilots) {
      const response = await f.request(`/api/v1/pilot/${pilot.data.id}`); assert.equal(response.status, 200);
      assert.equal(hash(await response.text()), hash(JSON.stringify(pilot)));
    }
    const baseline = f.originalBytes(); const repeat = await f.upload(); assert.equal(repeat.status, 200);
    assert.deepEqual(f.originalBytes(), baseline);
    assert.equal(f.bucket.writes.filter(w => w.succeeded && w.key.startsWith('vds/private/bundles/')).length, 1);
  });
});

test('UI import rejects bad JWT, origin, token configuration, action and digest before data writes', privateTest, async () => {
  for (const kind of ['anonymous', 'other-owner', 'foreign-origin', 'missing-origin', 'missing-token', 'mismatched-token', 'bad-digest', 'missing-digest', 'missing-action'] as const) {
    const f = await fixture(); let response: Response;
    if (kind === 'missing-token') delete f.env.VDS_IMPORT_TOKEN;
    if (kind === 'mismatched-token') f.env.VDS_IMPORT_TOKEN_SHA256 = '0'.repeat(64);
    if (kind === 'bad-digest') f.env.VDS_EXPECTED_BUNDLE_SHA256 = '0'.repeat(64);
    if (kind === 'missing-digest') delete f.env.VDS_EXPECTED_BUNDLE_SHA256;
    if (kind === 'missing-origin' || kind === 'missing-action') {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (kind === 'missing-origin') headers['X-VDS-Action'] = 'import'; else headers.Origin = origin;
      response = await f.request('/api/v1/setup/import', { method: 'POST', body: f.original.body, headers });
    } else response = await f.upload(f.original.body, kind === 'foreign-origin' ? { Origin: 'https://unrelated.invalid' } : {},
      kind === 'anonymous' ? null : kind === 'other-owner' ? await f.token('other@example.invalid') : f.signed);
    const expected = kind === 'anonymous' ? 401 : ['other-owner', 'foreign-origin', 'missing-origin'].includes(kind) ? 403
      : kind === 'missing-action' ? 400 : kind === 'bad-digest' ? 409 : 503;
    assert.equal(response.status, expected, kind); assert.equal(f.bucket.businessWrites().length, 0, kind); assert.equal(f.bucket.entries.size, 0, kind);
  }
});

test('unconfigured Google remains disconnected, uses no network and cannot alter the imported archive', privateTest, async () => {
  const f = await fixture(); await f.importReady(); const originalBytes = f.originalBytes();
  await withGoogleMock(null, async mock => {
    const config = await (await f.request('/api/v1/integrations')).json();
    assert.equal(config.sheets.configured, false); assert.equal(config.sheets.connected, false); assert.equal(config.sourceWrites, 0);
    assert.equal(config.invoicing.connected, false);
    assert.deepEqual(await (await f.request('/api/v1/integrations/sheets/preview')).json(), { proposal: null });
    const failed = await f.post('/api/v1/integrations/sheets/preview'); assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, 'google_configuration_missing_or_invalid');
    assert.equal(mock.calls.length, 0); assert.deepEqual(f.originalBytes(), originalBytes);
    assert.equal(hash(JSON.stringify(await f.snapshot())), hash(JSON.stringify(f.original.bundle.snapshot)));
    assert.equal(f.bucket.businessWrites().filter(w => w.key.startsWith('vds/private/sheets/')).length, 0);
  });
});

test('Google changes stay pending until explicit approval, then preserve identity, enrichment, original bytes and sourceWrites zero', privateTest, async () => {
  const f = await fixture(); await f.importReady(); Object.assign(f.env, googleEnv); const baseline = f.originalBytes();
  const rows = googleRows(f.original.bundle); rows[1][7] += ' [modification isolée pour le test]';
  await withGoogleMock(rows, async mock => {
    const pending = await f.post('/api/v1/integrations/sheets/preview'); assert.equal(pending.status, 200);
    const proposal = await pending.json(); assert.equal(proposal.requiresValidation, true); assert.equal(proposal.changes.length, 1);
    assert.equal(proposal.changes[0].requiresIdentityReview, false); assert.equal(proposal.sourceWrites, 0);
    assert.equal(hash(JSON.stringify(await f.snapshot())), hash(JSON.stringify(f.original.bundle.snapshot)));
    const incomplete = await f.post('/api/v1/integrations/sheets/approve', { revision: proposal.revision, confirm: false }); assert.equal(incomplete.status, 400);
    assert.equal(f.bucket.entries.has('vds/private/sheets/approved.json'), false);
    const response = await f.post('/api/v1/integrations/sheets/approve', { revision: proposal.revision, confirm: true }); assert.equal(response.status, 200);
    const approved = await response.json(); assert.equal(approved.sourceWrites, 0); assert.equal(approved.financialTotalsVerified, false);
    const snapshot = await f.snapshot(); assert.equal(snapshot.clients.length, 500); assert.equal(snapshot.enrichedClientIds.length, 10);
    assert.equal(snapshot.clients[0].statusAction, rows[1][7]); assert.equal(snapshot.sourceState.stale, false);
    assert.equal(hash(JSON.stringify(snapshot.clients.map((c: any) => [c.id, c.client, c.contact, c.address]))),
      hash(JSON.stringify(f.original.bundle.snapshot.clients.map(c => [c.id, c.client, c.contact, c.address]))));
    assert.ok(snapshot.clients.every((c: any) => c.contractHT === null && c.soldeAmount === null && c.category === 'non_verifie'));
    assert.deepEqual(f.originalBytes(), baseline);
    const get = await f.request('/api/v1/portal-snapshot');
    assert.equal((await f.request('/api/v1/portal-snapshot', { headers: { 'If-None-Match': get.headers.get('ETag')! } })).status, 304);
    assert.ok(mock.calls.length >= 14); assert.ok(mock.calls.every(c => c.url.hostname === 'oauth2.googleapis.com' || c.method === 'GET'));
    const pointer = f.bucket.writes.find(w => w.key === 'vds/private/sheets/approved.json' && w.succeeded)!;
    assert.equal(pointer.conditions?.onlyIf?.etagDoesNotMatch, '*');
    const afterApproval = await f.request('/api/v1/integrations/sheets/preview'); assert.equal(afterApproval.status, 200);
    assert.deepEqual(await afterApproval.json(), { proposal: null });
    const status = await (await f.request('/api/v1/integrations')).json();
    assert.equal(status.sheets.state, 'ready'); assert.equal(status.sheets.connected, true);
    const setup = await (await f.request('/api/v1/setup')).json(); assert.equal(setup.ready, true); assert.equal(setup.storage.state, 'ready');
    const approvedPointer = JSON.parse(f.bucket.entries.get('vds/private/sheets/approved.json')!.body);
    const versionKey = `vds/private/sheets/versions/${approvedPointer.digest}.json`;
    const intact = f.bucket.entries.get(versionKey)!;
    f.bucket.entries.set(versionKey, { body: '{"corrupt":true}', etag: hash('{"corrupt":true}') });
    assert.equal((await f.request('/api/v1/portal-snapshot')).status, 503);
    const unavailable = await f.request('/api/v1/setup'); assert.equal(unavailable.status, 200);
    const diagnostic = await unavailable.json(); assert.equal(diagnostic.ready, false); assert.equal(diagnostic.storage.state, 'unavailable');
    assert.equal(diagnostic.storage.dossiers, null); assert.equal(diagnostic.storage.enriched, null);
    assert.deepEqual(f.originalBytes(), baseline);
    f.bucket.entries.set(versionKey, intact);
  });
});

test('an identity change cannot be approved or linked to another real dossier', privateTest, async () => {
  const f = await fixture(); await f.importReady(); Object.assign(f.env, googleEnv); const baseline = f.originalBytes();
  const rows = googleRows(f.original.bundle); rows[1][3] += ' [différence identité de test]';
  await withGoogleMock(rows, async () => {
    const pending = await f.post('/api/v1/integrations/sheets/preview'); assert.equal(pending.status, 200); const proposal = await pending.json();
    assert.equal(proposal.changes[0].requiresIdentityReview, true);
    const rejected = await f.post('/api/v1/integrations/sheets/approve', { revision: proposal.revision, confirm: true }); assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error, 'identity_review_required');
    assert.equal(f.bucket.entries.has('vds/private/sheets/approved.json'), false);
    assert.equal(f.bucket.businessWrites().filter(w => w.key.startsWith('vds/private/sheets/')).length, 0);
    assert.deepEqual(f.originalBytes(), baseline);
    assert.equal(hash(JSON.stringify(await f.snapshot())), hash(JSON.stringify(f.original.bundle.snapshot)));
  });
});

test('approval re-reads Google and rejects a source revision changed since the displayed proposal', privateTest, async () => {
  const f = await fixture(); await f.importReady(); Object.assign(f.env, googleEnv); const baseline = f.originalBytes();
  const rows = googleRows(f.original.bundle); rows[1][7] += ' [première lecture de test]';
  await withGoogleMock(rows, async mock => {
    const pending = await f.post('/api/v1/integrations/sheets/preview'); assert.equal(pending.status, 200); const proposal = await pending.json();
    const updated = structuredClone(rows); updated[1][7] += ' [source modifiée après lecture]'; mock.replace(updated);
    const rejected = await f.post('/api/v1/integrations/sheets/approve', { revision: proposal.revision, confirm: true }); assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error, 'proposal_changed');
    assert.equal(f.bucket.entries.has('vds/private/sheets/approved.json'), false);
    assert.deepEqual(f.originalBytes(), baseline);
    assert.equal(hash(JSON.stringify(await f.snapshot())), hash(JSON.stringify(f.original.bundle.snapshot)));
    const latest = await (await f.request('/api/v1/integrations/sheets/preview')).json();
    assert.notEqual(latest.proposal.revision, proposal.revision); assert.equal(latest.proposal.sourceWrites, 0);
  });
});

test('R2 compare-and-swap permits one concurrent approval and rejects the stale activation', privateTest, async () => {
  const f = await fixture(); await f.importReady(); Object.assign(f.env, googleEnv); const baseline = f.originalBytes();
  const rows = googleRows(f.original.bundle); rows[1][7] += ' [approbation concurrente de test]';
  await withGoogleMock(rows, async () => {
    const pending = await f.post('/api/v1/integrations/sheets/preview'); assert.equal(pending.status, 200); const proposal = await pending.json();
    let arrivals = 0, release!: () => void; const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    f.bucket.beforeCompare = async key => {
      if (key !== 'vds/private/sheets/approved.json') return;
      arrivals++; if (arrivals === 2) release(); await gate;
    };
    const results = await Promise.all([
      f.post('/api/v1/integrations/sheets/approve', { revision: proposal.revision, confirm: true }),
      f.post('/api/v1/integrations/sheets/approve', { revision: proposal.revision, confirm: true }),
    ]);
    f.bucket.beforeCompare = undefined;
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const rejected = await results.find(r => r.status === 409)!.json(); assert.equal(rejected.error, 'source_version_changed');
    const decisions = f.bucket.writes.filter(w => w.key === 'vds/private/sheets/approved.json');
    assert.equal(decisions.filter(w => w.succeeded).length, 1); assert.equal(decisions.filter(w => !w.succeeded).length, 1);
    assert.deepEqual(f.originalBytes(), baseline);
    assert.equal((await f.snapshot()).clients[0].statusAction, rows[1][7]);
  });
});

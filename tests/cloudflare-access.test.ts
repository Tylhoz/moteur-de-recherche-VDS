import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createCloudflareWorker, type CloudflareEnv, type CloudflareWorkerOptions } from '../worker/cloudflare.js';
import { sha256Text } from '../shared/worker-bundle.js';

const origin = 'https://vds-auth-test.workers.dev';
const issuer = 'https://vds-auth-test.cloudflareaccess.com';
const audience = 'a'.repeat(64);
const ownerEmail = 'owner@example.invalid';
const now = new Date('2026-10-20T12:00:00Z');
const timestamp = Math.floor(now.getTime() / 1000);
const signingKeys = generateKeyPair('RS256', { extractable: true });
async function jwt(changes: JWTPayload = {}, omit: string[] = []) {
  const payload: JWTPayload = { iss: issuer, aud: [audience], email: ownerEmail, sub: 'owner-test-subject', type: 'app', iat: timestamp - 60, exp: timestamp + 3600, nbf: timestamp - 60, ...changes };
  for (const key of omit) delete payload[key];
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'test-signing-key' }).sign((await signingKeys).privateKey);
}
async function fixture(options: Pick<CloudflareWorkerOptions, 'handleAuthorized'> = {}) {
  const publicKey = await exportJWK((await signingKeys).publicKey);
  let certificateReads = 0, assetReads = 0, storageReads = 0, storageWrites = 0;
  let failCertificates = false, failStorage = false;
  const saved = new Map<string, string>(); const assetRequests: Request[] = [];
  const env: CloudflareEnv = { VDS_PUBLIC_ORIGIN: origin, VDS_ACCESS_TEAM_DOMAIN: issuer, VDS_ACCESS_AUD: audience, VDS_OWNER_EMAIL: ownerEmail,
    VDS_RELEASE_ID: 'vds-direct-test', VDS_COMMIT_SHA: 'b'.repeat(40), VDS_EXPECTED_BUNDLE_SHA256: 'c'.repeat(64),
    ASSETS: { async fetch(request) { assetReads++; assetRequests.push(request); return new Response('<!doctype html><main id="root"></main>', { headers: { 'Content-Type': 'text/html' } }); } },
    BUCKET: { async get(key) { storageReads++; if (failStorage) throw new Error('private-storage-diagnostic'); const body = saved.get(key);
      return body === undefined ? null : { size: new TextEncoder().encode(body).length, text: async () => body }; },
      async put(key, body, conditions) { storageWrites++; if (failStorage) throw new Error('private-storage-diagnostic');
        if (conditions?.onlyIf?.etagDoesNotMatch === '*' && saved.has(key)) return null; saved.set(key, body); return { key }; } },
  };
  const fetcher: typeof fetch = async (input, init) => {
    certificateReads++; assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`); assert.equal(init?.redirect, 'error');
    if (failCertificates) throw new Error('network-diagnostic-must-not-leak');
    return new Response(JSON.stringify({ keys: [{ ...publicKey, kid: 'test-signing-key', alg: 'RS256', use: 'sig' }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const app = createCloudflareWorker({ fetcher, now: () => now, ...options });
  const request = (path = '/', token?: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers); if (token) headers.set('Cf-Access-Jwt-Assertion', token);
    return app.fetch(new Request(`${origin}${path}`, { ...init, headers }), env);
  };
  return { env, saved, request, assetRequests, counts: () => ({ certificateReads, assetReads, storageReads, storageWrites }),
    failCertificates() { failCertificates = true; }, failStorage() { failStorage = true; } };
}

test('direct Worker fails closed before storage or assets for anonymous and forged proxy identities', async () => {
  const f = await fixture();
  const forged = { 'oai-authenticated-user-id': 'owner-test-subject', 'oai-authenticated-user-email': ownerEmail,
    'Cf-Access-Authenticated-User-Email': ownerEmail, 'X-Forwarded-User': ownerEmail, 'X-User-Id': 'owner-test-subject', Cookie: 'CF_Authorization=forged' };
  for (const path of ['/', '/assets/app.js', '/api/v1/setup', '/api/v1/portal-snapshot', '/release', '/api/internal/import-status']) {
    const response = await f.request(path, undefined, { headers: forged });
    assert.equal(response.status, 401); const body = await response.json(); assert.equal(body.error, 'authentication_required');
    assert.equal(body.signInPath, '/'); assert.ok(!JSON.stringify(body).includes(ownerEmail));
  }
  assert.deepEqual(f.counts(), { certificateReads: 0, assetReads: 0, storageReads: 0, storageWrites: 0 });
});

test('direct Worker rejects missing or unsafe Access configuration without trusting token issuer URLs', async () => {
  for (const changes of [
    { VDS_OWNER_EMAIL: undefined }, { VDS_ACCESS_AUD: undefined }, { VDS_ACCESS_TEAM_DOMAIN: undefined },
    { VDS_ACCESS_TEAM_DOMAIN: 'https://unrelated.invalid' }, { VDS_ACCESS_TEAM_DOMAIN: 'https://user:pass@vds-auth-test.cloudflareaccess.com' },
    { VDS_ACCESS_TEAM_DOMAIN: `${issuer}/path` }, { VDS_ACCESS_TEAM_DOMAIN: 'http://localhost' },
    { VDS_PUBLIC_ORIGIN: undefined }, { VDS_PUBLIC_ORIGIN: 'http://vds-auth-test.workers.dev' },
  ]) {
    const f = await fixture(); Object.assign(f.env, changes);
    assert.equal((await f.request('/api/v1/setup', await jwt())).status, 503);
    assert.equal(f.counts().certificateReads, 0); assert.equal(f.counts().storageReads, 0);
  }
});

test('real RSA signature validation rejects tampering, audience, issuer, expiry, future and non-application claims', async () => {
  const f = await fixture();
  const valid = await jwt(); const parts = valid.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); payload.sub = 'changed-without-resigning';
  const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
  const foreignKeys = await generateKeyPair('RS256');
  const wrongKey = await new SignJWT({ iss: issuer, aud: audience, sub: 'owner-test-subject', email: ownerEmail, type: 'app', iat: timestamp - 1, exp: timestamp + 60 })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'test-signing-key' }).sign(foreignKeys.privateKey);
  const unsupported = await new SignJWT({ email: ownerEmail }).setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'test-signing-key' })
    .sign(new TextEncoder().encode('test-only-hmac-key-of-more-than-32-characters'));
  for (const token of [tampered, wrongKey, unsupported, 'not-a-jwt', await jwt({ aud: 'd'.repeat(64) }),
    await jwt({ iss: 'https://another-team.cloudflareaccess.com' }), await jwt({ exp: timestamp - 1 }), await jwt({ nbf: timestamp + 60 }),
    await jwt({ iat: timestamp + 60 }), await jwt({ type: 'org' }), await jwt({}, ['exp']), await jwt({}, ['email']), await jwt({}, ['sub'])]) {
    assert.equal((await f.request('/api/v1/setup', token)).status, 401);
  }
  assert.equal(f.counts().assetReads, 0); assert.equal(f.counts().storageReads, 0);
  assert.equal((await f.request('/api/v1/setup', valid)).status, 200);
  assert.equal(f.counts().certificateReads, 1, 'JWKS are cached; every token is still cryptographically verified');
});

test('only signed owner email grants access; supplied identity headers and cookies are replaced before runtime/extension', async () => {
  let extensionCalls = 0;
  const f = await fixture({ async handleAuthorized(request, _env, identity) {
    extensionCalls++; assert.equal(identity.email, ownerEmail); assert.equal(identity.subject, 'owner-test-subject');
    assert.equal(request.headers.get('oai-authenticated-user-email'), ownerEmail); assert.equal(request.headers.get('oai-authenticated-user-id'), identity.subject);
    for (const key of ['Cookie', 'Cf-Access-Jwt-Assertion', 'Cf-Access-Authenticated-User-Email', 'X-Forwarded-User', 'X-User-Id']) assert.equal(request.headers.get(key), null);
    return request.url.endsWith('/api/v1/extension') ? new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }) : null;
  } });
  const forged = { 'oai-authenticated-user-id': 'forged', 'oai-authenticated-user-email': 'forged@example.invalid',
    'Cf-Access-Authenticated-User-Email': ownerEmail, 'X-Forwarded-User': ownerEmail, 'X-User-Id': 'forged', Cookie: 'CF_Authorization=not-trusted' };
  assert.equal((await f.request('/api/v1/extension', await jwt({ email: 'another@example.invalid' }), { headers: forged })).status, 403);
  assert.equal(extensionCalls, 0);
  const valid = await jwt({ email: ownerEmail.toUpperCase() });
  const response = await f.request('/api/v1/extension', valid, { headers: forged });
  assert.equal(response.status, 200); assert.match(response.headers.get('Cache-Control')!, /private, no-store/);
  assert.equal((await f.request('/', valid, { headers: forged })).status, 200);
  assert.equal(f.assetRequests[0].headers.get('oai-authenticated-user-email'), ownerEmail);
  assert.equal(f.assetRequests[0].headers.get('Cf-Access-Jwt-Assertion'), null);
});

test('certificate/network failures remain closed and setup reports missing or inaccessible storage without secrets', async () => {
  const failed = await fixture(); failed.failCertificates();
  const denied = await failed.request('/api/v1/setup', await jwt());
  assert.equal(denied.status, 503); assert.ok(!(await denied.text()).includes('diagnostic'));
  assert.equal(failed.counts().storageReads, 0);
  const f = await fixture(); const token = await jwt();
  let setup = await (await f.request('/api/v1/setup', token)).json();
  assert.equal(setup.storage.state, 'empty'); assert.equal(setup.storage.dossiers, null); assert.equal(setup.ready, false);
  f.env.VDS_IMPORT_TOKEN = 'test-private-import-secret-base64url-123456';
  setup = await (await f.request('/api/v1/setup', token)).json(); assert.equal(setup.configuration.importToken, true);
  f.failStorage(); setup = await (await f.request('/api/v1/setup', token)).json();
  assert.equal(setup.storage.state, 'unavailable'); assert.equal(setup.storage.enriched, null);
  assert.equal((await f.request('/api/v1/portal-snapshot', token)).status, 503);
  for (const secret of [ownerEmail, issuer, audience, f.env.VDS_IMPORT_TOKEN, f.env.VDS_EXPECTED_BUNDLE_SHA256!]) assert.ok(!JSON.stringify(setup).includes(secret));
  delete f.env.BUCKET; delete f.env.ASSETS; delete f.env.VDS_EXPECTED_BUNDLE_SHA256;
  setup = await (await f.request('/api/v1/setup', token)).json();
  assert.equal(setup.storage.state, 'not_configured'); assert.equal(setup.configuration.assets, false); assert.equal(setup.configuration.storage, false);
});

test('direct import requires Access owner plus existing import secret; cross-origin and unsupported methods remain denied', async () => {
  let extensionCalls = 0; const f = await fixture({ async handleAuthorized() { extensionCalls++; return null; } });
  const token = await jwt(), secret = 'test-only-import-secret-of-sufficient-length'; f.env.VDS_IMPORT_TOKEN_SHA256 = await sha256Text(secret);
  const body = '{}', requestHeaders = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
  assert.equal((await f.request('/api/internal/import', undefined, { method: 'POST', body, headers: requestHeaders })).status, 401);
  assert.equal((await f.request('/api/internal/import', token, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await f.request('/api/internal/import', token, { method: 'POST', body, headers: requestHeaders })).status, 409);
  assert.equal(extensionCalls, 0, 'Extensions cannot bypass internal import checks');
  assert.equal(f.counts().storageWrites, 0);
  const foreign = { Origin: 'https://unrelated.invalid' };
  assert.equal((await f.request('/api/v1/setup', token, { headers: foreign })).status, 403);
  assert.equal((await f.request('/api/v1/setup', token, { method: 'POST' })).status, 405);
  assert.equal((await f.request('/api/v1/setup?secret=not-accepted', token)).status, 400);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal((await f.request('/', token, { headers: navigation })).status, 200);
  assert.equal((await f.request('/api/v1/setup', token, { headers: navigation })).status, 403);
  const release = await (await f.request('/api/v1/release', token)).json();
  assert.equal(release.authentication, 'cloudflare-access'); assert.equal(release.release, f.env.VDS_RELEASE_ID); assert.equal(release.commit, f.env.VDS_COMMIT_SHA);
});

test('signed owner imports the real 500 dossiers and 10 fiches through the direct adapter', {
  skip: !process.env.VDS_REAL_CHAIN_DATA_ROOT,
}, async () => {
  const f = await fixture(), token = await jwt(), secret = 'test-only-import-secret-of-sufficient-length';
  const body = await readFile(resolve(process.env.VDS_REAL_CHAIN_DATA_ROOT!, 'worker-preview.private.json'), 'utf8');
  f.env.VDS_EXPECTED_BUNDLE_SHA256 = await sha256Text(body); f.env.VDS_IMPORT_TOKEN_SHA256 = await sha256Text(secret);
  const uploaded = await f.request('/api/internal/import', token, { method: 'POST', body, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } });
  assert.equal(uploaded.status, 200);
  const setup = await (await f.request('/api/v1/setup', token)).json();
  assert.equal(setup.ready, true); assert.equal(setup.storage.state, 'ready'); assert.equal(setup.storage.dossiers, 500); assert.equal(setup.storage.enriched, 10);
  const snapshot = await (await f.request('/api/v1/portal-snapshot', token)).json();
  const original = JSON.parse(body);
  assert.ok(JSON.stringify(snapshot) === JSON.stringify(original.snapshot), 'Actual source projection is unchanged by Access authentication');
  for (const pilot of original.pilots) {
    const response = await f.request(`/api/v1/pilot/${pilot.data.id}`, token); assert.equal(response.status, 200);
    assert.ok(JSON.stringify(await response.json()) === JSON.stringify(pilot));
  }
  assert.equal(snapshot.sourceState.stale, true);
  assert.ok(snapshot.clients.every((client: { contractHT: unknown; soldeAmount: unknown }) => client.contractHT === null && client.soldeAmount === null));
});

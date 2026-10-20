import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { WorkerEnv } from '../worker/index.js';
import { validateWorkerBundle } from '../shared/worker-bundle.js';

const sourceRoot = process.env.VDS_REAL_CHAIN_DATA_ROOT;
const artifactPath = resolve('worker-dist/server/index.js');
const privatePath = sourceRoot && resolve(sourceRoot, 'worker-preview.private.json');
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

test('compiled Worker ESM runs real private data through Fetch APIs and mock R2 without Node runtime imports', {
  skip: !privatePath || !existsSync(privatePath) || !existsSync(artifactPath),
}, async () => {
  // This is a Web API contract test of the deployed artifact. It is not a claim
  // of remote Cloudflare execution or proof of Sites access-policy enforcement.
  const [source, payload] = await Promise.all([readFile(artifactPath, 'utf8'), readFile(privatePath!, 'utf8')]);
  const actual = validateWorkerBundle(JSON.parse(payload));
  assert.doesNotMatch(source, /(?:from\s*["']node:|require\(["'](?:node:|fs|http|path))/);
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(typeof module.default.fetch, 'function');
  assert.equal(module.buildInfo.businessDataEmbedded, false);
  assert.match(module.buildInfo.commit, /^[a-f0-9]{40}$/);
  assert.ok(module.buildInfo.assets.length > 1);
  const entries = new Map<string, string>();
  let readCount = 0; let writeCount = 0; let failWrites = false;
  const importToken = randomBytes(48).toString('base64url');
  const origin = 'https://compiled-private-test.chatgpt.site';
  const env = { VDS_PUBLIC_ORIGIN: origin, VDS_OWNER_PRIVATE: 'true', VDS_EXPECTED_BUNDLE_SHA256: hash(payload), VDS_IMPORT_TOKEN_SHA256: hash(importToken),
    BUCKET: {
      async get(key: string) { readCount++; const value = entries.get(key); return value === undefined ? null : { size: Buffer.byteLength(value), text: async () => value }; },
      async put(key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
        if (failWrites) throw new Error('storage-diagnostic-secret');
        if (options?.onlyIf?.etagDoesNotMatch === '*' && entries.has(key)) return null;
        writeCount++; entries.set(key, value); return { key };
      },
    },
  } as unknown as WorkerEnv;
  const request = (path: string, init?: RequestInit) => module.default.fetch(new Request(`${origin}${path}`, init), env) as Promise<Response>;
  const authenticated = { 'oai-authenticated-user-id': 'test-dispatch-subject', 'oai-authenticated-user-email': 'test-dispatch@example.invalid' };
  const upload = (body = payload, extra: Record<string, string> = {}) => request('/api/internal/import', { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${importToken}`, ...extra } });

  // Origin and fetch-site may legitimately be absent during direct navigation.
  // Legacy/fake application headers still cannot substitute for native Dispatch.
  for (const path of ['/', '/api/v1/portal-snapshot', '/api/v1/pilot', '/api/v1/analytics']) {
    assert.equal((await request(path, { headers: { 'X-User-Id': 'unverified', Cookie: 'session=forged' } })).status, 401);
    assert.equal((await request(path, { headers: { Authorization: `Bearer ${importToken}` } })).status, 401);
    assert.equal((await request(path, { headers: { ...authenticated, Origin: 'https://unrelated.invalid' } })).status, 403);
  }
  assert.equal(readCount, 0); assert.equal(writeCount, 0);
  assert.equal((await upload(payload, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await upload('{}')).status, 409);
  assert.equal((await upload(payload, { 'Content-Length': String(4 * 1024 * 1024 + 1) })).status, 413);
  assert.equal(writeCount, 0);
  failWrites = true;
  const storageError = await upload(); assert.equal(storageError.status, 503);
  assert.equal(await storageError.text(), '{"error":"private_service_unavailable"}');
  assert.equal(entries.has('vds/private/active.json'), false);
  failWrites = false;
  assert.equal((await upload()).status, 200);
  assert.equal(entries.size, 2);

  for (const [path, expected] of [
    ['/api/v1/portal-snapshot', actual.snapshot], ['/api/v1/pilot', actual.summary], ['/api/v1/connections', actual.connections], ['/api/v1/analytics', actual.analytics],
    ...actual.pilots.map(pilot => [`/api/v1/pilot/${pilot.data.id}`, pilot]),
  ] as [string, unknown][]) {
    const response = await request(path, { headers: authenticated }); assert.equal(response.status, 200);
    assert.equal(hash(await response.text()), hash(JSON.stringify(expected)), 'Artifact must preserve the private projection byte-for-byte');
    assert.equal(response.headers.get('X-VDS-Source-Stale'), 'true');
    assert.equal(response.headers.get('X-VDS-Last-Read-At'), actual.snapshot.sourceState!.lastReadAt);
    assert.equal((await request(path, { headers: { ...authenticated, 'If-None-Match': response.headers.get('ETag')! } })).status, 304);
  }
  const page = await request('/', { headers: authenticated });
  assert.equal(page.status, 200); assert.match(page.headers.get('Content-Type')!, /text\/html/);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal((await request('/', { headers: { ...authenticated, ...navigation } })).status, 200);
  assert.equal((await request('/api/v1/analytics', { headers: { ...authenticated, ...navigation } })).status, 403);
  const html = await page.text(); assert.match(html, /<div id="root"><\/div>/);
  for (const client of actual.snapshot.clients) {
    assert.ok(!html.includes(client.client), 'No client identity in generic HTML');
    assert.ok(!source.includes(client.contact), 'No full client contact in compiled Worker');
  }
  for (const asset of module.buildInfo.assets as { path: string }[]) {
    assert.equal((await request(asset.path)).status, 401);
    assert.equal((await request(asset.path, { headers: authenticated })).status, 200);
  }
  assert.equal((await request('/vds-snapshot.json', { headers: authenticated })).status, 404);
  const release = await (await request('/api/v1/release')).json();
  assert.equal(release.release, module.buildInfo.releaseId); assert.equal(release.commit, module.buildInfo.commit);
  assert.ok(!JSON.stringify(release).includes(importToken));
  assert.equal(actual.snapshot.clients.length, 500); assert.equal(actual.pilots.length, 10);
});

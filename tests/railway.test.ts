import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { openPrivateStorage } from '../server/railway/storage.js';
import { createOwnerAuth, passwordHash } from '../server/railway/auth.js';
import { createRailwayApp } from '../server/railway/app.js';
import { validateSetup } from '../src/data/connections-client.js';
const origin = 'https://railway-test.invalid';
const password = randomBytes(24).toString('base64url');
const owner = 'owner@example.test';

test('Railway: owner session cannot be replaced by identity headers or a modified cookie', async () => {
  const auth = createOwnerAuth(owner, await passwordHash(password), randomBytes(48).toString('base64url'));
  assert.equal(await auth.login('other@example.test', password), null);
  assert.equal(await auth.login(owner, 'incorrect'), null);
  const cookie = await auth.login(owner, password);
  assert.ok(cookie?.includes('HttpOnly; Secure; SameSite=Strict'));
  assert.equal(auth.verify(new Request(origin, { headers: { cookie: cookie!.split(';')[0] } })), true);
  assert.equal(auth.verify(new Request(origin, { headers: { cookie: cookie!.split(';')[0] + 'x' } })), false);
  assert.equal(auth.verify(new Request(origin, { headers: { 'oai-authenticated-user-email': owner } })), false);
  const rotated = createOwnerAuth(owner, await passwordHash(password), randomBytes(48).toString('base64url'));
  assert.equal(rotated.verify(new Request(origin, { headers: { cookie: cookie!.split(';')[0] } })), false);
});

test('Railway: volume preserves writes, serializes CAS, and refuses symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vds-storage-'));
  try {
    let storage = await openPrivateStorage(root);
    await storage.bucket.put('key', 'first');
    const initial = (await storage.bucket.get('key'))!;
    const results = await Promise.all(['second', 'third'].map(value => storage.bucket.put('key', value, { onlyIf: { etagMatches: initial.etag } })));
    assert.equal(results.filter(Boolean).length, 1);
    await storage.close(); storage = await openPrivateStorage(root);
    assert.equal(await (await storage.bucket.get('key'))!.text(), 'second');
    const filename = (await readdir(root)).find(name => name.endsWith('.json'))!;
    assert.equal((await stat(join(root, filename))).mode & 0o777, 0o600);
    const badKey = createHash('sha256').update('symlink').digest('hex') + '.json';
    await symlink(join(root, filename), join(root, badKey));
    await assert.rejects(storage.bucket.get('symlink'));
    await storage.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Railway: APIs, assets, CSRF and private paths fail closed; setup identifies Railway', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vds-app-'));
  const storage = await openPrivateStorage(root);
  try {
    const app = createRailwayApp({ VDS_PUBLIC_ORIGIN: origin, VDS_OWNER_EMAIL: owner,
      VDS_PASSWORD_HASH: await passwordHash(password), VDS_SESSION_SECRET: randomBytes(48).toString('base64url'),
      VDS_EXPECTED_BUNDLE_SHA256: 'a'.repeat(64), VDS_IMPORT_TOKEN: randomBytes(32).toString('base64url'),
      VDS_COMMIT_SHA: 'a'.repeat(40) }, storage.bucket, 'dist');
    for (const path of ['/api/v1/setup', '/api/v1/portal-snapshot', '/api/v1/pilot']) {
      assert.equal((await app.fetch(new Request(origin + path, { headers: { 'oai-authenticated-user-email': owner, 'oai-authenticated-user-id': 'owner' } }))).status, 401);
    }
    assert.equal((await app.fetch(new Request(origin + '/'))).status, 303);
    assert.equal((await app.fetch(new Request(origin + '/auth/login', { method: 'POST', body: 'password=x' }))).status, 403);
    const login = await app.fetch(new Request(origin + '/auth/login', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: owner, password }) }));
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const request = (path: string) => new Request(origin + path, { headers: { Cookie: cookie } });
    const setup = validateSetup(await (await app.fetch(request('/api/v1/setup'))).json());
    assert.equal(setup.runtime, 'railway-node'); assert.equal(setup.storage.state, 'empty');
    for (const path of ['/api/internal/import-status', '/data/private.json', '/server/railway.ts', '/assets/private.json']) {
      assert.equal((await app.fetch(request(path))).status, 404);
    }
    const csrf = await app.fetch(new Request(origin + '/api/v1/setup/import', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.invalid' } }));
    assert.equal(csrf.status, 403);
    const logout = await app.fetch(new Request(origin + '/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } }));
    assert.equal(logout.status, 303); assert.ok(logout.headers.get('set-cookie')?.includes('Max-Age=0'));
  } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
});

test('Railway: actual approved archive imports through owner route and survives reopening', {
  skip: !process.env.VDS_RAILWAY_BUNDLE_PATH,
}, async () => {
  const body = await readFile(process.env.VDS_RAILWAY_BUNDLE_PATH!, 'utf8');
  const root = await mkdtemp(join(tmpdir(), 'vds-real-'));
  let storage = await openPrivateStorage(root);
  try {
    const values = { VDS_PUBLIC_ORIGIN: origin, VDS_OWNER_EMAIL: owner,
      VDS_PASSWORD_HASH: await passwordHash(password), VDS_SESSION_SECRET: randomBytes(48).toString('base64url'),
      VDS_EXPECTED_BUNDLE_SHA256: createHash('sha256').update(body).digest('hex'),
      VDS_IMPORT_TOKEN: randomBytes(32).toString('base64url'), VDS_COMMIT_SHA: 'a'.repeat(40) };
    let app = createRailwayApp(values, storage.bucket, 'dist');
    const login = await app.fetch(new Request(origin + '/auth/login', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: owner, password }) }));
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const imported = await app.fetch(new Request(origin + '/api/v1/setup/import', { method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-VDS-Action': 'import' }, body }));
    assert.equal(imported.status, 200);
    const receipt = await imported.json();
    assert.equal(receipt.dossiers, 500); assert.equal(receipt.enriched, 10);
    await storage.close(); storage = await openPrivateStorage(root);
    app = createRailwayApp(values, storage.bucket, 'dist');
    const setup = validateSetup(await (await app.fetch(new Request(origin + '/api/v1/setup', { headers: { Cookie: cookie } }))).json());
    assert.equal(setup.ready, true); assert.equal(setup.storage.dossiers, 500); assert.equal(setup.storage.enriched, 10);
    const snapshot = await app.fetch(new Request(origin + '/api/v1/portal-snapshot', { headers: { Cookie: cookie } }));
    assert.equal(snapshot.status, 200);
    const data = await snapshot.json();
    assert.equal(data.clients.length, 500);
  } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
});

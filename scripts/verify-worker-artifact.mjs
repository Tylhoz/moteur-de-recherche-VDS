import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
const index = args.indexOf('--private-bundle');
if (args.length && (index !== 0 || args.length !== 2)) throw new Error('Usage: node scripts/verify-worker-artifact.mjs [--private-bundle /external/data.private.json]');
const artifact = resolve(root, 'worker-dist');
const names = [];
async function files(path, prefix = '') { for (const entry of await readdir(path, { withFileTypes: true })) {
  const name = prefix + entry.name, full = resolve(path, entry.name);
  assert.equal((await lstat(full)).isSymbolicLink(), false, 'Artifact must not contain symlinks');
  if (entry.isDirectory()) await files(full, `${name}/`); else names.push(name);
} }
await files(artifact);
assert.deepEqual(names.sort(), ['.openai/hosting.json', 'server/index.js']);
const [source, manifestText, oldText] = await Promise.all([
  readFile(resolve(artifact, 'server/index.js'), 'utf8'), readFile(resolve(artifact, '.openai/hosting.json'), 'utf8'),
  readFile(resolve(root, '.openai/hosting.v2-backup.json'), 'utf8'),
]);
const manifest = JSON.parse(manifestText), old = JSON.parse(oldText);
assert.ok(manifest.project_id && manifest.project_id !== old.project_id, 'Version 2 cannot be the target');
assert.ok(!manifest.static);
assert.equal(manifest.r2, 'BUCKET');
assert.ok(!/from\s*["']node:|require\(["'](?:node:|fs|http|path)|\/workspace\//.test(source));
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
assert.equal(typeof module.default?.fetch, 'function');
assert.equal(module.buildInfo?.businessDataEmbedded, false);
assert.match(module.buildInfo.commit, /^[a-f0-9]{40}$/);
assert.ok(module.buildInfo.assets.some(asset => asset.path === '/index.html'));
// Call the real bundled runtime; missing runtime configuration must not serve assets or records.
const denied = await module.default.fetch(new Request('https://unconfigured.invalid/'), {}, {});
assert.ok([401, 503].includes(denied.status), 'Unconfigured Worker fails closed');
assert.ok(!(await denied.text()).includes('<html'));
let namesChecked = 0, emailsChecked = 0;
let privateChainVerified = false;
if (index === 0) {
  const privatePath = resolve(args[1]);
  assert.ok(!privatePath.startsWith(`${root}/`), 'Private export must stay outside repository');
  const privateText = await readFile(privatePath, 'utf8');
  const bundle = JSON.parse(privateText);
  assert.equal(bundle.schemaVersion, 'worker-private-1');
  const customerNames = [...new Set(bundle.snapshot.clients.map(client => client.client).filter(name => name.length > 4))];
  const emails = [...new Set(JSON.stringify(bundle).match(/[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}/g) || [])];
  // Decode every generic frontend asset through the compiled authenticated handler.
  // Native identity is a test fixture; this does not claim live hosting authentication.
  const origin = 'https://artifact-test.invalid';
  const env = { VDS_PUBLIC_ORIGIN: origin, VDS_OWNER_PRIVATE: 'true' };
  for (const asset of module.buildInfo.assets) {
    const response = await module.default.fetch(new Request(origin + asset.path, { headers: {
      'oai-authenticated-user-id': 'isolated-artifact-test', 'oai-authenticated-user-email': 'artifact-test@example.invalid',
    } }), env, {});
    assert.equal(response.status, 200, 'Authenticated generic asset is served by the Worker');
    if (!/text|javascript|svg/.test(response.headers.get('content-type') || '')) continue;
    const text = await response.text();
    for (const name of customerNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.ok(!new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i').test(text), 'Customer identity must not be embedded in frontend assets');
    }
    for (const email of emails) assert.ok(!text.toLowerCase().includes(email.toLowerCase()), 'Customer e-mail must not be embedded in frontend assets');
  }
  // Word boundaries avoid coincidental short-name substrings in base64-encoded
  // generic images/chunks. Their decoded text was inspected above as well.
  for (const name of customerNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.ok(!new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i').test(source), 'Private identity must not be in server bundle source');
  }
  for (const email of emails) assert.ok(!source.toLowerCase().includes(email.toLowerCase()), 'Private e-mail must not be in server bundle source');
  namesChecked = customerNames.length; emailsChecked = emails.length;
  // End-to-end check of the compiled module with the actual offline export.
  // Storage and sessions here are isolated test adapters, never live credentials.
  const token = randomBytes(48).toString('base64url');
  const digest = createHash('sha256').update(privateText).digest('hex');
  const objects = new Map();
  const protectedEnv = { ...env, VDS_EXPECTED_BUNDLE_SHA256: digest,
    VDS_IMPORT_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
    BUCKET: { async get(key) { const text = objects.get(key); return text === undefined ? null : { size: Buffer.byteLength(text), async text() { return text; } }; },
      async put(key, text) { objects.set(key, text); } },
  };
  const imported = await module.default.fetch(new Request(origin + '/api/internal/import', { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: privateText }), protectedEnv, {});
  assert.equal(imported.status, 200, 'Compiled Worker imports only the digest-approved private export');
  const receipt = await imported.json();
  assert.equal(receipt.dossiers, 500); assert.equal(receipt.enriched, 10); assert.equal(receipt.digest, digest);
  const headers = { 'oai-authenticated-user-id': 'isolated-artifact-test', 'oai-authenticated-user-email': 'artifact-test@example.invalid' };
  const closed = await module.default.fetch(new Request(origin + '/api/v1/portal-snapshot'), protectedEnv, {});
  assert.equal(closed.status, 401, 'Loaded data remains unavailable without a native identity');
  const snapshotResponse = await module.default.fetch(new Request(origin + '/api/v1/portal-snapshot', { headers }), protectedEnv, {});
  assert.equal(snapshotResponse.status, 200);
  const servedSnapshot = await snapshotResponse.json();
  assert.equal(cryptoHash(JSON.stringify(servedSnapshot)), cryptoHash(JSON.stringify(bundle.snapshot)), 'Worker serves the exact original projection');
  const analyticsResponse = await module.default.fetch(new Request(origin + '/api/v1/analytics', { headers }), protectedEnv, {});
  assert.equal(analyticsResponse.status, 200);
  assert.equal(cryptoHash(JSON.stringify(await analyticsResponse.json())), cryptoHash(JSON.stringify(bundle.analytics)), 'Analytics are derived from actual source observations');
  for (const pilot of bundle.pilots) {
    const response = await module.default.fetch(new Request(origin + `/api/v1/pilot/${pilot.data.id}`, { headers }), protectedEnv, {});
    assert.equal(response.status, 200);
    assert.equal(cryptoHash(JSON.stringify(await response.json())), cryptoHash(JSON.stringify(pilot)), 'Every enriched fiche remains unchanged');
  }
  const conditional = await module.default.fetch(new Request(origin + '/api/v1/portal-snapshot', { headers: { ...headers, 'If-None-Match': snapshotResponse.headers.get('ETag') } }), protectedEnv, {});
  assert.equal(conditional.status, 304);
  privateChainVerified = true;
  objects.clear();
}
function cryptoHash(text) { return createHash('sha256').update(text).digest('hex'); }
console.log(JSON.stringify({ valid: true, runtime: 'cloudflare-worker-esm', release: module.buildInfo.releaseId,
  commit: module.buildInfo.commit, files: names.length, genericAssets: module.buildInfo.assets.length,
  privateCustomerNamesChecked: namesChecked, privateEmailsChecked: emailsChecked, previousVersionProtected: true,
  storageBindingDeclared: !!manifest.r2, compiledPrivateChainVerified: privateChainVerified }));

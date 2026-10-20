import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnectionsError, mayApplyPreview, readPrivateJson, validateApprovalReceipt, validateImportReceipt,
  validateIntegrations, validateSetup, validateSheetsPreview, validateStoredPreview,
} from '../src/data/connections-client.js';

const setup = () => ({ schemaVersion: 'cloudflare-setup-1', runtime: 'cloudflare-worker', authentication: 'cloudflare-access',
  authenticated: true, ownerAuthorized: true, ready: false,
  configuration: { access: true, origin: true, assets: true, storage: true, importToken: true, expectedBundle: true, release: true },
  storage: { state: 'empty', dossiers: null, enriched: null }, release: { id: 'test-release', commit: 'a'.repeat(40) }, sourceWrites: 0 });
const integrations = () => ({ sheets: { configured: true, checked: false, connected: false, readOnly: true, state: 'not_checked' },
  invoicing: { provider: 'unconfirmed', providerConfirmed: false, configured: false, connected: false, enabled: false, implementationReady: false, readOnly: true } });
const proposal = () => ({ schemaVersion: 'sheets-proposal-1', revision: 'a'.repeat(64), baseVersion: 'archive-test', readAt: '2026-01-02T09:00:00Z',
  source: { provider: 'google_sheets', spreadsheetId: 'test_sheet_reference', range: "'Base_Centrale_360'!A1:H501" },
  snapshot: { value: 'not retained by the browser view' }, changes: [{ clientId: 'VDS-001', field: 'statusAction', before: 'Before', proposed: 'After', requiresIdentityReview: false }],
  requiresValidation: true, initialImport: false, sourceWrites: 0, financialTotalsVerified: false });

test('connections: HTML 200 is reported as an interface without an API', async () => {
  await assert.rejects(readPrivateJson('/api/v1/setup', { fetcher: async () => new Response('<html>Shell</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) }),
    (error: unknown) => error instanceof ConnectionsError && error.code === 'api_not_deployed' && error.message.startsWith('Interface publiée, API non déployée'));
});
test('connections: private reads and explicit import use authenticated non-cacheable same-origin requests', async () => {
  let seen: RequestInit | undefined;
  const fetcher: typeof fetch = async (_url, init) => { seen = init; return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); };
  await readPrivateJson('/api/v1/setup', { fetcher });
  assert.equal(seen?.method, 'GET'); assert.equal(seen?.credentials, 'same-origin'); assert.equal(seen?.cache, 'no-store'); assert.equal(seen?.redirect, 'error');
  await readPrivateJson('/api/v1/setup/import', { fetcher, method: 'POST', body: '{}', action: 'import' });
  assert.equal(new Headers(seen?.headers).get('X-VDS-Action'), 'import');
  assert.equal(new Headers(seen?.headers).get('Content-Type'), 'application/json');
  assert.equal(new Headers(seen?.headers).has('Authorization'), false);
});
test('connections: authentication failures are distinct from readable provider data', async () => {
  for (const status of [401, 403]) await assert.rejects(readPrivateJson('/api/v1/setup', {
    fetcher: async () => new Response('{}', { status, headers: { 'Content-Type': 'application/json' } }),
  }), (error: unknown) => error instanceof ConnectionsError && error.code === (status === 401 ? 'authentication_required' : 'access_forbidden'));
});
test('connections: unknown server errors never reflect arbitrary response text', async () => {
  await assert.rejects(readPrivateJson('/api/v1/setup', { fetcher: async () => new Response(JSON.stringify({ error: 'secret-response-content' }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  }) }), (error: unknown) => error instanceof Error && !error.message.includes('secret-response-content'));
});
test('connections: unverified configuration cannot be presented as a connected source', () => {
  const value = validateIntegrations(integrations());
  assert.equal(value.sheets.configured, true); assert.equal(value.sheets.connected, false);
  assert.throws(() => validateIntegrations({ ...integrations(), sheets: { ...integrations().sheets, connected: true } }));
  assert.throws(() => validateIntegrations({ ...integrations(), invoicing: { ...integrations().invoicing, connected: true } }));
});
test('connections: private archive counters require the setup contract and actual values', () => {
  assert.equal(validateSetup(setup()).storage.dossiers, null);
  assert.throws(() => validateSetup({ ...setup(), storage: { state: 'ready', dossiers: null, enriched: null } }));
  assert.throws(() => validateSetup({ ...setup(), authenticated: false }));
  assert.throws(() => validateSetup({ ...setup(), ownerAuthorized: false }));
});
test('connections: comparison retains sourced differences but discards the full snapshot', () => {
  const result = validateSheetsPreview(proposal());
  assert.equal(result.changes.length, 1); assert.equal(result.source.spreadsheetId, 'test_sheet_reference');
  assert.equal('snapshot' in result, false);
  assert.equal(validateStoredPreview({ proposal: null }), null);
  assert.equal(validateStoredPreview({ proposal: proposal() })?.revision, 'a'.repeat(64));
  assert.throws(() => validateSheetsPreview({ ...proposal(), financialTotalsVerified: true }));
  assert.throws(() => validateSheetsPreview({ ...proposal(), sourceWrites: 1 }));
  assert.throws(() => validateSheetsPreview({ ...proposal(), requiresValidation: false }));
});
test('connections: applying differences needs explicit confirmation and excludes all identity fields', () => {
  const result = validateSheetsPreview(proposal());
  assert.equal(mayApplyPreview(result, false), false); assert.equal(mayApplyPreview(result, true), true);
  for (const field of ['client', 'contact', 'address']) {
    const identity = validateSheetsPreview({ ...proposal(), changes: [{ ...proposal().changes[0], field, requiresIdentityReview: false }] });
    assert.equal(mayApplyPreview(identity, true), false);
  }
  assert.equal(mayApplyPreview(validateSheetsPreview({ ...proposal(), initialImport: true }), true), false);
  assert.equal(mayApplyPreview(null, true), false);
});
test('connections: import and approval receipts preserve source immutability and unverified finances', () => {
  assert.equal(validateImportReceipt({ imported: true, dossiers: 500, enriched: 10, sourceWrites: 0 }).dossiers, 500);
  assert.throws(() => validateImportReceipt({ imported: true, dossiers: 499, enriched: 10, sourceWrites: 0 }));
  const receipt = { applied: true, revision: 'a'.repeat(64), dossiers: 500, enriched: 10, sourceWrites: 0, financialTotalsVerified: false };
  assert.equal(validateApprovalReceipt(receipt).enriched, 10);
  assert.throws(() => validateApprovalReceipt({ ...receipt, sourceWrites: 1 }));
  assert.throws(() => validateApprovalReceipt({ ...receipt, financialTotalsVerified: true }));
});

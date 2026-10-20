import test from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../src/types.js';
import { createSheetsReader, integrationConfiguration, SHEETS_HEADERS, SHEETS_READONLY_SCOPE, type IntegrationsEnv } from '../worker/integrations.js';

// Synthetic values exist only in tests. They are never imported into a production bundle.
const env: IntegrationsEnv = {
  VDS_GOOGLE_CLIENT_ID: 'worker-test-client.apps.googleusercontent.com',
  VDS_GOOGLE_CLIENT_SECRET: 'test-only-client-secret',
  VDS_GOOGLE_REFRESH_TOKEN: 'test-only-refresh-token',
  VDS_LEGACY_SPREADSHEET_ID: 'test-workbook-id',
};
const date = new Date('2026-10-20T10:00:00.000Z');
function rows(): string[][] {
  return [Array.from(SHEETS_HEADERS), ...Array.from({ length: 500 }, (_, i) => [
    `VDS-${String(i + 1).padStart(3, '0')}`, `Dossier de test ${i + 1}`,
    `contact-${i + 1}@example.invalid`, 'Adresse de test', '', '',
    'Montant déclaré 42 500 € ; paiement annoncé, non vérifié', '',
  ])];
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function fixture(options: {
  values?: string[][];
  secondValues?: string[][];
  metadataRows?: number;
  tokenScope?: string;
  tokenStatus?: number;
  valuesResponse?: () => Response;
  failValues?: () => boolean;
} = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  let passes = 0;
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.href === 'https://oauth2.googleapis.com/token') return json({
      access_token: 'test-only-access-token', expires_in: 3600, token_type: 'Bearer',
      scope: options.tokenScope ?? SHEETS_READONLY_SCOPE,
    }, options.tokenStatus ?? 200);
    if (url.pathname.endsWith('/values:batchGet')) {
      if (options.failValues?.()) return json({ diagnostic: 'provider-secret-should-not-be-returned' }, 401);
      if (options.valuesResponse) return options.valuesResponse();
      return json({
        spreadsheetId: env.VDS_LEGACY_SPREADSHEET_ID,
        valueRanges: [{ range: 'Base_Centrale_360!A1:H501', majorDimension: 'ROWS',
          values: ++passes % 2 === 0 ? options.secondValues ?? options.values ?? rows() : options.values ?? rows() }],
      });
    }
    return json({ spreadsheetId: env.VDS_LEGACY_SPREADSHEET_ID, sheets: [{ properties: {
      sheetId: 1, title: 'Base_Centrale_360', gridProperties: { rowCount: options.metadataRows ?? 501, columnCount: 8 },
    } }] });
  };
  return { calls, reader: createSheetsReader(env, { request, now: () => date }) };
}

test('missing or invalid server configuration fails before fetching; configuration exposes only names and states', async () => {
  let requests = 0;
  for (const invalid of [{}, { ...env, VDS_GOOGLE_SHEET_RANGE: "'Other'!A1:Z2000" },
    { ...env, VDS_LEGACY_SPREADSHEET_ID: '../secret' }, { ...env, VDS_GOOGLE_CLIENT_SECRET: 'with\nnewline' }]) {
    const reader = createSheetsReader(invalid, { request: async () => { requests++; return json({}); } });
    assert.equal(reader.status().connected, false);
    await assert.rejects(reader.readProposal(null), /google_configuration_missing_or_invalid/);
  }
  assert.equal(requests, 0);
  const config = integrationConfiguration(env);
  assert.equal(config.sheets.configured, true);
  assert.equal(config.sheets.checked, false);
  assert.equal(config.sheets.connected, false);
  for (const secret of Object.values(env)) assert.ok(!JSON.stringify(config).includes(secret!));
});

test('bounded consistent Google reads create a review proposal and never certify narrative money or payments', async () => {
  const f = fixture();
  const proposal = await f.reader.readProposal(null);
  assert.equal(proposal.snapshot.clients.length, 500);
  assert.equal(proposal.initialImport, true);
  assert.equal(proposal.requiresValidation, true);
  assert.equal(proposal.sourceWrites, 0);
  assert.equal(proposal.financialTotalsVerified, false);
  assert.equal(proposal.snapshot.clients[0].finance, rows()[1][6]);
  assert.equal(proposal.snapshot.clients[0].contractHT, null);
  assert.equal(proposal.snapshot.clients[0].soldeAmount, null);
  assert.deepEqual(proposal.snapshot.records, []);
  assert.deepEqual(proposal.snapshot.enrichedClientIds, []);
  assert.equal(f.reader.status().connected, true);
  assert.equal(f.reader.status().state, 'pending_validation');
  assert.equal(f.calls.length, 7);
  for (const { url, init } of f.calls) {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    assert.ok(!url.href.includes('test-only'));
    if (url.hostname === 'sheets.googleapis.com') assert.equal(init.method, 'GET');
  }
  const noChange = await f.reader.readProposal(proposal.snapshot);
  assert.equal(noChange.requiresValidation, false);
  assert.deepEqual(noChange.changes, []);
  assert.equal(f.reader.status().state, 'ready');
  assert.equal(f.calls.filter(c => c.url.hostname === 'oauth2.googleapis.com').length, 1);
});

test('new values and identity differences remain proposals; baseline is not mutated or silently associated', async () => {
  const initial = await fixture().reader.readProposal(null);
  const baseline: Snapshot = structuredClone(initial.snapshot);
  baseline.enrichedClientIds = ['VDS-001'];
  const before = JSON.stringify(baseline);
  const changed = rows();
  changed[1][1] = 'Autre personne de test';
  changed[2][6] = 'Autre montant déclaré';
  const proposal = await fixture({ values: changed }).reader.readProposal(baseline);
  assert.equal(JSON.stringify(baseline), before);
  assert.equal(proposal.baseVersion, baseline.version);
  assert.deepEqual(proposal.snapshot.enrichedClientIds, []);
  assert.equal(proposal.changes.length, 2);
  assert.equal(proposal.changes[0].clientId, 'VDS-001');
  assert.equal(proposal.changes[0].requiresIdentityReview, true);
  assert.equal(proposal.changes[1].requiresIdentityReview, false);
  assert.equal(proposal.requiresValidation, true);
});

test('mapping, IDs, source URLs and concurrent edits are strictly checked before a proposal is returned', async () => {
  const invalidHeader = rows(); invalidHeader[0][6] = 'Chiffre différent';
  const duplicate = rows(); duplicate[2][0] = duplicate[1][0];
  const short = rows().slice(0, 500);
  const unsafe = rows(); unsafe[1][5] = 'https://docs.google.com/file?access_token=private';
  const changed = rows(); changed[1][7] = 'Nouvelle action de test';
  for (const [options, error] of [
    [{ values: invalidHeader }, /sheets_headers_invalid/],
    [{ values: duplicate }, /sheets_identity_invalid/],
    [{ values: short }, /sheets_dossier_count_changed/],
    [{ values: unsafe }, /sheets_unsafe_link/],
    [{ metadataRows: 502 }, /sheets_mapping_requires_review/],
    [{ secondValues: changed }, /source_changed_during_read/],
  ] as const) {
    const f = fixture(options);
    await assert.rejects(f.reader.readProposal(null), error);
    assert.equal(f.reader.status().connected, false);
  }
});

test('OAuth requires only the Sheets read scope and never exposes upstream secret-bearing errors', async () => {
  const scope = fixture({ tokenScope: `${SHEETS_READONLY_SCOPE} https://www.googleapis.com/auth/drive` });
  await assert.rejects(scope.reader.readProposal(null), /google_oauth_scope_not_readonly/);
  assert.equal(scope.calls.length, 1);
  const denied = fixture({ tokenStatus: 400 });
  await assert.rejects(denied.reader.readProposal(null), /google_oauth_reauthorization_required/);
  const reader = createSheetsReader(env, { request: async () => { throw new Error('URL https://secret.invalid?token=never-expose'); } });
  await assert.rejects(reader.readProposal(null), { message: 'google_read_failed' });
  assert.ok(!JSON.stringify(reader.status()).includes('never-expose'));
});

test('oversized or invalid upstream replies are rejected and failed reads keep the last success timestamp', async () => {
  const huge = fixture({ valuesResponse: () => new Response('{}', {
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(13 * 1024 * 1024) },
  }) });
  await assert.rejects(huge.reader.readProposal(null), /provider_response_too_large/);
  const bad = fixture({ valuesResponse: () => new Response('error secret-body', { headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(bad.reader.readProposal(null), /provider_response_invalid/);
  let failValues = false;
  const f = fixture({ failValues: () => failValues });
  const original = await f.reader.readProposal(null);
  failValues = true;
  await assert.rejects(f.reader.readProposal(original.snapshot), /google_access_denied/);
  assert.equal(f.reader.status().lastReadAt, date.toISOString());
  assert.equal(f.reader.status().connected, false);
  assert.equal(f.reader.status().error, 'google_access_denied');
});

test('future VosFactures settings cannot claim connection or activate an API before implementation and confirmation', () => {
  const unknown = integrationConfiguration({ VDS_VOSFACTURES_ENABLED: 'true', VDS_VOSFACTURES_ACCOUNT: 'example-account',
    VDS_VOSFACTURES_API_TOKEN: 'test-only-invoice-api-token' }).invoicing;
  assert.equal(unknown.providerConfirmed, false);
  assert.equal(unknown.configured, false);
  const prepared = integrationConfiguration({ VDS_INVOICING_PROVIDER: 'vosfactures', VDS_VOSFACTURES_ENABLED: 'true',
    VDS_VOSFACTURES_ACCOUNT: 'example-account', VDS_VOSFACTURES_API_TOKEN: 'test-only-invoice-api-token' }).invoicing;
  assert.equal(prepared.configured, true);
  assert.equal(prepared.enabled, false);
  assert.equal(prepared.checked, false);
  assert.equal(prepared.connected, false);
  assert.equal(prepared.implementationReady, false);
  const invalid = integrationConfiguration({ VDS_INVOICING_PROVIDER: 'vosfactures',
    VDS_VOSFACTURES_ACCOUNT: 'https://attacker.invalid', VDS_VOSFACTURES_API_TOKEN: 'test-only-invoice-api-token' }).invoicing;
  assert.equal(invalid.configured, false);
});

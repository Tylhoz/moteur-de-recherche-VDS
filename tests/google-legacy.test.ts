import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleLegacySheetsProvider, LEGACY_SPREADSHEET_ID, LEGACY_SHEET_ID, LEGACY_SHEET_RANGE, LEGACY_SHEET_HEADERS,
  normalizeLegacyRows, normalizeLegacySheetResponse } from '../server/google-legacy.js';

// Generated structural rows test the 500-record boundary. Never loaded into the app or deployed.
const date = '2026-10-20T00:00:00.000Z';
function rows(): string[][] {
  return [[...LEGACY_SHEET_HEADERS], ...Array.from({ length: 500 }, (_, i) => [
    `VDS-${String(i + 1).padStart(3, '0')}`, `structural-row-${i + 1}`, '', '', '', '', 'observed value without certified amount', 'observed status',
  ])];
}
function response(values: unknown = rows()) {
  return { spreadsheetId: LEGACY_SPREADSHEET_ID, valueRanges: [{ range: LEGACY_SHEET_RANGE, majorDimension: 'ROWS', values }] };
}
function metadata(rowCount = 501, columnCount = 8) {
  return { spreadsheetId: LEGACY_SPREADSHEET_ID, sheets: [{ properties: {
    sheetId: LEGACY_SHEET_ID, title: 'Base_Centrale_360', gridProperties: { rowCount, columnCount },
  } }] };
}

test('Google Sheets normalization preserves all 500 rows and narrative evidence, without money or status certification', () => {
  const values = rows(); values[1][6] = '1 337,05 € ; 13 370,50 € contradictoire'; values[1][7] = 'Confirmé selon la source';
  const snapshot = normalizeLegacySheetResponse(response(values), date);
  assert.equal(snapshot.clients.length, 500); assert.deepEqual(snapshot.records, []); assert.deepEqual(snapshot.enrichedClientIds, []);
  assert.equal(snapshot.clients[0].finance, values[1][6]); assert.equal(snapshot.clients[0].statusAction, values[1][7]);
  assert.equal(snapshot.clients[0].category, 'non_verifie'); assert.equal(snapshot.clients[0].contractHT, null); assert.equal(snapshot.clients[0].soldeAmount, null);
  assert.equal(snapshot.connection.mode, 'readonly-api'); assert.equal(snapshot.connection.intervalMs, 30_000);
  assert.equal(snapshot.sourceState?.lastReadAt, date); assert.equal(snapshot.sourceState?.lastAttemptAt, date);
  assert.equal(snapshot.version, normalizeLegacyRows(values, '2026-10-21T00:00:00.000Z').version);
  values[1][3] = 'changed structural field'; assert.notEqual(snapshot.version, normalizeLegacyRows(values, date).version);
});

test('Google Sheets 500-row invariant prevents silent loss, truncation or ambiguous identity', () => {
  const missing = rows(); missing.pop(); assert.throws(() => normalizeLegacyRows(missing, date), /dossier_count_changed/);
  const added = rows(); added.push(['VDS-501']); assert.throws(() => normalizeLegacyRows(added, date), /range_limit_reached/);
  const extraBlank = rows(); extraBlank.push([]); assert.throws(() => normalizeLegacyRows(extraBlank, date), /range_limit_reached/);
  const duplicate = rows(); duplicate[2][0] = duplicate[1][0]; assert.throws(() => normalizeLegacyRows(duplicate, date), /identity_invalid/);
  const blank = rows(); blank[2] = []; assert.throws(() => normalizeLegacyRows(blank, date), /identity_invalid/);
  const invalid = rows(); invalid[2][0] = 'VDS-999'; assert.throws(() => normalizeLegacyRows(invalid, date), /identity_invalid/);
});

test('Google Sheets normalization validates exact workbook, bounded range, header order, text cells and timestamp', () => {
  assert.throws(() => normalizeLegacySheetResponse({ ...response(), spreadsheetId: 'untrusted' }, date), /response_invalid/);
  const wrongRange = response(); wrongRange.valueRanges[0].range = 'Base_Centrale_360!A1:H1000';
  assert.throws(() => normalizeLegacySheetResponse(wrongRange, date), /response_invalid/);
  const headers = rows(); [headers[0][0], headers[0][1]] = [headers[0][1], headers[0][0]];
  assert.throws(() => normalizeLegacyRows(headers, date), /headers_invalid/);
  const typed: unknown[][] = rows(); typed[1][6] = 100;
  assert.throws(() => normalizeLegacyRows(typed, date), /cell_invalid/);
  assert.throws(() => normalizeLegacyRows(rows(), '2026-02-30T00:00:00.000Z'), /read_time_invalid/);
  const secret = rows(); secret[1][6] = 'https://drive.google.com/file/d/document?access_token=structural-secret';
  assert.throws(() => normalizeLegacyRows(secret, date), /unsafe_embedded_link/);
});

test('Google Sheets provider makes two equal, bounded GET requests, without writes or redirects', async () => {
  let valueCalls = 0; let metadataCalls = 0;
  const provider = new GoogleLegacySheetsProvider(async () => 'structural-access-token', async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://sheets.googleapis.com');
    assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    if (!url.pathname.endsWith('/values:batchGet')) {
      metadataCalls++;
      assert.equal(url.searchParams.get('fields'), 'spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))');
      return new Response(JSON.stringify(metadata()));
    }
    valueCalls++;
    assert.equal(url.pathname, `/v4/spreadsheets/${LEGACY_SPREADSHEET_ID}/values:batchGet`);
    assert.equal(url.searchParams.get('ranges'), LEGACY_SHEET_RANGE);
    assert.equal(url.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
    return new Response(JSON.stringify(response()));
  }, () => new Date(date));
  const snapshot = await provider.read(); assert.equal(valueCalls, 2); assert.equal(metadataCalls, 4); assert.equal(snapshot.clients.length, 500);
});

test('Google Sheets rejects grid expansion or shrinkage before reading and changes during the read', async () => {
  for (const [rowCount, columnCount] of [[502, 8], [501, 9], [500, 8], [501, 7]]) {
    let valueCalls = 0;
    const provider = new GoogleLegacySheetsProvider(async () => 'structural-token', async input => {
      if (String(input).includes('/values:batchGet')) valueCalls++;
      return new Response(JSON.stringify(metadata(rowCount, columnCount)));
    });
    await assert.rejects(() => provider.read(), /legacy_grid_changed/); assert.equal(valueCalls, 0);
  }
  let metadataCalls = 0;
  const changed = new GoogleLegacySheetsProvider(async () => 'structural-token', async input => {
    if (String(input).includes('/values:batchGet')) return new Response(JSON.stringify(response()));
    return new Response(JSON.stringify(metadata(++metadataCalls === 1 ? 501 : 502)));
  });
  await assert.rejects(() => changed.read(), /legacy_grid_changed/);
});

test('Google Sheets provider rejects edits during its double read, missing credentials and access errors', async () => {
  let calls = 0;
  const changed = new GoogleLegacySheetsProvider(async () => 'structural-token', async input => {
    if (!String(input).includes('/values:batchGet')) return new Response(JSON.stringify(metadata()));
    const values = rows(); if (++calls === 2) values[3][4] = 'changed structural value';
    return new Response(JSON.stringify(response(values)));
  });
  await assert.rejects(() => changed.read(), /source_changed_during_read/);
  const missing = new GoogleLegacySheetsProvider(async () => undefined, async () => { throw new Error('must not call'); });
  await assert.rejects(() => missing.read(), /google_credentials_missing/);
  const denied = new GoogleLegacySheetsProvider(async () => 'structural-token', async () => new Response('provider detail not exposed', { status: 403 }));
  await assert.rejects(() => denied.read(), error => error instanceof Error && error.message === 'google_access_denied');
  const failed = new GoogleLegacySheetsProvider(async () => 'structural-token', async () => { throw new Error('upstream sensitive detail'); });
  await assert.rejects(() => failed.read(), error => error instanceof Error && error.message === 'google_read_failed');
});

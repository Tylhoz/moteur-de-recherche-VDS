import type { Client, Snapshot } from '../src/types.js';
import { DataError, digest, safeLink } from './model.js';
import { readGoogleJson } from './google-auth.js';
import type { TokenProvider } from './providers.js';

// Server-only configuration. Never commit a private workbook reference.
export const LEGACY_SPREADSHEET_ID = (process.env.VDS_LEGACY_SPREADSHEET_ID ?? '').trim();
function requireLegacySheetConfiguration() {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(LEGACY_SPREADSHEET_ID)) throw new DataError('legacy_spreadsheet_not_configured');
}
export const LEGACY_SHEET_TITLE = 'Base_Centrale_360';
export const LEGACY_SHEET_ID = 768819879;
// Native metadata verifies exactly 501 rows × 8 columns, including the header.
export const LEGACY_SHEET_RANGE = "'Base_Centrale_360'!A1:H501";
export const LEGACY_SHEET_HEADERS = [
  'N° Dossier', 'Client', 'Téléphone & Email', 'Adresse du Chantier',
  'Modèle, Volet & Équipe', 'Technique & Maçonnerie', 'Contrat HT/TTC & Solde', 'Statut, Dates & Action',
] as const;

export interface LegacySnapshotProvider { readonly kind: 'google_sheets'; read(): Promise<Snapshot> }

function checkedText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 12_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new DataError('legacy_cell_invalid');
  for (const link of value.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
    if (!safeLink(link.replace(/[),.;]+$/, ''))) throw new DataError('unsafe_embedded_link');
  }
  return value;
}

/** Pure seam for a native connector response. Values remain observations, never certified facts. */
export function normalizeLegacyRows(values: unknown, readAt: string): Snapshot {
  requireLegacySheetConfiguration();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(readAt) || Number.isNaN(Date.parse(readAt)) || new Date(readAt).toISOString() !== readAt) throw new DataError('legacy_read_time_invalid');
  if (!Array.isArray(values) || values.length < 1 || !Array.isArray(values[0]) ||
      JSON.stringify(values[0]) !== JSON.stringify(LEGACY_SHEET_HEADERS)) throw new DataError('legacy_headers_invalid');
  if (values.length > 501) throw new DataError('legacy_range_limit_reached');
  const rows = values.slice(1, 501);
  if (rows.length !== 500) throw new DataError('legacy_dossier_count_changed');
  const seen = new Set<string>();
  const clients: Client[] = rows.map(raw => {
    if (!Array.isArray(raw) || raw.length > 8) throw new DataError('legacy_row_invalid');
    const row = Array.from({ length: 8 }, (_, index) => checkedText(raw[index] ?? ''));
    const [id, client, contact, address, modelTeam, techMacon, finance, statusAction] = row;
    if (!/^VDS-\d{3}$/.test(id) || Number(id.slice(4)) < 1 || Number(id.slice(4)) > 500 || seen.has(id) || !client.trim()) throw new DataError('legacy_identity_invalid');
    seen.add(id);
    // No parsing of money, invented debt, validation status or join with historical IDs.
    return { id, client, contact, address, modelTeam, techMacon, finance, statusAction,
      category: 'non_verifie', contractHT: null, soldeAmount: null };
  });
  const revision = digest({ spreadsheetId: LEGACY_SPREADSHEET_ID, range: LEGACY_SHEET_RANGE, headers: LEGACY_SHEET_HEADERS, clients });
  return {
    source: 'api', version: `google-sheets:${revision}`, fetchedAt: readAt, clients, records: [], enrichedClientIds: [],
    links: [{ label: 'Base centrale Google Sheets', url: `https://docs.google.com/spreadsheets/d/${LEGACY_SPREADSHEET_ID}/edit#gid=768819879` }],
    sourceState: { status: 'ready', stale: false, lastReadAt: readAt, lastAttemptAt: readAt, revision },
    connection: { mode: 'readonly-api', label: 'Google Sheets · lecture seule · informations à vérifier', intervalMs: 30_000, sheetReady: true },
  };
}

export function normalizeLegacySheetResponse(input: unknown, readAt: string): Snapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DataError('google_response_invalid');
  const body = input as Record<string, unknown>;
  if (body.spreadsheetId !== LEGACY_SPREADSHEET_ID || !Array.isArray(body.valueRanges) || body.valueRanges.length !== 1) throw new DataError('google_response_invalid');
  const valueRange = body.valueRanges[0];
  if (!valueRange || typeof valueRange !== 'object' || Array.isArray(valueRange) ||
      ![LEGACY_SHEET_RANGE, `${LEGACY_SHEET_TITLE}!A1:H501`].includes(valueRange.range) ||
      valueRange.majorDimension !== 'ROWS') throw new DataError('google_response_invalid');
  return normalizeLegacyRows(valueRange.values, readAt);
}

/** Fixed, bounded, read-only Google endpoint. It cannot accept a browser-supplied workbook or range. */
export class GoogleLegacySheetsProvider implements LegacySnapshotProvider {
  readonly kind = 'google_sheets' as const;
  constructor(private token: TokenProvider, private request: typeof fetch = fetch, private now: () => Date = () => new Date()) {}

  private async verifyGrid(token: string): Promise<void> {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${LEGACY_SPREADSHEET_ID}`);
    url.searchParams.set('fields', 'spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))');
    const response = await this.request(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DataError(response.status === 401 || response.status === 403 ? 'google_access_denied' : 'google_read_failed');
    }
    const raw = await readGoogleJson(response, 256 * 1024);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DataError('google_metadata_invalid');
    const body = raw as Record<string, unknown>;
    if (body.spreadsheetId !== LEGACY_SPREADSHEET_ID || !Array.isArray(body.sheets)) throw new DataError('google_metadata_invalid');
    const matching = body.sheets.filter(sheet => sheet?.properties?.sheetId === LEGACY_SHEET_ID || sheet?.properties?.title === LEGACY_SHEET_TITLE);
    if (matching.length !== 1) throw new DataError('legacy_grid_changed');
    const properties = matching[0].properties;
    if (properties.sheetId !== LEGACY_SHEET_ID || properties.title !== LEGACY_SHEET_TITLE ||
        properties.gridProperties?.rowCount !== 501 || properties.gridProperties?.columnCount !== 8) throw new DataError('legacy_grid_changed');
  }

  private async readPass(): Promise<Snapshot> {
    try {
      requireLegacySheetConfiguration();
      const token = await this.token();
      if (!token || !/^[\x21-\x7e]{1,8192}$/.test(token)) throw new DataError('google_credentials_missing');
      await this.verifyGrid(token);
      const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${LEGACY_SPREADSHEET_ID}/values:batchGet`);
      url.searchParams.set('ranges', LEGACY_SHEET_RANGE);
      url.searchParams.set('majorDimension', 'ROWS');
      url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
      url.searchParams.set('dateTimeRenderOption', 'FORMATTED_STRING');
      const response = await this.request(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (!response.ok) {
        await response.body?.cancel();
        throw new DataError(response.status === 401 || response.status === 403 ? 'google_access_denied' : 'google_read_failed');
      }
      const body = await readGoogleJson(response, 12 * 1024 * 1024);
      await this.verifyGrid(token);
      return normalizeLegacySheetResponse(body, this.now().toISOString());
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw new DataError('google_read_failed');
    }
  }

  async read(): Promise<Snapshot> {
    // Two identical bounded reads detect concurrent edits; this is not a Google transaction.
    const first = await this.readPass();
    const second = await this.readPass();
    if (first.version !== second.version) throw new DataError('source_changed_during_read');
    return second;
  }
}

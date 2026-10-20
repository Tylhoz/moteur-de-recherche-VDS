import type { Client, Snapshot } from '../src/types.js';
import { sha256Text } from '../shared/worker-bundle.js';

/** Secrets are supplied by Workers bindings. Never serialize this object. */
export interface IntegrationsEnv {
  VDS_GOOGLE_CLIENT_ID?: string;
  VDS_GOOGLE_CLIENT_SECRET?: string;
  VDS_GOOGLE_REFRESH_TOKEN?: string;
  VDS_LEGACY_SPREADSHEET_ID?: string;
  VDS_GOOGLE_SHEET_RANGE?: string;
  VDS_INVOICING_PROVIDER?: string;
  VDS_VOSFACTURES_ENABLED?: string;
  VDS_VOSFACTURES_ACCOUNT?: string;
  VDS_VOSFACTURES_API_TOKEN?: string;
}
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const SHEETS_HEADERS = [
  'N° Dossier', 'Client', 'Téléphone & Email', 'Adresse du Chantier',
  'Modèle, Volet & Équipe', 'Technique & Maçonnerie', 'Contrat HT/TTC & Solde', 'Statut, Dates & Action',
] as const;
const requiredGoogle = ['VDS_GOOGLE_CLIENT_ID', 'VDS_GOOGLE_CLIENT_SECRET', 'VDS_GOOGLE_REFRESH_TOKEN', 'VDS_LEGACY_SPREADSHEET_ID'] as const;
const DEFAULT_RANGE = "'Base_Centrale_360'!A1:H501";
export const OBSERVED_FIELDS = ['client', 'contact', 'address', 'modelTeam', 'techMacon', 'finance', 'statusAction'] as const;
type ObservedField = typeof OBSERVED_FIELDS[number];
export class IntegrationError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code: string): never => { throw new IntegrationError(code); };
function rangeConfiguration(env: IntegrationsEnv) {
  const value = env.VDS_GOOGLE_SHEET_RANGE?.trim() || DEFAULT_RANGE;
  // This adapter preserves the reviewed eight-column, 500-dossier mapping.
  // A different schema requires an explicit mapping change, never guessed columns.
  const match = value.match(/^(?:'([^'!\r\n]{1,100})'|([^'!\r\n]{1,100}))!A1:H501$/);
  if (!match) return null;
  const title = match[1] || match[2];
  return { title, range: `'${title}'!A1:H501` };
}
function googleConfiguration(env: IntegrationsEnv) {
  const missing = requiredGoogle.filter(name => !env[name]?.trim());
  const invalid: string[] = [];
  if (env.VDS_GOOGLE_CLIENT_ID && !/^[A-Za-z0-9._-]{8,250}\.apps\.googleusercontent\.com$/.test(env.VDS_GOOGLE_CLIENT_ID)) invalid.push('VDS_GOOGLE_CLIENT_ID');
  for (const name of ['VDS_GOOGLE_CLIENT_SECRET', 'VDS_GOOGLE_REFRESH_TOKEN'] as const) {
    if (env[name] && (!/^[\x21-\x7e]{1,8192}$/.test(env[name]!))) invalid.push(name);
  }
  if (env.VDS_LEGACY_SPREADSHEET_ID && !/^[A-Za-z0-9_-]{10,200}$/.test(env.VDS_LEGACY_SPREADSHEET_ID)) invalid.push('VDS_LEGACY_SPREADSHEET_ID');
  if (!rangeConfiguration(env)) invalid.push('VDS_GOOGLE_SHEET_RANGE');
  return { configured: !missing.length && !invalid.length, missing, invalid };
}

/** Configuration is not a successful provider connection. No values or private URLs returned. */
export function integrationConfiguration(env: IntegrationsEnv) {
  const google = googleConfiguration(env);
  const providerConfirmed = env.VDS_INVOICING_PROVIDER === 'vosfactures';
  const accountValid = typeof env.VDS_VOSFACTURES_ACCOUNT === 'string'
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(env.VDS_VOSFACTURES_ACCOUNT)
    && !['app', 'www', 'aide', 'sugester'].includes(env.VDS_VOSFACTURES_ACCOUNT);
  const tokenValid = typeof env.VDS_VOSFACTURES_API_TOKEN === 'string' && /^[\x21-\x7e]{16,8192}$/.test(env.VDS_VOSFACTURES_API_TOKEN);
  const invoiceConfigured = providerConfirmed && accountValid && tokenValid;
  return {
    sheets: { ...google, provider: 'google_sheets' as const, checked: false, connected: false, readOnly: true,
      mode: 'review_before_apply' as const, state: google.configured ? 'not_checked' as const : 'not_configured' as const },
    invoicing: {
      provider: providerConfirmed ? 'vosfactures' as const : 'unconfirmed' as const,
      providerConfirmed, configured: invoiceConfigured, enabledRequested: env.VDS_VOSFACTURES_ENABLED === 'true',
      // A later reviewed adapter is required. Supplying a token does not connect the service.
      implementationReady: false, enabled: false, checked: false, connected: false, readOnly: true,
      state: providerConfirmed ? 'planned' as const : 'provider_confirmation_required' as const,
      missing: [...(!providerConfirmed ? ['VDS_INVOICING_PROVIDER'] : []),
        ...(!accountValid ? ['VDS_VOSFACTURES_ACCOUNT'] : []), ...(!tokenValid ? ['VDS_VOSFACTURES_API_TOKEN'] : [])],
    },
  };
}

/** Bounded UTF-8 decoding, usable in Workers without Buffer or Node dependencies. */
async function readJson(response: Response, limit: number): Promise<unknown> {
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel(); return fail('provider_response_too_large');
  }
  if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel(); return fail('provider_response_invalid');
  }
  const reader = response.body?.getReader();
  if (!reader) return fail('provider_response_invalid');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0, text = '';
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > limit) { await reader.cancel(); return fail('provider_response_too_large'); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    return fail('provider_response_invalid');
  } finally { reader.releaseLock(); }
}
function checkedCell(value: unknown): string {
  if (typeof value !== 'string' || value.length > 12_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return fail('sheets_cell_invalid');
  for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    try {
      const link = match[0].replace(/[),.;]+$/, '');
      const url = new URL(link);
      let decoded = link;
      for (let i = 0; i < 3; i++) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; }
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !['docs.google.com', 'drive.google.com', 'mail.google.com', 'calendar.google.com'].includes(url.hostname)
        || /(?:access.?token|refresh.?token|signature|secret|password|api.?key|credential|authorization|jwt|[?&#](?:auth|token|key|sig)=)/i.test(decoded)) return fail('sheets_unsafe_link');
    } catch { return fail('sheets_unsafe_link'); }
  }
  return value;
}
export interface SheetsChange {
  clientId: string;
  field: ObservedField;
  before: string;
  proposed: string;
  requiresIdentityReview: boolean;
}
export interface SheetsProposal {
  schemaVersion: 'sheets-proposal-1';
  revision: string;
  baseVersion: string | null;
  readAt: string;
  source: { provider: 'google_sheets'; spreadsheetId: string; range: string };
  snapshot: Snapshot;
  changes: SheetsChange[];
  requiresValidation: boolean;
  initialImport: boolean;
  sourceWrites: 0;
  financialTotalsVerified: false;
}
export interface SheetsReaderStatus {
  configured: boolean;
  checked: boolean;
  connected: boolean;
  state: 'not_configured' | 'not_checked' | 'ready' | 'pending_validation' | 'error';
  lastAttemptAt: string | null;
  lastReadAt: string | null;
  error: string | null;
  readOnly: true;
}

export function createSheetsReader(env: IntegrationsEnv, options: { request?: typeof fetch; now?: () => Date } = {}) {
  const request = options.request ?? fetch, now = options.now ?? (() => new Date());
  const configured = googleConfiguration(env).configured;
  let status: SheetsReaderStatus = { configured, checked: false, connected: false, state: configured ? 'not_checked' : 'not_configured',
    lastAttemptAt: null, lastReadAt: null, error: null, readOnly: true };
  let cachedToken: { value: string; expiresAt: number } | null = null;
  let pendingToken: Promise<string> | null = null;
  async function token(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > now().getTime() + 60_000) return cachedToken.value;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const requestedAt = now().getTime();
      const response = await request('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.VDS_GOOGLE_CLIENT_ID!,
          client_secret: env.VDS_GOOGLE_CLIENT_SECRET!, refresh_token: env.VDS_GOOGLE_REFRESH_TOKEN! }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return fail([400, 401, 403].includes(response.status) ? 'google_oauth_reauthorization_required' : 'google_oauth_unavailable');
      }
      const grant = await readJson(response, 32 * 1024);
      if (!object(grant) || typeof grant.access_token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(grant.access_token)
        || grant.token_type !== 'Bearer' || !Number.isInteger(grant.expires_in) || grant.expires_in < 120 || grant.expires_in > 86_400) return fail('google_oauth_response_invalid');
      const scopes = typeof grant.scope === 'string' ? grant.scope.trim().split(/\s+/) : [];
      if (scopes.length !== 1 || scopes[0] !== SHEETS_READONLY_SCOPE) return fail('google_oauth_scope_not_readonly');
      const expiresAt = requestedAt + grant.expires_in * 1000;
      if (expiresAt < now().getTime() + 60_000) return fail('google_oauth_response_expired');
      cachedToken = { value: grant.access_token, expiresAt };
      return cachedToken.value;
    })();
    try { return await pendingToken; }
    finally { pendingToken = null; }
  }
  async function get(url: URL, bearer: string, maxBytes: number): Promise<unknown> {
    const response = await request(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) cachedToken = null;
      return fail([401, 403].includes(response.status) ? 'google_access_denied' : 'google_read_failed');
    }
    return readJson(response, maxBytes);
  }
  async function verifyGrid(bearer: string, title: string) {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${env.VDS_LEGACY_SPREADSHEET_ID}`);
    url.searchParams.set('fields', 'spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))');
    const metadata = await get(url, bearer, 256 * 1024);
    if (!object(metadata) || metadata.spreadsheetId !== env.VDS_LEGACY_SPREADSHEET_ID || !Array.isArray(metadata.sheets)) return fail('sheets_metadata_invalid');
    const matching = metadata.sheets.filter(sheet => sheet?.properties?.title === title);
    if (matching.length !== 1 || matching[0].properties.gridProperties?.rowCount !== 501
      || matching[0].properties.gridProperties?.columnCount !== 8) return fail('sheets_mapping_requires_review');
  }
  async function readPass(bearer: string, range: { title: string; range: string }): Promise<Client[]> {
    await verifyGrid(bearer, range.title);
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${env.VDS_LEGACY_SPREADSHEET_ID}/values:batchGet`);
    url.searchParams.set('ranges', range.range);
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
    url.searchParams.set('dateTimeRenderOption', 'FORMATTED_STRING');
    const body = await get(url, bearer, 12 * 1024 * 1024);
    if (!object(body) || body.spreadsheetId !== env.VDS_LEGACY_SPREADSHEET_ID || !Array.isArray(body.valueRanges) || body.valueRanges.length !== 1) return fail('sheets_response_invalid');
    const data = body.valueRanges[0];
    if (!object(data) || ![range.range, `${range.title}!A1:H501`].includes(data.range) || data.majorDimension !== 'ROWS') return fail('sheets_response_invalid');
    const values = data.values;
    if (!Array.isArray(values) || JSON.stringify(values[0]) !== JSON.stringify(SHEETS_HEADERS)) return fail('sheets_headers_invalid');
    if (values.length !== 501) return fail('sheets_dossier_count_changed');
    const seen = new Set<string>();
    const clients = values.slice(1).map((raw: unknown): Client => {
      if (!Array.isArray(raw) || raw.length > 8) return fail('sheets_row_invalid');
      const [id, client, contact, address, modelTeam, techMacon, finance, statusAction] =
        Array.from({ length: 8 }, (_, i) => checkedCell(raw[i] ?? ''));
      if (!/^VDS-\d{3}$/.test(id) || Number(id.slice(4)) < 1 || Number(id.slice(4)) > 500 || seen.has(id) || !client.trim()) return fail('sheets_identity_invalid');
      seen.add(id);
      return { id, client, contact, address, modelTeam, techMacon, finance, statusAction,
        category: 'non_verifie', contractHT: null, soldeAmount: null };
    });
    await verifyGrid(bearer, range.title);
    return clients;
  }
  return {
    status: (): SheetsReaderStatus => ({ ...status }),
    async readProposal(baseline: Snapshot | null): Promise<SheetsProposal> {
      if (!configured) return fail('google_configuration_missing_or_invalid');
      status = { ...status, lastAttemptAt: now().toISOString() };
      try {
        const range = rangeConfiguration(env)!;
        const bearer = await token();
        const first = await readPass(bearer, range), clients = await readPass(bearer, range);
        if (JSON.stringify(first) !== JSON.stringify(clients)) return fail('source_changed_during_read');
        const readAt = now().toISOString();
        const revision = await sha256Text(JSON.stringify({ spreadsheetId: env.VDS_LEGACY_SPREADSHEET_ID, range: range.range, clients }));
        const snapshot: Snapshot = {
          source: 'api', version: `google-sheets:${revision}`, fetchedAt: readAt, clients, records: [], enrichedClientIds: [],
          links: [{ label: 'Base centrale Google Sheets', url: `https://docs.google.com/spreadsheets/d/${env.VDS_LEGACY_SPREADSHEET_ID}/edit` }],
          sourceState: { status: 'ready', stale: false, lastReadAt: readAt, lastAttemptAt: readAt, revision },
          connection: { mode: 'readonly-api', label: 'Google Sheets · lecture seule · informations à vérifier', intervalMs: 30_000, sheetReady: true },
        };
        const changes: SheetsChange[] = [];
        if (baseline) {
          const previous = new Map(baseline.clients.map(client => [client.id, client]));
          if (previous.size !== 500 || clients.some(client => !previous.has(client.id))) return fail('sheets_identity_set_changed');
          for (const client of clients) for (const field of OBSERVED_FIELDS) {
            const before = previous.get(client.id)![field];
            if (before !== client[field]) changes.push({ clientId: client.id, field, before, proposed: client[field],
              requiresIdentityReview: ['client', 'contact', 'address'].includes(field) });
          }
        }
        const requiresValidation = !baseline || changes.length > 0;
        status = { ...status, checked: true, connected: true, state: requiresValidation ? 'pending_validation' : 'ready', lastReadAt: readAt, error: null };
        return { schemaVersion: 'sheets-proposal-1', revision, baseVersion: baseline?.version ?? null, readAt,
          source: { provider: 'google_sheets', spreadsheetId: env.VDS_LEGACY_SPREADSHEET_ID!, range: range.range },
          snapshot, changes, requiresValidation, initialImport: !baseline, sourceWrites: 0, financialTotalsVerified: false };
      } catch (error) {
        const code = error instanceof IntegrationError ? error.code : 'google_read_failed';
        status = { ...status, checked: true, connected: false, state: 'error', error: code };
        throw new IntegrationError(code);
      }
    },
  };
}

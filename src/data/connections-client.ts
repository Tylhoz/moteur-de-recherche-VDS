import { AUTHENTICATION_REQUIRED_EVENT } from './api-client';

export const API_NOT_DEPLOYED_MESSAGE = 'Interface publiée, API non déployée';
export const MAX_PRIVATE_ARCHIVE_BYTES = 4 * 1024 * 1024;
export interface SetupStatus {
  schemaVersion: 'cloudflare-setup-1'; runtime: 'cloudflare-worker' | 'railway-node'; authentication: 'cloudflare-access' | 'owner-session';
  authenticated: true; ownerAuthorized: true; ready: boolean;
  configuration: { access: true; origin: true; assets: boolean; storage: boolean; importToken: boolean; expectedBundle: boolean; release: boolean };
  storage: { state: 'not_configured' | 'unavailable' | 'empty' | 'ready'; dossiers: number | null; enriched: number | null };
  release: { id: string | null; commit: string | null }; sourceWrites: 0;
}
export interface IntegrationStatus {
  automaticIntervalMinutes?: number;
  sheets: { configured: boolean; checked: boolean; connected: boolean; readOnly: true; state: string; lastReadAt?: string | null; lastAttemptAt?: string | null; error?: string | null };
  invoicing: { provider: 'vosfactures' | 'unconfirmed'; providerConfirmed: boolean; configured: boolean; connected: false; enabled: false; implementationReady: false; readOnly: true };
}
export const FIELD_LABELS = {
  client: 'Identité', contact: 'Coordonnées', address: 'Adresse du chantier', modelTeam: 'Piscine et équipe',
  techMacon: 'Technique et maçonnerie', finance: 'Informations financières', statusAction: 'Statut, dates et action',
} as const;
export interface SheetsDifference { clientId: string; field: keyof typeof FIELD_LABELS; before: string; proposed: string; requiresIdentityReview: boolean; }
export interface SheetsPreview {
  schemaVersion: 'sheets-proposal-1'; revision: string; baseVersion: string | null; readAt: string;
  source: { provider: 'google_sheets'; spreadsheetId: string; range: string };
  changes: SheetsDifference[]; requiresValidation: boolean; initialImport: boolean; sourceWrites: 0; financialTotalsVerified: false;
}
export interface ImportReceipt { imported: true; dossiers: 500; enriched: 10; sourceWrites: 0; }
export interface ApprovalReceipt { applied: true; revision: string; dossiers: number; enriched: number; sourceWrites: 0; financialTotalsVerified: false; }
export class ConnectionsError extends Error {
  constructor(readonly code: string) { super(messageFor(code)); this.name = 'ConnectionsError'; }
}
const messages: Record<string, string> = {
  api_not_deployed: `${API_NOT_DEPLOYED_MESSAGE}. Le serveur privé doit être déployé pour lire vos dossiers.`,
  authentication_required: 'Votre session doit être renouvelée. Reconnectez-vous pour consulter les données.',
  access_forbidden: 'Ce compte n’est pas autorisé à accéder à cet espace privé.',
  access_configuration_required: 'La protection de cet environnement doit être configurée côté serveur.',
  private_hosting_not_configured: 'L’adresse de cet environnement privé doit être configurée côté serveur.',
  access_service_unavailable: 'Le service d’authentification est momentanément indisponible.',
  google_configuration_missing_or_invalid: 'La lecture Google Sheets doit être configurée côté serveur.',
  google_oauth_scope_not_readonly: 'L’autorisation Google doit être limitée à la lecture seule avant toute connexion.',
  sheets_mapping_requires_review: 'La structure de la feuille a changé. Le rapprochement doit être vérifié.',
  sheets_headers_invalid: 'Les colonnes de la feuille ne correspondent pas à la structure attendue.',
  sheets_dossier_count_changed: 'Le nombre de dossiers diffère de la base attendue. Une vérification est nécessaire.',
  sheets_identity_set_changed: 'Les identifiants des dossiers ont changé. Aucun rapprochement automatique n’a été appliqué.',
  sheets_identity_invalid: 'Un identifiant de dossier manque ou apparaît plusieurs fois. Vérifiez la feuille source.',
  sheets_unsafe_link: 'Un lien de la source nécessite une vérification avant d’afficher les informations.',
  source_changed_during_read: 'La source a changé pendant la lecture. Relancez le contrôle.',
  identity_review_required: 'Les écarts concernent l’identité d’un dossier. Un rapprochement manuel est nécessaire avant leur application.',
  source_version_changed: 'L’archive a changé depuis ce contrôle. Relancez la comparaison avant de valider.',
  proposal_changed: 'Une nouvelle proposition remplace celle affichée. Actualisez les écarts avant de valider.',
  private_data_not_loaded: 'Les dossiers privés n’ont pas encore été importés dans cet environnement.',
  private_import_not_configured: 'L’import de l’archive privée doit être configuré côté serveur.',
  private_storage_not_configured: 'Le stockage privé de cet environnement doit être configuré côté serveur.',
  archive_file_invalid: 'Choisissez l’archive privée au format JSON, de 4 Mio maximum.',
  invalid_response: 'Le serveur a renvoyé une réponse non reconnue. Aucune information n’a été appliquée.',
  network_unavailable: 'Impossible de joindre l’API privée. Vérifiez la connexion puis réessayez.',
};
export function messageFor(code: string): string {
  return messages[code] ?? 'Cette opération n’a pas abouti. Les données existantes sont conservées ; vérifiez la configuration du serveur.';
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bool = (value: unknown) => typeof value === 'boolean';
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
const fail = (): never => { throw new ConnectionsError('invalid_response'); };

export function validateSetup(value: unknown): SetupStatus {
  if (!object(value) || value.schemaVersion !== 'cloudflare-setup-1' || !((value.runtime === 'cloudflare-worker' && value.authentication === 'cloudflare-access') ||
      (value.runtime === 'railway-node' && value.authentication === 'owner-session')) || value.authenticated !== true || value.ownerAuthorized !== true ||
      !bool(value.ready) || value.sourceWrites !== 0 || !object(value.configuration) || !object(value.storage) || !object(value.release) ||
      value.configuration.access !== true || value.configuration.origin !== true ||
      !['assets', 'storage', 'importToken', 'expectedBundle', 'release'].every(key => bool((value.configuration as Record<string, unknown>)[key])) ||
      !['not_configured', 'unavailable', 'empty', 'ready'].includes(String(value.storage.state)) ||
      !count(value.storage.dossiers) || !count(value.storage.enriched) ||
      !(value.release.id === null || (typeof value.release.id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value.release.id))) ||
      !(value.release.commit === null || (typeof value.release.commit === 'string' && /^[a-f0-9]{40}$/.test(value.release.commit)))) return fail();
  if (value.storage.state === 'ready' && (value.storage.dossiers === null || value.storage.enriched === null)) return fail();
  return value as unknown as SetupStatus;
}
export function validateIntegrations(value: unknown): IntegrationStatus {
  if (!object(value) || !object(value.sheets) || !object(value.invoicing)) return fail();
  const { sheets, invoicing } = value;
  if (!['configured', 'checked', 'connected'].every(key => bool(sheets[key])) || sheets.readOnly !== true ||
      !['not_configured', 'not_checked', 'ready', 'pending_validation', 'error'].includes(String(sheets.state)) ||
      (sheets.connected && (!sheets.configured || !sheets.checked)) ||
      (sheets.lastReadAt != null && !date(sheets.lastReadAt)) || (sheets.lastAttemptAt != null && !date(sheets.lastAttemptAt)) ||
      !['vosfactures', 'unconfirmed'].includes(String(invoicing.provider)) ||
      !bool(invoicing.providerConfirmed) || !bool(invoicing.configured) || invoicing.connected !== false ||
      invoicing.enabled !== false || invoicing.implementationReady !== false || invoicing.readOnly !== true) return fail();
  return value as unknown as IntegrationStatus;
}
export function validateSheetsPreview(value: unknown): SheetsPreview {
  if (!object(value) || value.schemaVersion !== 'sheets-proposal-1' || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision) ||
      !(value.baseVersion === null || typeof value.baseVersion === 'string') || !date(value.readAt) || !object(value.source) ||
      value.source.provider !== 'google_sheets' || typeof value.source.spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(value.source.spreadsheetId) ||
      typeof value.source.range !== 'string' || !value.source.range || value.source.range.length > 150 ||
      !Array.isArray(value.changes) || value.changes.length > 3500 || !bool(value.requiresValidation) || !bool(value.initialImport) ||
      value.sourceWrites !== 0 || value.financialTotalsVerified !== false) return fail();
  for (const change of value.changes) {
    if (!object(change) || typeof change.clientId !== 'string' || !/^VDS-\d+$/.test(change.clientId) ||
        typeof change.field !== 'string' || !Object.hasOwn(FIELD_LABELS, change.field) || typeof change.before !== 'string' ||
        typeof change.proposed !== 'string' || !bool(change.requiresIdentityReview)) return fail();
  }
  if (value.requiresValidation !== (value.initialImport || value.changes.length > 0)) return fail();
  // Deliberately discard the full source snapshot; this view only retains the differences to review.
  return { schemaVersion: 'sheets-proposal-1', revision: value.revision, baseVersion: value.baseVersion as string | null,
    readAt: value.readAt as string, source: value.source as unknown as SheetsPreview['source'], changes: value.changes as SheetsDifference[],
    requiresValidation: value.requiresValidation as boolean, initialImport: value.initialImport as boolean, sourceWrites: 0, financialTotalsVerified: false };
}
export function previewRequiresIdentityReview(preview: SheetsPreview): boolean {
  return preview.changes.some(change => change.requiresIdentityReview || ['client', 'contact', 'address'].includes(change.field));
}
export function mayApplyPreview(preview: SheetsPreview | null, confirmed: boolean): boolean {
  return !!preview && confirmed && preview.requiresValidation && !preview.initialImport && !previewRequiresIdentityReview(preview);
}
export function validateImportReceipt(value: unknown): ImportReceipt {
  if (!object(value) || value.imported !== true || value.dossiers !== 500 || value.enriched !== 10 || value.sourceWrites !== 0) return fail();
  return { imported: true, dossiers: 500, enriched: 10, sourceWrites: 0 };
}
export function validateApprovalReceipt(value: unknown): ApprovalReceipt {
  if (!object(value) || value.applied !== true || typeof value.revision !== 'string' || !value.revision ||
      value.dossiers === null || !count(value.dossiers) || value.enriched === null || !count(value.enriched) ||
      value.sourceWrites !== 0 || value.financialTotalsVerified !== false) return fail();
  return value as unknown as ApprovalReceipt;
}
export function validateStoredPreview(value: unknown): SheetsPreview | null {
  if (!object(value) || !Object.hasOwn(value, 'proposal')) return fail();
  return value.proposal === null ? null : validateSheetsPreview(value.proposal);
}

export async function readPrivateJson(path: string, options: { method?: 'GET' | 'POST'; body?: BodyInit; action?: 'import'; signal?: AbortSignal; fetcher?: typeof fetch } = {}): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 30_000);
  try {
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(path, { method: options.method ?? 'GET', body: options.body,
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(options.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...(options.action ? { 'X-VDS-Action': options.action } : {}) } });
    } catch { throw new ConnectionsError('network_unavailable'); }
    if (response.status === 401 || response.status === 403) {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));
      throw new ConnectionsError(response.status === 401 ? 'authentication_required' : 'access_forbidden');
    }
    const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
    if (response.ok && contentType.includes('text/html')) throw new ConnectionsError('api_not_deployed');
    if (!contentType.includes('application/json')) throw new ConnectionsError('invalid_response');
    let value: unknown;
    try { value = await response.json(); } catch { throw new ConnectionsError('invalid_response'); }
    if (!response.ok) throw new ConnectionsError(object(value) && typeof value.error === 'string' ? value.error : 'invalid_response');
    return value;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

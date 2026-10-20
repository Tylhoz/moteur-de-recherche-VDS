import { readFile, realpath, stat, appendFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Snapshot, Client } from '../src/types.js';
import type { PilotBundle, PilotDossier, PilotResponse } from '../shared/pilot-contract.js';
import { DataError, digest } from './model.js';
import { normalizeLegacyRows, LEGACY_SPREADSHEET_ID } from './google-legacy.js';
import { loadPrivatePilot } from './pilot.js';

export interface PortalProvider {
  readonly kind: 'google_sheets' | 'private_native_read';
  read(): Promise<Snapshot>;
}
export async function readPrivateJson(filename: string, privateRoot: string, forbiddenRoots: string[] = []): Promise<unknown> {
  const root = await realpath(privateRoot), file = await realpath(filename);
  const under = (base: string, path: string) => { const p = relative(base, path); return !!p && p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p); };
  if (!under(root, file)) throw new DataError('private_file_outside_root');
  for (const base of forbiddenRoots) { let actual: string; try { actual = await realpath(base); } catch { actual = resolve(base); } if (file === actual || under(actual, file)) throw new DataError('public_data_source_forbidden'); }
  const info = await stat(file);
  if (!info.isFile() || info.size > 12 * 1024 * 1024 || (info.mode & 0o077)) throw new DataError('private_file_permissions_or_size');
  return JSON.parse(await readFile(file, 'utf8'));
}

/** An explicitly dated native read, not an automatic Google connection or a public fallback. */
export class PrivateNativeReadProvider implements PortalProvider {
  readonly kind = 'private_native_read' as const;
  constructor(private filename: string, private root: string, private forbiddenRoots: string[] = []) {}
  async read(): Promise<Snapshot> {
    const raw = await readPrivateJson(this.filename, this.root, this.forbiddenRoots) as Record<string, any>;
    if (raw.schemaVersion !== 'native-sheet-read-1' || raw.spreadsheetId !== LEGACY_SPREADSHEET_ID || raw.range !== 'Base_Centrale_360!A1:H501' || raw.verification?.twoEqualNativeReads !== true) throw new DataError('invalid_native_read_archive');
    const snapshot = normalizeLegacyRows(raw.values, raw.readAt);
    return { ...snapshot,
      connection: { ...snapshot.connection, sheetReady: false, label: 'Lecture Google Sheets datée · connexion automatique non configurée' },
      sourceState: { ...snapshot.sourceState!, status: 'not_connected', stale: true, reason: 'Source non connectée au serveur. Dernière lecture Google conservée, sans actualisation continue.' },
    };
  }
}

function identityText(text: string) { return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function identityPhone(value: string, explicitCountry?: '32' | '33'): string | undefined {
  const clean = value.trim().replace(/[^+0-9]/g, '');
  if (/^(?:\+|00)[1-9]\d{7,14}$/.test(clean)) return `+${clean.replace(/^(?:\+|00)/, '')}`;
  if (!/^0\d{8,9}$/.test(clean)) return undefined;
  // A national number is not assigned a country from its digits or the company's location.
  return explicitCountry ? `+${explicitCountry}${clean.slice(1)}` : `national:${clean}`;
}
function identityKeys(client: Pick<Client, 'client' | 'contact'>) {
  const email = client.contact.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0].toLowerCase();
  const beforeEmail = client.contact.split(/[•✉@]/)[0];
  return { name: identityText(client.client), email, phone: identityPhone(beforeEmail) };
}
/** Never links another legacy ID or accepts a name alone. */
export function sameAuditedIdentity(current: Client, baseline: Client): boolean {
  if (current.id !== baseline.id) return false;
  const a = identityKeys(current), b = identityKeys(baseline);
  return !!a.name && a.name === b.name && !!a.email && a.email === b.email && !!a.phone && a.phone === b.phone;
}

/** Checks the identity inside the audited fiche, not merely its ID or a confidence label. */
export function samePilotIdentity(pilot: PilotDossier, baseline: Client): boolean {
  if (pilot.id !== baseline.id) return false;
  const fields = pilot.sections.find(section => section.id === 'identite')?.fields ?? [];
  const readSources = new Set(pilot.sources.filter(source => source.status === 'read').map(source => source.id));
  const values = (label: string) => fields.filter(field => identityText(field.label) === label
    && field.status === 'documented' && field.value && field.sourceIds.some(id => readSources.has(id)))
    .map(field => field.value!.trim());
  const unique = (items: string[]) => [...new Set(items)];
  const emails = unique(values('email').map(value => value.toLowerCase()));
  const country = /\b(?:BE|Belgique|Belgium)\b/i.test(baseline.address) ? '32'
    : /\b(?:FR|France)\b/i.test(baseline.address) ? '33' : undefined;
  const phones = unique(values('telephone').map(value => identityPhone(value, country) ?? ''));
  const baselineEmail = identityKeys(baseline).email;
  const baselinePhone = identityPhone(baseline.contact.split(/[•✉@]/)[0], country);
  if (emails.length !== 1 || emails[0] !== baselineEmail || phones.length !== 1 || !phones[0] || phones[0] !== baselinePhone) return false;
  // A location annotation may be ignored only when it is also present in the audited address.
  const name = (value: string) => identityText(value.replace(/\(([^)]+)\)/g, (whole, annotation: string) =>
    identityText(annotation) && identityText(baseline.address).includes(identityText(annotation)) ? '' : whole).replace(/\bet\b/gi, ''));
  const expectedName = name(baseline.client);
  return !!expectedName && name(pilot.name) === expectedName && values('nom').every(value => name(value) === expectedName);
}

export interface PortalStoreOptions {
  provider: PortalProvider; privateRoot: string; pilotFile: string; identityBaselineFile: string;
  forbiddenRoots?: string[]; journalFile?: string; now?: () => Date; refreshMs?: number;
}
export class PortalStore {
  private snapshot: Snapshot | null = null;
  private bundle: PilotBundle | null = null;
  private active: Promise<void> | null = null;
  private lastAttemptMs = -Infinity;
  private lastFileReadAt: string | null = null;
  private failure: string | null = null;
  private readonly now: () => Date;
  constructor(private options: PortalStoreOptions) { this.now = options.now ?? (() => new Date()); }

  async refresh(): Promise<void> {
    if (this.active) return this.active;
    if (this.now().getTime() - this.lastAttemptMs < (this.options.refreshMs ?? 30_000)) return;
    this.lastAttemptMs = this.now().getTime();
    this.active = this.read();
    try { await this.active; } finally { this.active = null; }
  }
  private async journal(entry: Record<string, unknown>) {
    const file = this.options.journalFile; if (!file) return;
    const root = await realpath(this.options.privateRoot);
    const parent = await realpath(dirname(file));
    if (parent !== root) throw new DataError('journal_outside_private_root');
    try { const info = await stat(file); if (!info.isFile() || info.mode & 0o077 || info.size > 4 * 1024 * 1024 || await realpath(file) !== resolve(file)) throw new DataError('journal_invalid'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
  private async read(): Promise<void> {
    const attemptedAt = this.now().toISOString();
    try {
      const { provider, pilotFile, privateRoot, forbiddenRoots = [], identityBaselineFile } = this.options;
      const [snapshot, bundle, baselineRaw] = await Promise.all([
        provider.read(), loadPrivatePilot(pilotFile, privateRoot, forbiddenRoots), readPrivateJson(identityBaselineFile, privateRoot, forbiddenRoots),
      ]);
      const baseline = baselineRaw as { clients?: Client[] };
      if (!Array.isArray(baseline.clients) || baseline.clients.length !== 500) throw new DataError('audited_identity_baseline_missing');
      const enrichedClientIds = bundle.dossiers.filter(pilot => {
        const current = snapshot.clients.find(c => c.id === pilot.id);
        const original = baseline.clients!.find(c => c.id === pilot.id);
        return pilot.matching.status === 'proposed_strong' && !!current && !!original
          && sameAuditedIdentity(current, original) && samePilotIdentity(pilot, original);
      }).map(d => d.id);
      const revision = digest({ source: snapshot.version, pilot: bundle.sourceDigest, identities: enrichedClientIds });
      const next = { ...snapshot, version: revision, enrichedClientIds };
      await this.journal({ at: attemptedAt, provider: provider.kind, status: 'read', sourceReadAt: snapshot.sourceState?.lastReadAt ?? null, revision, dossiers: snapshot.clients.length, pilotDossiers: enrichedClientIds.length, sourceWrites: 0 });
      this.snapshot = next; this.bundle = bundle; this.lastFileReadAt = attemptedAt; this.failure = null;
    } catch (error) {
      const code = error instanceof DataError ? error.code : 'portal_read_failed';
      this.failure = code;
      if (this.snapshot) this.snapshot = { ...this.snapshot, sourceState: { ...this.snapshot.sourceState!, status: 'stale', stale: true, lastAttemptAt: attemptedAt, reason: 'Synchronisation indisponible. Dernière version valide conservée.' } };
      try { await this.journal({ at: attemptedAt, provider: this.options.provider.kind, status: 'failed', error: code, sourceWrites: 0 }); } catch { /* No source mutation or secret-bearing diagnostics on journal failure. */ }
    }
  }
  current(): Snapshot | null { return this.snapshot; }
  status() { return { provider: this.options.provider.kind, lastPrivateReadAt: this.lastFileReadAt, lastSourceReadAt: this.snapshot?.sourceState?.lastReadAt ?? null, state: this.snapshot?.sourceState?.status ?? 'not_connected', error: this.failure, continuousGoogleConnection: this.options.provider.kind === 'google_sheets' && !this.failure && this.snapshot?.sourceState?.status === 'ready' && this.snapshot?.connection.sheetReady === true, readOnly: true }; }
  pilot(id: string): PilotResponse | null {
    if (!this.snapshot?.enrichedClientIds?.includes(id)) return null;
    const data = this.bundle?.dossiers.find(d => d.id === id); if (!data || !this.lastFileReadAt || !this.bundle) return null;
    return { data, meta: { lastReadAt: this.lastFileReadAt, lastSourceReadAt: data.lastSourceReadAt, state: this.failure ? 'stale' : 'private_audit_snapshot', readOnly: true, revision: digest({ data, failure: this.failure }), sourceMode: 'private_audit_snapshot' } };
  }
  pilotSummary() {
    return { availableIds: this.snapshot?.enrichedClientIds ?? [], counts: this.bundle?.counts ?? null, sourceMode: 'private_audit_snapshot', auditDate: this.bundle?.sourceAuditDate ?? null, humanValidationRequired: true };
  }
}

import type { Snapshot } from '../src/types.js';
import { validatePortalSnapshot } from '../src/data/api-client.js';
import type { PilotCounts, PilotResponse } from './pilot-contract.js';
import type { AnalyticsResponse } from './analytics-contract.js';

export interface WorkerPrivateBundle {
  schemaVersion: 'worker-private-1';
  snapshot: Snapshot;
  pilots: PilotResponse[];
  summary: { availableIds: string[]; counts: PilotCounts & { dossiers: number; timelineEvents: number; documents: number; agendaCandidates: number };
    sourceMode: 'private_audit_snapshot'; auditDate: string | null; humanValidationRequired: true };
  connections: Record<string, unknown>;
  analytics: AnalyticsResponse;
}
export const WORKER_BUNDLE_MAX_BYTES = 4 * 1024 * 1024;
const states = ['documented', 'review', 'missing', 'unverified', 'excluded', 'obsolete'] as const;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const nullableText = (v: unknown) => v === null || text(v);
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown) => v === null || text(v) && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(`${v.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === v.slice(0, 10);
function ensure(value: unknown): asserts value { if (!value) throw new Error('invalid_private_bundle'); }
function safeUrl(v: unknown) {
  if (v === null) return true;
  if (!text(v)) return false;
  try { const u = new URL(v); const alias = u.hostname === 'www.google.com' && u.pathname === '/calendar/event' && !!u.searchParams.get('eid');
    return u.protocol === 'https:' && !u.username && !u.password && !u.port
      && (alias || ['mail.google.com', 'calendar.google.com', 'drive.google.com', 'docs.google.com'].includes(u.hostname))
      && ![...u.searchParams.keys()].some(k => /token|secret|password|signature|credential|api.?key|resourcekey/i.test(k));
  } catch { return false; }
}
function ids(list: unknown, allowed?: Set<string>): list is string[] {
  return Array.isArray(list) && list.every(v => text(v) && !!v && (!allowed || allowed.has(v))) && new Set(list).size === list.length;
}
/** Web Crypto only: neither Workers nor its deployed dependency graph require Node. */
export async function sha256Text(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function rejectEmbeddedSecrets(value: unknown, depth = 0): void {
  ensure(depth < 30);
  if (Array.isArray(value)) { for (const item of value) rejectEmbeddedSecrets(item, depth + 1); return; }
  if (object(value)) { for (const [key, item] of Object.entries(value)) {
    ensure(!/^(?:__proto__|prototype|constructor|access[_-]?token|refresh[_-]?token|api[_-]?key|password|credentials|private[_-]?key)$/i.test(key));
    rejectEmbeddedSecrets(item, depth + 1);
  } return; }
  if (text(value)) {
    ensure(!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,})|\/workspace\/|\/codex\/|file:\/\//.test(value));
    for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      const cleaned = match[0].replace(/[),.;]+$/, '');
      const u = new URL(cleaned);
      ensure(!u.username && !u.password && ![...u.searchParams.keys()].some(k => /token|secret|password|signature|credential|api.?key/i.test(k)));
    }
  }
}

/** Recheck the exact identity keys used by PortalStore without importing its filesystem provider. */
function sourcedIdentityMatches(pilot: PilotResponse['data'], client: Snapshot['clients'][number]) {
  const normalized = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const country = /\b(?:BE|Belgique|Belgium)\b/i.test(client.address) ? '32' : /\b(?:FR|France)\b/i.test(client.address) ? '33' : undefined;
  const phone = (value: string) => {
    const cleaned = value.trim().replace(/[^+0-9]/g, '');
    if (/^(?:\+|00)[1-9]\d{7,14}$/.test(cleaned)) return `+${cleaned.replace(/^(?:\+|00)/, '')}`;
    return /^0\d{8,9}$/.test(cleaned) ? country ? `+${country}${cleaned.slice(1)}` : `national:${cleaned}` : undefined;
  };
  const readSources = new Set(pilot.sources.filter(source => source.status === 'read').map(source => source.id));
  const values = (label: string) => (pilot.sections.find(section => section.id === 'identite')?.fields ?? [])
    .filter(field => normalized(field.label) === label && field.status === 'documented' && field.value && field.sourceIds.some(id => readSources.has(id)))
    .map(field => field.value!.trim());
  const emails = [...new Set(values('email').map(value => value.toLowerCase()))];
  const phones = [...new Set(values('telephone').map(phone))];
  const name = (value: string) => normalized(value.replace(/\(([^)]+)\)/g, (whole, annotation: string) =>
    normalized(annotation) && normalized(client.address).includes(normalized(annotation)) ? '' : whole).replace(/\bet\b/gi, ''));
  const expectedEmail = client.contact.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0].toLowerCase();
  const expectedPhone = phone(client.contact.split(/[•✉@]/)[0]);
  return pilot.id === client.id && !!name(client.client) && name(pilot.name) === name(client.client)
    && values('nom').every(value => name(value) === name(client.client))
    && emails.length === 1 && !!expectedEmail && emails[0] === expectedEmail
    && phones.length === 1 && !!expectedPhone && phones[0] === expectedPhone;
}

/** Validate an already identity-checked projection; never infer or overwrite business facts. */
export function validateWorkerBundle(value: unknown): WorkerPrivateBundle {
  ensure(object(value) && value.schemaVersion === 'worker-private-1');
  ensure(Object.keys(value).sort().join(',') === ['analytics','connections','pilots','schemaVersion','snapshot','summary'].sort().join(','));
  rejectEmbeddedSecrets(value);
  const snapshot = validatePortalSnapshot(value.snapshot);
  ensure(snapshot.clients.length === 500 && snapshot.enrichedClientIds?.length === 10 && snapshot.records.length === 0);
  ensure(snapshot.connection.sheetReady === false && snapshot.sourceState?.stale === true && snapshot.sourceState.status === 'not_connected');
  ensure(snapshot.clients.every(c => c.contractHT === null && c.soldeAmount === null && c.category === 'non_verifie'));
  const clients = new Map(snapshot.clients.map(c => [c.id, c]));
  const eligible = new Set(snapshot.enrichedClientIds);
  ensure(Array.isArray(value.pilots) && value.pilots.length === 10 && ids(value.pilots.map(p => p?.data?.id), eligible));
  const totals: Record<string, number> = Object.fromEntries(states.map(s => [s, 0]));
  let contradictions = 0, timeline = 0, documents = 0, documentsRead = 0, sourcesCount = 0, agenda = 0;
  const sourceSets = new Map<string, Set<string>>();
  for (const p of value.pilots) {
    ensure(object(p) && object(p.meta) && object(p.data));
    ensure(p.meta.readOnly === true && p.meta.sourceMode === 'private_audit_snapshot' && text(p.meta.revision) && date(p.meta.lastReadAt) && date(p.meta.lastSourceReadAt));
    const d = p.data;
    ensure(text(d.name) && !!d.name.trim() && d.status === 'review' && d.productionApplied === false && date(d.lastSourceReadAt));
    ensure(object(d.matching) && d.matching.status === 'proposed_strong' && d.matching.humanValidated === false);
    ensure(Array.isArray(d.sources) && d.sources.length > 0 && ids(d.sources.map((s: any) => s?.id)));
    const sources = new Set<string>(d.sources.map((s: any) => s.id)); sourceSets.set(d.id, sources);
    for (const s of d.sources) ensure(object(s) && text(s.label) && ['gmail','agenda','attachment'].includes(s.kind)
      && ['read','identified','excluded'].includes(s.status) && safeUrl(s.url) && date(s.occurredAt));
    ensure(Array.isArray(d.sections) && d.sections.length > 0 && ids(d.sections.map((s: any) => s?.id)));
    const fields = d.sections.flatMap((section: any) => {
      // Original document projections repeat a field identifier for separate attachments.
      // Preserve these sourced rows; document/source identifiers below remain unique.
      ensure(object(section) && text(section.label) && Array.isArray(section.fields) && section.fields.every((f: any) => text(f?.id) && !!f.id));
      return section.fields;
    });
    const local: Record<string, number> = Object.fromEntries(states.map(s => [s, 0]));
    for (const f of fields) { ensure(object(f) && text(f.label) && nullableText(f.value) && states.includes(f.status) && f.humanValidated === false && ids(f.sourceIds, sources)); local[f.status]++; totals[f.status]++; }
    ensure(sourcedIdentityMatches(d as PilotResponse['data'], clients.get(d.id)!));
    ensure(Array.isArray(d.contradictions) && ids(d.contradictions.map((c: any) => c?.id)));
    for (const c of d.contradictions) ensure(object(c) && c.status === 'review' && text(c.field) && nullableText(c.existingValue) && nullableText(c.observedValue) && ids(c.sourceIds, sources));
    ensure(Array.isArray(d.timeline) && ids(d.timeline.map((e: any) => e?.id)));
    for (const e of d.timeline) ensure(object(e) && text(e.summary) && states.includes(e.status) && date(e.dateUTC) && nullableText(e.eventDate) && ids(e.sourceIds, sources) && e.sourceIds.length > 0);
    ensure(Array.isArray(d.documents) && ids(d.documents.map((doc: any) => doc?.id)));
    for (const doc of d.documents) ensure(object(doc) && text(doc.filename) && typeof doc.contentRead === 'boolean' && typeof doc.visuallyChecked === 'boolean' && safeUrl(doc.url) && ids(doc.sourceIds, sources));
    ensure(Array.isArray(d.agenda) && ids(d.agenda.map((event: any) => event?.id)));
    for (const e of d.agenda) ensure(object(e) && e.status === 'review' && e.associationApproved === false && e.clientApprovalVerified === false && e.completionVerified === false && safeUrl(e.url) && ids(e.sourceIds, sources));
    ensure(object(d.counts) && states.every(s => d.counts[s] === local[s]) && d.counts.contradictions === d.contradictions.length && d.counts.humanValidated === 0);
    ensure(Array.isArray(d.nextActions) && d.nextActions.every(text) && Array.isArray(d.limitations) && d.limitations.every(text));
    contradictions += d.contradictions.length; timeline += d.timeline.length; documents += d.documents.length;
    documentsRead += d.documents.filter((doc: any) => doc.contentRead || doc.visuallyChecked).length;
    sourcesCount += d.sources.length; agenda += d.agenda.length;
  }
  const summary = value.summary;
  ensure(object(summary) && ids(summary.availableIds, eligible) && summary.availableIds.length === 10 && summary.sourceMode === 'private_audit_snapshot'
    && summary.humanValidationRequired === true && date(summary.auditDate) && object(summary.counts));
  ensure(states.every(s => summary.counts[s] === totals[s]) && summary.counts.humanValidated === 0 && summary.counts.dossiers === 10
    && summary.counts.contradictions === contradictions && summary.counts.timelineEvents === timeline && summary.counts.documents === documents && summary.counts.agendaCandidates === agenda);
  const a = value.analytics;
  ensure(object(a) && a.schemaVersion === 'analytics-1' && object(a.meta) && a.meta.sourceRevision === snapshot.version
    && a.meta.readOnly === true && a.meta.sourceMode === 'private_audit_snapshot' && a.meta.stale === true
    && a.meta.state === snapshot.sourceState.status && a.meta.sourceReadAt === snapshot.sourceState.lastReadAt && a.meta.sourceAuditDate === summary.auditDate);
  ensure(object(a.finance) && a.finance.currency === 'EUR' && a.finance.contractsTotal === null && a.finance.balancesTotal === null && Array.isArray(a.finance.series) && !a.finance.series.length);
  ensure(object(a.totals) && Object.values(a.totals).every(count) && a.totals.clients === 500 && a.totals.enriched === 10 && a.totals.unenriched === 490
    && a.totals.humanValidated === 0 && a.totals.contradictions === contradictions && a.totals.events === timeline
    && a.totals.documents === documents && a.totals.documentsRead === documentsRead && a.totals.sources === sourcesCount
    && a.totals.documentedFields === totals.documented && a.totals.missingFields === totals.missing && a.totals.reviewFields === totals.review);
  ensure(Array.isArray(a.dossiers) && a.dossiers.length === 500 && ids(a.dossiers.map((d: any) => d?.id), new Set(clients.keys())));
  for (const d of a.dossiers) {
    ensure(object(d) && d.name === clients.get(d.id)?.client && d.enriched === eligible.has(d.id) && object(d.counts) && Object.values(d.counts).every(count)
      && Array.isArray(d.months) && d.months.every((m: unknown) => text(m) && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(m)) && Array.isArray(d.observations));
    for (const o of d.observations) ensure(object(o) && text(o.id) && text(o.label) && nullableText(o.value) && states.includes(o.status) && o.humanValidated === false
      && Array.isArray(o.sources) && o.sources.every((s: any) => object(s) && sourceSets.get(d.id)?.has(s.id) && safeUrl(s.url)));
    if (!d.enriched) ensure(d.observations.length === 0 && Object.values(d.counts).every(n => n === 0));
  }
  ensure(Array.isArray(a.events) && a.events.length === timeline && ids(a.events.map((e: any) => e?.id)));
  for (const e of a.events) ensure(object(e) && eligible.has(e.dossierId) && text(e.summary) && date(e.date) && states.includes(e.status)
    && Array.isArray(e.sources) && e.sources.length > 0 && e.sources.every((s: any) => object(s) && sourceSets.get(e.dossierId)?.has(s.id) && safeUrl(s.url)));
  ensure(Array.isArray(a.activity) && a.activity.every((p: any) => object(p) && text(p.month) && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(p.month)
    && [p.count,p.documented,p.review,p.other].every(count) && p.count === p.documented+p.review+p.other && ids(p.dossierIds, eligible)));
  ensure(a.activity.reduce((sum: number, p: any) => sum+p.count, 0) === a.totals.datedEvents && a.totals.datedEvents+a.totals.undatedEvents === timeline);
  ensure(Array.isArray(a.coverage) && a.coverage.length === states.length && ids(a.coverage.map((p: any) => p?.id), new Set(states))
    && a.coverage.every((p: any) => object(p) && p.count === totals[p.id] && ids(p.dossierIds, eligible)));
  ensure(object(value.connections) && object(value.connections.sheets) && value.connections.sheets.readOnly === true && value.connections.sheets.continuousGoogleConnection === false
    && value.connections.gmail?.continuousConnection === false && value.connections.agenda?.continuousConnection === false && value.connections.vosfactures?.connected === false);
  return value as unknown as WorkerPrivateBundle;
}

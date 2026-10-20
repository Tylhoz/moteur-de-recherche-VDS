import type { Snapshot } from '../src/types.js';
import type { PilotDossier, PilotField, PilotFieldStatus, PilotResponse } from '../shared/pilot-contract.js';
import type { AnalyticsDossier, AnalyticsEvent, AnalyticsObservation, AnalyticsResponse, AnalyticsSource } from '../shared/analytics-contract.js';
import { digest } from './model.js';

const statuses: PilotFieldStatus[] = ['documented', 'review', 'missing', 'unverified', 'excluded', 'obsolete'];
const labels: Record<PilotFieldStatus, string> = {
  documented: 'Documentés par une source', review: 'À vérifier', missing: 'Information non retrouvée',
  unverified: 'Non vérifiés', excluded: 'Écartés du périmètre', obsolete: 'Obsolètes',
};
const normalized = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** ISO-only dates: no locale-dependent guessing or borrowing an audit/import date. */
function explicitDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return null;
  const literal = value.slice(0, 10), parsedDay = new Date(`${literal}T00:00:00Z`);
  return Number.isFinite(parsedDay.getTime()) && parsedDay.toISOString().slice(0, 10) === literal && Number.isFinite(Date.parse(value)) ? value : null;
}
function safeSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const calendarAlias = url.hostname === 'www.google.com' && url.pathname === '/calendar/event' && !!url.searchParams.get('eid');
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (calendarAlias || ['mail.google.com', 'drive.google.com', 'docs.google.com', 'calendar.google.com'].includes(url.hostname) || /^[a-z0-9-]+\.vosfactures\.fr$/.test(url.hostname)&&/^\/(?:invoices|clients)\/\d+$/.test(url.pathname)&&!url.search)
      && ![...url.searchParams.keys()].some(key => /token|secret|password|signature|credential|api.?key|resourcekey/i.test(key)) ? url.href : null;
  } catch { return null; }
}
function sourceMap(dossier: PilotDossier): Map<string, AnalyticsSource> {
  return new Map(dossier.sources.map(source => [source.id, {
    id: source.id, label: source.label, url: safeSourceUrl(source.url), kind: source.kind,
    status: source.status, occurredAt: explicitDate(source.occurredAt),
  }]));
}
function referenced(ids: string[], sources: Map<string, AnalyticsSource>): AnalyticsSource[] {
  return [...new Set(ids)].map(id => sources.get(id)).filter((source): source is AnalyticsSource => !!source);
}
function category(field: PilotField): AnalyticsObservation['category'] {
  const name = normalized(field.label);
  if (/\bsolde\b/.test(name)) return 'balance';
  if (/\becheance/.test(name)) return 'due_date';
  if (/\b(paiement|paiements|encaissement|encaissements|virement|remboursement)\b/.test(name)) return 'payment';
  if (/\b(facture|factures|avoir|proforma|acompte)\b/.test(name)) return 'invoice';
  if (/\b(contrat|contrats|ht|ttc|tva|devis)\b/.test(name)) return 'contract';
  return 'financial';
}
function financialFields(pilot: PilotDossier): PilotField[] {
  return pilot.sections.flatMap(section => {
    if (normalized(section.id) === 'finances') return section.fields;
    // Explicit commercial price fields may be absent from the finance section.
    // Narrative offers/signatures are left in their original fiche, not parsed.
    return normalized(section.id) === 'commercial' ? section.fields.filter(field => /^(?:ht|ttc|tva|montant)\b/.test(normalized(field.label))) : [];
  });
}
function owner(pilot: PilotDossier, sources: Map<string, AnalyticsSource>) {
  const allowed = new Set(['commercial', 'commercial responsable', 'commercial unique responsable', 'commercial responsable actuel']);
  const fields = pilot.sections.flatMap(section => section.fields).filter(field => allowed.has(normalized(field.label))
    && field.status === 'documented' && field.value?.trim() && referenced(field.sourceIds, sources).some(source => source.status === 'read'));
  const values = [...new Set(fields.map(field => field.value!.trim()))];
  return values.length === 1 ? { owner: values[0], ownerSources: referenced(fields.flatMap(field => field.sourceIds), sources) }
    : { owner: null, ownerSources: [] };
}

/**
 * Project only identity-eligible private fiches. No financial numbers are inferred
 * from legacy cells or narrative observations; no external service is contacted.
 * Eligibility must be established by PortalStore's identity checks before calling.
 */
export function buildAnalytics(snapshot: Snapshot, pilots: PilotResponse[], options: { sourceAuditDate?: string | null } = {}): AnalyticsResponse {
  const eligible = new Set(snapshot.enrichedClientIds ?? []);
  const occurrences = new Map<string, number>();
  for (const response of pilots) occurrences.set(response.data.id, (occurrences.get(response.data.id) ?? 0) + 1);
  const byId = new Map(pilots.filter(response => eligible.has(response.data.id) && occurrences.get(response.data.id) === 1
    && response.data.matching.status === 'proposed_strong').map(response => [response.data.id, response]));
  const events: AnalyticsEvent[] = [];
  const statusDossiers = new Map(statuses.map(status => [status, new Set<string>()]));
  const statusCounts = new Map(statuses.map(status => [status, 0]));
  const dossiers: AnalyticsDossier[] = snapshot.clients.map(client => {
    const response = byId.get(client.id), pilot = response?.data;
    const counts: AnalyticsDossier['counts'] = { fields: 0, documented: 0, missing: 0, review: 0, unverified: 0,
      excluded: 0, obsolete: 0, contradictions: 0, sources: 0, documents: 0, documentsRead: 0, events: 0 };
    if (!pilot) return { id: client.id, name: client.client, enriched: false, category: client.category, counts, months: [], owner: null, ownerSources: [], observations: [] };
    const sources = sourceMap(pilot);
    for (const field of pilot.sections.flatMap(section => section.fields)) {
      counts.fields++; counts[field.status]++;
      statusCounts.set(field.status, statusCounts.get(field.status)! + 1);
      statusDossiers.get(field.status)!.add(client.id);
    }
    counts.contradictions = pilot.contradictions.length;
    counts.sources = sources.size;
    counts.documents = pilot.documents.length;
    counts.documentsRead = pilot.documents.filter(document => document.contentRead || document.visuallyChecked).length;
    const seenEvents = new Set<string>();
    const dossierEvents = pilot.timeline.flatMap(event => {
      // Do not turn an unsourced or duplicated timeline record into chart evidence.
      const eventSources = referenced(event.sourceIds, sources);
      if (!eventSources.length || seenEvents.has(event.id)) return [];
      seenEvents.add(event.id);
      const date = explicitDate(event.dateUTC);
      const month = date ? new Date(date).toISOString().slice(0, 7) : null;
      return [{ id: `${pilot.id}:${event.id}`, dossierId: client.id, date, month, dateOriginal: event.dateOriginal,
        plannedEventDate: explicitDate(event.eventDate), summary: event.summary, category: event.category,
        status: event.status, sources: eventSources }];
    });
    counts.events = dossierEvents.length; events.push(...dossierEvents);
    const observations = financialFields(pilot).map(field => ({
      id: field.id, label: field.label, value: field.value, status: field.status, category: category(field),
      sources: referenced(field.sourceIds, sources), note: field.note, humanValidated: false as const,
    }));
    return { id: client.id, name: client.client, enriched: true, category: client.category, counts,
      months: [...new Set(dossierEvents.flatMap(event => event.month ? [event.month] : []))].sort(),
      ...owner(pilot, sources), observations };
  });
  const months = [...new Set(events.flatMap(event => event.month ? [event.month] : []))].sort();
  const activity = months.map(month => {
    const rows = events.filter(event => event.month === month);
    const documented = rows.filter(row => row.status === 'documented').length;
    const review = rows.filter(row => row.status === 'review').length;
    return { month, count: rows.length, documented, review, other: rows.length - documented - review,
      dossierIds: [...new Set(rows.map(row => row.dossierId))] };
  });
  const sum = (key: keyof AnalyticsDossier['counts']) => dossiers.reduce((total, dossier) => total + dossier.counts[key], 0);
  const enriched = dossiers.filter(dossier => dossier.enriched).length;
  const datedEvents = events.filter(event => event.date !== null).length;
  const state = snapshot.sourceState?.status ?? 'not_connected';
  const sourceReadAt = explicitDate(snapshot.sourceState?.lastReadAt);
  const sourceAuditDate = options.sourceAuditDate && /^\d{4}-\d{2}-\d{2}$/.test(options.sourceAuditDate) ? explicitDate(options.sourceAuditDate) : null;
  const data: AnalyticsResponse = {
    schemaVersion: 'analytics-1',
    meta: { sourceReadAt, sourceAuditDate, stale: snapshot.sourceState?.stale !== false || pilots.some(response => response.meta.state === 'stale'),
      state, revision: '', sourceRevision: snapshot.version, readOnly: true, sourceMode: 'private_audit_snapshot', activityDateBasis: 'source_communication_date_utc' },
    totals: { clients: dossiers.length, enriched, unenriched: dossiers.length - enriched,
      documentedFields: sum('documented'), missingFields: sum('missing'), reviewFields: sum('review'),
      contradictions: sum('contradictions'), reviewDossiers: dossiers.filter(dossier => dossier.enriched && (dossier.counts.contradictions > 0 || dossier.counts.review > 0)).length,
      sources: sum('sources'), documents: sum('documents'), documentsRead: sum('documentsRead'),
      events: events.length, datedEvents, undatedEvents: events.length - datedEvents, humanValidated: 0 },
    dossiers, events, activity,
    coverage: statuses.map(status => ({ id: status, label: labels[status], count: statusCounts.get(status)!, dossierIds: [...statusDossiers.get(status)!] })),
    finance: { currency: 'EUR', contractsTotal: null, balancesTotal: null, series: [],
      reason: 'Les montants retrouvés sont des observations documentaires, avec des versions et des contradictions. Aucun grand livre de contrats, paiements ou soldes vérifiés ne permet de produire un total ou une évolution monétaire fiable.' },
    limitations: [
      `L’enrichissement porte sur ${enriched} dossiers sur ${dossiers.length}. Les dossiers non enrichis ne sont pas considérés comme exempts d’anomalies.`,
      'Les volumes mensuels représentent les événements sourcés retrouvés dans les fiches, à la date UTC de la communication. Ils ne mesurent ni le chiffre d’affaires ni la réalisation d’un chantier.',
      'Un événement documenté prouve la présence d’une information dans sa source, pas un encaissement comptable. Les événements à vérifier restent identifiés.',
      'Les noms des responsables ne sont repris que depuis un champ explicite documenté et sourcé. Aucun commercial n’est déduit du texte des échanges.',
      'Les données d’enrichissement proviennent d’un audit privé daté ; Gmail, Agenda et Drive ne sont pas synchronisés en continu.',
      'Les champs documentés n’ont pas encore reçu de validation humaine. Les informations contradictoires restent conservées dans les fiches.',
    ],
  };
  data.meta.revision = digest({ snapshot: snapshot.version, data });
  return data;
}

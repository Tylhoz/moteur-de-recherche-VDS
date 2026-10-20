import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataError, safeLink } from './model.js';
import type { PilotAgendaEvent, PilotBundle, PilotCounts, PilotDocument, PilotDossier, PilotField, PilotFieldStatus, PilotSource } from '../shared/pilot-contract.js';

type Obj = Record<string, any>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const list = (v: unknown): any[] => Array.isArray(v) ? v : [];
const string = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;
const fold = (v: string): string => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const slug = (v: string): string => fold(v).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sourceId = (v: unknown): string => {
  const id = string(v) ?? '';
  return /^[a-f0-9]{8,32}$/i.test(id) ? `gmail:${id}` : id;
};
const instant = (v: unknown): string | null => {
  if (!string(v)) return null;
  const time = Date.parse(v as string); return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const maxBytes = 8 * 1024 * 1024;
const inside = (root: string, file: string) => { const p = relative(root, file); return p === '' || (p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p)); };

export function safePilotLink(value: string): boolean {
  if (safeLink(value)) return true;
  // Calendar supplied this exact canonical event URL during the audit.
  // Keep the source URL rather than inventing a replacement link.
  try {
    const u = new URL(value);
    if (u.origin !== 'https://www.google.com' || u.pathname !== '/calendar/event' || u.username || u.password || u.hash) return false;
    const keys = [...u.searchParams.keys()];
    return keys.length === 1 && keys[0] === 'eid' && /^[A-Za-z0-9_=-]{1,1000}$/.test(u.searchParams.get('eid') ?? '');
  } catch { return false; }
}
function url(value: unknown): string | null {
  const text = string(value); if (!text) return null;
  if (!safePilotLink(text)) throw new DataError('unsafe_pilot_source_link');
  return text;
}
function text(value: unknown, label = ''): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DataError('invalid_pilot_number');
    if (/centimes$/.test(label)) return `${(value / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
    return value.toLocaleString('fr-FR', { maximumFractionDigits: 6 });
  }
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (typeof value === 'string') return string(value);
  if (Array.isArray(value)) return value.map(v => text(v, label)).filter(Boolean).join(' ; ');
  const pairs = Object.entries(object(value));
  return pairs.map(([key, v]) => `${key.replace(/_/g, ' ').replace(/centimes$/, 'EUR')} : ${text(v, key) ?? 'Information non retrouvée'}`).join(' · ');
}
function counts(fields: PilotField[], contradictions: number): PilotCounts {
  const out: PilotCounts = { documented: 0, review: 0, missing: 0, unverified: 0, excluded: 0, obsolete: 0, contradictions, humanValidated: 0 };
  for (const field of fields) out[field.status]++;
  return out;
}
function status(value: string | null, original: string | null, refs: PilotSource[]): PilotFieldStatus {
  const marker = fold(original ?? ''); const all = fold(`${original ?? ''} ${value ?? ''}`);
  if (/exclu|brouillon/.test(marker) || (refs.length > 0 && refs.every(r => r.status === 'excluded'))) return 'excluded';
  if (/contradic|a verifier/.test(marker)) return 'review';
  if (!value || /^information non retrouvee/.test(fold(value)) || /information manquante/.test(marker)) return 'missing';
  if (/obsolete|version anterieure/.test(marker)) return 'obsolete';
  if (/a verifier|a confirmer|non verifie|non confirme|probable|hypothese|envisagee|contradic|sans preuve|rapprochement.*contexte|action proposee/.test(all)) return 'review';
  if (!refs.length || !refs.some(r => r.status === 'read')) return 'unverified';
  return 'documented';
}
const sectionLabels: Record<string, string> = {
  identite: 'Identité', commercial: 'Commercial', technique: 'Technique', chantier: 'Chantier', finances: 'Finances',
  sav: 'SAV', communications: 'Communications', documents: 'Documents', agenda: 'Agenda',
};

/** Transform evidence observations only; never produces a human-approved canonical record. */
export function normalizePilotDossier(input: unknown): PilotDossier {
  const raw = object(input); const id = string(raw.legacy_id ?? raw.dossier_id);
  const name = string(raw.name ?? raw.nom);
  if (!id || !/^VDS-\d{3,6}$/.test(id) || !name || !raw.sections) throw new DataError('invalid_pilot_dossier');
  const sources = new Map<string, PilotSource>();
  for (const entry of list(raw.sources)) {
    const s = object(entry); const sid = sourceId(s.source_id ?? s.message_id ?? s.id);
    if (!sid) throw new DataError('missing_pilot_source_id');
    const excluded = s.excluded_from_facts === true || list(s.labels).includes('DRAFT');
    sources.set(sid, { id: sid, label: string(s.subject) ?? 'Message source', kind: 'gmail',
      occurredAt: instant(s.date_utc ?? s.utc ?? s.date), dateOriginal: string(s.date_header ?? s.date),
      url: excluded ? null : url(s.display_url ?? s.source_url ?? s.gmail_url ?? s.url), status: excluded ? 'excluded' : 'read' });
  }
  const docs: PilotDocument[] = [];
  const rawDocs = [...list(raw.documents), ...list(raw.pieces_jointes_lues)];
  for (const item of rawDocs) {
    const d = object(item); const filename = string(d.filename);
    const sid = sourceId(d.message_id); const parent = sources.get(sid);
    if (!filename || !parent || parent.status === 'excluded' || d.excluded_from_dossier === true) continue;
    const did = `${sid}:${filename}`;
    if (docs.some(v => v.id === did)) continue;
    const contentRead = d.content_read === true || d.full_extraction_loaded === true || Boolean(d.extraction_path);
    const visuallyChecked = d.visually_checked === true || d.inspection === 'scanned_pages_visually_read' || d.visually_inspected === true;
    const link = url(d.source_url ?? parent.url);
    sources.set(did, { id: did, label: filename, kind: 'attachment', occurredAt: parent.occurredAt, dateOriginal: parent.dateOriginal, url: link, status: contentRead || visuallyChecked ? 'read' : 'identified' });
    docs.push({ id: did, filename, mimeType: string(d.mime_type) ?? (/\.pdf$/i.test(filename) ? 'application/pdf' : null), sourceIds: [did], url: link, contentRead, visuallyChecked,
      status: contentRead || visuallyChecked ? 'documented' : 'unverified', note: visuallyChecked ? 'Contenu inspecté visuellement ; authenticité de signature non expertisée.' : contentRead ? 'Texte extrait lu ; signature non expertisée.' : 'Pièce jointe repérée ; contenu non inspecté.' });
  }
  const refs = (values: unknown): string[] => [...new Set(list(values).map(sourceId).filter(Boolean))].map(sid => {
    if (sources.has(sid)) return sid;
    const parent = sources.get(sid.split(':').slice(0, 2).join(':'));
    if (parent && sid.split(':').length > 2) {
      sources.set(sid, { ...parent, id: sid, label: sid.split(':').slice(2).join(':'), kind: 'attachment', status: parent.status === 'excluded' ? 'excluded' : 'identified' });
    } else {
      sources.set(sid, { id: sid, label: 'Référence source à vérifier', url: null, kind: 'gmail', occurredAt: null, dateOriginal: null, status: 'identified' });
    }
    return sid;
  });
  const sections = Object.entries(object(raw.sections)).map(([sectionName, contents]) => {
    const sectionId = slug(sectionName);
    const entries: [string, any][] = Array.isArray(contents) ? contents.map((value, index) => [String(index), value]) : Object.entries(object(contents));
    const fields = entries.map(([key, item], index): PilotField => {
      const f = object(item); const tuple = Array.isArray(item);
      const label = String(tuple ? item[0] : f.champ ?? key);
      const value = text(tuple ? item[1] : f.valeur, label);
      const sourceIds = refs(tuple ? item.slice(2) : f.source_ids);
      const original = string(f.statut ?? f.etat);
      let state = status(value, original, sourceIds.map(s => sources.get(s)!));
      // This import contains correspondence and document observations, no linked
      // accounting transaction ledger. A confident email cannot settle a payment.
      if (sectionId === 'finances' && /paiement|encaissement|solde verifie|solde comptable/.test(fold(label)) && state === 'documented') state = 'review';
      return { id: `${sectionId}-${slug(label) || index}`, label: label.replace(/_/g, ' ').replace(/centimes$/, '(EUR)'), value,
        status: state, sourceIds, note: string(f.note), sourceStatus: original, humanValidated: false };
    });
    return { id: sectionId, label: sectionLabels[sectionId] ?? sectionName, fields };
  });
  const contradictions = list(raw.contradictions).map((entry, index) => {
    const c = object(entry);
    return { id: `${id}-contradiction-${index + 1}`, field: string(c.field ?? c.champ) ?? 'Divergence entre sources',
      existingValue: text(c.portal ?? c.portail ?? c.valeur_portail_ou_ancienne), observedValue: text(c.evidence ?? c.preuve_observee ?? c.information_source),
      sourceIds: refs(c.source_ids ?? c.sources), reason: string(c.raison), action: string(c.action ?? c.action_proposee), status: 'review' as const };
  });
  const timeline = list(raw.timeline ?? raw.chronologie).map((entry, index) => {
    const e = object(entry); const sourceIds = refs([e.source_message_id ?? e.source_id ?? e.message_id]);
    const sourceStatus = string(e.status ?? e.statut); const summary = string(e.summary ?? e.resume) ?? 'Information non retrouvée';
    return { id: `${id}-event-${index + 1}`, dateOriginal: string(e.date_original ?? e.date_source_originale ?? e.date_message_entete),
      dateUTC: instant(e.date_utc ?? e.date_source_utc ?? e.date_message_utc), eventDate: string(e.date_evenement), summary,
      category: string(e.nature), status: status(summary, sourceStatus, sourceIds.map(s => sources.get(s)!)), sourceStatus, sourceIds };
  }).filter(e => e.status !== 'excluded').sort((a, b) => (Date.parse(a.dateUTC ?? '') || 0) - (Date.parse(b.dateUTC ?? '') || 0));
  const agenda: PilotAgendaEvent[] = list(object(raw.agenda_audit).candidate_events).map(entry => {
    const e = object(entry); const sid = `agenda:${e.id}`; const link = url(e.display_url ?? e.url);
    sources.set(sid, { id: sid, label: string(e.summary) ?? 'Événement Agenda', url: link, kind: 'agenda', occurredAt: instant(e.start), dateOriginal: string(e.start), status: 'read' });
    return { id: String(e.id), title: string(e.summary) ?? 'Information non retrouvée', start: string(e.start), end: string(e.end), location: string(e.location), url: link,
      sourceIds: [sid], status: 'review', sourceStatus: string(e.status), issues: list(e.issues).filter(v => typeof v === 'string'), associationApproved: false, clientApprovalVerified: false, completionVerified: false };
  });
  const matching = object(raw.rapprochement); const description = string(raw.matching ?? matching.statut ?? matching.etat) ?? 'Rapprochement à vérifier';
  const keys = typeof raw.matching === 'string' ? raw.matching.split(';').map((v: string) => v.trim()).filter(Boolean) : list(matching.cles).filter(v => typeof v === 'string');
  const matchText = fold(description);
  const strong = /forte|e-mail et telephone|email et telephone/.test(matchText) || (/e-?mail exact/.test(matchText) && /telephone.*concordant/.test(matchText));
  const scope = string(raw.scope ?? raw.nature) ?? 'Fiche issue de l’audit documentaire ; propositions non appliquées en production.';
  const fields = sections.flatMap(s => s.fields);
  const limitations = [...new Set([
    'Les informations documentées confirment une lecture de source, pas une validation humaine du fait métier.',
    'Copie privée de l’audit du 20/10/2026 ; aucune synchronisation Google continue active dans ce fichier.',
    'Les paiements et soldes ne sont pas certifiés par cette fiche ; les courriels ne constituent pas une preuve comptable.',
    'Aucune fusion ni correction de dossier appliquée. Les références VDS historiques ne suffisent pas à rapprocher deux clients.',
    ...list(raw.limites).filter(v => typeof v === 'string').map(v => `Limite du sous-audit documentaire : ${v}`),
  ])];
  return { id, name, scope, summary: string(raw.resume) ?? scope, matching: { status: strong ? 'proposed_strong' : 'uncertain', description, keys, humanValidated: false },
    status: 'review', sections, sources: [...sources.values()], contradictions, nextActions: list(raw.next_actions ?? raw.prochaines_actions ?? raw.actions).filter(v => typeof v === 'string'),
    timeline, documents: docs, agenda, counts: counts(fields, contradictions.length), lastSourceReadAt: null, limitations, productionApplied: false };
}

export function normalizePilotBundle(input: unknown, options: { sourceAuditDate: string; generatedAt: string; sourceDigest: string }): PilotBundle {
  if (!Array.isArray(input) || !input.length || input.length > 500) throw new DataError('invalid_pilot_input');
  const dossiers = input.map(normalizePilotDossier).sort((a, b) => a.id.localeCompare(b.id));
  const totals = counts(dossiers.flatMap(d => d.sections.flatMap(s => s.fields)), dossiers.reduce((n, d) => n + d.contradictions.length, 0));
  return validatePilotBundle({ schemaVersion: 'pilot-1', sourceMode: 'private_audit_snapshot', ...options, dossiers, humanValidationRequired: true,
    counts: { ...totals, dossiers: dossiers.length, timelineEvents: dossiers.reduce((n, d) => n + d.timeline.length, 0), documents: dossiers.reduce((n, d) => n + d.documents.length, 0), agendaCandidates: dossiers.reduce((n, d) => n + d.agenda.length, 0) } });
}

function ensure(condition: unknown): asserts condition { if (!condition) throw new DataError('invalid_pilot_bundle'); }
const fieldStatuses = ['documented', 'review', 'missing', 'unverified', 'excluded', 'obsolete'];
export function validatePilotBundle(input: unknown): PilotBundle {
  const b = object(input);
  ensure(b.schemaVersion === 'pilot-1' && b.sourceMode === 'private_audit_snapshot' && b.humanValidationRequired === true);
  ensure(typeof b.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(b.sourceDigest));
  ensure(typeof b.sourceAuditDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.sourceAuditDate) && instant(b.generatedAt));
  ensure(Array.isArray(b.dossiers) && b.dossiers.length > 0 && b.dossiers.length <= 500);
  const ids = new Set<string>();
  const nullableText = (v: unknown) => v === null || typeof v === 'string';
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');
  for (const d of b.dossiers as PilotDossier[]) {
    ensure(d && /^VDS-\d{3,6}$/.test(d.id) && !ids.has(d.id) && typeof d.name === 'string' && d.name.length > 0); ids.add(d.id);
    ensure(d.status === 'review' && d.productionApplied === false && d.matching?.humanValidated === false && ['proposed_strong', 'uncertain'].includes(d.matching.status));
    ensure(typeof d.matching.description === 'string' && strings(d.matching.keys) && typeof d.scope === 'string' && typeof d.summary === 'string');
    ensure(strings(d.nextActions) && strings(d.limitations) && (d.lastSourceReadAt === null || instant(d.lastSourceReadAt)));
    ensure(Array.isArray(d.sources) && Array.isArray(d.sections) && Array.isArray(d.contradictions) && Array.isArray(d.timeline) && Array.isArray(d.documents) && Array.isArray(d.agenda));
    const sids = new Set<string>();
    for (const s of d.sources) {
      ensure(s && typeof s.id === 'string' && s.id.length > 0 && !sids.has(s.id)); sids.add(s.id);
      ensure(typeof s.label === 'string' && ['gmail', 'attachment', 'agenda'].includes(s.kind) && ['read', 'identified', 'excluded'].includes(s.status));
      ensure((s.occurredAt === null || instant(s.occurredAt)) && nullableText(s.dateOriginal));
      ensure(s.url === null || (typeof s.url === 'string' && safePilotLink(s.url)));
      ensure(s.status !== 'excluded' || s.url === null);
    }
    const refs = (v: unknown) => strings(v) && (v as string[]).every(s => sids.has(s));
    for (const section of d.sections) {
      ensure(typeof section.id === 'string' && typeof section.label === 'string' && Array.isArray(section.fields));
      for (const f of section.fields) ensure(typeof f.id === 'string' && typeof f.label === 'string' && nullableText(f.value) && nullableText(f.note) && nullableText(f.sourceStatus) && fieldStatuses.includes(f.status) && refs(f.sourceIds) && f.humanValidated === false);
    }
    for (const c of d.contradictions) ensure(typeof c.id === 'string' && typeof c.field === 'string' && nullableText(c.existingValue) && nullableText(c.observedValue) && nullableText(c.reason) && nullableText(c.action) && c.status === 'review' && refs(c.sourceIds));
    for (const e of d.timeline) ensure(typeof e.id === 'string' && typeof e.summary === 'string' && nullableText(e.dateOriginal) && (e.dateUTC === null || instant(e.dateUTC)) && nullableText(e.eventDate) && nullableText(e.category) && nullableText(e.sourceStatus) && fieldStatuses.includes(e.status) && e.status !== 'excluded' && refs(e.sourceIds));
    for (const doc of d.documents) ensure(typeof doc.id === 'string' && typeof doc.filename === 'string' && nullableText(doc.mimeType) && refs(doc.sourceIds) && (doc.url === null || safePilotLink(doc.url)) && typeof doc.contentRead === 'boolean' && typeof doc.visuallyChecked === 'boolean' && ['documented', 'unverified'].includes(doc.status) && typeof doc.note === 'string');
    for (const e of d.agenda) ensure(typeof e.id === 'string' && typeof e.title === 'string' && nullableText(e.start) && nullableText(e.end) && nullableText(e.location) && nullableText(e.sourceStatus) && refs(e.sourceIds) && (e.url === null || safePilotLink(e.url)) && e.status === 'review' && e.associationApproved === false && e.clientApprovalVerified === false && e.completionVerified === false && strings(e.issues));
    const expected = counts(d.sections.flatMap(s => s.fields), d.contradictions.length);
    ensure(JSON.stringify(d.counts) === JSON.stringify(expected));
  }
  const dossiers = b.dossiers as PilotDossier[];
  const totals = counts(dossiers.flatMap(d => d.sections.flatMap(s => s.fields)), dossiers.reduce((n, d) => n + d.contradictions.length, 0));
  const expectedCounts = { ...totals, dossiers: dossiers.length, timelineEvents: dossiers.reduce((n, d) => n + d.timeline.length, 0), documents: dossiers.reduce((n, d) => n + d.documents.length, 0), agendaCandidates: dossiers.reduce((n, d) => n + d.agenda.length, 0) };
  ensure(JSON.stringify(b.counts) === JSON.stringify(expectedCounts));
  // Reject local attachment locations, signed URLs and unknown payload attributes
  // carrying sensitive paths even if the enclosing response type is otherwise valid.
  const inspect = (v: unknown, key = '') => {
    if (typeof v === 'string') {
      ensure(v.length <= 40000 && !/(?:\/workspace\/|\/tmp\/|file:\/\/|sediment:\/\/)/.test(v));
      for (const match of v.matchAll(/https?:\/\/[^\s<>"']+/g)) ensure(safePilotLink(match[0].replace(/[),.;]+$/, '')));
    } else if (Array.isArray(v)) v.forEach(x => inspect(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { ensure(!/password|secret|token|extraction_path|file_id|attachment_id/i.test(k)); inspect(x, k); }
  };
  inspect(input);
  return input as PilotBundle;
}

/** Reads an explicitly configured private snapshot, never a frontend/public asset. */
export async function loadPrivatePilot(filename: string, privateRoot: string, forbiddenRoots: string[] = []): Promise<PilotBundle> {
  const root = await realpath(privateRoot); const file = await realpath(filename);
  if (file === root || !inside(root, file)) throw new DataError('pilot_file_outside_private_root');
  for (const denied of [repoRoot, ...forbiddenRoots]) {
    let actual: string; try { actual = await realpath(denied); } catch { actual = resolve(denied); }
    if (inside(actual, file)) throw new DataError('public_pilot_source_forbidden');
  }
  const rootStat = await stat(root);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) throw new DataError('pilot_private_root_permissions');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0) throw new DataError('pilot_file_permissions_or_size');
    const content = await handle.readFile('utf8');
    if (Buffer.byteLength(content) > maxBytes) throw new DataError('pilot_file_too_large');
    return validatePilotBundle(JSON.parse(content));
  } finally { await handle.close(); }
}
export function pilotDigest(bundle: PilotBundle): string { return createHash('sha256').update(JSON.stringify(bundle)).digest('hex'); }

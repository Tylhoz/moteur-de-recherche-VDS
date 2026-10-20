import CommercialRules from './CommercialRules';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownUp, ArrowRight, CalendarDays, Check, ChevronDown, CircleHelp, Clock3, CreditCard,
  ExternalLink, FileText, FolderOpen, History, Layers3, LoaderCircle,
  LockKeyhole, Mail, PenLine, RefreshCw, Search, ShieldCheck, SlidersHorizontal, UserRound, Wrench, X,
} from 'lucide-react';
import type {
  PilotAgendaEvent, PilotContradiction, PilotDossier, PilotField,
  PilotFieldStatus, PilotResponse, PilotSource, PilotTimelineEvent,
} from '../../shared/pilot-contract';
import { consolidateFields, consolidateTimeline, consolidateContradictions } from '../../shared/consolidation';
import { initials } from '../lib/format';
import './client-detail-360.css';

interface ClientDetail360Props { clientId: string; onClose: () => void; }
type Tab = 'overview' | 'commercial' | 'technique' | 'chantier' | 'finances' | 'communications' | 'agenda' | 'sav' | 'documents' | 'history' | 'actions' | 'sources';
type ReadProblem = 'authentication' | 'missing' | 'unavailable' | 'invalid';
const MISSING = 'Information non retrouvée';
const FullDetailsContext=createContext(false);
const tabs = [
  { id: 'overview', label: 'Vue générale', icon: UserRound },
  { id: 'commercial', label: 'Commercial', icon: FileText },
  { id: 'technique', label: 'Technique', icon: Layers3 },
  { id: 'chantier', label: 'Chantier', icon: Wrench },
  { id: 'finances', label: 'Finances', icon: CreditCard },
  { id: 'communications', label: 'Communications', icon: Mail },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays },
  { id: 'sav', label: 'SAV', icon: CircleHelp },
  { id: 'documents', label: 'Documents', icon: FolderOpen },
  { id: 'history', label: 'Historique global', icon: History },
  { id: 'actions', label: 'Actions et suivi', icon: Check },
  { id: 'sources', label: 'Sources', icon: Layers3 },
] as const;

const statusLabel: Record<PilotFieldStatus, string> = {
  documented: 'Source consultée', review: 'À vérifier', missing: MISSING,
  unverified: 'Non vérifié', excluded: 'Écarté du rapprochement', obsolete: 'Information obsolète',
};

/** Links are restricted even when an API accidentally returns an unsafe URL. */
function safeSourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const calendarAlias = url.hostname === 'www.google.com' && url.pathname === '/calendar/event' && !!url.searchParams.get('eid');
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      (!calendarAlias && !['mail.google.com', 'calendar.google.com', 'docs.google.com', 'drive.google.com'].includes(url.hostname) && !(/^[a-z0-9-]+\.vosfactures\.fr$/.test(url.hostname) && /^\/(?:invoices|clients)\/\d+$/.test(url.pathname) && !url.search))) return null;
    if ([...url.searchParams.keys()].some(key => /token|secret|password|signature|credential|api[_-]?key|resourcekey/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

function validCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function explicitInstant(value: string): Date | null {
  if (!validCalendarDay(value.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant : null;
}

function displayDate(value: string | null | undefined): string {
  if (!value) return MISSING;
  // Calendar dates printed on contracts have no time zone and must not shift.
  if (validCalendarDay(value)) {
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
  }
  const date = explicitInstant(value);
  if (!date) return 'Date non exploitable · voir la source';
  return `${new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
  }).format(date)} · Bangkok`;
}

function Badge({ status }: { status: PilotFieldStatus }) {
  return <span className={`vds360-badge ${status === 'documented' ? 'vds360-badge-reviewed' : status === 'review' ? 'vds360-badge-warning' : 'vds360-badge-muted'}`}>
    {status === 'documented' ? <Check size={11} /> : status === 'review' ? <AlertTriangle size={11} /> : null}
    {statusLabel[status]}
  </span>;
}

function SourceLinks({ ids, sources }: { ids: string[]; sources: Map<string, PilotSource> }) {
  const references = [...new Set(ids)].map(id => sources.get(id)).filter((source): source is PilotSource => !!source);
  if (!references.length) return null;
  return <div className="vds360-source-links">
    {references.map(source => {
      const href = safeSourceUrl(source.url);
      return href ? <a key={source.id} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="vds360-source-link" title={source.label}>
        {source.kind === 'agenda' ? <CalendarDays size={11} /> : source.kind === 'attachment' ? <FileText size={11} /> : <Mail size={11} />}
        <span>{source.label}</span><ExternalLink size={10} />
      </a> : <span key={source.id} className="vds360-source-unavailable">Source identifiée · lien indisponible</span>;
    })}
  </div>;
}

function Fields({ fields, sources, single = false, section = 'unknown' }: { fields: PilotField[]; sources: Map<string, PilotSource>; single?: boolean; section?: string }) {
  const globalComplete=useContext(FullDetailsContext);const [expanded,setComplete]=useState(false);const complete=globalComplete||expanded;
  const compact=consolidateFields(fields,section);
  const populated=compact.filter(f=>f.status!=='missing'&&f.value);
  const shown=complete?fields:populated.length?populated:compact.slice(0,1);
  if (!fields.length) return <Empty />;
  return <><button className="vds360-detail-toggle" type="button" aria-pressed={complete} disabled={globalComplete} onClick={()=>setComplete(v=>!v)}>{complete?'Vue condensée':'Afficher les détails complets'} · {fields.length} observations</button><dl className={`vds360-fields ${single ? 'is-single' : ''}`}>
    {shown.map(field => <div key={field.id} className="vds360-field">
      <dt>{field.label}</dt>
      <dd className={field.status === 'missing' || !field.value ? 'is-missing' : ''}>{field.value || MISSING}</dd>
      {field.status !== 'missing' && <dd className="vds360-field-status"><Badge status={field.status} /></dd>}
      {field.note && <dd className="vds360-source-unavailable">{field.note}</dd>}
      <dd><SourceLinks ids={field.sourceIds} sources={sources} /></dd>
    </div>)}
  </dl></>;
}

function Empty({ message = 'Aucune information complémentaire retrouvée dans les sources consultées.' }: { message?: string }) {
  return <div className="vds360-empty"><FolderOpen size={28} /><h3>{MISSING}</h3><p>{message}</p></div>;
}

function Contradictions({ items, sources }: { items: PilotContradiction[]; sources: Map<string, PilotSource> }) {
  const full=useContext(FullDetailsContext);const shown=full?items:consolidateContradictions(items);
  if (!items.length) return null;
  return <section className="vds360-alerts" aria-label="Contradictions à vérifier">
    <h3 className="vds360-alerts-heading"><AlertTriangle size={18} /> Points d’attention <span className="vds360-badge vds360-badge-warning">{shown.length}</span></h3>
    {shown.map(item => <article key={item.id} className="vds360-conflict">
      <div className="vds360-conflict-heading"><h4>{item.field}</h4><Badge status="review" /></div>
      <div className="vds360-comparison">
        <div><span className="vds360-comparison-label">INFORMATION EXISTANTE</span><p>{item.existingValue || MISSING}</p></div>
        <div><span className="vds360-comparison-label">INFORMATION RETROUVÉE</span><p>{item.observedValue || MISSING}</p><SourceLinks ids={item.sourceIds} sources={sources} /></div>
      </div>
      <div className="vds360-conflict-foot">{item.reason && <div>{item.reason}</div>}{item.action && <div>{item.action}</div>}Aucune modification appliquée. Une décision humaine est nécessaire.</div>
    </article>)}
  </section>;
}

export interface TimelineFilters {
  query: string;
  source: 'all' | PilotSource['kind'];
  category: string;
  status: 'all' | PilotFieldStatus;
  order: 'newest' | 'oldest';
}
export const DEFAULT_TIMELINE_FILTERS: TimelineFilters = { query: '', source: 'all', category: '', status: 'all', order: 'newest' };
const sourceKindLabel: Record<PilotSource['kind'], string> = { gmail: 'E-mail', attachment: 'Document', agenda: 'Agenda', sheets: 'Google Sheets', vosfactures: 'VosFactures' };
const normalizeSearch = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr-FR');

/** Explicit dates only: no date or time is inferred from an event's narrative. */
export function timelineDate(event: PilotTimelineEvent) {
  const instant = event.dateUTC ? explicitInstant(event.dateUTC) : null;
  if (instant && !Number.isNaN(instant.getTime())) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
    const part = (type: string) => parts.find(item => item.type === type)?.value;
    return {
      key: `${part('year')}-${part('month')}-${part('day')}`,
      dayLabel: new Intl.DateTimeFormat('fr-FR', { timeZone: 'Asia/Bangkok', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(instant),
      timeLabel: new Intl.DateTimeFormat('fr-FR', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }).format(instant),
      dateTime: event.dateUTC!, timestamp: instant.getTime(), dateOnly: false,
    };
  }
  if (event.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(event.eventDate)) {
    const date = new Date(`${event.eventDate}T12:00:00Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === event.eventDate) return {
      key: event.eventDate,
      dayLabel: new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date),
      timeLabel: 'Heure non retrouvée', dateTime: event.eventDate,
      timestamp: date.getTime(), dateOnly: true,
    };
  }
  return { key: 'undated', dayLabel: 'Date non retrouvée', timeLabel: 'Heure non retrouvée', dateTime: undefined, timestamp: null, dateOnly: true };
}

export function selectTimelineEvents(events: PilotTimelineEvent[], sources: Map<string, PilotSource>, filters: TimelineFilters) {
  const tokens = normalizeSearch(filters.query.trim()).split(/\s+/).filter(Boolean);
  return events.filter(event => {
    const references = event.sourceIds.map(id => sources.get(id)).filter((source): source is PilotSource => !!source);
    const haystack = normalizeSearch([event.summary, event.category || '', event.sourceStatus || '', statusLabel[event.status], ...references.map(source => source.label)].join(' '));
    return tokens.every(token => haystack.includes(token)) &&
      (filters.source === 'all' || references.some(source => source.kind === filters.source)) &&
      (!filters.category || event.category === filters.category) &&
      (filters.status === 'all' || event.status === filters.status);
  }).sort((a, b) => {
    const dateA = timelineDate(a), dateB = timelineDate(b);
    if (dateA.timestamp === null && dateB.timestamp === null) return a.id.localeCompare(b.id);
    if (dateA.timestamp === null) return 1;
    if (dateB.timestamp === null) return -1;
    const direction = filters.order === 'newest' ? -1 : 1;
    // Within one day, records without an hour remain after the timed records.
    if (dateA.key === dateB.key && dateA.dateOnly !== dateB.dateOnly) return dateA.dateOnly ? 1 : -1;
    return direction * (dateA.timestamp - dateB.timestamp) || a.id.localeCompare(b.id);
  });
}

export function groupTimelineDays(events: PilotTimelineEvent[]) {
  const groups = new Map<string, { key: string; label: string; events: PilotTimelineEvent[] }>();
  for (const event of events) {
    const date = timelineDate(event);
    const group = groups.get(date.key) || { key: date.key, label: date.dayLabel, events: [] };
    group.events.push(event); groups.set(date.key, group);
  }
  return [...groups.values()];
}

function eventAppearance(event: PilotTimelineEvent, sources: Map<string, PilotSource>) {
  // Icons decorate an existing category; they never create a business status.
  const category = normalizeSearch(event.category || '');
  if (event.sourceIds.some(id => sources.get(id)?.kind === 'agenda') || /rendez|visite|reunion|planifie/.test(category)) return { icon: CalendarDays, tone: 'gold' };
  if (/sav|technique|intervention|inspection|equipement/.test(category)) return { icon: Wrench, tone: 'aqua' };
  if (/facture|avoir|acompte|paiement/.test(category)) return { icon: CreditCard, tone: 'blue' };
  if (/signe|accord|acceptation/.test(category)) return { icon: PenLine, tone: 'gold' };
  if (event.sourceIds.some(id => sources.get(id)?.kind === 'attachment')) return { icon: FileText, tone: 'blue' };
  return { icon: Mail, tone: 'lavender' };
}

export function ActivityTimeline({ events, sources, limit, onShowAll, initialFilters = DEFAULT_TIMELINE_FILTERS }: {
  events: PilotTimelineEvent[]; sources: Map<string, PilotSource>; limit?: number;
  onShowAll?: () => void; initialFilters?: TimelineFilters;
}) {
  const [filters, setFilters] = useState<TimelineFilters>({ ...initialFilters });
  const [expandedId, setExpandedId] = useState<string | null>(() => selectTimelineEvents(events, sources, initialFilters)[0]?.id ?? null);
  const instanceId = useId();
  const filtered = useMemo(() => selectTimelineEvents(consolidateTimeline(events), sources, filters), [events, sources, filters]);
  const visible = limit ? filtered.slice(0, limit) : filtered;
  const groups = groupTimelineDays(visible);
  const categories = useMemo(() => [...new Set(events.map(event => event.category).filter((category): category is string => !!category))].sort((a, b) => a.localeCompare(b, 'fr')), [events]);
  const isFiltered = !!filters.query || filters.source !== 'all' || !!filters.category || filters.status !== 'all';
  return <section className="vds360-activity" aria-labelledby={`${instanceId}-title`}>
    <div className="vds360-activity-heading"><div><span className="vds360-kicker">ACTIVITY TIMELINE</span><h3 id={`${instanceId}-title`}>L’histoire du dossier</h3><p>Chaque échange, chaque décision, avec sa source.</p></div><span className="vds360-activity-total"><History size={14} />{events.length} événement{events.length > 1 ? 's' : ''}</span></div>
    <div className="vds360-timeline-toolbar">
      <label className="vds360-timeline-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Rechercher dans la chronologie</span><input type="search" value={filters.query} placeholder="Rechercher une activité…" onChange={event => setFilters(current => ({ ...current, query: event.target.value }))} autoComplete="off" />{filters.query && <button type="button" aria-label="Effacer la recherche chronologique" onClick={() => setFilters(current => ({ ...current, query: '' }))}><X size={13} /></button>}</label>
      <label className="vds360-timeline-sort"><ArrowDownUp size={14} aria-hidden="true" /><span className="sr-only">Ordre de la chronologie</span><select value={filters.order} onChange={event => setFilters(current => ({ ...current, order: event.target.value as TimelineFilters['order'] }))}><option value="newest">Plus récents</option><option value="oldest">Plus anciens</option></select></label>
    </div>
    <div className="vds360-timeline-filters"><SlidersHorizontal size={14} aria-hidden="true" />
      <label><span className="sr-only">Filtrer par type de source</span><select value={filters.source} onChange={event => setFilters(current => ({ ...current, source: event.target.value as TimelineFilters['source'] }))}><option value="all">Toutes les sources</option>{Object.entries(sourceKindLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span className="sr-only">Filtrer par catégorie explicite</span><select value={filters.category} onChange={event => setFilters(current => ({ ...current, category: event.target.value }))}><option value="">Toutes les activités</option>{categories.map(category => <option key={category} value={category}>{category}</option>)}</select></label>
      <label><span className="sr-only">Filtrer par statut de vérification</span><select value={filters.status} onChange={event => setFilters(current => ({ ...current, status: event.target.value as TimelineFilters['status'] }))}><option value="all">Tous les statuts</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {isFiltered && <button type="button" onClick={() => setFilters(current => ({ ...DEFAULT_TIMELINE_FILTERS, order: current.order }))}>Réinitialiser</button>}
    </div>
    <div className="vds360-timeline-count" role="status">{filtered.length} événement{filtered.length > 1 ? 's' : ''} {isFiltered ? 'correspondant aux filtres' : 'dans les sources consultées'}<span>Heures · Asia/Bangkok</span></div>
    {groups.length ? <div className="vds360-timeline-days">{groups.map(group => <section className="vds360-timeline-day" key={group.key} aria-label={group.label}>
      <h4 className="vds360-timeline-day-title"><span>{group.label}</span></h4>
      <ol className="vds360-timeline">{group.events.map(event => {
        const date = timelineDate(event), appearance = eventAppearance(event, sources);
        const expanded = expandedId === event.id;
        const referenceKinds = [...new Set(event.sourceIds.map(id => sources.get(id)?.kind).filter((kind): kind is PilotSource['kind'] => !!kind))];
        const detailsId = `${instanceId}-${encodeURIComponent(event.id)}-details`;
        return <li className={`vds360-timeline-item tone-${appearance.tone}`} key={event.id}>
          <time className="vds360-timeline-time" dateTime={date.dateTime} title={event.dateOriginal || undefined}>{date.timeLabel}{!date.dateOnly && <span>Bangkok</span>}</time>
          <span className="vds360-timeline-marker" aria-hidden="true"><appearance.icon size={16} /></span>
          <article className={`vds360-timeline-card ${expanded ? 'is-selected' : ''}`}>
            <button type="button" className="vds360-timeline-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedId(current => current === event.id ? null : event.id)}>
              <span className="vds360-timeline-copy"><span className="vds360-timeline-category">{event.category || referenceKinds.map(kind => sourceKindLabel[kind]).join(' · ') || 'Événement sourcé'}</span><strong>{event.summary}</strong><span className="vds360-timeline-inline-status"><Badge status={event.status} /><span>{event.sourceIds.length} référence{event.sourceIds.length > 1 ? 's' : ''}</span></span></span>
              <ChevronDown size={16} className="vds360-timeline-chevron" aria-hidden="true" />
            </button>
            <div id={detailsId} className="vds360-timeline-details" hidden={!expanded}>
              {event.sourceStatus && <p className="vds360-timeline-description">{event.sourceStatus}</p>}
              <dl className="vds360-timeline-metadata"><div><dt>Date de l’échange ou de l’événement</dt><dd>{displayDate(event.dateUTC || event.eventDate)}</dd></div>{event.eventDate && event.dateUTC && <div><dt>Date métier citée dans la source</dt><dd>{displayDate(event.eventDate)}</dd></div>}{event.dateOriginal && <div><dt>Horodatage d’origine</dt><dd>{event.dateOriginal}</dd></div>}</dl>
              <div className="vds360-timeline-evidence"><span>Retrouver la preuve</span><SourceLinks ids={event.sourceIds} sources={sources} />{!event.sourceIds.length && <p>{MISSING}</p>}</div>
            </div>
          </article>
        </li>;
      })}</ol>
    </section>)}</div> : <div className="vds360-timeline-empty"><Search size={26} /><h4>{isFiltered ? 'Aucune activité pour ces critères' : MISSING}</h4><p>{isFiltered ? 'Modifiez les filtres pour retrouver les autres événements du dossier.' : 'Aucun événement sourcé n’a été retrouvé pour cette chronologie.'}</p>{isFiltered && <button type="button" onClick={() => setFilters({ ...DEFAULT_TIMELINE_FILTERS })}>Afficher toute la chronologie</button>}</div>}
    {!!limit && filtered.length > limit && <button type="button" className="vds360-timeline-more" onClick={onShowAll}>Consulter l’historique complet <span>{visible.length} sur {filtered.length}</span><ArrowRight size={15} /></button>}
  </section>;
}

function ActivityContext({ dossier }: { dossier: PilotDossier }) {
  return <aside className="vds360-activity-context" aria-label="Contexte et prochaines actions">
    <section className="vds360-context-card vds360-context-actions"><span className="vds360-kicker">ET MAINTENANT</span><h3><Layers3 size={17} /> Prochaines actions</h3><p>Actions proposées, distinctes de l’historique réalisé. Aucune échéance ajoutée.</p>{dossier.nextActions.length ? <ol className="vds360-actions">{dossier.nextActions.map((action, index) => <li key={index}>{action}</li>)}</ol> : <p>{MISSING}</p>}</section>
    <section className="vds360-context-card"><span className="vds360-kicker">LES SOURCES DU DOSSIER</span><h3>Une lecture traçable</h3><dl className="vds360-context-counts"><div><dt>Événements retrouvés</dt><dd>{dossier.timeline.length}</dd></div><div><dt>Documents identifiés</dt><dd>{dossier.documents.length}</dd></div><div><dt>Contradictions à examiner</dt><dd>{dossier.contradictions.length}</dd></div></dl><p>Les événements conservent leur statut. Une source consultée ne vaut pas validation métier.</p></section>
  </aside>;
}

function AgendaEvent({ event, sources }: { event: PilotAgendaEvent; sources: Map<string, PilotSource> }) {
  const href = safeSourceUrl(event.url);
  return <article className="vds360-event">
    <Badge status="review" />
    <h4>{event.title}</h4>
    <div className="vds360-note is-warning"><AlertTriangle size={16} /><p>Correspondance proposée uniquement. Cet événement n’est pas rattaché définitivement au dossier. Ni l’accord client ni la réalisation du rendez-vous ne sont établis par sa seule présence dans l’Agenda.</p></div>
    <dl className="vds360-fields">
      <div className="vds360-field"><dt>Début</dt><dd>{displayDate(event.start)}</dd></div>
      <div className="vds360-field"><dt>Fin</dt><dd>{displayDate(event.end)}</dd></div>
      <div className="vds360-field"><dt>Lieu</dt><dd>{event.location || MISSING}</dd></div>
      <div className="vds360-field"><dt>Statut de la source</dt><dd>{event.sourceStatus || 'Non vérifié'}</dd></div>
    </dl>
    {event.issues.length > 0 && <ul>{event.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
    <SourceLinks ids={event.sourceIds} sources={sources} />
    {href && <a className="vds360-source-link" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><CalendarDays size={12} />Ouvrir l’événement source<ExternalLink size={11} /></a>}
  </article>;
}

function isPilotResponse(value: unknown, id: string): value is PilotResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<PilotResponse>;
  const data = response.data;
  const optionalText = (item: unknown) => item === null || typeof item === 'string';
  const strings = (item: unknown): item is string[] => Array.isArray(item) && item.every(entry => typeof entry === 'string');
  const hasStatus = (item: unknown) => typeof item === 'string' && Object.hasOwn(statusLabel, item);
  return !!data && data.id === id && typeof data.name === 'string' && typeof data.scope === 'string' && typeof data.summary === 'string' &&
    Array.isArray(data.sections) && data.sections.every(section => section && typeof section.id === 'string' && Array.isArray(section.fields) && section.fields.every(field =>
      field && typeof field.id === 'string' && typeof field.label === 'string' && optionalText(field.value) && optionalText(field.note) && hasStatus(field.status) && strings(field.sourceIds))) &&
    Array.isArray(data.sources) && data.sources.every(source => source && typeof source.id === 'string' && typeof source.label === 'string' && optionalText(source.url)) &&
    Array.isArray(data.contradictions) && data.contradictions.every(item => item && typeof item.id === 'string' && typeof item.field === 'string' && optionalText(item.existingValue) && optionalText(item.observedValue) && optionalText(item.reason) && optionalText(item.action) && strings(item.sourceIds)) &&
    Array.isArray(data.timeline) && data.timeline.every(event => event && typeof event.id === 'string' && typeof event.summary === 'string' && hasStatus(event.status) && optionalText(event.dateUTC) && optionalText(event.eventDate) && optionalText(event.dateOriginal) && optionalText(event.category) && optionalText(event.sourceStatus) && strings(event.sourceIds)) &&
    Array.isArray(data.documents) && data.documents.every(document => document && typeof document.id === 'string' && typeof document.filename === 'string' && typeof document.note === 'string' && typeof document.contentRead === 'boolean' && typeof document.visuallyChecked === 'boolean' && optionalText(document.url) && strings(document.sourceIds)) &&
    Array.isArray(data.agenda) && data.agenda.every(event => event && typeof event.id === 'string' && typeof event.title === 'string' && optionalText(event.start) && optionalText(event.end) && optionalText(event.location) && optionalText(event.url) && optionalText(event.sourceStatus) && strings(event.sourceIds) && strings(event.issues)) &&
    strings(data.nextActions) && strings(data.limitations) && !!data.matching && typeof data.matching.description === 'string' && !!data.counts &&
    [data.counts.documented, data.counts.missing].every(count => Number.isSafeInteger(count) && count >= 0) &&
    response.meta?.readOnly === true && typeof response.meta.lastReadAt === 'string' && optionalText(response.meta.lastSourceReadAt) && ['private_audit_snapshot', 'sheets_observations'].includes(response.meta.sourceMode);
}

export default function ClientDetail360({ clientId, onClose }: ClientDetail360Props) {
  const [response, setResponse] = useState<PilotResponse | null>(null);
  const [problem, setProblem] = useState<ReadProblem | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true, inFlight = false, authenticationLost = false;
    let controller: AbortController | null = null;
    let etag: string | null = null;
    let hasData = false;
    setResponse(null); setProblem(null); setLoading(true);
    async function read() {
      if (!active || inFlight || authenticationLost || document.visibilityState === 'hidden') return;
      inFlight = true;
      setLoading(true);
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 15000);
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (etag && hasData) headers['If-None-Match'] = etag;
        const result = await fetch(`/api/v1/pilot/${encodeURIComponent(clientId)}`, {
          credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
          cache: 'no-store', headers, signal: controller.signal,
        });
        if (!active || authenticationLost) return;
        if (result.status === 401 || result.status === 403) {
          authenticationLost = true; hasData = false; etag = null;
          setResponse(null); setProblem('authentication');
          window.dispatchEvent(new Event('vds:authentication-required'));
          return;
        }
        if (result.status === 304 && hasData) { setProblem(null); return; }
        if (result.status === 404) { setResponse(null); hasData = false; setProblem('missing'); return; }
        if (!result.ok) { setProblem('unavailable'); return; }
        if (!result.headers.get('content-type')?.includes('application/json')) { setProblem('unavailable'); return; }
        const next: unknown = await result.json();
        if (!active || authenticationLost) return;
        if (!isPilotResponse(next, clientId)) { setProblem('invalid'); return; }
        etag = result.headers.get('etag'); hasData = true;
        setResponse(next); setProblem(null);
      } catch {
        if (active && !authenticationLost) setProblem('unavailable');
      } finally {
        window.clearTimeout(timeout); inFlight = false;
        if (active) setLoading(false);
      }
    }
    const purge = () => {
      authenticationLost = true; hasData = false; etag = null;
      controller?.abort(); setResponse(null); setProblem('authentication'); setLoading(false);
    };
    const visible = () => { if (document.visibilityState === 'visible') void read(); };
    refreshRef.current = () => { void read(); };
    window.addEventListener('vds:authentication-required', purge);
    document.addEventListener('visibilitychange', visible);
    const interval = window.setInterval(() => { void read(); }, 60000);
    void read();
    return () => {
      active = false; controller?.abort(); window.clearInterval(interval);
      window.removeEventListener('vds:authentication-required', purge);
      document.removeEventListener('visibilitychange', visible);
      refreshRef.current = () => {};
    };
  }, [clientId]);

  return <PilotDetailView key={clientId} clientId={clientId} onClose={onClose} response={response?.data.id === clientId ? response : null} loading={loading} problem={problem} onRefresh={() => refreshRef.current()} />;
}

export interface PilotDetailViewProps extends ClientDetail360Props {
  response: PilotResponse | null;
  loading?: boolean;
  problem?: ReadProblem | null;
  onRefresh?: () => void;
  initialTab?: Tab;
  initialFullDetails?: boolean;
}

/** Presentation layer also exercised against the real private audit in SSR tests. */
export function PilotDetailView({ clientId, onClose, response, loading = false, problem = null, onRefresh = () => {}, initialTab = 'overview', initialFullDetails=false }: PilotDetailViewProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [fullDetails,setFullDetails]=useState(initialFullDetails);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const tabsId = useId();
  closeRef.current = onClose;

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(element => element.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKey);
      if (before?.isConnected) before.focus();
    };
  }, []);


  const dossier = problem === 'authentication' ? null : response?.data ?? null;
  const sources = useMemo(() => new Map(dossier?.sources.map(source => [source.id, source]) ?? []), [dossier]);
  const fields = (section: string) => dossier?.sections.find(item => item.id === section)?.fields ?? [];
  const sourceRead = response?.meta.lastSourceReadAt || dossier?.lastSourceReadAt;
  const stale = !!problem || response?.meta.state === 'stale' || response?.meta.state === 'error';
  const activeTab = tabs.find(item => item.id === tab)!;

  function content(data: PilotDossier) {
    if (tab === 'overview') return <>
      <div className="vds360-grid">
        <section className="vds360-card"><h3><UserRound size={17} /> Identité et coordonnées</h3><Fields section="identite" fields={fields('identite')} sources={sources} single /></section>
        <div>
          <section className="vds360-card"><h3><Clock3 size={17} /> Situation du dossier</h3><p>{data.summary || data.scope || MISSING}</p><div className="vds360-note is-warning"><ShieldCheck size={16} /><p>{data.matching.description}<br />{data.matching.status === 'uncertain' ? 'Correspondance incertaine · À vérifier.' : 'Rapprochement proposé · validation humaine en attente.'}</p></div></section>
        </div>
      </div>
      <div className="vds360-activity-workspace"><ActivityTimeline events={data.timeline} sources={sources} limit={5} onShowAll={() => setTab('history')} /><ActivityContext dossier={data} /></div>
      <Contradictions items={data.contradictions} sources={sources} />
      {!!data.limitations.length && <section className="vds360-card"><h3><CircleHelp size={17} /> Périmètre des vérifications</h3>{data.limitations.map((limit, index) => <p key={index}>{limit}</p>)}</section>}
    </>;
    if (tab === 'history') return <>
      <div className="vds360-note"><Clock3 size={16} /><p>Les heures des échanges sont affichées dans le fuseau Asia/Bangkok. Les dates contractuelles sans heure restent inchangées et distinctes des horodatages des messages.</p></div>
      <div className="vds360-activity-workspace"><ActivityTimeline events={data.timeline} sources={sources} /><ActivityContext dossier={data} /></div>
    </>;
    if (tab === 'documents') return <>
      <section className="vds360-card"><h3><FolderOpen size={17} /> Documents du dossier</h3><Fields section="documents" fields={fields('documents')} sources={sources} /></section>
      {data.documents.length > 0 && <div className="vds360-documents">{data.documents.map(document => {
        const href = safeSourceUrl(document.url);
        return <article key={document.id} className={`vds360-document ${document.contentRead ? 'is-read' : 'is-identified'}`}>
          <div className="vds360-document-visual"><div className="vds360-document-icon"><FileText size={25} /></div><span>{document.mimeType === 'application/pdf' ? 'PDF' : document.mimeType?.startsWith('image/') ? 'IMAGE' : 'DOCUMENT'}</span><span className="vds360-document-lock"><LockKeyhole size={13} /> Accès source protégé</span></div>
          <div className="vds360-document-body"><h4>{document.filename}</h4>
          <span className={`vds360-badge ${document.contentRead ? 'vds360-badge-reviewed' : 'vds360-badge-muted'}`}>{document.contentRead ? 'Contenu lu' : 'Identifié · contenu non vérifié'}</span>
          {document.visuallyChecked && <div className="vds360-field-status"><span className="vds360-badge vds360-badge-reviewed">Contrôle visuel réalisé</span></div>}
          <p>{document.note}</p><SourceLinks ids={document.sourceIds} sources={sources} />
          {href && <a className="vds360-document-open" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Ouvrir la source<ExternalLink size={13} /></a>}
          </div>
        </article>;
      })}</div>}
    </>;
    if (tab === 'agenda') return <>
      <section className="vds360-card"><h3><CalendarDays size={17} /> Dates et rendez-vous retrouvés</h3><Fields section="agenda" fields={fields('agenda')} sources={sources} /></section>
      {data.agenda.map(event => <AgendaEvent key={event.id} event={event} sources={sources} />)}
      {!data.agenda.length && <div className="vds360-note"><CalendarDays size={16} /><p>Aucun événement Agenda rattaché dans le périmètre consulté. Les dates présentes dans les e-mails restent consultables dans les onglets Chantier et Communications.</p></div>}
    </>;
    if (tab === 'communications') return <>
      <section className="vds360-card"><h3><Mail size={17} /> Échanges importants</h3><Fields section="communications" fields={fields('communications')} sources={sources} /></section>
      <ActivityTimeline events={data.timeline.filter(event => event.sourceIds.some(id => sources.get(id)?.kind === 'gmail' || event.category === 'gmail'))} sources={sources} />
    </>;
    return <>
      {tab === 'finances' && <div className="vds360-note is-warning"><ShieldCheck size={17} /><p>Les montants ci-dessous sont des observations documentaires. Une facture ou une déclaration par e-mail ne confirme pas un encaissement. La connexion API VosFactures n’est pas établie : <strong>Source non connectée</strong>.</p></div>}
      {tab === 'finances' && fields('commercial').some(field => /\bHT\b|\bTTC\b|\bTVA\b|montant|contrat|acompte/i.test(field.label)) && <section className="vds360-card"><h3><FileText size={17} /> Montants des documents commerciaux</h3><Fields fields={fields('commercial').filter(field => /\bHT\b|\bTTC\b|\bTVA\b|montant|contrat|acompte/i.test(field.label))} sources={sources} /></section>}
      <section className="vds360-card"><h3><activeTab.icon size={17} /> {activeTab.label}</h3><Fields section={tab} fields={fields(tab)} sources={sources} /></section>
      {tab === 'finances' && <CommercialRules id={data.id} />}
      {tab === 'finances' && <Contradictions items={data.contradictions} sources={sources} />}
    </>;
  }

  return <FullDetailsContext.Provider value={fullDetails}><div className="vds360-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} className="vds360-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="vds360-topline"><span className="vds360-eyebrow"><LockKeyhole size={13} /> VDS INTELLIGENCE 360° · LECTURE PRIVÉE</span><button type="button" ref={closeButton} className="vds360-close" aria-label="Fermer la fiche client" onClick={onClose}><X size={19} /></button></div>
      <header className="vds360-heading">
        <div className="vds360-avatar" aria-hidden="true">{dossier ? initials(dossier.name) : <UserRound size={24} />}</div>
        <div className="vds360-heading-main"><span className="vds360-reference">{clientId} · Fiche 360°</span><h2 id={titleId}>{dossier?.name || 'Dossier client'}</h2>{dossier && <><p>{dossier.scope}</p><div className="vds360-badges"><span className="vds360-badge vds360-badge-reviewed"><FileText size={11} /> {dossier.counts.documented} observations sourcées</span><span className="vds360-badge vds360-badge-warning"><AlertTriangle size={11} /> {dossier.contradictions.length} points à vérifier</span><span className="vds360-badge vds360-badge-muted">{dossier.counts.missing} informations non retrouvées</span></div></>}</div>
      </header>
      {dossier && response ? <>
        <div className={`vds360-sync ${stale ? 'is-stale' : ''}`} role="status">
          <div>{stale ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}<span>{stale ? 'Synchronisation indisponible · dernière version conservée' : 'Informations sourcées · vérifications détaillées dans chaque rubrique'}<small>Dernière lecture réussie du portail : {displayDate(response.meta.lastReadAt)}.</small><small>Dernière consultation des sources : {displayDate(sourceRead)}. {response.meta.continuous ? 'Synchronisation Sheets active · contrôle chaque minute, sous réserve des délais Google.' : response.meta.sourceMode === 'sheets_observations' ? 'Copie des sources · synchronisation continue en attente d’activation.' : 'Connexion continue aux sources : non activée.'}</small></span></div>
          <button type="button" className="vds360-refresh" onClick={onRefresh} disabled={loading}><RefreshCw size={13} className={loading ? 'vds360-spin' : ''} /><span>{loading ? 'Lecture…' : 'Actualiser'}</span></button>
        </div>
        <div className="vds360-layout">
          <nav className="vds360-tabs" role="tablist" aria-label="Sections de la fiche client">
            {tabs.map((item, index) => <button key={item.id} type="button" role="tab" id={`${tabsId}-${item.id}`} aria-controls={`${tabsId}-panel`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className={`vds360-tab ${tab === item.id ? 'is-active' : ''}`} onClick={() => setTab(item.id)} onKeyDown={event => {
              let next: number | null = null;
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
              if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
              if (event.key === 'Home') next = 0;
              if (event.key === 'End') next = tabs.length - 1;
              if (next !== null) { event.preventDefault(); setTab(tabs[next].id); document.getElementById(`${tabsId}-${tabs[next].id}`)?.focus(); }
            }}><item.icon size={16} />{item.label}</button>)}
          </nav>
          <div className="vds360-content" id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} tabIndex={0}>
            <div className="vds360-section-heading"><div><h3>{activeTab.label}</h3><p>Chaque information conserve sa source et son statut de vérification.</p></div></div>
<button type="button" className="vds360-detail-toggle" aria-pressed={fullDetails} onClick={()=>setFullDetails(v=>!v)}>{fullDetails?'Revenir à la vue condensée':'Afficher toutes les observations originales'}</button>
            {content(dossier)}
          </div>
        </div>
      </> : <div className="vds360-loading" role="status"><div>
        {loading ? <LoaderCircle size={35} className="vds360-spin" /> : problem === 'authentication' ? <LockKeyhole size={35} /> : <CircleHelp size={35} />}
        <h3>{loading ? 'Lecture du dossier…' : problem === 'authentication' ? 'Authentification requise' : problem === 'missing' ? MISSING : 'Source non connectée'}</h3>
        <p>{loading ? 'Les informations sont demandées à l’API privée.' : problem === 'authentication' ? 'Votre session a expiré ou ne permet pas l’accès à ce dossier. Les informations privées ont été retirées de l’écran.' : problem === 'missing' ? 'Ce dossier ne dispose pas encore d’une fiche enrichie accessible.' : 'Synchronisation indisponible. L’API privée n’a pas fourni de fiche valide. Aucune donnée de remplacement n’est affichée.'}</p>
        {!loading && problem !== 'authentication' && <button type="button" className="button button-secondary" onClick={onRefresh}><RefreshCw size={14} />Réessayer la lecture</button>}
      </div></div>}
      <footer className="vds360-footer"><span><LockKeyhole size={12} /> Sources conservées · aucune modification automatique</span><button type="button" onClick={onClose}>Fermer le dossier</button></footer>
    </div>
  </div></FullDetailsContext.Provider>;
}

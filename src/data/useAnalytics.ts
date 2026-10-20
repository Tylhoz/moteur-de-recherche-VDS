import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalyticsResponse } from '../../shared/analytics-contract';
import { AUTHENTICATION_REQUIRED_EVENT, PortalApiError } from './api-client';

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nullableDate = (v: unknown) => v === null || typeof v === 'string' && Number.isFinite(Date.parse(v));
const safeSource = (v: unknown) => {
  if (!object(v) || typeof v.id !== 'string' || typeof v.label !== 'string') return false;
  if (v.url === null) return true;
  if (typeof v.url !== 'string') return false;
  try {
    const url = new URL(v.url);
    const calendarAlias = url.hostname === 'www.google.com' && url.pathname === '/calendar/event' && !!url.searchParams.get('eid');
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (calendarAlias || ['mail.google.com', 'docs.google.com', 'drive.google.com', 'calendar.google.com'].includes(url.hostname)) &&
      ![...url.searchParams.keys()].some(key => /token|secret|password|signature|credential|api.?key|resourcekey/i.test(key));
  } catch { return false; }
};
const fieldStates = ['documented', 'review', 'missing', 'unverified', 'excluded', 'obsolete'];

/** Reject malformed/private-link responses before any chart or clickable source is rendered. */
export function validateAnalytics(value: unknown): AnalyticsResponse {
  const invalid = () => new PortalApiError('Les données d’analyse reçues ne sont pas exploitables.');
  if (!object(value) || value.schemaVersion !== 'analytics-1' || !object(value.meta) ||
      value.meta.readOnly !== true || !nullableDate(value.meta.sourceReadAt) ||
      !nullableDate(value.meta.sourceAuditDate) || typeof value.meta.stale !== 'boolean' ||
      typeof value.meta.sourceRevision !== 'string' || value.meta.sourceMode !== 'private_audit_snapshot' ||
      typeof value.meta.state !== 'string' || typeof value.meta.revision !== 'string' ||
      !object(value.totals) || !['clients','enriched','unenriched','documentedFields','missingFields','reviewFields','contradictions','reviewDossiers','sources','documents','documentsRead','events','datedEvents','undatedEvents','humanValidated'].every(key => count((value.totals as Record<string, unknown>)[key])) || value.totals.humanValidated !== 0 ||
      !Array.isArray(value.dossiers) || !Array.isArray(value.activity) || !Array.isArray(value.coverage) ||
      !Array.isArray(value.events) || !Array.isArray(value.limitations) || !value.limitations.every(v => typeof v === 'string') ||
      !object(value.finance) || value.finance.contractsTotal !== null || value.finance.balancesTotal !== null ||
      !Array.isArray(value.finance.series) || value.finance.series.length !== 0 || typeof value.finance.reason !== 'string') throw invalid();
  const ids = new Set<string>();
  for (const dossier of value.dossiers) {
    if (!object(dossier) || typeof dossier.id !== 'string' || !/^VDS-\d+$/.test(dossier.id) || ids.has(dossier.id) ||
        typeof dossier.name !== 'string' || !dossier.name.trim() || typeof dossier.enriched !== 'boolean' ||
        !object(dossier.counts) || !['fields','documented','missing','review','unverified','excluded','obsolete','contradictions','sources','documents','documentsRead','events'].every(key => count((dossier.counts as Record<string, unknown>)[key])) ||
        !Array.isArray(dossier.months) || !dossier.months.every(v => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)) ||
        !(dossier.owner === null || typeof dossier.owner === 'string') || !Array.isArray(dossier.ownerSources) ||
        !dossier.ownerSources.every(safeSource) || !Array.isArray(dossier.observations)) throw invalid();
    for (const observation of dossier.observations) {
      if (!object(observation) || typeof observation.id !== 'string' || typeof observation.label !== 'string' ||
          !(observation.value === null || typeof observation.value === 'string') || !fieldStates.includes(String(observation.status)) ||
          !['contract', 'invoice', 'payment', 'balance', 'due_date', 'financial'].includes(String(observation.category)) ||
          !Array.isArray(observation.sources) || !observation.sources.every(safeSource)) throw invalid();
    }
    ids.add(dossier.id);
  }
  for (const point of value.activity) {
    if (!object(point) || typeof point.month !== 'string' || !/^\d{4}-\d{2}$/.test(point.month) ||
        ![point.count, point.documented, point.review, point.other].every(count) || !Array.isArray(point.dossierIds) ||
        !point.dossierIds.every(id => typeof id === 'string' && ids.has(id))) throw invalid();
  }
  for (const point of value.coverage) {
    if (!object(point) || typeof point.id !== 'string' || typeof point.label !== 'string' || !count(point.count) ||
        !Array.isArray(point.dossierIds) || !point.dossierIds.every(id => typeof id === 'string' && ids.has(id))) throw invalid();
  }
  for (const event of value.events) {
    if (!object(event) || typeof event.id !== 'string' || typeof event.dossierId !== 'string' || !ids.has(event.dossierId) ||
        !nullableDate(event.date) || !(event.month === null || typeof event.month === 'string' && /^\d{4}-\d{2}$/.test(event.month)) ||
        typeof event.summary !== 'string' || !fieldStates.includes(String(event.status)) ||
        !Array.isArray(event.sources) || !event.sources.every(safeSource)) throw invalid();
  }
  return value as unknown as AnalyticsResponse;
}

/** One client per mounted page; no business data in localStorage or public files. */
export function createAnalyticsClient(fetcher: typeof fetch = fetch) {
  let cached: AnalyticsResponse | null = null;
  let etag: string | null = null;
  let pending: Promise<AnalyticsResponse> | null = null;
  let controller: AbortController | null = null;
  let generation = 0;
  const clear = () => { generation++; controller?.abort(); controller = null; cached = null; etag = null; pending = null; };
  function read(): Promise<AnalyticsResponse> {
    if (pending) return pending;
    const version = generation;
    const abort = new AbortController();
    controller = abort;
    const timer = setTimeout(() => abort.abort(), 20_000);
    const task = (async () => {
      let response: Response;
      try {
        response = await fetcher('/api/v1/analytics', {
          credentials: 'same-origin', method: 'GET', cache: 'no-store', redirect: 'error', signal: abort.signal,
          headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
        });
      } catch { throw new PortalApiError('Synchronisation indisponible. La dernière analyse reçue reste datée.'); }
      if (version !== generation) throw new PortalApiError('Lecture interrompue.');
      if (response.status === 401 || response.status === 403) {
        cached = null; etag = null;
        throw new PortalApiError('Votre session doit être renouvelée pour consulter les analyses.', response.status);
      }
      if (response.status === 304 && cached) {
        const sourceReadAt = response.headers.get('X-VDS-Last-Read-At');
        const stale = response.headers.get('X-VDS-Source-Stale');
        cached = { ...cached, meta: { ...cached.meta,
          ...(sourceReadAt && nullableDate(sourceReadAt) ? { sourceReadAt } : {}),
          ...(stale === 'true' || stale === 'false' ? { stale: stale === 'true' } : {}),
        } };
        return cached;
      }
      if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json'))
        throw new PortalApiError('Synchronisation indisponible. La source d’analyse privée ne répond pas.', response.status);
      let value: unknown;
      try { value = await response.json(); } catch { throw new PortalApiError('La réponse d’analyse est illisible.'); }
      if (version !== generation) throw new PortalApiError('Lecture interrompue.');
      cached = validateAnalytics(value);
      etag = response.headers.get('ETag');
      return cached;
    })();
    pending = task;
    void task.finally(() => { clearTimeout(timer); if (pending === task) { pending = null; controller = null; } }).catch(() => {});
    return task;
  }
  return { read, clear };
}

export function useAnalytics() {
  const client = useRef(createAnalyticsClient());
  const mounted = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const version = generation.current;
    setRefreshing(true);
    const task = (async () => {
      try {
        const result = await client.current.read();
        if (!mounted.current || version !== generation.current) return;
        setData(result); setError(null);
      } catch (cause) {
        if (!mounted.current || version !== generation.current) return;
        if (cause instanceof PortalApiError && cause.requiresAuthentication) {
          setData(null); window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));
        } else setData(previous => previous ? { ...previous, meta: { ...previous.meta, stale: true } } : null);
        setError(cause instanceof Error ? cause.message : 'Synchronisation indisponible.');
      } finally { if (mounted.current && version === generation.current) { setLoading(false); setRefreshing(false); } }
    })();
    inFlight.current = task;
    void task.finally(() => { if (inFlight.current === task) inFlight.current = null; });
    return task;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const revoked = () => {
      generation.current++; client.current.clear(); inFlight.current = null; setData(null);
      setLoading(false); setRefreshing(false); setError('Votre session doit être renouvelée pour consulter les analyses.');
    };
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener(AUTHENTICATION_REQUIRED_EVENT, revoked);
    document.addEventListener('visibilitychange', visible);
    void refresh();
    const interval = window.setInterval(visible, 30_000);
    return () => {
      mounted.current = false; generation.current++; client.current.clear(); inFlight.current = null;
      clearInterval(interval); window.removeEventListener(AUTHENTICATION_REQUIRED_EVENT, revoked);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  return { data, loading, refreshing, error, refresh };
}

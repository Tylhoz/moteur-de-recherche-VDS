import type { AnalyticsDossier } from '../../shared/analytics-contract';
import type { Snapshot } from '../types';

export interface AnalysisFilters { search: string; month: string; coverage: string; }
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Every chart and its detail table use the same intersection of source identities and filters. */
export function filterAnalysisDossiers(dossiers: AnalyticsDossier[], snapshot: Snapshot, filters: AnalysisFilters) {
  const current = new Map(snapshot.clients.map(client => [client.id, client.client]));
  const tokens = normalize(filters.search).split(/\s+/).filter(Boolean);
  return dossiers.filter(dossier => current.get(dossier.id) === dossier.name
    && tokens.every(token => normalize(`${dossier.id} ${dossier.name}`).includes(token))
    && (filters.month === 'all' || dossier.months.includes(filters.month))
    && (filters.coverage === 'all' || (filters.coverage === 'enriched' ? dossier.enriched
      : filters.coverage === 'pending' ? !dossier.enriched : dossier.counts.contradictions + dossier.counts.review > 0)));
}
export function selectAnalysisDossiers(scope: AnalyticsDossier[], selectedIds: string[] | null) {
  if (selectedIds === null) return scope;
  const ids = new Set(selectedIds);
  return scope.filter(dossier => ids.has(dossier.id));
}

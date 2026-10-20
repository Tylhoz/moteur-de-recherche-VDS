import type { ClientFilters, Section } from '../types';
import type { AnalyticsMetric } from '../../shared/analytics-contract';
import { DEFAULT_FILTERS } from './clients';

export const ANALYSIS_LABELS: Record<AnalyticsMetric, string> = {
  clients: 'Analyse des clients', contracts: 'Analyse des contrats', balances: 'Analyse des soldes',
  review: 'Analyse des vérifications', activity: 'Analyse de l’activité',
};
export interface Route {
  section: Section; filters: ClientFilters; selectedId: string | null; metric: AnalyticsMetric;
}
const sections: Section[] = ['dashboard', 'analysis', 'validation', 'clients', 'devis', 'ventes', 'chantiers', 'factures', 'sav'];
export function readRoute(hash = location.hash): Route {
  const [part, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const status = params.get('status') || '';
  const sort = params.get('sort') || '';
  const metric = params.get('metric') || '';
  return {
    section: sections.includes(part as Section) ? part as Section : 'dashboard',
    metric: Object.hasOwn(ANALYSIS_LABELS, metric) ? metric as AnalyticsMetric : 'clients',
    selectedId: /^VDS-\d{3}$/.test(params.get('client') || '') ? params.get('client') : null,
    filters: { ...DEFAULT_FILTERS, search: params.get('q') || '',
      status: ['all', 'alerte', 'solde', 'sav', 'valide', 'non_verifie', 'followup'].includes(status) ? status as ClientFilters['status'] : 'all',
      team: params.get('team') || 'all', model: params.get('model') || 'all',
      sort: ['id_asc', 'mixed', 'solde_desc', 'ht_desc', 'name_asc'].includes(sort) ? sort as ClientFilters['sort'] : 'mixed',
    },
  };
}
export function routeUrl(route: Route): string {
  const params = new URLSearchParams();
  if (route.section === 'analysis') params.set('metric', route.metric);
  if (route.filters.search) params.set('q', route.filters.search);
  if (route.filters.status !== 'all') params.set('status', route.filters.status);
  if (route.filters.team !== 'all') params.set('team', route.filters.team);
  if (route.filters.model !== 'all') params.set('model', route.filters.model);
  if (route.filters.sort !== 'mixed') params.set('sort', route.filters.sort);
  if (route.selectedId) params.set('client', route.selectedId);
  return `#${route.section}${params.size ? '?' + params.toString() : ''}`;
}

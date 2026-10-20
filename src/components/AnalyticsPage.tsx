import BusinessAnalytics from './BusinessAnalytics';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, BarChart3, CalendarDays,
  Check, ChevronLeft, ChevronRight, CircleAlert, FileCheck2, FileText, Filter, Info,
  Layers3, RefreshCw, Search, ShieldCheck, Users, Wallet, X } from 'lucide-react';
import type { AnalyticsDossier, AnalyticsEvent, AnalyticsMetric, AnalyticsObservation, AnalyticsResponse } from '../../shared/analytics-contract';
import type { Snapshot } from '../types';
import { useAnalytics } from '../data/useAnalytics';
import { initials } from '../lib/format';
import { filterAnalysisDossiers, selectAnalysisDossiers } from '../lib/analytics';
import './analytics.css';

export interface AnalyticsPageProps {
  metric: AnalyticsMetric;
  snapshot: Snapshot;
  onSelectClient: (id: string) => void;
  onNavigateMetric: (metric: AnalyticsMetric) => void;
  onBack: () => void;
}
const metrics = {
  clients: { label: 'Clients & dossiers', title: 'Vos dossiers, en perspective.', subtitle: 'Une lecture claire de la couverture de vos dossiers et des informations réellement retrouvées.', icon: Users, tone: 'blue' },
  contracts: { label: 'Contrats HT', title: 'Analyse des contrats.', subtitle: 'Explorez les montants mentionnés dans les sources, leur documentation et les vérifications nécessaires.', icon: FileText, tone: 'violet' },
  balances: { label: 'Soldes à encaisser', title: 'Analyse des soldes.', subtitle: 'Rapprochez factures, échéances et preuves disponibles avant toute conclusion sur un encaissement.', icon: Wallet, tone: 'aqua' },
  review: { label: 'Dossiers à vérifier', title: 'L’attention, au bon endroit.', subtitle: 'Identifiez les dossiers qui demandent une vérification, puis retrouvez le contexte et les sources.', icon: ShieldCheck, tone: 'gold' },
  activity: { label: 'Activité documentée', title: 'L’histoire de vos dossiers.', subtitle: 'Parcourez les événements retrouvés dans les sources et les périodes où les échanges se concentrent.', icon: Activity, tone: 'blue' },
} as const;
const colors = ['#7dacee', '#6fc9b5', '#b1a0e8', '#dfbc6d', '#db9592', '#a6b0bc'];
const fieldLabels = { documented: 'Documentées', review: 'À vérifier', missing: 'Manquantes', unverified: 'Non vérifiées', excluded: 'Exclues', obsolete: 'Obsolètes' };
const number = (n: number) => n.toLocaleString('fr-FR');
const monthLabel = (month: string, short = false) => new Intl.DateTimeFormat('fr-FR', {
  month: short ? 'short' : 'long', year: short ? '2-digit' : 'numeric', timeZone: 'UTC',
}).format(new Date(`${month}-01T12:00:00Z`));
const dateLabel = (date: string | null) => date ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date)) : 'Date non retrouvée';
interface Point { id: string; label: string; count: number; dossierIds: string[]; color?: string; }
interface Selection { label: string; ids: string[]; }
interface ChartProps { points: Point[]; onSelect: (point: Point) => void; selected: string | null; }
const keysActivate = (event: React.KeyboardEvent<SVGElement>, select: () => void) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); }
};

function ChartCard({ title, caption, badge, children, footer, className = '' }: {
  title: string; caption: string; badge?: string; children: ReactNode; footer?: ReactNode; className?: string;
}) {
  return <section className={`analysis-chart-card ${className}`}>
    <header><div><h2>{title}</h2><p>{caption}</p></div>{badge && <span className="analysis-card-badge">{badge}</span>}</header>
    <div className="analysis-chart-body">{children}</div>
    {footer && <div className="analysis-chart-foot">{footer}</div>}
  </section>;
}
function EmptyChart({ title, children }: { title: string; children: ReactNode }) {
  return <div className="analysis-empty-chart"><span><BarChart3 size={26} /></span><h3>{title}</h3><p>{children}</p></div>;
}
export function DonutChart({ points, onSelect, selected, unit = 'dossiers' }: ChartProps & { unit?: string }) {
  const total = points.reduce((sum, p) => sum + p.count, 0);
  let offset = 0;
  return total ? <div className="analysis-donut-layout"><div className="analysis-donut-wrap">
    <svg viewBox="0 0 220 220" aria-label={`Répartition de ${number(total)} ${unit}`} className="analysis-donut">
      <circle cx="110" cy="110" r="82" fill="none" stroke="#edf0f2" strokeWidth="28" />
      {points.filter(p => p.count > 0).map((point, index) => {
        const percent = point.count / total * 100, start = offset; offset += percent;
        return <circle key={point.id} cx="110" cy="110" r="82" fill="none" stroke={point.color ?? colors[index % colors.length]}
          strokeWidth={selected === point.label ? 34 : 28} pathLength="100" strokeDasharray={`${percent} ${100 - percent}`}
          strokeDashoffset={-start} transform="rotate(-90 110 110)" role="button" tabIndex={0}
          aria-label={`${point.label} : ${number(point.count)} ${unit}. Afficher les dossiers concernés.`}
          aria-pressed={selected === point.label} onClick={() => onSelect(point)}
          onKeyDown={event => keysActivate(event, () => onSelect(point))} className="analysis-svg-action"><title>{`${point.label} · ${number(point.count)} ${unit}`}</title></circle>;
      })}
      <text x="110" y="108" textAnchor="middle" className="analysis-donut-value">{number(total)}</text>
      <text x="110" y="130" textAnchor="middle" className="analysis-donut-unit">{unit}</text>
    </svg>
  </div><div className="analysis-legend">{points.map((point, index) => <button key={point.id} type="button" onClick={() => onSelect(point)}
    aria-pressed={selected === point.label} disabled={!point.count}>
    <i style={{ background: point.color ?? colors[index % colors.length] }} /><span>{point.label}</span><strong>{number(point.count)}</strong>
  </button>)}</div></div> : <EmptyChart title="Aucune information dans ce périmètre">Modifiez les filtres pour retrouver les dossiers disponibles.</EmptyChart>;
}
export function BarChart({ points, onSelect, selected }: ChartProps) {
  const max = Math.max(...points.map(p => p.count), 1);
  return points.some(p => p.count) ? <div className="analysis-bars">{points.map((point, index) => <button type="button" key={point.id}
    onClick={() => onSelect(point)} aria-pressed={selected === point.label} disabled={!point.count}
    aria-label={`${point.label} : ${number(point.count)}. Afficher les dossiers concernés.`}>
    <span className="analysis-bar-label">{point.label}</span><span className="analysis-bar-track"><span style={{ width: `${point.count / max * 100}%`, background: point.color ?? colors[index % colors.length] }} /></span>
    <strong>{number(point.count)}</strong>
  </button>)}</div> : <EmptyChart title="Données insuffisantes">Aucune valeur documentée ne permet de construire cette répartition.</EmptyChart>;
}
function ActivityChart({ points, onSelect, selected }: ChartProps) {
  const gradient = `analysis-fill-${useId().replace(/:/g, '')}`;
  if (!points.length) return <EmptyChart title="Pas de date exploitable">Les événements sans date source restent accessibles dans les fiches.</EmptyChart>;
  const width = Math.max(540, points.length * 52), top = 20, bottom = 180, left = 32, right = width - 26;
  const max = Math.max(...points.map(point => point.count), 1);
  const xy = points.map((point, i) => ({ x: points.length === 1 ? width / 2 : left + i * (right - left) / (points.length - 1), y: bottom - point.count / max * (bottom - top) }));
  const path = xy.map(({ x, y }, i) => `${i ? 'L' : 'M'} ${x},${y}`).join(' ');
  return <div className="analysis-line-scroll" tabIndex={0} aria-label="Courbe des activités. Défilement horizontal si nécessaire.">
    <svg viewBox={`0 0 ${width} 225`} style={{ minWidth: width }} aria-label="Événements par mois de communication source">
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#77b8d5" stopOpacity=".34" /><stop offset="100%" stopColor="#77b8d5" stopOpacity=".02" /></linearGradient></defs>
      {[0, .5, 1].map(ratio => <g key={ratio}><line x1={left} x2={right} y1={bottom - ratio * (bottom - top)} y2={bottom - ratio * (bottom - top)} stroke="#e7ecef" strokeDasharray="4 5" /><text x="4" y={bottom - ratio * (bottom - top) + 4} className="analysis-axis">{Math.round(max * ratio)}</text></g>)}
      <path d={`${path} L ${xy[xy.length - 1].x},${bottom} L ${xy[0].x},${bottom} Z`} fill={`url(#${gradient})`} />
      <path d={path} stroke="#5795d6" strokeWidth="3" strokeLinejoin="round" fill="none" />
      {points.map((point, i) => <g key={point.id} role="button" tabIndex={0} className="analysis-svg-action" aria-pressed={selected === point.label}
        aria-label={`${point.label} : ${number(point.count)} événements. Afficher les dossiers concernés.`}
        onClick={() => onSelect(point)} onKeyDown={event => keysActivate(event, () => onSelect(point))}>
        <title>{`${point.label} · ${number(point.count)} événements`}</title>
        <circle cx={xy[i].x} cy={xy[i].y} r="22" fill="transparent" />
        <circle cx={xy[i].x} cy={xy[i].y} r={selected === point.label ? 7 : 5} fill={selected === point.label ? '#b28c42' : '#5795d6'} stroke="white" strokeWidth="2" />
        <text x={xy[i].x} y={xy[i].y - 11} textAnchor="middle" className="analysis-point-value">{point.count}</text>
        <text x={xy[i].x} y="211" textAnchor="middle" className="analysis-axis">{monthLabel(point.id, true)}</text>
      </g>)}
    </svg>
  </div>;
}
function SourceObservations({ observations }: { observations: AnalyticsObservation[] }) {
  if (!observations.length) return <span className="analysis-muted">Information non retrouvée dans les sources enrichies.</span>;
  return <details className="analysis-observations"><summary>{number(observations.length)} information{observations.length > 1 ? 's' : ''} source{observations.length > 1 ? 's' : ''}<ChevronRight size={14} /></summary>
    <div>{observations.map(observation => <article key={observation.id}>
      <header><strong>{observation.label}</strong><span className={`analysis-status ${observation.status}`}>{fieldLabels[observation.status]}</span></header>
      <p>{observation.value || 'Information non retrouvée'}</p>
      {observation.note && <small>{observation.note}</small>}
      <div className="analysis-source-links">{observation.sources.map(source => source.url ? <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer">{source.label}<ArrowUpRight size={12} /></a> : <span key={source.id}>{source.label} · lien non disponible</span>)}</div>
    </article>)}</div>
  </details>;
}
const financialObservations = (dossier: AnalyticsDossier, metric: AnalyticsMetric) => dossier.observations.filter(observation =>
  metric === 'contracts' ? observation.category === 'contract' : ['invoice', 'payment', 'balance', 'due_date'].includes(observation.category));
const readable = (observation: AnalyticsObservation) => !!observation.value && !['missing', 'excluded', 'obsolete'].includes(observation.status);
const sum = (dossiers: AnalyticsDossier[], key: keyof AnalyticsDossier['counts']) => dossiers.reduce((total, dossier) => total + dossier.counts[key], 0);

export function AnalyticsView({ metric, snapshot, onSelectClient, onNavigateMetric, onBack, data, error, refreshing = false, onRefresh }: AnalyticsPageProps & {
  data: AnalyticsResponse; error?: string | null; refreshing?: boolean; onRefresh: () => void;
}) {
  const [search, setSearch] = useState('');
  const [month, setMonth] = useState('all');
  const [coverage, setCoverage] = useState('all');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [page, setPage] = useState(0);
  const detailRef = useRef<HTMLElement>(null);
  const info = metrics[metric];
  const financial = metric === 'contracts' || metric === 'balances';
  const scope = useMemo(() => filterAnalysisDossiers(data.dossiers, snapshot, { search, month, coverage }), [data.dossiers, snapshot, search, month, coverage]);
  const rows = selectAnalysisDossiers(scope, selection?.ids ?? null);
  const scopeIds = new Set(scope.map(dossier => dossier.id));
  const events = data.events.filter(event => scopeIds.has(event.dossierId) && (month === 'all' || event.month === month));
  const eventMonths = [...new Set(data.events.flatMap(event => event.month ? [event.month] : []))].sort().reverse();
  const activity: Point[] = [...new Set(events.flatMap(event => event.month ? [event.month] : []))].sort().map(month => {
    const matching = events.filter(event => event.month === month);
    return { id: month, label: monthLabel(month), count: matching.length, dossierIds: [...new Set(matching.map(event => event.dossierId))] };
  });
  const fieldPoints: Point[] = (Object.keys(fieldLabels) as Array<keyof typeof fieldLabels>).map((id, index) => ({
    id, label: fieldLabels[id], count: sum(scope, id), dossierIds: scope.filter(dossier => dossier.counts[id] > 0).map(d => d.id), color: colors[index],
  }));
  const enriched = scope.filter(d => d.enriched);
  const evidence = scope.map(dossier => {
    const observations = financialObservations(dossier, metric).filter(readable);
    return { dossier, state: observations.some(o => o.status === 'documented' && o.sources.length > 0) ? 'documented' : observations.length ? 'review' : 'missing' };
  });
  const evidencePoints: Point[] = [
    { id: 'documented', label: 'Information sourcée', color: colors[1] },
    { id: 'review', label: 'Information à vérifier', color: colors[3] },
    { id: 'missing', label: 'Information non retrouvée', color: '#c4cdd6' },
  ].map(point => ({ ...point, count: evidence.filter(e => e.state === point.id).length, dossierIds: evidence.filter(e => e.state === point.id).map(e => e.dossier.id) }));
  const coveragePoints: Point[] = [
    { id: 'enriched', label: 'Fiches enrichies', count: enriched.length, dossierIds: enriched.map(d => d.id), color: colors[1] },
    { id: 'pending', label: 'Enrichissement à compléter', count: scope.length - enriched.length, dossierIds: scope.filter(d => !d.enriched).map(d => d.id), color: '#b5cbe8' },
  ];
  const financialLabels = { contract: 'Contrats', invoice: 'Factures', payment: 'Paiements mentionnés', balance: 'Soldes mentionnés', due_date: 'Échéances', financial: 'Autres informations' };
  const financialPoints: Point[] = (Object.keys(financialLabels) as Array<keyof typeof financialLabels>)
    .filter(category => metric === 'contracts' ? ['contract', 'invoice', 'due_date'].includes(category) : ['invoice', 'payment', 'balance', 'due_date'].includes(category))
    .map((category, index) => ({ id: category, label: financialLabels[category], count: scope.reduce((n, d) => n + d.observations.filter(o => o.category === category && readable(o)).length, 0), dossierIds: scope.filter(d => d.observations.some(o => o.category === category && readable(o))).map(d => d.id), color: colors[index] }));
  const documentPoints: Point[] = [
    { id: 'read', label: 'Lus ou inspectés', count: sum(scope, 'documentsRead'), dossierIds: scope.filter(d => d.counts.documentsRead > 0).map(d => d.id), color: colors[1] },
    { id: 'identified', label: 'Identifiés, à examiner', count: sum(scope, 'documents') - sum(scope, 'documentsRead'), dossierIds: scope.filter(d => d.counts.documents > d.counts.documentsRead).map(d => d.id), color: colors[3] },
  ];
  const reviewPoints: Point[] = scope.filter(d => d.counts.contradictions > 0).sort((a, b) => b.counts.contradictions - a.counts.contradictions).map((d, index) => ({ id: d.id, label: `${d.id} · ${d.name}`, count: d.counts.contradictions, dossierIds: [d.id], color: colors[index % colors.length] }));
  const activityPoints: Point[] = [
    { id: 'documented', label: 'Événements documentés', color: colors[0] },
    { id: 'review', label: 'Événements à vérifier', color: colors[3] },
    { id: 'other', label: 'Autres statuts', color: colors[2] },
  ].map(point => {
    const matching = events.filter(event => point.id === 'other' ? !['documented', 'review'].includes(event.status) : event.status === point.id);
    return { ...point, count: matching.length, dossierIds: [...new Set(matching.map(e => e.dossierId))] };
  });
  useEffect(() => { setSelection(null); setPage(0); }, [metric, search, month, coverage]);
  useEffect(() => { setPage(0); }, [selection]);
  useEffect(() => { setSelection(null); setPage(0); }, [data.meta.revision]);
  const select = (point: Point) => {
    setSelection({ label: point.label, ids: point.dossierIds }); setPage(0);
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
  };
  const reset = () => { setSearch(''); setMonth('all'); setCoverage('all'); setSelection(null); setPage(0); };
  const stats = metric === 'clients' ? [
    { label: 'Dossiers dans le périmètre', value: number(scope.length), foot: 'Identifiants issus de la source', icon: Users, tone: 'blue' },
    { label: 'Fiches enrichies', value: number(enriched.length), foot: 'Rapprochements à valider', icon: Layers3, tone: 'aqua' },
    { label: 'Informations documentées', value: number(sum(scope, 'documented')), foot: 'Une source retrouvée', icon: FileCheck2, tone: 'violet' },
    { label: 'Informations manquantes', value: number(sum(scope, 'missing')), foot: 'Dans les fiches enrichies', icon: CircleAlert, tone: 'gold' },
  ] : financial ? [
    { label: metric === 'contracts' ? 'Total des contrats HT' : 'Solde total à encaisser', value: 'Non vérifié', foot: 'Aucune somme certifiée disponible', icon: Wallet, tone: 'blue' },
    { label: 'Dossiers avec information sourcée', value: number(evidencePoints[0].count), foot: 'Une mention ne vaut pas validation', icon: FileCheck2, tone: 'aqua' },
    { label: 'Documents lus ou inspectés', value: number(sum(scope, 'documentsRead')), foot: 'Tous types, périmètre sélectionné', icon: FileText, tone: 'violet' },
    { label: 'Contradictions à contrôler', value: number(sum(scope, 'contradictions')), foot: 'Tous champs, aucune correction auto.', icon: CircleAlert, tone: 'gold' },
  ] : metric === 'review' ? [
    { label: 'Dossiers à vérifier', value: number(scope.filter(d => d.counts.review + d.counts.contradictions > 0).length), foot: 'Avec champ ou contradiction signalé', icon: ShieldCheck, tone: 'gold' },
    { label: 'Contradictions', value: number(sum(scope, 'contradictions')), foot: 'Écarts conservés avec leurs sources', icon: CircleAlert, tone: 'violet' },
    { label: 'Informations à vérifier', value: number(sum(scope, 'review')), foot: 'Champs issus des fiches enrichies', icon: FileCheck2, tone: 'blue' },
    { label: 'Validations humaines', value: number(data.totals.humanValidated), foot: 'Aucune validation automatique', icon: Check, tone: 'aqua' },
  ] : [
    { label: 'Événements retrouvés', value: number(events.length), foot: 'Historique des sources consultées', icon: Activity, tone: 'blue' },
    { label: 'Avec date de communication', value: number(events.filter(e => e.date).length), foot: 'Date source en UTC', icon: CalendarDays, tone: 'aqua' },
    { label: 'Sans date source exploitable', value: number(events.filter(e => !e.date).length), foot: 'Conservés, exclus de la courbe', icon: CircleAlert, tone: 'gold' },
    { label: 'Dossiers concernés', value: number(new Set(events.map(e => e.dossierId)).size), foot: 'Rapprochements proposés, à valider', icon: Users, tone: 'violet' },
  ];
  const pages = Math.max(1, Math.ceil(rows.length / 15));
  const safePage = Math.min(page, pages - 1);
  const visible = rows.slice(safePage * 15, safePage * 15 + 15);
  const selectedLabel = selection?.label ?? null;
  const sourceReadAt = data.meta.sourceReadAt;

  if (data.meta.sourceRevision !== snapshot.version) return <section className="analysis-page analysis-loading" role="status">
    <ShieldCheck size={32} /><h1>Les dossiers ont été actualisés</h1><p>Actualisez l’analyse pour consulter la même version des identités et des sources.</p>
    <button className="analysis-refresh" type="button" onClick={onRefresh} disabled={refreshing}><RefreshCw size={16} />Actualiser l’analyse</button>
  </section>;

  return <div className={`analysis-page analysis-${info.tone}`}>
    <div className="analysis-breadcrumb"><button type="button" onClick={onBack}><ArrowLeft size={15} /> Tableau de bord</button><ChevronRight size={13} /><span>{info.label}</span></div>
    <header className="analysis-heading"><div><div className="analysis-eyebrow"><span /> VDS INTELLIGENCE 360° / ANALYSES</div><h1>{info.title}</h1><p>{info.subtitle}</p></div>
      <button type="button" className="analysis-refresh" onClick={onRefresh} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'analysis-spinning' : ''} />{refreshing ? 'Actualisation…' : 'Actualiser'}</button>
    </header>
    <BusinessAnalytics onSelectClient={onSelectClient} />
    <nav className="analysis-tabs" aria-label="Choisir une analyse">{(Object.keys(metrics) as AnalyticsMetric[]).map(key => { const Icon = metrics[key].icon; return <button key={key} type="button" aria-current={metric === key ? 'page' : undefined} onClick={() => onNavigateMetric(key)}><Icon size={16} />{metrics[key].label}</button>; })}</nav>
    <div className={`analysis-source-state ${error ? 'has-error' : ''}`} role={error ? 'alert' : 'status'}><ShieldCheck size={16} /><div>
      {error || (data.meta.stale ? 'Lecture privée datée · actualisation des sources non active' : 'Données issues de l’API privée')}
      <span>Lecture Sheets : {sourceReadAt ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(sourceReadAt)) + ' (Bangkok)' : 'Information non retrouvée'} · Audit des sources : {dateLabel(data.meta.sourceAuditDate)}</span>
    </div><span className="analysis-readonly">Lecture seule</span></div>
    <div className="analysis-stats">{stats.map(stat => <article className={`analysis-stat ${stat.tone}`} key={stat.label}><div><span>{stat.label}</span><stat.icon size={19} /></div><strong className={stat.value === 'Non vérifié' ? 'analysis-stat-text' : ''}>{stat.value}</strong><small>{stat.foot}</small></article>)}</div>
    <section className="analysis-filterbar" aria-label="Filtres des analyses"><label className="analysis-search"><Search size={17} /><span className="sr-only">Rechercher un dossier dans l’analyse</span><input type="search" placeholder="Rechercher un nom, un dossier…" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label><CalendarDays size={15} /><span className="sr-only">Période de communication source</span><select value={month} onChange={event => setMonth(event.target.value)}><option value="all">Toutes les périodes</option>{eventMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>
      <label><Filter size={15} /><span className="sr-only">Couverture des dossiers</span><select value={coverage} onChange={event => setCoverage(event.target.value)}><option value="all">Tous les dossiers</option><option value="enriched">Fiches enrichies</option><option value="pending">À enrichir</option><option value="review">À vérifier</option></select></label>
      <button type="button" className="analysis-reset" onClick={reset}>Réinitialiser</button>
    </section>
    <p className="analysis-filter-help"><Info size={13} /> La période filtre les dossiers par date de communication source. Les montants restent des observations de dossier ; ils ne constituent pas un chiffre d’affaires par période.</p>
    <div className="analysis-chart-grid">
      <ChartCard title={financial ? 'Couverture des informations financières' : metric === 'review' ? 'État des informations' : metric === 'activity' ? 'Fiabilité des événements' : 'Couverture des dossiers'}
        caption={financial ? 'Nombre de dossiers par niveau de documentation' : metric === 'review' ? 'Répartition exclusive des champs des fiches enrichies' : metric === 'activity' ? 'Statut des événements retrouvés dans les sources' : 'Dossiers de la source centrale et fiches enrichies'} badge="Répartition"
        footer={<><span className="analysis-chart-tip"><ArrowDown size={13} /> Touchez un segment pour explorer les dossiers</span>{financial && <span>Une information sourcée n’est pas un encaissement confirmé.</span>}</>}>
        <DonutChart points={financial ? evidencePoints : metric === 'review' ? fieldPoints : metric === 'activity' ? activityPoints : coveragePoints} onSelect={select} selected={selectedLabel} unit={metric === 'review' ? 'informations' : metric === 'activity' ? 'événements' : 'dossiers'} />
      </ChartCard>
      <ChartCard title={financial ? 'Ce que les sources permettent de lire' : metric === 'review' ? 'Contradictions par dossier' : metric === 'activity' ? 'Documents de l’historique' : 'Qualité des informations'}
        caption={financial ? 'Nombre d’observations par catégorie, sans addition de montants' : metric === 'review' ? 'Un dossier peut présenter plusieurs écarts à vérifier' : metric === 'activity' ? 'Pièces consultées et pièces encore à examiner' : 'Champs documentés, absents ou nécessitant un contrôle'} badge="Comparaison"
        footer={<span className="analysis-chart-tip"><ArrowDown size={13} /> Sélectionnez une barre pour voir son périmètre</span>}>
        <BarChart points={financial ? financialPoints : metric === 'review' ? reviewPoints : metric === 'activity' ? documentPoints : fieldPoints} onSelect={select} selected={selectedLabel} />
      </ChartCard>
      <ChartCard title="Activité documentée dans le temps" caption="Événements regroupés par mois de communication source (UTC)" badge="Historique"
        footer={<><span>Dates d’échanges, pas dates de chantier réalisé ni d’encaissement. Seuls les mois documentés sont représentés ; une période non couverte ne vaut pas zéro.</span>{events.some(event => !event.date) && <span>{number(events.filter(e => !e.date).length)} événement(s) sans date, exclus de la courbe.</span>}</>}>
        <ActivityChart points={activity} onSelect={select} selected={selectedLabel} />
      </ChartCard>
      <ChartCard title={financial ? 'Pour aller plus loin dans l’analyse' : metric === 'review' ? 'Documents à rapprocher' : metric === 'activity' ? 'Dossiers actifs dans les sources' : 'Documents disponibles'}
        caption={financial ? 'Les limites actuelles restent visibles, sans valeurs estimées' : metric === 'activity' ? 'Nombre d’événements par dossier dans le périmètre' : 'Lecture ou inspection des pièces disponibles'} badge={financial ? 'À compléter' : 'Sources'}
        footer={financial ? <span>Aucun total ancien ou hypothétique n’entre dans les graphiques.</span> : <span>Les documents identifiés ne sont pas présumés lus ou validés.</span>}>
        {financial ? <div className="analysis-finance-limits"><div><span className="analysis-limit-icon"><BarChart3 size={19} /></span><div><h3>Évolution des montants</h3><p>Informations insuffisantes pour tracer une courbe financière fiable.</p></div></div><div><span className="analysis-limit-icon"><Users size={19} /></span><div><h3>Répartition par commercial</h3><p>{scope.some(d => d.owner) ? 'Attributions encore insuffisantes pour une comparaison consolidée.' : 'Commercial responsable non structuré dans les sources analysées.'}</p></div></div><div><span className="analysis-limit-icon"><Wallet size={19} /></span><div><h3>{metric === 'balances' ? 'Encaissements et échéances' : 'Montants consolidés'}</h3><p>{data.finance.reason}</p></div></div></div>
          : <BarChart points={metric === 'activity' ? scope.filter(d => d.counts.events > 0).map((d, i) => ({ id: d.id, label: `${d.id} · ${d.name}`, count: events.filter(e => e.dossierId === d.id).length, dossierIds: [d.id], color: colors[i % colors.length] })).filter(p => p.count > 0).sort((a, b) => b.count - a.count) : documentPoints} onSelect={select} selected={selectedLabel} />}
      </ChartCard>
    </div>
    <section className="analysis-detail-section" ref={detailRef} aria-labelledby="analysis-dossiers-heading">
      <header className="analysis-detail-heading"><div><div className="analysis-eyebrow">DU GRAPHIQUE AU DOSSIER</div><h2 id="analysis-dossiers-heading">Les dossiers derrière les chiffres <span>{number(rows.length)}</span></h2><p>{financial ? 'Ouvrez les informations sources puis la fiche pour comparer les documents et leurs versions.' : 'Votre sélection graphique est appliquée ici. Ouvrez ensuite la fiche pour retrouver son contexte.'}</p></div><span className="analysis-table-count">{number(rows.length)} / {number(scope.length)} dossiers</span></header>
      {selection && <div className="analysis-selection" role="status"><Filter size={15} /><span>Sélection : <strong>{selection.label}</strong></span><button type="button" onClick={() => { setSelection(null); setPage(0); }} aria-label="Effacer la sélection du graphique"><X size={15} /></button></div>}
      <div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>Dossier</th><th>{financial ? 'Informations financières' : metric === 'activity' ? 'Dernières activités de la période' : 'Couverture de la fiche'}</th><th>Vérifications</th><th><span className="sr-only">Ouvrir</span></th></tr></thead><tbody>
        {visible.map(dossier => { const dossierEvents = events.filter(event => event.dossierId === dossier.id).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')); return <tr key={dossier.id}><td><div className="analysis-dossier-id"><span className="analysis-avatar">{initials(dossier.name)}</span><div><strong>{dossier.name}</strong><span>{dossier.id}{dossier.enriched ? ' · Fiche enrichie' : ''}</span></div></div></td>
          <td>{financial ? <SourceObservations observations={financialObservations(dossier, metric)} /> : metric === 'activity' ? <ActivitySummary events={dossierEvents} /> : dossier.enriched ? <div className="analysis-coverage-cell"><strong>{number(dossier.counts.documented)} informations documentées</strong><div className="analysis-mini-progress" aria-label={`${dossier.counts.documented} champs documentés sur ${dossier.counts.fields}`}><span style={{ width: `${dossier.counts.fields ? dossier.counts.documented / dossier.counts.fields * 100 : 0}%` }} /></div><small>{number(dossier.counts.missing)} manquantes · {number(dossier.counts.sources)} références sources</small></div> : <span className="analysis-muted">Enrichissement à compléter</span>}</td>
          <td><div className="analysis-checks">{dossier.counts.contradictions > 0 && <span className="analysis-status review">{number(dossier.counts.contradictions)} contradiction{dossier.counts.contradictions > 1 ? 's' : ''}</span>}{dossier.counts.review > 0 && <small>{number(dossier.counts.review)} champ(s) à vérifier</small>}{!dossier.counts.contradictions && !dossier.counts.review && <span className="analysis-status unverified">Non vérifié</span>}</div></td>
          <td><button type="button" className="analysis-open-client" onClick={() => onSelectClient(dossier.id)} aria-label={`Voir la fiche ${dossier.enriched ? '360° ' : ''}de ${dossier.name}`}>{dossier.enriched ? 'Fiche 360°' : 'Voir le dossier'}<ArrowUpRight size={15} /></button></td></tr>; })}
        {!visible.length && <tr><td colSpan={4}><div className="analysis-no-results"><Search size={24} /><h3>Aucun dossier pour cette sélection</h3><p>Élargissez la période ou retirez un filtre.</p><button type="button" onClick={reset}>Réinitialiser les filtres</button></div></td></tr>}
      </tbody></table></div>
      <footer className="analysis-pagination"><span>{rows.length ? `${safePage * 15 + 1}–${Math.min((safePage + 1) * 15, rows.length)}` : '0'} sur {number(rows.length)} dossiers</span><div><button type="button" onClick={() => setPage(Math.max(0, safePage - 1))} disabled={!safePage} aria-label="Page précédente"><ChevronLeft size={17} /></button><span>Page {safePage + 1} / {pages}</span><button type="button" onClick={() => setPage(Math.min(pages - 1, safePage + 1))} disabled={safePage >= pages - 1} aria-label="Page suivante"><ChevronRight size={17} /></button></div></footer>
    </section>
    <details className="analysis-method"><summary><Info size={15} /> Comprendre les sources et les limites de cette analyse</summary><ul>{data.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul><p>Les graphiques décrivent la documentation disponible. Les rapprochements de personnes, les engagements et les encaissements nécessitent les contrôles prévus dans le centre de validation.</p></details>
  </div>;
}
function ActivitySummary({ events }: { events: AnalyticsEvent[] }) {
  if (!events.length) return <span className="analysis-muted">Événement non retrouvé dans ce périmètre.</span>;
  return <details className="analysis-observations"><summary>{number(events.length)} événement{events.length > 1 ? 's' : ''} retrouvé{events.length > 1 ? 's' : ''}<ChevronRight size={14} /></summary><div>{events.map(event => <article key={event.id}><header><strong>{dateLabel(event.date)}</strong><span className={`analysis-status ${event.status}`}>{fieldLabels[event.status]}</span></header><p>{event.summary}</p><div className="analysis-source-links">{event.sources.filter(s => s.url).map(source => <a key={source.id} href={source.url!} target="_blank" rel="noopener noreferrer">{source.label}<ArrowUpRight size={12} /></a>)}</div></article>)}</div></details>;
}
export default function AnalyticsPage(props: AnalyticsPageProps) {
  const { data, loading, error, refreshing, refresh } = useAnalytics();
  if (!data) return <section className="analysis-page analysis-loading"><button type="button" className="analysis-back" onClick={props.onBack}><ArrowLeft size={16} /> Tableau de bord</button><span className="analysis-loading-icon"><BarChart3 size={32} /></span><h1>{metrics[props.metric].title}</h1><p role={error ? 'alert' : 'status'}>{loading ? 'Chargement des analyses depuis l’API privée…' : error || 'Les analyses sont indisponibles.'}</p>{loading ? <div className="analysis-loading-bars" aria-hidden="true"><i /><i /><i /><i /><i /></div> : <button type="button" className="analysis-refresh" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={16} /> Réessayer</button>}</section>;
  return <AnalyticsView {...props} data={data} error={error} refreshing={refreshing} onRefresh={() => void refresh()} />;
}

import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  ChartColumnIncreasing,
  ChevronRight,
  CircleAlert,
  FileCheck2,
  FileText,
  Layers3,
  LockKeyhole,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import type { ClientFilters, Section, Snapshot } from "../types";
import { initials } from "../lib/format";
import "./dashboard-premium.css";

export type DashboardAnalysisMetric = "clients" | "contracts" | "balances" | "review" | "activity";
interface DashboardProps {
  snapshot: Snapshot;
  onNavigate: (section: Section, filters?: Partial<ClientFilters>) => void;
  onSelectClient: (id: string) => void;
  onAnalyze: (metric: DashboardAnalysisMetric) => void;
}

const integer = (value: number) => value.toLocaleString("fr-FR");

export default function Dashboard({ snapshot, onNavigate, onSelectClient, onAnalyze }: DashboardProps) {
  const { clients } = snapshot;
  const enrichedIds = new Set(snapshot.enrichedClientIds ?? []);
  const pilotClients = clients.filter(client => enrichedIds.has(client.id));
  const total = clients.length;
  const enriched = pilotClients.length;
  const remaining = total - enriched;
  const coverage = total ? enriched / total * 100 : 0;
  const coverageLabel = coverage.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Bangkok",
  }).format(new Date());
  const sourceReadAt = snapshot.sourceState?.lastReadAt;
  const sourceDate = sourceReadAt && Number.isFinite(Date.parse(sourceReadAt))
    ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Bangkok" }).format(new Date(sourceReadAt))
    : null;
  const metrics = [
    { id: "clients" as const, label: "Clients & dossiers", value: integer(total), detail: "Dossiers disponibles", icon: Users, tone: "blue", numeric: true },
    { id: "contracts" as const, label: "Contrats HT", value: "Non vérifié", detail: "Pièces contractuelles à rapprocher", icon: FileText, tone: "purple", numeric: false },
    { id: "balances" as const, label: "Soldes à encaisser", value: "Non vérifié", detail: "Justificatifs comptables nécessaires", icon: Wallet, tone: "aqua", numeric: false },
    { id: "review" as const, label: "Dossiers à vérifier", value: integer(enriched), detail: "Fiches enrichies à examiner", icon: ShieldCheck, tone: "gold", numeric: true },
  ];
  const bars = [
    { label: "Dossiers disponibles", count: total, tone: "graphite", metric: "clients" as const },
    { label: "Fiches enrichies", count: enriched, tone: "aqua", metric: "review" as const },
    { label: "Dossiers à enrichir", count: remaining, tone: "gold", metric: "clients" as const },
  ];

  return (
    <div className="premium-dashboard">
      <header className="pdash-heading">
        <div>
          <p className="pdash-eyebrow"><span /> VDS INTELLIGENCE 360°</p>
          <h1>Votre activité,<br className="pdash-mobile-break" /> en perspective.</h1>
          <p className="pdash-intro">Les bonnes informations. Les points à vérifier. Vos prochaines décisions.</p>
        </div>
        <div className="pdash-heading-actions">
          <span className="pdash-date"><CalendarDays size={15} aria-hidden="true" />{date}</span>
          <button type="button" className="pdash-outline-button" onClick={() => onNavigate("validation")}>
            <ShieldCheck size={16} aria-hidden="true" />Centre de validation<ArrowUpRight size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="pdash-kpis" aria-label="Indicateurs de pilotage — ouvrir une analyse">
        {metrics.map(({ id, label, value, detail, icon: Icon, tone, numeric }) => (
          <button key={id} type="button" className={`pdash-kpi pdash-tone-${tone}`} data-dashboard-metric={id}
            aria-label={`Ouvrir l’analyse ${label} : ${value}. ${detail}.`} onClick={() => onAnalyze(id)}>
            <span className="pdash-kpi-top"><span className="pdash-kpi-label">{label}</span><span className="pdash-icon"><Icon size={20} strokeWidth={1.65} aria-hidden="true" /></span></span>
            <strong className={`pdash-kpi-value ${numeric ? "" : "pdash-kpi-unverified"}`}>{value}</strong>
            <span className="pdash-kpi-bottom"><span>{detail}</span><span className="pdash-kpi-arrow"><ArrowUpRight size={17} aria-hidden="true" /></span></span>
          </button>
        ))}
      </div>

      <div className="pdash-analytics-grid">
        <section className="pdash-panel pdash-portfolio" aria-labelledby="pdash-portfolio-title">
          <div className="pdash-panel-heading">
            <div><p className="pdash-section-kicker">VUE D’ENSEMBLE</p><h2 id="pdash-portfolio-title">Votre portefeuille de dossiers</h2><p>Une lecture de la couverture actuelle de votre base.</p></div>
            <button type="button" className="pdash-icon-button" aria-label="Ouvrir l’analyse des clients et dossiers" onClick={() => onAnalyze("clients")}><ArrowUpRight size={19} /></button>
          </div>
          {total > 0 ? <div className="pdash-bar-chart" aria-label={`Couverture : ${total} dossiers, ${enriched} fiches enrichies et ${remaining} dossiers à enrichir`}>
            {bars.map(bar => <button key={bar.label} type="button" className={`pdash-bar-row pdash-bar-${bar.tone}`} onClick={() => onAnalyze(bar.metric)}
              aria-label={`${bar.label} : ${integer(bar.count)}. Ouvrir l’analyse ${bar.metric === "review" ? "des dossiers à vérifier" : "des clients"}.`}>
              <span className="pdash-bar-caption"><span><i aria-hidden="true" />{bar.label}</span><strong>{integer(bar.count)}<ChevronRight size={14} aria-hidden="true" /></strong></span>
              <span className="pdash-bar-track"><span style={{ width: `${bar.count / total * 100}%` }} /></span>
            </button>)}
            <div className="pdash-chart-axis" aria-hidden="true"><span>0</span><span>{integer(Math.round(total / 2))}</span><span>{integer(total)} dossiers</span></div>
          </div> : <div className="pdash-empty"><Layers3 size={25} /><strong>Information non retrouvée</strong><p>Aucun dossier disponible dans la source consultée.</p></div>}
          <div className="pdash-panel-footer"><span><span className="pdash-dot" />Périmètre réel · lecture seule</span><button type="button" className="pdash-text-button" onClick={() => onAnalyze("clients")}>Explorer les dossiers<ArrowRight size={15} /></button></div>
        </section>

        <section className="pdash-panel pdash-coverage" aria-labelledby="pdash-coverage-title">
          <div className="pdash-panel-heading"><div><p className="pdash-section-kicker">ENRICHISSEMENT</p><h2 id="pdash-coverage-title">La vision 360° avance</h2></div><span className="pdash-panel-emblem"><Layers3 size={18} aria-hidden="true" /></span></div>
          <button type="button" className="pdash-donut-button" onClick={() => onAnalyze("review")}
            aria-label={`${enriched} fiches enrichies sur ${total} dossiers, soit ${coverageLabel} %. Ouvrir l’analyse des dossiers à vérifier.`}>
            <svg viewBox="0 0 200 200" aria-hidden="true"><circle className="pdash-donut-track" cx="100" cy="100" r="78" /><circle className="pdash-donut-value" cx="100" cy="100" r="78" pathLength="100" strokeDasharray={`${coverage} ${100 - coverage}`} transform="rotate(-90 100 100)" /></svg>
            <span className="pdash-donut-center"><strong>{coverageLabel}<small>%</small></strong><span>de fiches enrichies</span><span className="pdash-donut-hint">Voir l’analyse<ArrowUpRight size={12} /></span></span>
          </button>
          <div className="pdash-coverage-legend">
            <button type="button" onClick={() => onAnalyze("review")}><span><i className="pdash-legend-aqua" />Fiches enrichies</span><strong>{integer(enriched)}<ChevronRight size={13} /></strong></button>
            <button type="button" onClick={() => onAnalyze("clients")}><span><i className="pdash-legend-pale" />À enrichir</span><strong>{integer(remaining)}<ChevronRight size={13} /></strong></button>
          </div>
          <p className="pdash-coverage-note">Une fiche enrichie contient des informations sourcées ; ses points à vérifier restent visibles.</p>
        </section>

        <section className="pdash-panel pdash-finances" aria-labelledby="pdash-finance-title">
          <div className="pdash-panel-heading"><div><p className="pdash-section-kicker">PILOTAGE FINANCIER</p><h2 id="pdash-finance-title">Des chiffres qui s’appuient sur des preuves</h2><p>Contrats, échéances et encaissements dans leurs analyses dédiées.</p></div><span className="pdash-panel-emblem"><ChartColumnIncreasing size={19} aria-hidden="true" /></span></div>
          <div className="pdash-finance-empty"><span className="pdash-empty-chart-icon"><ChartColumnIncreasing size={28} strokeWidth={1.4} aria-hidden="true" /></span><div><strong>Données insuffisantes pour établir ce graphique</strong><p>Les montants globaux et leur évolution attendent le rapprochement des documents contractuels et comptables.</p></div><span className="pdash-proof-badge"><LockKeyhole size={12} aria-hidden="true" />Non vérifié</span></div>
          <div className="pdash-finance-links">
            <button type="button" onClick={() => onAnalyze("contracts")}><span className="pdash-mini-icon pdash-mini-purple"><FileCheck2 size={18} aria-hidden="true" /></span><span><strong>Analyse des contrats</strong><small>Versions, signatures, montants documentés</small></span><ArrowRight size={17} aria-hidden="true" /></button>
            <button type="button" onClick={() => onAnalyze("balances")}><span className="pdash-mini-icon pdash-mini-aqua"><Wallet size={18} aria-hidden="true" /></span><span><strong>Analyse des soldes</strong><small>Échéances et justificatifs à rapprocher</small></span><ArrowRight size={17} aria-hidden="true" /></button>
          </div>
        </section>

        <section className="pdash-panel pdash-activity" aria-labelledby="pdash-activity-title">
          <div className="pdash-activity-decoration" aria-hidden="true"><span /><span /><span /></div>
          <span className="pdash-activity-icon"><Activity size={23} strokeWidth={1.5} aria-hidden="true" /></span>
          <p className="pdash-section-kicker">LE FIL DES DOSSIERS</p>
          <h2 id="pdash-activity-title">Chaque échange<br />fait avancer un projet.</h2>
          <p className="pdash-activity-description">Retrouvez les étapes, les communications et les décisions documentées dans l’analyse d’activité.</p>
          <button type="button" className="pdash-activity-button" data-dashboard-metric="activity" onClick={() => onAnalyze("activity")} aria-label="Ouvrir l’analyse d’activité et les chronologies des dossiers">Explorer l’activité<ArrowUpRight size={18} aria-hidden="true" /></button>
          <span className="pdash-activity-footnote"><ShieldCheck size={13} aria-hidden="true" />Dates et sources consultables dans l’analyse</span>
        </section>
      </div>

      <section className="pdash-panel pdash-dossiers" aria-labelledby="pdash-dossiers-title">
        <div className="pdash-panel-heading"><div><p className="pdash-section-kicker">POUR ALLER PLUS LOIN</p><h2 id="pdash-dossiers-title">Vos fiches documentées</h2><p>Ouvrez un dossier pour examiner ses sources, ses décisions et son historique.</p></div><button type="button" className="pdash-text-button" onClick={() => onAnalyze("review")}>Voir l’analyse complète<ArrowUpRight size={16} /></button></div>
        {pilotClients.length ? <>
          <div className="pdash-dossier-column-headings" aria-hidden="true"><span>CLIENT & DOSSIER</span><span>CONTENU DISPONIBLE</span><span>REVUE</span><span /></div>
          <ul className="pdash-dossier-list">{pilotClients.slice(0, 5).map((client, index) => <li key={client.id}>
            <button type="button" className="pdash-dossier-row" data-client-id={client.id} onClick={() => onSelectClient(client.id)} aria-label={`Ouvrir la fiche 360° de ${client.client}, dossier ${client.id}`}>
              <span className="pdash-dossier-identity"><span className={`pdash-avatar pdash-avatar-${index % 3}`}>{initials(client.client)}</span><span><strong>{client.client}</strong><small>{client.id}</small></span></span>
              <span className="pdash-dossier-content"><FileText size={15} aria-hidden="true" />Sources & fiche 360°</span>
              <span className="pdash-review-badge"><CircleAlert size={12} aria-hidden="true" />À examiner</span><ArrowUpRight className="pdash-dossier-arrow" size={18} aria-hidden="true" />
            </button>
          </li>)}</ul>
          <div className="pdash-panel-footer"><span>{Math.min(5, enriched)} fiches affichées sur {integer(enriched)} fiches enrichies disponibles</span><button type="button" className="pdash-text-button" onClick={() => onAnalyze("review")}>Poursuivre la revue<ArrowRight size={15} /></button></div>
        </> : <div className="pdash-empty"><FileText size={27} /><strong>Information non retrouvée</strong><p>Les fiches enrichies apparaîtront ici lorsqu’elles seront disponibles dans la source privée.</p><button type="button" className="pdash-text-button" onClick={() => onAnalyze("clients")}>Consulter l’analyse des dossiers<ArrowRight size={15} /></button></div>}
      </section>
      <div className="pdash-source-caption"><LockKeyhole size={12} aria-hidden="true" /><span>{snapshot.connection.label}{sourceDate ? ` · Source lue le ${sourceDate}` : " · Date de lecture non retrouvée"} · Aucune modification des sources</span></div>
    </div>
  );
}

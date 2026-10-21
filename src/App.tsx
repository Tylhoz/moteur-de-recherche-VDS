import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  ChartNoAxesCombined,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Database,
  ExternalLink,
  FileCheck2,
  FileText,
  HardHat,
  LayoutDashboard,
  LifeBuoy,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Users,
  Waves,
  X,
} from "lucide-react";
import type { ClientFilters, Section } from "./types";
import type { AnalyticsMetric } from "../shared/analytics-contract";
import { ANALYSIS_LABELS, readRoute, routeUrl, type Route } from "./lib/navigation";
import { clientIdentityKey, DEFAULT_FILTERS } from "./lib/clients";
import { useSnapshot } from "./data/useSnapshot";
import Modal from "./components/Modal";
import BrandLogo from "./components/BrandLogo";
const ValidationCenter = lazy(() => import("./components/RealValidationCenter"));
const Dashboard = lazy(() => import("./components/Dashboard"));
const AnalyticsPage = lazy(() => import("./components/AnalyticsPage"));
const Clients = lazy(() => import("./components/Clients"));
const Workspace = lazy(() => import("./components/Workspace"));
const ClientDetail = lazy(() => import("./components/ClientDetail"));
const ClientDetail360 = lazy(() => import("./components/ClientDetail360"));
const ConnectionsPanel = lazy(() => import("./components/ConnectionsPanel"));

const navigation = [
  { id: "dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { id: "analysis", label: "Analyses", icon: ChartNoAxesCombined },
  { id: "clients", label: "Clients", icon: Users },
  { id: "devis", label: "Devis", icon: FileText },
  { id: "ventes", label: "Ventes", icon: FileCheck2 },
  { id: "chantiers", label: "Chantiers", icon: HardHat },
  { id: "factures", label: "Factures", icon: ClipboardList },
  { id: "sav", label: "SAV", icon: LifeBuoy },
  { id: "validation", label: "Validation", icon: ShieldCheck },
] as const;
function Loading() {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spinning" size={24} />
      <p>Votre espace prend forme…</p>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const routeRef = useRef(route);
  routeRef.current = route;
  const [menuOpen, setMenuOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [compactNav, setCompactNav] = useState(
    () => window.matchMedia("(max-width: 900px)").matches,
  );
  const [toast, setToast] = useState("");
  const [selectionIdentity, setSelectionIdentity] = useState<{ id: string; key: string } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const data = useSnapshot();
  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 4200);
  }, []);
  const update = useCallback((change: Partial<Route>, push = false) => {
    const next = { ...routeRef.current, ...change };
    routeRef.current = next;
    setRoute(next);
    history[push ? "pushState" : "replaceState"](null, "", routeUrl(next));
  }, []);
  useEffect(() => {
    const back = () => setRoute(readRoute());
    window.addEventListener("popstate", back);
    window.addEventListener("hashchange", back);
    return () => {
      window.removeEventListener("popstate", back);
      window.removeEventListener("hashchange", back);
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    document.title = `${route.section === "analysis" ? ANALYSIS_LABELS[route.metric] : navigation.find((n) => n.id === route.section)?.label} · VDS Pools`;
  }, [route.section, route.metric]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const changed = () => {
      setCompactNav(media.matches);
      if (!media.matches) setMenuOpen(false);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    sidebarRef.current?.querySelector<HTMLElement>("button")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>("button") ?? [],
      ).filter((e) => e.getClientRects().length);
      const first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      menuButtonRef.current?.focus();
    };
  }, [menuOpen]);
  const navigate = useCallback(
    (section: Section, filters?: Partial<ClientFilters>) => {
      update(
        {
          section,
          selectedId: null,
          ...(filters ? { filters: { ...DEFAULT_FILTERS, ...filters } } : {}),
        },
        true,
      );
      setMenuOpen(false);
      window.scrollTo({ top: 0, behavior: "instant" });
    },
    [update],
  );
  const analyze = useCallback((metric: AnalyticsMetric) => {
    update({ section: "analysis", metric, selectedId: null, filters: { ...DEFAULT_FILTERS } }, true);
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [update]);
  function openSettings() {
    setMenuOpen(false);
    setSettings(true);
  }
  const active = navigation.find((n) => n.id === route.section)!;
  const selectedCandidate = data.snapshot?.clients.find((c) => c.id === route.selectedId);
  const client = selectedCandidate && selectionIdentity?.id === selectedCandidate.id &&
    selectionIdentity.key === clientIdentityKey(selectedCandidate) ? selectedCandidate : undefined;
  useEffect(() => {
    if (!route.selectedId) { setSelectionIdentity(null); return; }
    if (!data.snapshot) return;
    if (!selectedCandidate) {
      update({ selectedId: null });
      setSelectionIdentity(null);
      notify("Ce dossier n’est plus présent dans la dernière lecture. La fiche a été fermée.");
      return;
    }
    const key = clientIdentityKey(selectedCandidate);
    if (selectionIdentity?.id !== selectedCandidate.id) {
      setSelectionIdentity({ id: selectedCandidate.id, key });
    } else if (selectionIdentity.key !== key) {
      update({ selectedId: null });
      setSelectionIdentity(null);
      notify("L’identité associée à cet identifiant a changé. La fiche a été fermée : vérifiez le rapprochement avant de la rouvrir.");
    }
  }, [route.selectedId, data.snapshot, selectedCandidate, selectionIdentity, update, notify]);
  const lastReadAt = data.snapshot?.sourceState?.lastReadAt;
  const stale = Boolean(data.snapshot?.sourceState?.stale);
  const sourceLabel = data.snapshot?.connection.label ?? "Source non connectée";
  const timeLabel = (value: string) => new Date(value).toLocaleString("fr-FR", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const alerts =
    data.snapshot?.clients.filter((c) => c.category === "alerte").length || 0;

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Aller au contenu
      </a>
      {menuOpen && (
        <div className="nav-backdrop" onClick={() => setMenuOpen(false)} />
      )}
      <aside
        ref={sidebarRef}
        className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}
        aria-label="Navigation principale"
        inert={compactNav && !menuOpen ? true : undefined}
        aria-hidden={compactNav && !menuOpen ? true : undefined}
        {...(menuOpen ? { role: "dialog", "aria-modal": true } : {})}
      >
        <button
          className="brand"
          aria-label="VDS Pools — Tableau de bord"
          onClick={() => navigate("dashboard")}
        >
          <BrandLogo />
        </button>
        <button
          className="sidebar-close icon-button"
          aria-label="Fermer le menu"
          onClick={() => setMenuOpen(false)}
        >
          <X size={21} />
        </button>
        <div className="workspace-label">
          <span className="workspace-dot" />
          Votre espace de travail
          <ChevronDown size={13} />
        </div>
        <div className="nav-caption">PILOTAGE</div>
        <nav>
          {navigation.map(({ id, label, icon: Icon }) => (
            <Fragment key={id}>
              <button
                className={`nav-item ${route.section === id ? "active" : ""}`}
                aria-current={route.section === id ? "page" : undefined}
                onClick={() => navigate(id)}
              >
                <Icon size={19} strokeWidth={1.7} />
                <span>{label}</span>
                {id === "clients" && data.snapshot && (
                  <span className="nav-count">
                    {data.snapshot.clients.length}
                  </span>
                )}
                {id === "sav" && data.snapshot && (
                  <span className="nav-indicator" />
                )}
              </button>
              {id === "factures" && (
                <a
                  className="nav-item"
                  href="https://meert-val-gmail-com.vosfactures.fr"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none" }}
                  aria-label="VosFactures — ouvrir la facturation dans un nouvel onglet"
                  onClick={() => setMenuOpen(false)}
                >
                  <ExternalLink size={19} strokeWidth={1.7} />
                  <span>VosFactures</span>
                </a>
              )}
            </Fragment>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="source-card">
            <span className="source-icon">
              <Database size={18} />
            </span>
            <strong>Une base, une vision.</strong>
            <p>
              {data.snapshot ? `Vos ${data.snapshot.clients.length} dossiers,` : "Vos dossiers,"}
              <br />
              dans votre espace privé.
            </p>
            <button onClick={openSettings}>
              À propos des données
              <ArrowRight size={14} />
            </button>
          </div>
          <button className="nav-item utility-item" onClick={openSettings}>
            <Settings2 size={18} />
            <span>Données & accès</span>
          </button>
          <button
            className="nav-item utility-item"
            onClick={() => {
              setMenuOpen(false);
              setHelp(true);
            }}
          >
            <CircleHelp size={18} />
            <span>Prendre en main</span>
          </button>
          <div className="sidebar-profile">
            <span className="profile-avatar">VP</span>
            <div>
              <strong>VDS Pools</strong>
              <small>Aperçu privé</small>
            </div>
            <ShieldCheck size={16} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              ref={menuButtonRef}
              className="icon-button mobile-menu"
              aria-label="Ouvrir le menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={22} />
            </button>
            <span className="breadcrumb-brand">Espace VDS Pools</span>
            <ChevronRight size={14} className="breadcrumb-chevron" />
            <span className="breadcrumb-current">{route.section === "analysis" ? ANALYSIS_LABELS[route.metric] : active.label}</span>
          </div>
          <div className="topbar-actions">
            <form
              className="global-search"
              onSubmit={(e) => {
                e.preventDefault();
                navigate("clients", {
                  ...route.filters,
                  search: searchRef.current?.value || "",
                });
              }}
            >
              <Search size={17} />
              <label className="sr-only" htmlFor="global-search">
                Rechercher un dossier
              </label>
              <input
                ref={searchRef}
                id="global-search"
                placeholder="Rechercher un client, un dossier…"
                defaultValue=""
              />
              <kbd>⌘ K</kbd>
            </form>
            <button
              className="icon-button notification-button"
              aria-label="Analyser les dossiers à vérifier"
              onClick={() => analyze("review")}
            >
              <Bell size={19} />
              {alerts > 0 && <span />}
            </button>
            <span className="topbar-avatar" aria-label="Espace VDS Pools">
              VP
            </span>
          </div>
        </header>
        <div className="statusbar">
          <button className="source-pill local" onClick={openSettings}>
            <span />
            Aperçu privé
            <ChevronDown size={12} />
          </button>
          <div className="sync-status">
            <span className="sync-desktop">
              {lastReadAt ? `Source lue le ${timeLabel(lastReadAt)} · Bangkok` : "Dernière lecture source : information non retrouvée"}
              {stale ? " · Copie périmée" : ""}
              {" · Vérification automatique toutes les 30 s"}
            </span>
            <button
              className="sync-button"
              onClick={() => void data.refresh()}
              disabled={data.refreshing}
              aria-label="Actualiser les données"
            >
              <RefreshCw
                size={13}
                className={data.refreshing ? "spinning" : ""}
              />
              <span>Actualiser</span>
            </button>
          </div>
        </div>
        <main id="main-content" tabIndex={-1} className="main-content">
          {route.section === "dashboard" && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
              <a
                className="button button-primary"
                href="https://vosfactures.fr/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Accéder à VosFactures — nouvel onglet"
                style={{ textDecoration: "none", minHeight: 44 }}
              >
                <ExternalLink size={18} aria-hidden="true" />
                Accéder à VosFactures
              </a>
            </div>
          )}
          {data.error && (
            <div className="error-banner" role="alert">
              <span>
                {data.error}
                {data.snapshot
                  ? ` Copie périmée : dernière lecture source ${lastReadAt ? timeLabel(lastReadAt) + " (Bangkok)" : "non retrouvée"}.`
                  : ""}
              </span>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                {data.authenticationRequired
                  ? <a className="button primary" href="/">Se reconnecter</a>
                  : <button onClick={() => void data.refresh()}>Réessayer</button>}
                <button onClick={openSettings}>Données & accès</button>
              </div>
            </div>
          )}
          {data.snapshot && !stale && (
            <p className="source-reading-summary" style={{ fontSize: "0.76rem", color: "var(--text-muted, #59666a)", margin: "0 0 18px", lineHeight: 1.6 }}>
              {sourceLabel} · Dernière lecture source : {lastReadAt ? `${timeLabel(lastReadAt)} (Bangkok)` : "Information non retrouvée"}.
              {" "}Vérification de l’API toutes les 30 secondes lorsque l’application est visible.
            </p>
          )}
          {data.snapshot && stale && !data.error && (
            <div className="error-banner" role="status">
              <span>Copie Google Sheets disponible. Actualisation automatique non confirmée ; dernière lecture source {lastReadAt ? `${timeLabel(lastReadAt)} (Bangkok)` : "non retrouvée"}. {data.snapshot.sourceState?.reason}</span>
            </div>
          )}
          {data.loading ? (
            <Loading />
          ) : data.snapshot ? (
            <Suspense fallback={<Loading />}>
              {route.section === "validation" ? (
                <ValidationCenter
                  clients={data.snapshot.clients}
                  snapshotAt={data.snapshot.fetchedAt}
                  sourceLabel={data.snapshot.connection.label}
                  enrichedClientIds={data.snapshot.enrichedClientIds ?? []}
                  onSelectClient={(id) => update({ selectedId: id }, true)}
                />
              ) : route.section === "dashboard" ? (
                <Dashboard
                  snapshot={data.snapshot}
                  onNavigate={navigate}
                  onAnalyze={analyze}
                  onSelectClient={(id) => update({ selectedId: id }, true)}
                />
              ) : route.section === "analysis" ? (
                <AnalyticsPage
                  key={route.metric}
                  metric={route.metric}
                  snapshot={data.snapshot}
                  onNavigateMetric={analyze}
                  onBack={() => navigate("dashboard")}
                  onSelectClient={(id) => update({ selectedId: id }, true)}
                />
              ) : route.section === "clients" ? (
                <Clients
                  clients={data.snapshot.clients}
                  records={data.snapshot.records}
                  source="api"
                  enrichedClientIds={data.snapshot.enrichedClientIds ?? []}
                  filters={route.filters}
                  onFiltersChange={(filters) => update({ filters })}
                  selectedId={client?.id ?? null}
                  onSelect={(id) => update({ selectedId: id }, true)}
                  onNotify={notify}
                />
              ) : (
                <Workspace
                  key={route.section}
                  kind={route.section}
                  snapshot={data.snapshot}
                  onSelectClient={(id) => update({ selectedId: id }, true)}
                />
              )}
              {route.section !== "clients" && client && (
                data.snapshot.enrichedClientIds?.includes(client.id) ? <ClientDetail360
                  clientId={client.id}
                  onClose={() => update({ selectedId: null })}
                /> : <ClientDetail
                  client={client}
                  records={data.snapshot.records}
                  source="api"
                  onClose={() => update({ selectedId: null })}
                  onNotify={notify}
                />
              )}
            </Suspense>
          ) : (
            !data.error && <p>Source non connectée. Aucune donnée disponible.</p>
          )}
          <footer className="app-footer">
            <span>
              VDS Pools <span>·</span> Chaque projet, une attention.
            </span>
            <span>
              <span className="footer-dot" />
              {sourceLabel} · Lecture seule
            </span>
          </footer>
        </main>
      </div>
      <nav className="mobile-bottom-nav" aria-label="Accès rapides">
        <button
          className={route.section === "dashboard" ? "active" : ""}
          onClick={() => navigate("dashboard")}
        >
          <LayoutDashboard size={20} />
          Accueil
        </button>
        <button
          className={route.section === "clients" ? "active" : ""}
          onClick={() => navigate("clients")}
        >
          <Users size={20} />
          Clients
        </button>
        <button
          className={route.section === "validation" ? "active" : ""}
          onClick={() => navigate("validation")}
        >
          <ShieldCheck size={20} />
          Validation
        </button>
        <button onClick={() => setMenuOpen(true)}>
          <MoreHorizontal size={21} />
          Plus
        </button>
      </nav>
      {settings && (
        <Modal title="Données & accès" onClose={() => setSettings(false)} wide>
          <Suspense fallback={<Loading />}>
            <ConnectionsPanel
              links={data.snapshot?.links}
              lastReadAt={lastReadAt}
              lastCheckedAt={data.lastCheckedAt}
              lastAttemptAt={data.lastAttemptAt}
              formatDate={(value) => `${timeLabel(value)} (Bangkok)`}
              onImported={data.refresh}
            />
          </Suspense>
        </Modal>
      )}
      {help && (
        <Modal
          title="Bienvenue dans votre espace VDS"
          onClose={() => setHelp(false)}
        >
          <div className="help-content">
            <span className="help-mark">
              <Waves size={34} />
            </span>
            <h3>Tout commence par un dossier.</h3>
            <p>
              Consultez vos dossiers et ouvrez les fiches enrichies pour retrouver les sources, les documents et les points à vérifier. Un montant historique n’est pas une preuve d’encaissement.
            </p>
            <ol>
              <li>
                Utilisez la recherche globale ou <kbd>⌘ / Ctrl K</kbd> pour
                retrouver un client.
              </li>
              <li>
                Combinez les filtres dans Clients et ouvrez une fiche pour
                consulter les détails.
              </li>
              <li>
                Explorez les espaces métier pour retrouver les dossiers associés
                aux informations existantes, sans créer de nouveaux documents.
              </li>
              <li>
                Consultez Données & accès pour connaître la provenance des
                informations.
              </li>
            </ol>
            <button
              className="button button-primary"
              onClick={() => {
                setHelp(false);
                navigate("clients");
              }}
            >
              Explorer les clients
              <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
      <div
        className={`toast ${toast ? "visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        {toast && (
          <>
            <Check size={17} />
            <span>{toast}</span>
            <button
              aria-label="Masquer la notification"
              onClick={() => setToast("")}
            >
              <X size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

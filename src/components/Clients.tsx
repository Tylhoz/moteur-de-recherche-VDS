import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownUp,
  ArrowRight,
  Check,
  ChevronDown,
  Grid2X2,
  List,
  MapPin,
  Search,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import type { Client, BusinessRecord, Source, ClientFilters } from "../types";
import {
  DEFAULT_FILTERS,
  filterClients,
  getCounts,
  MODEL_OPTIONS,
  normalizeText,
  SORT_OPTIONS,
  TEAM_OPTIONS,
} from "../lib/clients";
import { categoryLabel, initials } from "../lib/format";
import ClientDetail from "./ClientDetail";
import ClientDetail360 from "./ClientDetail360";
import "./clients.css";

interface ClientsProps {
  clients: Client[];
  records: BusinessRecord[];
  source: Source;
  enrichedClientIds: string[];
  filters: ClientFilters;
  onFiltersChange: (next: ClientFilters) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNotify: (message: string) => void;
}

const quickSearches = [
  "Family",
  "Serenity",
  "Cosy",
  "Volet",
  "Filtration",
  "Liège",
  "Namur",
];

export default function Clients({
  clients,
  records,
  source,
  enrichedClientIds,
  filters,
  onFiltersChange,
  selectedId,
  onSelect,
  onNotify,
}: ClientsProps) {
  const [view, setView] = useState<"list" | "cards">(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 600px)").matches
      ? "cards"
      : "list",
  );
  const [limit, setLimit] = useState(60);
  const [showFilters, setShowFilters] = useState(false);
  const filtered = useMemo(
    () => filterClients(clients, filters),
    [clients, filters],
  );
  const counts = useMemo(
    () => getCounts(filterClients(clients, { ...filters, status: "all" })),
    [clients, filters],
  );
  const availableTeams = useMemo(
    () =>
      TEAM_OPTIONS.filter(
        (option) =>
          option.value === "all" ||
          clients.some((client) =>
            normalizeText(client.modelTeam).includes(
              normalizeText(option.value),
            ),
          ),
      ),
    [clients],
  );
  const visible = filtered.slice(0, limit);
  const selectedClient = clients.find((client) => client.id === selectedId);
  const activeFilterCount =
    Number(filters.team !== "all") + Number(filters.model !== "all");
  const hasFilters =
    !!filters.search || filters.status !== "all" || activeFilterCount > 0;
  const closeDetail = useCallback(() => onSelect(null), [onSelect]);

  useEffect(() => {
    setLimit(60);
  }, [
    filters.search,
    filters.status,
    filters.team,
    filters.model,
    filters.sort,
  ]);
  useEffect(() => {
    if (selectedId && !selectedClient) onSelect(null);
  }, [selectedId, selectedClient, onSelect]);

  const update = (patch: Partial<ClientFilters>) =>
    onFiltersChange({ ...filters, ...patch });
  const tabs: {
    value: ClientFilters["status"];
    label: string;
    count: number;
  }[] = [
    { value: "all", label: "Tous les dossiers", count: counts.total },
    { value: "alerte", label: "À vérifier", count: counts.alerte },
    { value: "solde", label: "Soldes & devis", count: counts.solde },
    { value: "sav", label: "SAV & pose", count: counts.sav },
    { value: "valide", label: "Classés validés", count: counts.valide },
    { value: "non_verifie", label: "Non vérifiés", count: counts.non_verifie },
    { value: "followup", label: "Solde historique positif", count: counts.followup },
  ];

  return (
    <section className="clients-page" aria-labelledby="clients-title">
      <div className="clients-heading">
        <div>
          <p className="clients-eyebrow">RELATION CLIENT · APERÇU PRIVÉ</p>
          <h1 id="clients-title">Tous vos clients. Une vue claire.</h1>
          <p className="clients-subtitle">
            Retrouvez vos dossiers historiques et leurs fiches enrichies avec des sources vérifiables.
          </p>
        </div>
        <span className="clients-total">
          <Users size={16} aria-hidden="true" /> {clients.length} dossiers
        </span>
      </div>

      <div className="clients-panel">
        <div
          className="clients-status-tabs"
          aria-label="Filtrer les dossiers par statut"
        >
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`clients-status-tab ${filters.status === tab.value ? "is-active" : ""}`}
              aria-pressed={filters.status === tab.value}
              onClick={() => update({ status: tab.value })}
            >
              {tab.label}
              <span>{tab.count}</span>
            </button>
          ))}
        </div>

        <div className="clients-search-row">
          <div className="clients-search">
            <Search size={19} aria-hidden="true" />
            <label htmlFor="clients-search" className="clients-sr-only">
              Rechercher dans tous les champs clients
            </label>
            <input
              id="clients-search"
              type="search"
              value={filters.search}
              placeholder="Un nom, un téléphone, une adresse, un dossier…"
              onChange={(event) => update({ search: event.target.value })}
              autoComplete="off"
            />
            {filters.search && (
              <button
                className="clients-clear"
                type="button"
                aria-label="Effacer la recherche clients"
                onClick={() => update({ search: "" })}
              >
                <X size={16} />
              </button>
            )}
          </div>
          <button
            className={`clients-filter-toggle ${showFilters ? "is-active" : ""}`}
            type="button"
            aria-label={`Filtres${activeFilterCount ? `, ${activeFilterCount} actifs` : ""}`}
            aria-expanded={showFilters}
            aria-controls="clients-filters"
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal size={17} />
            <span>
              Filtres{activeFilterCount ? ` (${activeFilterCount})` : ""}
            </span>
          </button>
          <div
            className="clients-view-toggle"
            aria-label="Présentation des dossiers"
          >
            <button
              type="button"
              aria-label="Afficher en tableau"
              aria-pressed={view === "list"}
              className={view === "list" ? "is-active" : ""}
              onClick={() => setView("list")}
            >
              <List size={18} />
            </button>
            <button
              type="button"
              aria-label="Afficher en cartes"
              aria-pressed={view === "cards"}
              className={view === "cards" ? "is-active" : ""}
              onClick={() => setView("cards")}
            >
              <Grid2X2 size={17} />
            </button>
          </div>
        </div>

        <div
          id="clients-filters"
          className={`clients-filter-row ${showFilters ? "is-open" : ""}`}
        >
          <label className="clients-select-field">
            <span>Équipe</span>
            <select
              value={filters.team}
              onChange={(event) => update({ team: event.target.value })}
            >
              {availableTeams.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <label className="clients-select-field">
            <span>Gamme / volet</span>
            <select
              value={filters.model}
              onChange={(event) => update({ model: event.target.value })}
            >
              {MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <label className="clients-select-field clients-sort">
            <span>
              <ArrowDownUp size={13} aria-hidden="true" /> Trier par
            </span>
            <select
              value={filters.sort}
              onChange={(event) =>
                update({ sort: event.target.value as ClientFilters["sort"] })
              }
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === "solde_desc" || option.value === "ht_desc" ? `${option.label} · historique non vérifié` : option.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <button
            className="clients-reset"
            type="button"
            onClick={() => {
              onFiltersChange({ ...DEFAULT_FILTERS });
              setLimit(60);
            }}
          >
            <X size={14} />
            Réinitialiser
          </button>
        </div>

        <div
          className="clients-quick-search"
          aria-label="Raccourcis de recherche"
        >
          <span>Accès rapide</span>
          {quickSearches.map((query) => (
            <button
              key={query}
              type="button"
              aria-pressed={filters.search === query}
              onClick={() =>
                update({ search: filters.search === query ? "" : query })
              }
            >
              {query}
            </button>
          ))}
        </div>

        <div className="clients-results-bar">
          <p aria-live="polite" aria-atomic="true">
            <strong>{filtered.length}</strong> dossier
            {filtered.length !== 1 ? "s" : ""}
            {hasFilters && <span> sur {clients.length}</span>}
          </p>
          <label className="clients-direct">
            <span className="clients-sr-only">
              Ouvrir directement une fiche parmi les résultats
            </span>
            <select
              aria-label="Ouvrir directement une fiche parmi les résultats"
              value={selectedClient?.id ?? ""}
              onChange={(event) =>
                event.target.value && onSelect(event.target.value)
              }
            >
              <option value="">Ouvrir un dossier…</option>
              {filtered.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.id} · {client.client}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
        </div>

        {filtered.length === 0 ? (
          <div className="clients-empty">
            <div className="clients-empty-icon">
              <Search size={26} />
            </div>
            <h2>Aucun dossier trouvé</h2>
            <p>
              Essayez un autre nom ou élargissez les filtres pour retrouver
              votre client.
            </p>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onFiltersChange({ ...DEFAULT_FILTERS })}
            >
              Effacer les filtres
            </button>
          </div>
        ) : view === "cards" ? (
          <div className="clients-cards">
            {visible.map((client) => (
              <button
                key={client.id}
                type="button"
                className={`clients-card ${selectedId === client.id ? "is-selected" : ""}`}
                onClick={() => onSelect(client.id)}
                aria-label={`Ouvrir le dossier ${client.client}, ${client.id}`}
              >
                <div className="clients-card-top">
                  <span className="clients-avatar">
                    {initials(client.client)}
                  </span>
                  <span
                    className={`clients-badge clients-badge-${client.category}`}
                  >
                    {client.category === "valide" && <Check size={11} />}
                    {categoryLabel[client.category]}
                  </span>
                </div>
                <h2>{client.client}</h2>
                <span className="clients-id">{client.id}</span>
                <p className="clients-card-address">
                  <MapPin size={14} aria-hidden="true" />
                  {client.address || "Adresse non renseignée"}
                </p>
                <p className="clients-card-model">
                  {client.modelTeam || "Équipe à renseigner"}
                </p>
                <div className="clients-card-bottom">
                  <span>
                    Solde vérifié : <strong>Non vérifié</strong>
                  </span>
                  <span className="clients-card-open">
                    Voir le dossier
                    <ArrowRight size={15} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div
            className="clients-table-scroll"
            role="region"
            aria-label="Tableau des clients, défilement horizontal disponible"
            tabIndex={0}
          >
            <table className="clients-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Localisation</th>
                  <th scope="col">Gamme & équipe</th>
                  <th scope="col">Technique</th>
                  <th scope="col">Informations financières</th>
                  <th scope="col">Statut</th>
                  <th scope="col" className="clients-th-number">
                    Solde vérifié
                  </th>
                  <th scope="col">
                    <span className="clients-sr-only">Ouvrir la fiche</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((client) => (
                  <tr
                    key={client.id}
                    className={selectedId === client.id ? "is-selected" : ""}
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button"))
                        onSelect(client.id);
                    }}
                  >
                    <td>
                      <button
                        className="clients-name-button"
                        type="button"
                        onClick={() => onSelect(client.id)}
                        aria-label={`Ouvrir le dossier ${client.client}, ${client.id}`}
                      >
                        <span className="clients-avatar">
                          {initials(client.client)}
                        </span>
                        <span>
                          <strong>{client.client}</strong>
                          <span>{client.id}{enrichedClientIds.includes(client.id) ? " · Fiche 360°" : ""}</span>
                        </span>
                      </button>
                    </td>
                    <td>
                      <span className="clients-cell-text clients-location">
                        {client.address || "—"}
                      </span>
                    </td>
                    <td>
                      <span className="clients-cell-text">
                        {client.modelTeam || "—"}
                      </span>
                    </td>
                    <td>
                      <span className="clients-cell-text">
                        {client.techMacon || "—"}
                      </span>
                    </td>
                    <td>
                      <span className="clients-cell-text">
                        {client.finance || "—"}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`clients-badge clients-badge-${client.category}`}
                      >
                        {client.category === "valide" && <Check size={11} />}
                        {categoryLabel[client.category]}
                      </span>
                    </td>
                    <td className="clients-cell-amount">Non vérifié</td>
                    <td>
                      <button
                        type="button"
                        className="clients-open-button"
                        aria-label={`Consulter ${client.client}`}
                        onClick={() => onSelect(client.id)}
                      >
                        <ArrowRight size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="clients-pagination">
            <span>
              <strong>{Math.min(limit, filtered.length)}</strong> sur{" "}
              {filtered.length} dossiers affichés
            </span>
            <div>
              {limit < filtered.length ? (
                <>
                  <button
                    type="button"
                    className="clients-show-all"
                    onClick={() => setLimit(filtered.length)}
                  >
                    Tout afficher
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setLimit((current) => current + 100)}
                  >
                    Afficher {Math.min(100, filtered.length - limit)} de plus
                    <ChevronDown size={15} />
                  </button>
                </>
              ) : (
                <span className="clients-all-shown">
                  <Check size={14} />
                  Tous les résultats sont affichés
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      {selectedClient && (
        enrichedClientIds.includes(selectedClient.id) ? <ClientDetail360
          clientId={selectedClient.id}
          onClose={closeDetail}
        /> : <ClientDetail
          key={selectedClient.id}
          client={selectedClient}
          records={records}
          source={source}
          onClose={closeDetail}
          onNotify={onNotify}
        />
      )}
    </section>
  );
}

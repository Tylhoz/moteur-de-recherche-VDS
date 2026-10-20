import {
  ChevronRight,
  FolderOpen,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { Category, Client, RecordKind, Snapshot } from "../types";
import { DEFAULT_FILTERS, filterClients } from "../lib/clients";
import { categoryLabel, initials } from "../lib/format";
import "./workspace.css";

interface WorkspaceProps {
  kind: RecordKind;
  snapshot: Snapshot;
  onSelectClient: (id: string) => void;
}

const moduleConfig = {
  devis: {
    title: "Devis",
    description: "Retrouvez les dossiers à rapprocher de vos devis.",
  },
  ventes: {
    title: "Ventes",
    description:
      "Retrouvez les dossiers dont les informations commerciales restent à vérifier.",
  },
  chantiers: {
    title: "Chantiers",
    description:
      "Les informations techniques et les équipes, dossier par dossier.",
  },
  factures: {
    title: "Factures",
    description: "Retrouvez les dossiers à rapprocher de vos factures.",
  },
  sav: {
    title: "SAV",
    description:
      "Retrouvez les dossiers de suivi après-vente et de pose.",
  },
};

const isRelated = (client: Client, kind: RecordKind) => {
  if (kind === "sav") return client.category === "sav";
  if (kind === "factures") return (client.soldeAmount !== null && client.soldeAmount > 0) || /facture|solde/i.test(client.finance);
  if (kind === "devis")
    return client.category === "solde" || /devis/i.test(client.finance);
  if (kind === "ventes") return (client.contractHT !== null && client.contractHT > 0) || /contrat|signé|accepté/i.test(client.finance);
  return Boolean(client.modelTeam.trim() || client.techMacon.trim());
};

const relatedDescriptions = {
  devis:
    "Dossiers classés « À suivre » ou mentionnant un devis dans leurs informations financières.",
  ventes: "Dossiers comportant une mention contractuelle historique, à vérifier dans les sources.",
  chantiers: "Dossiers comportant des informations techniques ou une équipe.",
  factures:
    "Dossiers mentionnant une facture ou un solde historique. Ces mentions ne prouvent pas un impayé.",
  sav: "Dossiers de la catégorie « SAV & pose ». Ils pourront être rapprochés de vos tickets.",
};

export default function Workspace({
  kind,
  snapshot,
  onSelectClient,
}: WorkspaceProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | Category>("all");
  const [limit, setLimit] = useState(40);
  const searchId = useId();
  const categoryId = useId();
  const config = moduleConfig[kind];
  // An unclassified source is an incomplete inventory, never proof of zero activity.
  const hasSourceInventory = snapshot.moduleClientIds !== undefined;
  const hasUnverifiedCategories = !hasSourceInventory && snapshot.clients.some(
    client => client.category === "non_verifie",
  );

  const related = useMemo(
    () => hasSourceInventory
      ? snapshot.clients.filter(client => (snapshot.moduleClientIds?.[kind] ?? []).includes(client.id))
      : hasUnverifiedCategories
      ? snapshot.clients
      : snapshot.clients.filter((client) => isRelated(client, kind)),
    [snapshot.clients, snapshot.moduleClientIds, kind, hasUnverifiedCategories, hasSourceInventory],
  );
  const filtered = useMemo(
    () =>
      filterClients(related, {
        ...DEFAULT_FILTERS,
        search,
        status: category,
        sort: "id_asc",
      }),
    [related, search, category],
  );

  useEffect(() => {
    setSearch("");
    setCategory("all");
    setLimit(40);
  }, [kind]);
  useEffect(() => {
    setLimit(40);
  }, [search, category]);

  const reset = () => {
    setSearch("");
    setCategory("all");
    setLimit(40);
  };

  return (
    <div className="workspace-page">
      <div className="workspace-heading">
        <div>
          <div className="dashboard-eyebrow">VOTRE APERÇU PRIVÉ</div>
          <h1>{config.title}</h1>
          <p>{config.description}</p>
        </div>
      </div>

      <div className="workspace-source-note">
        <span className="workspace-source-icon">
          <FolderOpen size={23} />
        </span>
        <div>
          <strong>{hasUnverifiedCategories ? "Classement métier non vérifié" : hasSourceInventory ? "Dossiers rattachés aux tables métier" : "Mentions historiques à rapprocher"}</strong>
          <p>
            {hasSourceInventory ? "Ces dossiers possèdent des lignes dans les tables de cette rubrique. Les statuts et montants restent des observations à vérifier ; ouvrez la fiche 360° pour les détails et les sources." : hasUnverifiedCategories
              ? `Informations insuffisantes pour établir les dossiers de la rubrique « ${config.title} ». Tous les dossiers disponibles restent consultables ci-dessous, sans leur attribuer ce statut métier. Les éléments documentés se trouvent dans les fiches 360°.`
              : "Consultez les dossiers en lecture seule. Les rubriques ci-dessous regroupent les mentions historiques ; les pièces et informations documentées se trouvent dans les fiches 360°. Une mention de vente ou de solde ne certifie pas un contrat ou un encaissement."}
          </p>
        </div>
        <span className="workspace-source-chip">{snapshot.connection.sheetReady ? "Lecture Google Sheets" : "Archive réelle"}</span>
      </div>

      <section className="workspace-content" aria-label="Dossiers associés">
        <div className="workspace-toolbar">
          <div className="workspace-search">
            <Search size={18} aria-hidden="true" />
            <label className="workspace-visually-hidden" htmlFor={searchId}>
              Rechercher dans les dossiers associés
            </label>
            <input
              id={searchId}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Rechercher un dossier, un client…"
              autoComplete="off"
            />
            {search && (
              <button
                type="button"
                className="workspace-search-clear"
                aria-label="Effacer la recherche"
                onClick={() => setSearch("")}
              >
                <X size={15} />
              </button>
            )}
          </div>
          <div className="workspace-toolbar-actions">
            <div className="workspace-filter">
              <SlidersHorizontal size={15} aria-hidden="true" />
              <label className="workspace-visually-hidden" htmlFor={categoryId}>
                Catégorie transmise par la source
              </label>
              <select
                id={categoryId}
                value={category}
                onChange={(event) =>
                  setCategory(event.target.value as "all" | Category)
                }
              >
                <option value="all">Toutes les catégories source</option>
                {Object.entries(categoryLabel).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="workspace-results-heading">
          <strong aria-live="polite" aria-atomic="true">
            {hasSourceInventory ? "Dossiers liés à cette rubrique" : hasUnverifiedCategories ? "Dossiers consultables" : "Dossiers à rapprocher"} <span>{filtered.length}</span>
          </strong>
          <small>{hasSourceInventory ? "Nombre de références de dossiers distinctes, pas nombre de tickets ni de factures." : hasUnverifiedCategories ? `Ce nombre indique les dossiers consultables. Leur affectation à la rubrique « ${config.title} » reste non vérifiée.` : relatedDescriptions[kind]}</small>
        </div>

        {filtered.length ? (
          <>
            <div className="workspace-related-grid">
              {filtered.slice(0, limit).map((client) => (
                <button
                  type="button"
                  key={client.id}
                  className="workspace-related-card"
                  onClick={() => onSelectClient(client.id)}
                  aria-label={`Ouvrir le dossier ${client.client}, ${client.id}`}
                >
                  <span className="dashboard-avatar">
                    {initials(client.client)}
                  </span>
                  <span className="workspace-related-name">
                    <strong>{client.client}</strong>
                    <small>Dossier {client.id}{snapshot.enrichedClientIds?.includes(client.id) ? " · Fiche 360°" : " · Non enrichi"}</small>
                    <span
                      className={`workspace-category workspace-category-${client.category}`}
                    >
                      {categoryLabel[client.category]}
                    </span>
                  </span>
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              ))}
            </div>
            <div className="workspace-load-more">
              <span>
                {Math.min(limit, filtered.length)} sur {filtered.length}{" "}
                dossiers
              </span>
              {filtered.length > limit && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setLimit((value) => value + 40)}
                >
                  Afficher {Math.min(40, filtered.length - limit)} dossiers de
                  plus
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="workspace-empty">
            <span>
              <Search size={28} />
            </span>
            <h3>
              {search || category !== "all"
                ? "Aucun résultat pour ces critères"
                : "Informations insuffisantes"}
            </h3>
            <p>
              {search || category !== "all"
                ? "Essayez une autre recherche ou réinitialisez les filtres."
                : "La source ne fournit pas de dossiers rapprochés pour cette rubrique. Cela ne permet pas de conclure à l’absence d’activité."}
            </p>
            {(search || category !== "all") && (
              <button
                type="button"
                className="button button-secondary"
                onClick={reset}
              >
                Réinitialiser les filtres
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  BookmarkCheck,
  BookmarkPlus,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  FileQuestion,
  FileSignature,
  FileText,
  History,
  LockKeyhole,
  MessageSquareMore,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { Category, Client } from "../types";
import { clientIdentityKey, DEFAULT_FILTERS, filterClients } from "../lib/clients";
import Modal from "./Modal";
import { AUTHENTICATION_REQUIRED_EVENT } from "../data/api-client";
import "./validation-center.css";
import "./real-validation-center.css";

type ReviewEvent = {
  id: string;
  kind: "note" | "marked" | "unmarked";
  at: string;
  text: string;
  source: string;
};
type SessionReview = { identity: string; marked: boolean; events: ReviewEvent[] };

const categoryLabels: Record<Category, string> = {
  alerte: "Alerte",
  solde: "Solde",
  sav: "SAV",
  valide: "Validé dans le portail",
  non_verifie: "Non vérifié",
};
const categoryRank: Record<Category, number> = {
  alerte: 0,
  solde: 1,
  sav: 2,
  valide: 3,
  non_verifie: 4,
};
const euros = (amount: number | null) =>
  amount !== null && Number.isFinite(amount)
    ? new Intl.NumberFormat("fr-BE", {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      }).format(amount)
    : "Non vérifié";
const dateTime = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("fr-FR", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Bangkok",
      }).format(new Date(value))
    : "Date non renseignée";
const sourceIdentity = (client: Client) =>
  JSON.stringify([
    client.id,
    client.client,
    client.contact,
    client.contractHT,
    client.soldeAmount,
    client.finance,
    client.statusAction,
  ]);
/** Memory-only and identity-bound: a recycled ID never inherits another person's review. */
export function createSessionReviewMemory() {
  let entries: Record<string, SessionReview> = {};
  let observedIdentities = new Map<string, string>();
  return {
    reconcile(clients: Client[]) {
      observedIdentities = new Map(clients.map(client => [client.id, clientIdentityKey(client)]));
      const retained = Object.entries(entries).filter(([id, review]) => observedIdentities.get(id) === review.identity);
      if (retained.length !== Object.keys(entries).length) entries = Object.fromEntries(retained);
      return entries;
    },
    append(client: Client, kind: ReviewEvent["kind"], text: string) {
      const identity = clientIdentityKey(client);
      // A handler captured before a source update must not restore the old person's notes.
      if (observedIdentities.get(client.id) !== identity) return false;
      const previous = entries[client.id]?.identity === identity
        ? entries[client.id] : { identity, marked: false, events: [] };
      entries = { ...entries, [client.id]: {
        identity,
        marked: kind === "marked" ? true : kind === "unmarked" ? false : previous.marked,
        events: [...previous.events, {
          id: `${client.id}:${previous.events.length}`, kind, at: new Date().toISOString(), text,
          source: sourceIdentity(client),
        }],
      } };
      return true;
    },
    clear() { entries = {}; observedIdentities.clear(); },
  };
}
const sessionReviewMemory = createSessionReviewMemory();
// This module outlives the mounted view; logout also clears notes while another page is open.
if (typeof window !== "undefined") {
  window.addEventListener(AUTHENTICATION_REQUIRED_EVENT, () => sessionReviewMemory.clear());
}

const prioritySort = (clients: Client[]) =>
  [...clients].sort(
    (a, b) =>
      categoryRank[a.category] - categoryRank[b.category] ||
      a.id.localeCompare(b.id, "fr", { numeric: true }),
  );

export default function RealValidationCenter({
  clients,
  snapshotAt,
  sourceLabel = "Source historique",
  enrichedClientIds = [],
  onSelectClient,
}: {
  clients: Client[];
  snapshotAt: string;
  sourceLabel?: string;
  enrichedClientIds?: string[];
  onSelectClient?: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    () => prioritySort(clients)[0]?.id ?? null,
  );
  const initialized = useRef(clients.length > 0);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category | "all">("all");
  const [markedOnly, setMarkedOnly] = useState(false);
  const [limit, setLimit] = useState(20);
  const [, redrawReviews] = useState(0);
  // Reconcile before reading anything for this render, including counts and filters.
  // Purging is deliberately synchronous so a remount cannot resurrect a recycled identity.
  const reviews = sessionReviewMemory.reconcile(clients);
  const [draft, setDraft] = useState({ identity: "", text: "" });
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"source" | "missing" | null>(null);
  const searched = useMemo(
    () =>
      prioritySort(
        filterClients(clients, { ...DEFAULT_FILTERS, search, sort: "id_asc" }),
      ),
    [clients, search],
  );
  const categoryCounts = useMemo(
    () =>
      searched.reduce(
        (result, client) => {
          result[client.category]++;
          return result;
        },
        { alerte: 0, solde: 0, sav: 0, valide: 0, non_verifie: 0 },
      ),
    [searched],
  );
  const filtered = useMemo(
    () =>
      searched.filter(
        (client) =>
          (category === "all" || client.category === category) &&
          (!markedOnly || reviews[client.id]?.marked),
      ),
    [searched, category, markedOnly, reviews],
  );
  const item = filtered.find((client) => client.id === selectedId);
  const enriched = Boolean(item && enrichedClientIds.includes(item.id));
  const note = item && draft.identity === clientIdentityKey(item) ? draft.text : "";
  const setNote = (text: string) => setDraft({ identity: item ? clientIdentityKey(item) : "", text });
  const review = item ? reviews[item.id] : undefined;
  const markedCount = clients.reduce(
    (count, client) => count + Number(!!reviews[client.id]?.marked),
    0,
  );
  const alertCount = clients.reduce(
    (count, client) => count + Number(client.category === "alerte"),
    0,
  );
  const hasUnverifiedCategories = clients.some(client => client.category === "non_verifie");
  const alertFilter: Category = hasUnverifiedCategories ? "non_verifie" : "alerte";
  const events = review ? [...review.events].reverse() : [];
  useEffect(() => {
    const clearReviews = () => {
      sessionReviewMemory.clear();
      redrawReviews(value => value + 1);
      setDraft({ identity: "", text: "" });
      setNotice("");
      setModal(null);
    };
    window.addEventListener(AUTHENTICATION_REQUIRED_EVENT, clearReviews);
    return () => window.removeEventListener(AUTHENTICATION_REQUIRED_EVENT, clearReviews);
  }, []);
  useEffect(() => {
    if (!initialized.current && clients.length) {
      initialized.current = true;
      setSelectedId(prioritySort(clients)[0].id);
    }
  }, [clients]);
  useEffect(() => {
    setLimit(20);
  }, [search, category, markedOnly]);
  useEffect(() => {
    setModal(null);
    setNote("");
  }, [selectedId, item?.client, item?.contact]);
  useEffect(() => {
    if (!item) setModal(null);
  }, [item]);

  function selectClient(id: string) {
    setSelectedId(id);
    setNote("");
    setNotice("");
  }
  function addEvent(kind: ReviewEvent["kind"], text: string) {
    if (!item) return;
    if (!sessionReviewMemory.append(item, kind, text)) return;
    redrawReviews(value => value + 1);
    setNotice(
      kind === "note"
        ? "Note de revue ajoutée pour cette session. Aucune donnée source modifiée."
        : kind === "marked"
          ? "Dossier marqué pour vérification dans cette session."
          : "Marqueur de cette session retiré.",
    );
  }
  function saveNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    addEvent("note", note.trim());
    setNote("");
  }
  function resetFilters() {
    setSearch("");
    setCategory("all");
    setMarkedOnly(false);
  }

  return (
    <div className="vc rvc">
      <header className="vc-page-heading">
        <div>
          <p className="vc-eyebrow">VDS POOLS 360° · REVUE DES DOSSIERS</p>
          <h1>Centre de validation</h1>
          <p>Vos dossiers, leurs pièces sources et les points à vérifier.</p>
        </div>
        <span className="rvc-private-label">
          <LockKeyhole size={15} />
          Espace privé
        </span>
      </header>
      <div className="vc-demo-banner rvc-source-banner">
        <Database size={18} />
        <span>
          <strong>{sourceLabel}</strong> · Valeurs d’origine non vérifiées.
          {" "}{enrichedClientIds.length} fiches enrichies disponibles : ouvrez une fiche 360° pour ses preuves et contradictions.
        </span>
      </div>
      <div className="vc-summary">
        <button
          className={`vc-summary-card ${category === "all" && !markedOnly ? "is-active" : ""}`}
          onClick={resetFilters}
          aria-pressed={category === "all" && !markedOnly}
        >
          <span className="vc-summary-icon rvc-summary-neutral">
            <Users size={21} />
          </span>
          <span>
            <span className="vc-summary-label">Dossiers disponibles</span>
            <strong>
              {clients.length}
              <small>dans la copie privée</small>
            </strong>
          </span>
        </button>
        <button
          className={`vc-summary-card vc-open ${category === alertFilter && !markedOnly ? "is-active" : ""}`}
          onClick={() => {
            setCategory(
              category === alertFilter && !markedOnly ? "all" : alertFilter,
            );
            setMarkedOnly(false);
          }}
          aria-pressed={category === alertFilter && !markedOnly}
        >
          <span className="vc-summary-icon">
            <CircleAlert size={21} />
          </span>
          <span>
            <span className="vc-summary-label">{hasUnverifiedCategories ? "Classement des alertes" : "Alertes du portail"}</span>
            <strong>
              {hasUnverifiedCategories ? "Non vérifié" : alertCount}
              <small>{hasUnverifiedCategories ? "statuts à contrôler" : "statuts d’origine"}</small>
            </strong>
          </span>
        </button>
        <button
          className={`vc-summary-card vc-waiting ${markedOnly ? "is-active" : ""}`}
          onClick={() => {
            setMarkedOnly(!markedOnly);
            setCategory("all");
          }}
          aria-pressed={markedOnly}
        >
          <span className="vc-summary-icon">
            <BookmarkCheck size={21} />
          </span>
          <span>
            <span className="vc-summary-label">Marqués à vérifier</span>
            <strong>
              {markedCount}
              <small>dans cette session</small>
            </strong>
          </span>
        </button>
      </div>
      <div className="vc-workspace">
        <aside className="vc-queue" aria-label="Dossiers à examiner">
          <div className="vc-queue-heading">
            <h2>Vos dossiers</h2>
            <span>{filtered.length}</span>
          </div>
          <div className="rvc-search">
            <Search size={16} />
            <input
              aria-label="Rechercher un dossier à vérifier"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Client, dossier, montant…"
            />
            {search && (
              <button
                aria-label="Effacer la recherche des contrôles"
                onClick={() => setSearch("")}
              >
                ×
              </button>
            )}
          </div>
          <label className="sr-only" htmlFor="rvc-category">
            Catégorie du portail
          </label>
          <select
            id="rvc-category"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value as Category | "all");
              setMarkedOnly(false);
            }}
          >
            <option value="all">
              Toutes les catégories ({searched.length})
            </option>
            {(["alerte", "solde", "sav", "valide", "non_verifie"] as const).map((value) => (
              <option value={value} key={value}>
                {categoryLabels[value]} ({categoryCounts[value]})
              </option>
            ))}
          </select>
          {markedOnly && (
            <div className="rvc-marker-filter">
              Marqués dans cette session
              <button
                onClick={() => setMarkedOnly(false)}
                aria-label="Retirer le filtre des dossiers marqués"
              >
                ×
              </button>
            </div>
          )}
          <div className="vc-case-list">
            {filtered.slice(0, limit).map((client) => (
              <button
                key={client.id}
                className={`vc-case ${client.id === item?.id ? "is-selected" : ""}`}
                aria-pressed={client.id === item?.id}
                onClick={() => selectClient(client.id)}
              >
                <span
                  className={`vc-status ${client.category === "alerte" ? "vc-open" : "rvc-category-neutral"}`}
                >
                  <CircleAlert size={13} />
                  {categoryLabels[client.category]}
                </span>
                <strong>{client.client}</strong>
                <span>Dossier {client.id}</span>
                <small>
                  {client.statusAction ||
                    "Consulter les informations du dossier"}
                </small>
                <span className="vc-case-footer">
                  {reviews[client.id]?.marked ? (
                    <>
                      <BookmarkCheck size={14} />
                      Marqué à vérifier
                    </>
                  ) : (
                    "Examiner le dossier"
                  )}
                  <ChevronRight size={16} />
                </span>
              </button>
            ))}
          </div>
          {!filtered.length && (
            <div className="vc-empty">
              <p>Aucun dossier ne correspond à ces critères.</p>
              <button className="vc-link-button" onClick={resetFilters}>
                Réinitialiser les filtres
              </button>
            </div>
          )}
          {filtered.length > 0 && (
            <div className="rvc-pagination">
              <span>
                {Math.min(limit, filtered.length)} sur {filtered.length}{" "}
                dossiers
              </span>
              {limit < filtered.length && (
                <button
                  className="button button-secondary"
                  onClick={() => setLimit((previous) => previous + 20)}
                >
                  Afficher 20 dossiers de plus
                </button>
              )}
            </div>
          )}
        </aside>
        <div className="vc-detail">
          {!item ? (
            <section className="vc-panel rvc-no-selection">
              <ShieldCheck size={34} />
              <h2>
                {filtered.length
                  ? "Sélectionnez un dossier"
                  : "Aucun dossier à afficher"}
              </h2>
              <p>
                {filtered.length
                  ? "Choisissez un dossier dans la liste pour examiner sa source et consigner votre revue."
                  : "Ajustez la recherche ou les catégories pour retrouver vos dossiers."}
              </p>
              {filtered.length > 0 && (
                <button
                  className="button button-secondary"
                  onClick={() => selectClient(filtered[0].id)}
                >
                  Examiner le premier résultat
                  <ArrowRight size={16} />
                </button>
              )}
            </section>
          ) : (
            <>
              <section
                className="vc-panel vc-comparison"
                aria-labelledby="rvc-control-title"
              >
                <div className="vc-control-heading">
                  <div>
                    <p className="vc-eyebrow">DOSSIER {item.id}</p>
                    <h2 id="rvc-control-title">{item.client}</h2>
                    <p>
                      Montant contractuel et pièces justificatives
                      <span>{item.modelTeam}</span>
                    </p>
                  </div>
                  <span className="vc-status vc-waiting">
                    <FileQuestion size={15} />
                    Pièces à compléter
                  </span>
                </div>
                {onSelectClient && (
                  <button
                    className="vc-link-button vc-client-link"
                    onClick={() => onSelectClient(item.id)}
                  >
                    Ouvrir la fiche client
                    <ArrowRight size={14} />
                  </button>
                )}
                <div className="vc-sources">
                  <article className="vc-source">
                    <div className="vc-source-heading">
                      <span className="vc-source-icon">
                        <Database size={22} />
                      </span>
                      <div>
                        <h3>Valeur d’origine</h3>
                        <small>Montant contractuel déclaré</small>
                      </div>
                    </div>
                    <div className="vc-money">
                      {euros(item.contractHT)}
                      {Number.isFinite(item.contractHT) && <span>HT</span>}
                    </div>
                    <dl>
                      <div>
                        <dt>Source disponible</dt>
                        <dd>{sourceLabel}</dd>
                      </div>
                      <div>
                        <dt>Champ d’origine</dt>
                        <dd>Montant contractuel HT</dd>
                      </div>
                      <div>
                        <dt>Vérification</dt>
                        <dd>Non rapproché d’un devis</dd>
                      </div>
                    </dl>
                    <button
                      className="vc-document-button"
                      onClick={() => setModal("source")}
                    >
                      <FileText size={16} />
                      Examiner l’extrait source
                      <ArrowRight size={15} />
                    </button>
                    <div className="rvc-source-tag">
                      <Database size={13} />
                      Champ d’origine non vérifié
                    </div>
                  </article>
                  <article className="vc-source rvc-missing-source">
                    <div className="vc-source-heading">
                      <span className="vc-source-icon is-document">
                        <FileSignature size={22} />
                      </span>
                      <div>
                        <h3>Devis signé</h3>
                        <small>{enriched ? "Sources dans la fiche 360°" : "Pièce justificative à retrouver"}</small>
                      </div>
                    </div>
                    <div className="vc-money is-missing">
                      {enriched ? "Voir la fiche 360°" : "Information non retrouvée"}
                    </div>
                    <dl>
                      <div>
                        <dt>Montant documentaire</dt>
                        <dd>{enriched ? "Consulter les montants documentés dans la fiche" : "Information non retrouvée"}</dd>
                      </div>
                      <div>
                        <dt>Version et signature</dt>
                        <dd>À vérifier sur le document</dd>
                      </div>
                      <div>
                        <dt>Base fiscale et TVA</dt>
                        <dd>À confirmer</dd>
                      </div>
                    </dl>
                    <button
                      className="vc-document-button"
                      onClick={() => enriched && onSelectClient ? onSelectClient(item.id) : setModal("missing")}
                    >
                      <FileQuestion size={16} />
                      {enriched ? "Ouvrir les sources et documents" : "Voir la pièce attendue"}
                      <ArrowRight size={15} />
                    </button>
                    <div className="rvc-source-tag">
                      <LockKeyhole size={13} />
                      Validation indisponible
                    </div>
                  </article>
                </div>
                <div className="vc-gap">
                  <span>
                    <CircleAlert size={22} />
                  </span>
                  <div>
                    <strong>
                      {enriched ? "Rapprochement documenté dans la fiche 360°" : "Écart non calculable · preuve à retrouver"}
                    </strong>
                    <p>
                      {enriched ? "Les montants documentés et leurs éventuelles divergences sont présentés dans la fiche enrichie. Les valeurs d’origine restent conservées." : "Une comparaison financière nécessite un document identifiable et une correspondance d’identité fiable. Aucune valeur d’origine n’est remplacée."}
                    </p>
                  </div>
                </div>
                <div className="rvc-balance">
                  <div>
                    <span>Solde indiqué dans le portail</span>
                    <strong>{euros(item.soldeAmount)}</strong>
                  </div>
                  <p>
                    Valeur de la copie, sans rapprochement des encaissements. La
                    base HT/TTC de ce solde n’est pas précisée.
                  </p>
                </div>
              </section>
              <div className="vc-actions-grid">
                <section className="vc-panel vc-decision">
                  <div className="vc-section-heading">
                    <MessageSquareMore size={20} />
                    <h2>Votre revue du dossier</h2>
                  </div>
                  <p className="rvc-review-explanation">
                    Consignez un point à vérifier. Cette note de travail ne
                    valide aucun montant.
                  </p>
                  <button
                    className={`button ${review?.marked ? "button-primary" : "button-secondary"} rvc-mark-button`}
                    onClick={() =>
                      addEvent(
                        review?.marked ? "unmarked" : "marked",
                        review?.marked
                          ? "Marqueur de vérification retiré dans cette session."
                          : "Dossier marqué pour vérification dans cette session.",
                      )
                    }
                    aria-pressed={!!review?.marked}
                  >
                    {review?.marked ? (
                      <BookmarkCheck size={16} />
                    ) : (
                      <BookmarkPlus size={16} />
                    )}{" "}
                    {review?.marked
                      ? "Retirer le marqueur de vérification"
                      : "Marquer pour vérification"}
                  </button>
                  <form onSubmit={saveNote}>
                    <label htmlFor="rvc-note">
                      Note de revue <span>conservée pour cette session</span>
                    </label>
                    <textarea
                      id="rvc-note"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      rows={4}
                      maxLength={2000}
                      placeholder="Indiquez le document ou l’information à vérifier…"
                      required
                    />
                    <button
                      className="button button-primary vc-confirm-button rvc-save-note"
                      disabled={!note.trim()}
                    >
                      <MessageSquareMore size={16} />
                      Consigner la note
                    </button>
                    <p className="vc-form-hint">
                      Aucun envoi ni modification du dossier source.
                    </p>
                  </form>
                </section>
                <section className="vc-panel vc-consequences">
                  <div className="vc-section-heading">
                    <LockKeyhole size={19} />
                    <h2>Validation financière</h2>
                  </div>
                  <div className="vc-deposit">
                    <span>ACOMPTE DE 30 %</span>
                    <strong>Préparation bloquée</strong>
                    <p>
                      Le devis signé, son montant, sa base fiscale et sa
                      signature doivent être disponibles et vérifiés avant toute
                      préparation.
                    </p>
                    <button
                      className="button button-secondary"
                      disabled
                      aria-describedby="rvc-block-reason"
                    >
                      <ShieldCheck size={16} />
                      Confirmer un montant
                    </button>
                  </div>
                  <p id="rvc-block-reason" className="rvc-block-reason">
                    Une note de revue ou un statut « Validé » du portail ne
                    remplace pas une validation documentaire.
                  </p>
                  <ul className="vc-guards">
                    <li>
                      <Check size={16} />
                      Copie des données en lecture seule
                    </li>
                    <li>
                      <Check size={16} />
                      Aucun calcul d’acompte non vérifié
                    </li>
                    <li>
                      <Check size={16} />
                      Aucune facture émise ou envoyée
                    </li>
                    <li>
                      <Check size={16} />
                      Aucune écriture dans Google Sheets
                    </li>
                  </ul>
                </section>
              </div>
              <section className="vc-panel vc-history">
                <div className="vc-section-heading">
                  <History size={20} />
                  <h2>Journal de cette session</h2>
                  <span>
                    {events.length} entrée{events.length > 1 ? "s" : ""}
                  </span>
                </div>
                {!events.length ? (
                  <p className="rvc-empty-history">
                    Aucune note de revue pour ce dossier. Les statuts et
                    commentaires du portail restent consultables dans l’extrait
                    source.
                  </p>
                ) : (
                  <ol>
                    {events.map((event) => (
                      <li key={event.id}>
                        <span className="vc-history-dot" />
                        <div>
                          <strong>
                            {event.kind === "note"
                              ? "Note de revue consignée"
                              : event.kind === "marked"
                                ? "Dossier marqué à vérifier"
                                : "Marqueur retiré"}
                          </strong>
                          <p>{event.text}</p>
                          {event.source !== sourceIdentity(item) && (
                            <small className="rvc-old-note">
                              La copie du dossier a changé depuis cette entrée.
                            </small>
                          )}
                        </div>
                        <time dateTime={event.at}>{dateTime(event.at)}</time>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </div>
      <div className="vc-notice" role="status" aria-live="polite">
        {notice}
      </div>
      <footer className="vc-footer">
        <LockKeyhole size={15} />
        Notes et marqueurs conservés en mémoire uniquement ; ils disparaissent
        au rechargement.<span>Relevé fourni : {dateTime(snapshotAt)}</span>
      </footer>
      {item && modal === "source" && (
        <Modal
          title="Extrait du portail VDS Pools"
          onClose={() => setModal(null)}
          wide
        >
          <div className="vc-document-modal rvc-document">
            <div className="vc-document-label">
              <Database size={16} />
              COPIE DU PORTAIL · SOURCE UNIQUE DISPONIBLE
            </div>
            <div className="vc-paper">
              <div className="vc-paper-brand">
                VDS<span>POOLS 360°</span>
              </div>
              <h3>{item.client}</h3>
              <p>
                Dossier {item.id} · Relevé fourni : {dateTime(snapshotAt)}
              </p>
              <dl>
                <div>
                  <dt>Montant contractuel</dt>
                  <dd>{euros(item.contractHT)} HT</dd>
                </div>
                <div>
                  <dt>Solde indiqué</dt>
                  <dd>{euros(item.soldeAmount)} · base non précisée</dd>
                </div>
                <div>
                  <dt>Catégorie du portail</dt>
                  <dd>{categoryLabels[item.category]}</dd>
                </div>
              </dl>
              <section className="rvc-raw-field">
                <h4>Informations financières d’origine</h4>
                <p>
                  {item.finance ||
                    "Aucune information financière textuelle renseignée."}
                </p>
              </section>
              <section className="rvc-raw-field">
                <h4>Statut et action d’origine</h4>
                <p>
                  {item.statusAction ||
                    "Aucun statut ou action textuel renseigné."}
                </p>
              </section>
              <p className="vc-paper-note">
                Cet extrait restitue les valeurs d’origine de la source affichée. Il ne constitue ni un devis signé ni une preuve de paiement. Les dernières dates de lecture sont visibles dans Données & accès.
              </p>
            </div>
          </div>
        </Modal>
      )}
      {item && modal === "missing" && (
        <Modal title="Devis signé attendu" onClose={() => setModal(null)}>
          <div className="vc-modal-form rvc-expected-document">
            <FileSignature size={36} />
            <h3>Pièce non disponible pour ce dossier</h3>
            <p>
              La copie du portail ne contient pas le devis signé de{" "}
              <strong>{item.client}</strong> (dossier {item.id}). Aucun document
              n’a été fabriqué ou reconstitué.
            </p>
            <ul>
              <li>Devis complet et signé, avec sa référence et sa version.</li>
              <li>Montant contractuel, base HT/TTC et taux de TVA.</li>
              <li>Éventuels avenants ou options qui modifient le montant.</li>
            </ul>
            <p>
              Ces pièces devront être apportées par un futur import ou une
              connexion documentaire autorisée. Leur rapprochement avec le
              portail restera soumis à vérification humaine.
            </p>
            <button
              className="button button-primary"
              onClick={() => {
                setModal(null);
                addEvent(
                  "marked",
                  "Devis signé à retrouver pour permettre la comparaison du montant contractuel.",
                );
              }}
            >
              <BookmarkPlus size={16} />
              Marquer ce document à retrouver
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

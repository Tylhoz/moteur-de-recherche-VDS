import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowRight,
  BadgeCheck,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  FileCheck2,
  FileQuestion,
  FileSignature,
  FileText,
  History,
  LockKeyhole,
  MessageSquareMore,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { prepareDeposit, type Evidence } from "../domain/coherence";
import {
  applyDemoCommand,
  caseStatus,
  readDemoCommands,
  replayDemoCommands,
  VALIDATION_STORAGE_KEY,
  type DemoCommand,
  type DemoControlStatus,
} from "../data/validation-demo";
import Modal from "./Modal";
import "./validation-center.css";

const euros = (cents: number) =>
  new Intl.NumberFormat("fr-BE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
const date = (value: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  }).format(new Date(value));
const time = (value: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(new Date(value));
const statusLabel: Record<DemoControlStatus, string> = {
  open: "À vérifier",
  waiting: "À compléter",
  resolved: "Validé",
};
const statusIcon = { open: CircleAlert, waiting: Clock3, resolved: CheckCheck };

function initialState() {
  try {
    return {
      commands: readDemoCommands(localStorage.getItem(VALIDATION_STORAGE_KEY)),
      notice: "",
    };
  } catch {
    return {
      commands: [] as DemoCommand[],
      notice:
        "L’historique local ne peut pas être restauré. Les scénarios fictifs ont été réinitialisés.",
    };
  }
}

export default function ValidationCenter({
  onSelectClient,
}: {
  onSelectClient?: (id: string) => void;
}) {
  const [initial] = useState(initialState);
  const [commands, setCommands] = useState<DemoCommand[]>(initial.commands);
  const cases = useMemo(() => replayDemoCommands(commands), [commands]);
  const [caseId, setCaseId] = useState("DEMO-001");
  const [filter, setFilter] = useState<DemoControlStatus | "all">("all");
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState(initial.notice);
  const [error, setError] = useState("");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [modal, setModal] = useState<"info" | "reset" | "deposit" | null>(null);
  const [infoReason, setInfoReason] = useState("");
  const [storageAvailable, setStorageAvailable] = useState(true);
  const item = cases.find((value) => value.id === caseId)!;
  const status = caseStatus(item);
  const StatusIcon = statusIcon[status];
  const deposit = prepareDeposit(item.control, item.evidence);
  const sourceDocument = item.evidence.find(
    (source) => source.id === documentId,
  );
  const comparable = !["missing", "incomparable"].includes(
    item.control.signal.kind,
  );
  const chosen = item.evidence.find((source) => source.id === selected);
  const counts = cases.reduce(
    (result, value) => {
      result[caseStatus(value)]++;
      return result;
    },
    { open: 0, waiting: 0, resolved: 0 },
  );
  const visible = cases.filter(
    (value) => filter === "all" || caseStatus(value) === filter,
  );
  const difference =
    comparable && item.evidence.every((source) => source.amount)
      ? Math.abs(
          item.evidence[1].amount!.cents - item.evidence[0].amount!.cents,
        )
      : null;
  const differencePercent =
    difference !== null && item.evidence[0].amount?.cents
      ? new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(
          (difference * 100) / item.evidence[0].amount.cents,
        )
      : null;
  const history = [
    ...item.control.history.map((event, index) => ({
      id: `domain-${index}`,
      at: event.at,
      label:
        event.type === "resolved"
          ? "Montant confirmé par le validateur démo"
          : event.type === "invalidated"
            ? "Validation précédente invalidée"
            : "Comparaison des sources",
      reason: event.reason,
      resolved: event.type === "resolved",
    })),
    ...item.workflow.map((event) => ({ ...event, resolved: false })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  useEffect(() => {
    try {
      localStorage.setItem(
        VALIDATION_STORAGE_KEY,
        JSON.stringify({ schema: 1, commands }),
      );
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
    }
  }, [commands]);

  function selectCase(id: string) {
    setCaseId(id);
    setSelected("");
    setReason("");
    setConfirmed(false);
    setError("");
    setNotice("");
  }
  function dispatch(
    command: Omit<DemoCommand, "at" | "caseId">,
    message: string,
  ) {
    try {
      const fullCommand = { ...command, at: new Date().toISOString(), caseId };
      if (commands.length >= 500)
        throw new Error(
          "La démonstration a atteint 500 actions. Réinitialisez les scénarios pour continuer.",
        );
      applyDemoCommand(cases, fullCommand);
      setCommands((previous) => [...previous, fullCommand]);
      setSelected("");
      setConfirmed(false);
      setReason("");
      setError("");
      setNotice(message);
      setModal(null);
    } catch (value) {
      setError(
        value instanceof Error
          ? value.message
          : "Cette décision ne peut pas être enregistrée.",
      );
    }
  }
  function decide(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || !chosen || !reason.trim()) return;
    dispatch(
      { action: "resolve", evidenceId: selected, reason: reason.trim() },
      "Décision enregistrée dans cette démonstration. Les valeurs sources restent conservées.",
    );
  }
  function reset() {
    setCommands([]);
    setCaseId("DEMO-001");
    setFilter("all");
    setSelected("");
    setReason("");
    setConfirmed(false);
    setError("");
    setModal(null);
    setNotice("Les trois scénarios fictifs ont été réinitialisés.");
  }
  return (
    <div className="vc">
      <header className="vc-page-heading">
        <div>
          <p className="vc-eyebrow">VDS POOLS 360° · CONTRÔLE DE COHÉRENCE</p>
          <h1>Centre de validation</h1>
          <p>Les bonnes informations. Une décision éclairée.</p>
        </div>
        <button
          className="button button-secondary"
          onClick={() => setModal("reset")}
        >
          <RotateCcw size={16} /> Réinitialiser la démo
        </button>
      </header>
      <div className="vc-demo-banner">
        <Sparkles size={18} />
        <span>
          <strong>Démonstration interactive</strong> · Données fictives
          uniquement · Aucune écriture Google Sheets
        </span>
      </div>
      <div className="vc-summary">
        {(["open", "waiting", "resolved"] as const).map((value) => {
          const Icon = statusIcon[value];
          return (
            <button
              key={value}
              className={`vc-summary-card vc-${value} ${filter === value ? "is-active" : ""}`}
              onClick={() => setFilter(filter === value ? "all" : value)}
              aria-pressed={filter === value}
            >
              <span className="vc-summary-icon">
                <Icon size={21} />
              </span>
              <span>
                <span className="vc-summary-label">
                  {value === "resolved"
                    ? "Contrôles validés"
                    : statusLabel[value]}
                </span>
                <strong>
                  {counts[value]}
                  <small>
                    {value === "resolved"
                      ? "décision consignée"
                      : value === "waiting"
                        ? "complément attendu"
                        : "votre attention requise"}
                  </small>
                </strong>
              </span>
            </button>
          );
        })}
      </div>
      <div className="vc-workspace">
        <aside className="vc-queue" aria-label="Dossiers à contrôler">
          <div className="vc-queue-heading">
            <h2>Les contrôles</h2>
            <span>{visible.length}</span>
          </div>
          <label className="sr-only" htmlFor="vc-status-filter">
            Filtrer les contrôles
          </label>
          <select
            id="vc-status-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
          >
            <option value="all">Tous les contrôles</option>
            <option value="open">À vérifier</option>
            <option value="waiting">À compléter</option>
            <option value="resolved">Validés</option>
          </select>
          <div className="vc-case-list">
            {visible.map((value) => {
              const valueStatus = caseStatus(value),
                Icon = statusIcon[valueStatus];
              return (
                <button
                  key={value.id}
                  className={`vc-case ${value.id === item.id ? "is-selected" : ""}`}
                  aria-pressed={value.id === item.id}
                  onClick={() => selectCase(value.id)}
                >
                  <span className={`vc-status vc-${valueStatus}`}>
                    <Icon size={13} />
                    {statusLabel[valueStatus]}
                  </span>
                  <strong>{value.title}</strong>
                  <span>{value.client}</span>
                  <small>{value.issue}</small>
                  <span className="vc-case-footer">
                    {value.id}
                    <ChevronRight size={16} />
                  </span>
                </button>
              );
            })}
          </div>
          {!visible.length && (
            <p className="vc-empty">
              Aucun contrôle dans cette catégorie.
              <button
                className="vc-link-button"
                onClick={() => setFilter("all")}
              >
                Voir tous les contrôles
              </button>
            </p>
          )}
          <div className="vc-queue-note">
            <ShieldCheck size={22} />
            <strong>Vous gardez la décision.</strong>
            <p>Une divergence reste visible jusqu’à votre vérification.</p>
          </div>
        </aside>
        <div className="vc-detail">
          {filter !== "all" && status !== filter && (
            <div className="vc-filter-note">
              Le dossier sélectionné est maintenant « {statusLabel[status]} ».{" "}
              <button onClick={() => setFilter("all")}>
                Afficher tous les contrôles
              </button>
            </div>
          )}
          <section
            className="vc-panel vc-comparison"
            aria-labelledby="vc-control-title"
          >
            <div className="vc-control-heading">
              <div>
                <p className="vc-eyebrow">DOSSIER {item.id}</p>
                <h2 id="vc-control-title">{item.title}</h2>
                <p>
                  {item.client}
                  <span> · {item.description}</span>
                </p>
              </div>
              <span className={`vc-status vc-${status}`}>
                <StatusIcon size={15} />
                {statusLabel[status]}
              </span>
            </div>
            {onSelectClient && (
              <button
                className="vc-link-button vc-client-link"
                onClick={() => onSelectClient(item.id)}
              >
                Ouvrir la fiche de démonstration <ArrowRight size={14} />
              </button>
            )}
            <div className="vc-sources">
              {item.evidence.map((source, index) => {
                const Icon =
                  source.source.kind === "google_sheets"
                    ? Database
                    : source.source.kind === "signed_quote"
                      ? FileSignature
                      : FileText;
                const isSelected =
                  selected === source.id ||
                  item.control.resolution?.selectedEvidenceId === source.id;
                const verified =
                  source.verification &&
                  source.verification.evidenceRevision === source.revision &&
                  JSON.stringify(source.verification.verifiedAmount) ===
                    JSON.stringify(source.amount);
                return (
                  <article
                    className={`vc-source ${isSelected ? "is-selected" : ""}`}
                    key={source.id}
                  >
                    <div className="vc-source-heading">
                      <span
                        className={`vc-source-icon ${index === 1 ? "is-document" : ""}`}
                      >
                        <Icon size={22} />
                      </span>
                      <div>
                        <h3>{source.source.label}</h3>
                        <small>
                          {index === 0
                            ? "Extrait de feuille fictif"
                            : "Document de démonstration"}
                        </small>
                      </div>
                      {isSelected && (
                        <Check size={19} className="vc-selected-icon" />
                      )}
                    </div>
                    <div
                      className={`vc-money ${!source.amount ? "is-missing" : ""}`}
                    >
                      {source.amount
                        ? euros(source.amount.cents)
                        : "Non disponible"}
                      {source.amount && <span>{source.amount.taxBasis}</span>}
                    </div>
                    <dl>
                      <div>
                        <dt>Référence</dt>
                        <dd>
                          {item.id} ·{" "}
                          {index === 0 ? "Suivi clients" : "Pièce 01"}
                        </dd>
                      </div>
                      <div>
                        <dt>Version</dt>
                        <dd>
                          v{source.revision} · {date(source.observedAt)}
                        </dd>
                      </div>
                      <div>
                        <dt>
                          {source.source.kind === "signed_quote"
                            ? "Vérification"
                            : "TVA"}
                        </dt>
                        <dd>
                          {source.source.kind === "signed_quote"
                            ? verified
                              ? "Devis signé vérifié"
                              : "Devis signé à vérifier"
                            : source.amount
                              ? "21 %"
                              : "À confirmer"}
                        </dd>
                      </div>
                    </dl>
                    <button
                      className="vc-document-button"
                      onClick={() => setDocumentId(source.id)}
                    >
                      <FileText size={16} />
                      {source.amount
                        ? "Voir le document"
                        : "Voir la pièce attendue"}
                      <ArrowRight size={15} />
                    </button>
                    {!item.control.resolution && (
                      <button
                        className={`button ${isSelected ? "button-primary" : "button-secondary"} vc-select-source`}
                        disabled={!comparable || !source.amount}
                        aria-pressed={isSelected}
                        onClick={() => {
                          setSelected(source.id);
                          setConfirmed(false);
                          setError("");
                        }}
                      >
                        {isSelected ? (
                          <Check size={16} />
                        ) : (
                          <ShieldCheck size={16} />
                        )}{" "}
                        {isSelected
                          ? "Montant sélectionné"
                          : "Retenir ce montant"}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
            <div
              className={`vc-gap ${status === "resolved" ? "is-resolved" : ""}`}
            >
              <span>
                {status === "resolved" ? (
                  <CheckCheck size={22} />
                ) : (
                  <CircleAlert size={22} />
                )}
              </span>
              <div>
                <strong>
                  {item.control.resolution
                    ? `${euros(item.control.resolution.confirmedAmount.cents)} ${item.control.resolution.confirmedAmount.taxBasis} retenus après vérification`
                    : item.control.signal.kind === "incomparable"
                      ? "HT et TTC : comparaison bloquée"
                      : item.control.signal.kind === "missing"
                        ? "Une preuve manque : validation bloquée"
                        : difference
                          ? `Écart de ${euros(difference)}${differencePercent ? ` · ${differencePercent} %` : ""}`
                          : "Les montants concordent"}
                </strong>
                <p>
                  {item.control.resolution
                    ? "La décision est liée aux versions affichées. Chaque valeur source reste conservée."
                    : item.control.signal.kind === "incomparable"
                      ? "Les bases fiscales doivent être identiques avant de calculer un écart."
                      : item.control.signal.kind === "missing"
                        ? "Un paiement déclaré ne constitue pas une preuve d’encaissement."
                        : "Aucune correction automatique. Vérifiez les documents avant de confirmer."}
                </p>
              </div>
            </div>
          </section>
          <div className="vc-actions-grid">
            <section
              className="vc-panel vc-decision"
              aria-labelledby="vc-decision-title"
            >
              <div className="vc-section-heading">
                <ShieldCheck size={20} />
                <h2 id="vc-decision-title">Votre décision</h2>
              </div>
              {item.control.resolution ? (
                <div className="vc-resolved">
                  <span>
                    <CheckCheck size={28} />
                  </span>
                  <h3>Décision enregistrée</h3>
                  <p>{item.control.resolution.justification}</p>
                  <small>
                    Validateur démo · {time(item.control.resolution.at)}
                  </small>
                  <button
                    className="button button-secondary"
                    onClick={() =>
                      dispatch(
                        { action: "update-source" },
                        "Nouvelle version fictive reçue : la décision précédente est invalidée et conservée dans le journal.",
                      )
                    }
                  >
                    <RotateCcw size={16} />
                    Simuler une nouvelle version
                  </button>
                </div>
              ) : (
                <>
                  {item.waiting && (
                    <div className="vc-waiting-note">
                      <Clock3 size={16} />
                      <span>
                        Complément attendu. La validation reste en suspens.
                      </span>
                      <button
                        onClick={() =>
                          dispatch(
                            { action: "resume" },
                            "Le contrôle a été repris.",
                          )
                        }
                      >
                        Reprendre
                      </button>
                    </div>
                  )}
                  {!comparable ? (
                    <div className="vc-incomplete">
                      <FileQuestion size={28} />
                      <h3>
                        {item.control.signal.kind === "missing"
                          ? "Compléter les pièces sources"
                          : "Rapprocher les bases fiscales"}
                      </h3>
                      <p>{item.control.signal.summary}</p>
                      <button
                        className="button button-secondary"
                        onClick={() =>
                          dispatch(
                            { action: "complete-source" },
                            "Une nouvelle pièce fictive est disponible. Vérifiez-la avant de confirmer le montant.",
                          )
                        }
                      >
                        <FileCheck2 size={16} />
                        {item.control.signal.kind === "missing"
                          ? "Ajouter une preuve fictive"
                          : "Charger l’extrait HT fictif"}
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={decide}>
                      <label htmlFor="vc-reason">
                        Justification de la décision <span>obligatoire</span>
                      </label>
                      <textarea
                        id="vc-reason"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="Ex. Le devis signé inclut l’option reprise dans le contrat…"
                        rows={3}
                        maxLength={1200}
                        required
                      />
                      <label className="vc-checkbox">
                        <input
                          type="checkbox"
                          checked={confirmed}
                          onChange={(event) =>
                            setConfirmed(event.target.checked)
                          }
                        />
                        <span>
                          J’ai vérifié le document et je confirme le montant
                          retenu.
                          {chosen?.source.kind === "signed_quote" && (
                            <small>
                              Cette confirmation vérifie ce devis signé, dans sa
                              version actuelle.
                            </small>
                          )}
                        </span>
                      </label>
                      <button
                        className="button button-primary vc-confirm-button"
                        disabled={!selected || !reason.trim() || !confirmed}
                      >
                        <ShieldCheck size={17} />
                        Confirmer la décision
                      </button>
                      <p className="vc-form-hint">
                        {selected
                          ? `${euros(chosen!.amount!.cents)} ${chosen!.amount!.taxBasis} · ${chosen!.source.label}`
                          : "Sélectionnez d’abord un montant dans les sources ci-dessus."}
                      </p>
                    </form>
                  )}
                  <button
                    className="vc-link-button vc-info-button"
                    onClick={() => {
                      setInfoReason("");
                      setModal("info");
                    }}
                  >
                    <MessageSquareMore size={16} />
                    Marquer « À compléter »
                  </button>
                </>
              )}
            </section>
            <section className="vc-panel vc-consequences">
              <div className="vc-section-heading">
                <LockKeyhole size={19} />
                <h2>Avant l’étape suivante</h2>
              </div>
              <div
                className={`vc-deposit ${deposit.allowed ? "is-ready" : ""}`}
              >
                <span>
                  {item.control.signal.field === "contract_total"
                    ? "ACOMPTE DE 30 %"
                    : "SUITE DU DOSSIER"}
                </span>
                <strong>
                  {deposit.allowed
                    ? `${euros(deposit.amount.cents)} ${deposit.amount.taxBasis}`
                    : status === "resolved" &&
                        item.control.signal.field !== "contract_total"
                      ? "Contrôle terminé"
                      : "Préparation bloquée"}
                </strong>
                <p>
                  {deposit.allowed
                    ? "Montant préparatoire calculé sur le contrat confirmé."
                    : status === "resolved" &&
                        item.control.signal.field !== "contract_total"
                      ? "La décision est consignée. Les documents et paiements restent inchangés."
                      : item.control.signal.field === "contract_total"
                        ? deposit.reasons[0]
                        : "Les pièces doivent être complètes, comparables et validées."}
                </p>
                {item.control.signal.field === "contract_total" && (
                  <button
                    className="button button-secondary"
                    disabled={!deposit.allowed}
                    onClick={() => setModal("deposit")}
                  >
                    <FileCheck2 size={16} />
                    Voir la préparation
                  </button>
                )}
              </div>
              <ul className="vc-guards">
                <li>
                  <Check size={16} />
                  Vos sources restent inchangées
                </li>
                <li>
                  <Check size={16} />
                  Aucune facture émise ou envoyée
                </li>
                <li>
                  <Check size={16} />
                  Aucun paiement déclenché
                </li>
                <li>
                  <Check size={16} />
                  Une nouvelle source relance le contrôle
                </li>
              </ul>
            </section>
          </div>
          <section className="vc-panel vc-history">
            <div className="vc-section-heading">
              <History size={20} />
              <h2>Historique du contrôle</h2>
              <span>{history.length} événements</span>
            </div>
            <ol>
              {history.map((event) => (
                <li key={event.id}>
                  <span
                    className={`vc-history-dot ${event.resolved ? "is-resolved" : ""}`}
                  />
                  <div>
                    <strong>{event.label}</strong>
                    <p>{event.reason}</p>
                  </div>
                  <time dateTime={event.at}>{time(event.at)}</time>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
      <div className="vc-notice" role="status" aria-live="polite">
        {notice}
      </div>
      {error && (
        <p className="vc-error" role="alert">
          {error}
        </p>
      )}
      <footer className="vc-footer">
        <ShieldCheck size={15} />
        {storageAvailable
          ? "Vos décisions de démonstration sont conservées dans ce navigateur."
          : "Le stockage est indisponible : vos décisions seront perdues à la fermeture de cette page."}
        <span>Scénarios fictifs · Aucun service connecté</span>
      </footer>
      {sourceDocument && (
        <Modal
          title={
            sourceDocument.amount
              ? "Document source de démonstration"
              : "Pièce source attendue"
          }
          onClose={() => setDocumentId(null)}
          wide
        >
          <SourceDocument source={sourceDocument} client={item.client} />
        </Modal>
      )}
      {modal === "info" && (
        <Modal
          title="Marquer le contrôle à compléter"
          onClose={() => setModal(null)}
        >
          <form
            className="vc-modal-form"
            onSubmit={(event) => {
              event.preventDefault();
              dispatch(
                { action: "request-info", reason: infoReason.trim() },
                "Le contrôle est marqué « À compléter ». Aucun message n’a été envoyé.",
              );
            }}
          >
            <p>
              Précisez l’information attendue. Cette note reste dans la
              démonstration et n’envoie aucun message.
            </p>
            <label htmlFor="vc-info-reason">Complément à vérifier</label>
            <textarea
              id="vc-info-reason"
              value={infoReason}
              onChange={(event) => setInfoReason(event.target.value)}
              maxLength={1200}
              required
              rows={4}
              placeholder="Ex. Vérifier que la dernière option est incluse dans le devis signé…"
            />
            <div className="vc-modal-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setModal(null)}
              >
                Annuler
              </button>
              <button
                className="button button-primary"
                disabled={!infoReason.trim()}
              >
                Enregistrer la demande
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "reset" && (
        <Modal
          title="Réinitialiser la démonstration ?"
          onClose={() => setModal(null)}
        >
          <div className="vc-modal-form">
            <p>
              Les trois scénarios fictifs retrouveront leur état initial. Les
              décisions de cette démonstration seront effacées de ce navigateur.
            </p>
            <div className="vc-modal-actions">
              <button
                className="button button-secondary"
                onClick={() => setModal(null)}
              >
                Annuler
              </button>
              <button className="button button-primary" onClick={reset}>
                Réinitialiser les scénarios
              </button>
            </div>
          </div>
        </Modal>
      )}
      {modal === "deposit" && deposit.allowed && (
        <Modal
          title="Préparation de l’acompte · démonstration"
          onClose={() => setModal(null)}
        >
          <div className="vc-modal-form">
            <span className="vc-status vc-resolved">
              <BadgeCheck size={16} />
              Contrat confirmé et devis signé vérifié
            </span>
            <div className="vc-deposit-preview">
              <span>
                {euros(deposit.contractAmount.cents)}{" "}
                {deposit.contractAmount.taxBasis} × 30 %
              </span>
              <strong>
                {euros(deposit.amount.cents)} {deposit.amount.taxBasis}
              </strong>
              <p>
                {item.client} · {item.id}
              </p>
            </div>
            <p>
              Il s’agit d’un calcul préparatoire. Aucune facture n’a été créée
              ou envoyée et aucun paiement n’a été déclenché.
            </p>
            <button
              className="button button-primary"
              onClick={() => setModal(null)}
            >
              Terminer la consultation
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SourceDocument({
  source,
  client,
}: {
  source: Evidence;
  client: string;
}) {
  const sheet = source.source.kind === "google_sheets";
  return (
    <div className="vc-document-modal">
      <div className="vc-document-label">
        <FileText size={16} />
        DOCUMENT FICTIF · APERÇU INTERACTIF
      </div>
      <div className="vc-paper">
        <div className="vc-paper-brand">
          VDS<span>POOLS 360°</span>
        </div>
        <span className="vc-paper-demo">DÉMONSTRATION</span>
        <h3>{sheet ? "Extrait du suivi clients" : source.source.label}</h3>
        <p>
          {client} · {source.dossierId}
        </p>
        <dl>
          <div>
            <dt>Source</dt>
            <dd>{source.source.label}</dd>
          </div>
          <div>
            <dt>Référence</dt>
            <dd>
              {source.dossierId} / {sheet ? "Suivi clients" : "Pièce 01"}
            </dd>
          </div>
          <div>
            <dt>Version observée</dt>
            <dd>
              v{source.revision} · {date(source.observedAt)}
            </dd>
          </div>
          <div>
            <dt>Base fiscale</dt>
            <dd>{source.amount?.taxBasis ?? "Non renseignée"}</dd>
          </div>
          <div>
            <dt>TVA</dt>
            <dd>{source.amount ? "21 %" : "Non renseignée"}</dd>
          </div>
        </dl>
        <div className="vc-paper-total">
          <span>
            {source.amount
              ? "Montant figurant dans la source"
              : "Document manquant"}
          </span>
          <strong>
            {source.amount
              ? `${euros(source.amount.cents)} ${source.amount.taxBasis}`
              : "Justificatif à fournir"}
          </strong>
        </div>
        {source.signed && (
          <div className="vc-paper-signature">
            <FileSignature size={22} />
            <span>
              Signature de démonstration
              <br />
              <small>Cette mention n’a aucune valeur contractuelle.</small>
            </span>
          </div>
        )}
        <p className="vc-paper-note">
          {source.amount
            ? "Cette pièce synthétique permet de tester la comparaison et la validation. Elle ne représente aucun document client réel."
            : "Un montant est déclaré dans la feuille fictive, mais aucun justificatif n’est encore disponible. Le contrôle reste bloqué jusqu’à réception d’une pièce."}
        </p>
      </div>
    </div>
  );
}

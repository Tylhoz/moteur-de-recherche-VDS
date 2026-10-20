import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Clipboard,
  Clock3,
  FileText,
  FolderOpen,
  Layers3,
  MapPin,
  MessageSquareText,
  Phone,
  ShieldCheck,
  Wallet,
  Wrench,
  X,
} from "lucide-react";
import type { BusinessRecord, Client, Source } from "../types";
import { buildClientMessage } from "../lib/clients";
import { categoryLabel, dateLabel, euro, initials } from "../lib/format";
import "./clients.css";

interface ClientDetailProps {
  client: Client;
  records: BusinessRecord[];
  source: Source;
  onClose: () => void;
  onNotify: (message: string) => void;
}

const kindLabel = {
  devis: "Devis",
  ventes: "Vente",
  chantiers: "Chantier",
  factures: "Facture",
  sav: "SAV",
};

export default function ClientDetail({
  client,
  records,
  onClose,
  onNotify,
}: ClientDetailProps) {
  const [tab, setTab] = useState<"summary" | "activity" | "documents">(
    "summary",
  );
  const initialMessage = useMemo(() => buildClientMessage(client), [client]);
  const [message, setMessage] = useState(initialMessage);
  const previousInitialMessage = useRef(initialMessage);
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "error"
  >("idle");
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const tabsId = useId();
  const linkedRecords = useMemo(
    () =>
      records
        .filter((record) => record.clientId === client.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [records, client.id],
  );
  closeRef.current = onClose;

  useEffect(() => {
    const focusedBefore =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]',
        ),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !panel.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !panel.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKey);
      if (focusedBefore?.isConnected) focusedBefore.focus();
    };
  }, []);

  useEffect(() => {
    const previous = previousInitialMessage.current;
    setMessage((current) => (current === previous ? initialMessage : current));
    previousInitialMessage.current = initialMessage;
    setCopyState("idle");
  }, [initialMessage]);

  const copyMessage = async () => {
    setCopyState("copying");
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message);
        copied = true;
      }
    } catch {
      /* The browser may require the fallback below. */
    }
    if (!copied) {
      const focused =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const temporary = document.createElement("textarea");
      temporary.value = message;
      temporary.setAttribute("readonly", "");
      temporary.style.cssText = "position:fixed;left:-9999px;top:0";
      panel.current?.appendChild(temporary);
      temporary.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      temporary.remove();
      focused?.focus();
    }
    setCopyState(copied ? "copied" : "error");
    onNotify(
      copied
        ? "Message copié dans le presse-papiers."
        : "La copie a été refusée. Sélectionnez et copiez le texte du message.",
    );
  };

  const tabs = [
    { id: "summary", label: "Résumé" },
    {
      id: "activity",
      label: `Activité${linkedRecords.length ? ` · ${linkedRecords.length}` : ""}`,
    },
    { id: "documents", label: "Documents" },
  ] as const;

  return (
    <div
      className="detail-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="detail-panel"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="detail-top">
          <span>
            <span className="detail-presence" /> FICHE CLIENT · APERÇU PRIVÉ
          </span>
          <button
            ref={closeButton}
            type="button"
            className="detail-close"
            aria-label="Fermer la fiche client"
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </div>
        <header className="detail-heading">
          <div className="detail-avatar">{initials(client.client)}</div>
          <div>
            <span className="detail-reference">
              {client.id}
              {" · Copie historique du portail · Non vérifié"}
            </span>
            <h2 id={titleId}>{client.client}</h2>
            <span className={`clients-badge clients-badge-${client.category}`}>
              {client.category === "valide" && <Check size={11} />}
              {categoryLabel[client.category]} · statut source non vérifié
            </span>
          </div>
        </header>
        <div
          className="detail-tabs"
          role="tablist"
          aria-label="Sections de la fiche client"
        >
          {tabs.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${tabsId}-${item.id}`}
              aria-controls={`${tabsId}-panel-${item.id}`}
              aria-selected={tab === item.id}
              tabIndex={tab === item.id ? 0 : -1}
              className={tab === item.id ? "is-active" : ""}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                let next: number | null = null;
                if (event.key === "ArrowRight")
                  next = (index + 1) % tabs.length;
                if (event.key === "ArrowLeft")
                  next = (index + tabs.length - 1) % tabs.length;
                if (event.key === "Home") next = 0;
                if (event.key === "End") next = tabs.length - 1;
                if (next !== null) {
                  event.preventDefault();
                  setTab(tabs[next].id);
                  document
                    .getElementById(`${tabsId}-${tabs[next].id}`)
                    ?.focus();
                }
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div
          className="detail-content"
          role="tabpanel"
          id={`${tabsId}-panel-${tab}`}
          aria-labelledby={`${tabsId}-${tab}`}
          tabIndex={0}
        >
          {tab === "summary" && (
            <>
              <div className="detail-status-note">
                <ShieldCheck size={18} />
                <div>
                  <h3>Situation du dossier</h3>
                  <p>{client.statusAction || "Information non retrouvée"}</p>
                </div>
              </div>
              <section className="detail-section">
                <h3>
                  <Phone size={17} />
                  Coordonnées
                </h3>
                <dl>
                  <div>
                    <dt>Contact</dt>
                    <dd className="detail-preserve">
                      {client.contact || "Information non retrouvée"}
                    </dd>
                  </div>
                  <div>
                    <dt>Adresse</dt>
                    <dd className="detail-preserve">
                      {client.address || "Information non retrouvée"}
                    </dd>
                  </div>
                </dl>
                {client.address && (
                  <a
                    className="detail-map-link"
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(client.address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <MapPin size={15} />
                    Ouvrir dans Google Maps
                    <ArrowUpRight size={14} />
                  </a>
                )}
              </section>
              <section className="detail-section">
                <h3>
                  <Layers3 size={17} />
                  Projet & équipe
                </h3>
                <p className="detail-preserve">
                  {client.modelTeam || "Information non retrouvée"}
                </p>
              </section>
              <section className="detail-section">
                <h3>
                  <Wrench size={17} />
                  Informations techniques
                </h3>
                <p className="detail-preserve">
                  {client.techMacon || "Information non retrouvée"}
                </p>
              </section>
              <section className="detail-section">
                <h3>
                  <Wallet size={17} />
                  Finances
                </h3>
                <div className="detail-financial-grid">
                  <div>
                    <span>Contrat HT vérifié</span>
                    <strong>Non vérifié</strong>
                  </div>
                  <div>
                    <span>Solde justifié</span>
                    <strong>Non vérifié</strong>
                  </div>
                </div>
                <p className="detail-finance-note">
                  Les nombres historiques ne sont pas des montants comptablement
                  vérifiés. Le commentaire source ci-dessous est conservé sans
                  correction automatique.
                </p>
                <p className="detail-preserve detail-finance-note">
                  {client.finance || "Information non retrouvée"}
                </p>
              </section>
              <section className="detail-section detail-message">
                <h3>
                  <MessageSquareText size={17} />
                  Préparer un message
                </h3>
                <p>
                  Vous pouvez ajuster le texte avant de le copier.
                </p>
                <label
                  className="clients-sr-only"
                  htmlFor={`${titleId}-message`}
                >
                  Message à copier pour {client.client}
                </label>
                <textarea
                  id={`${titleId}-message`}
                  rows={7}
                  value={message}
                  readOnly={copyState === "copying"}
                  onChange={(event) => {
                    setMessage(event.target.value);
                    setCopyState("idle");
                  }}
                />
                <div className="detail-copy-row">
                  <span role="status">
                    {copyState === "copied"
                      ? "Le message est prêt à être collé."
                      : copyState === "error"
                        ? "Copiez le texte manuellement."
                        : "Copie uniquement, aucun envoi automatique."}
                  </span>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={copyState === "copying" || !message.trim()}
                    onClick={copyMessage}
                  >
                    {copyState === "copied" ? (
                      <Check size={16} />
                    ) : (
                      <Clipboard size={16} />
                    )}
                    {copyState === "copying"
                      ? "Copie…"
                      : copyState === "copied"
                        ? "Copié"
                        : "Copier le message"}
                  </button>
                </div>
              </section>
            </>
          )}
          {tab === "activity" && (
            <section className="detail-section detail-activity">
              <div className="detail-section-intro">
                <h3>
                  <Clock3 size={17} />
                  Suivi du dossier
                </h3>
                <p>
                  Les éléments liés à ce client, du plus récent au plus ancien.
                </p>
              </div>
              {linkedRecords.length ? (
                <div className="detail-records">
                  {linkedRecords.map((record) => (
                    <article key={record.id} className="detail-record">
                      <div className="detail-record-icon">
                        <FileText size={17} />
                      </div>
                      <div>
                        <div className="detail-record-meta">
                          <span>
                            {kindLabel[record.kind]} · {record.id}
                          </span>
                          <span>{record.status}</span>
                        </div>
                        <h4>{record.title}</h4>
                        <p>
                          {record.owner || "Non affecté"} ·{" "}
                          {record.dueDate
                            ? `Échéance ${dateLabel(record.dueDate)}`
                            : "Échéance à planifier"}
                        </p>
                        {record.amount !== null && (
                          <strong>{euro(record.amount)} · Non vérifié</strong>
                        )}
                        {record.progress !== undefined && (
                          <div
                            className="detail-progress"
                            role="progressbar"
                            aria-valuenow={record.progress}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`Avancement ${record.title}`}
                          >
                            <span
                              style={{
                                width: `${Math.min(100, Math.max(0, record.progress))}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="detail-empty">
                  <Clock3 size={29} />
                  <h4>Aucun élément lié pour le moment</h4>
                  <p>
                    Les informations du portail sont conservées dans le résumé.
                    Les devis, ventes, chantiers, factures et SAV pourront être
                    rattachés après connexion des données structurées.
                  </p>
                </div>
              )}
            </section>
          )}
          {tab === "documents" && (
            <section className="detail-empty">
              <FolderOpen size={34} />
              <h3>Vos documents, au même endroit</h3>
              <p>
                Aucun document n’est joint à cette copie du dossier. Le rattachement
                des devis signés, factures et photos permettra de comparer les sources.
              </p>
            </section>
          )}
        </div>
        <footer className="detail-footer">
          <span>
            <span className="detail-presence" />
            Copie du portail · lecture seule
          </span>
          <button type="button" onClick={onClose}>
            Fermer le dossier
          </button>
        </footer>
      </div>
    </div>
  );
}

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  FileSignature,
  History,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Waves,
} from "lucide-react";
import {
  decideControl,
  prepareDeposit,
  reconcileControl,
  type Evidence,
  type ControlState,
} from "./domain/coherence";
import "./styles.css";
import "./validation-preview.css";

const stamp = "2026-10-20T02:00:00.000Z";
const euros = (cents: number) =>
  new Intl.NumberFormat("fr-BE", { style: "currency", currency: "EUR" }).format(
    cents / 100,
  );
const initialEvidence = (): Evidence[] => [
  {
    id: "sheet-example",
    revision: "1",
    dossierId: "EXEMPLE",
    field: "contract_total",
    source: {
      id: "sheet-source-example",
      label: "Google Sheets",
      kind: "google_sheets",
    },
    observedAt: stamp,
    amount: {
      cents: 3_950_000,
      currency: "EUR",
      taxBasis: "HT",
      vatRateBps: 2100,
    },
  },
  {
    id: "quote-example",
    revision: "1",
    dossierId: "EXEMPLE",
    field: "contract_total",
    source: {
      id: "quote-source-example",
      label: "Devis signé",
      kind: "signed_quote",
    },
    observedAt: stamp,
    amount: {
      cents: 4_250_000,
      currency: "EUR",
      taxBasis: "HT",
      vatRateBps: 2100,
    },
    signed: true,
    verification: {
      actorId: "controleur-test",
      at: stamp,
      reason: "Document vérifié dans ce scénario fictif.",
      evidenceRevision: "1",
      verifiedAmount: {
        cents: 4_250_000,
        currency: "EUR",
        taxBasis: "HT",
        vatRateBps: 2100,
      },
    },
  },
];
const reconcile = (evidence: Evidence[], previous?: ControlState) =>
  reconcileControl({
    dossierId: "EXEMPLE",
    field: "contract_total",
    evidence,
    previous,
  });

function ValidationPreview() {
  const [evidence, setEvidence] = useState(initialEvidence);
  const [control, setControl] = useState(() => reconcile(initialEvidence()));
  const [selected, setSelected] = useState("");
  const [justification, setJustification] = useState("");
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState("");
  const deposit = prepareDeposit(control, evidence);
  const resolved = !!control.resolution;
  const comparable =
    evidence[0].amount?.taxBasis === evidence[1].amount?.taxBasis;
  function reset() {
    const next = initialEvidence();
    setEvidence(next);
    setControl(reconcile(next));
    setSelected("");
    setJustification("");
    setChecked(false);
    setNotice("Le scénario fictif est réinitialisé.");
  }
  function changeEvidence(incomparable: boolean) {
    const next = evidence.map((item, index) =>
      index === 0
        ? item
        : {
            ...item,
            revision: String(Number(item.revision) + 1),
            observedAt: new Date().toISOString(),
            amount: {
              ...item.amount!,
              taxBasis: incomparable ? ("TTC" as const) : ("HT" as const),
              cents: incomparable ? 4_250_000 : 4_400_000,
            },
          },
    );
    setEvidence(next);
    setControl(reconcile(next, control));
    setSelected("");
    setChecked(false);
    setJustification("");
    setNotice(
      "Nouvelle version simulée : une nouvelle vérification est nécessaire.",
    );
  }
  function decide(event: React.FormEvent) {
    event.preventDefault();
    if (!checked || !selected || !justification.trim()) return;
    try {
      setControl(
        decideControl(control, evidence, {
          actorId: "utilisateur-test",
          justification,
          at: new Date().toISOString(),
          evidenceRefs: control.signal.evidenceRefs,
          selectedEvidenceId: selected,
        }),
      );
      setNotice(
        "Décision de test enregistrée pour ces versions uniquement. Aucune source modifiée.",
      );
      setChecked(false);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "La décision ne peut pas être retenue.",
      );
    }
  }
  return (
    <div className="validation-shell">
      <aside className="validation-sidebar">
        <div className="validation-brand">
          <Waves size={31} />
          <div>
            VDS<span>.</span>
            <small>POOLS 360°</small>
          </div>
        </div>
        <p className="validation-nav-caption">FONDATIONS DE LA PLATEFORME</p>
        <div className="validation-nav-active">
          <ShieldCheck size={19} /> Centre de validation
        </div>
        <div className="validation-roadmap">
          <p>UNE CONNEXION À LA FOIS</p>
          {[
            "Identité VDS Pools",
            "Google Sheets",
            "Fiches clients",
            "Finances & graphiques",
            "Gmail, Drive & Agenda",
            "Automatisations",
          ].map((item, i) => (
            <div key={item}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              {item}
            </div>
          ))}
        </div>
        <div className="validation-sidebar-foot">
          <LockKeyhole size={19} />
          <strong>Vous gardez la décision.</strong>
          <p>Une proposition ne modifie jamais vos sources.</p>
        </div>
      </aside>
      <div className="validation-main">
        <header className="validation-topbar">
          <span>
            VDS Pools 360° <ChevronRight size={14} /> Contrôle de cohérence
          </span>
          <span>
            <LockKeyhole size={14} /> Préparation locale
          </span>
        </header>
        <main>
          <div className="validation-preview-note">
            <ShieldCheck size={17} />
            <span>
              <strong>Exemple fictif — hors dossiers clients.</strong> Aucun
              service connecté. Les décisions de test disparaissent au
              rechargement.
            </span>
          </div>
          <div className="validation-heading">
            <div>
              <p className="validation-eyebrow">CENTRE DE VALIDATION</p>
              <h1>Voir l’écart. Garder le contrôle.</h1>
              <p>
                La bonne information, la bonne source, une décision explicite.
              </p>
            </div>
            <button className="button button-secondary" onClick={reset}>
              <RotateCcw size={15} /> Réinitialiser le test
            </button>
          </div>
          <div className="validation-summary">
            <div>
              <span>Contrôle du scénario</span>
              <strong>{resolved ? "Vérifié" : "À vérifier"}</strong>
              <small>Valeur contractuelle</small>
            </div>
            <div>
              <span>Sources à comparer</span>
              <strong>02</strong>
              <small>Feuille et document signé</small>
            </div>
            <div>
              <span>Modifications automatiques</span>
              <strong>00</strong>
              <small>Vos sources restent intactes</small>
            </div>
          </div>
          <section
            className="validation-control"
            aria-labelledby="control-title"
          >
            <div className="validation-control-heading">
              <div>
                <p>DOSSIER EXEMPLE · MONTANT CONTRACTUEL</p>
                <h2 id="control-title">
                  {resolved
                    ? "Une décision documentée"
                    : comparable
                      ? "Deux sources, deux montants"
                      : "Des montants non comparables"}
                </h2>
              </div>
              <span
                className={`validation-status ${resolved ? "is-resolved" : ""}`}
              >
                {resolved ? (
                  <CheckCheck size={15} />
                ) : (
                  <CircleAlert size={15} />
                )}
                {resolved ? "Validé dans ce test" : "À vérifier"}
              </span>
            </div>
            <p className="validation-control-intro">
              {resolved
                ? "La valeur retenue est liée aux versions examinées. Une nouvelle version rouvrira le contrôle."
                : comparable
                  ? "La différence doit être examinée avant de retenir une valeur ou préparer un acompte."
                  : "Une base HT et une base TTC ne peuvent pas être rapprochées comme deux montants équivalents."}
            </p>
            <div className="validation-sources">
              {evidence.map((item, index) => (
                <article
                  className={`validation-source ${selected === item.id ? "is-selected" : ""}`}
                  key={item.id}
                >
                  <div className="validation-source-label">
                    <span>
                      {index === 0 ? (
                        <Database size={19} />
                      ) : (
                        <FileSignature size={19} />
                      )}
                    </span>
                    <div>
                      <h3>{item.source.label}</h3>
                      <small>Source simulée · version {item.revision}</small>
                    </div>
                  </div>
                  <div className="validation-money">
                    {item.amount ? euros(item.amount.cents) : "Non renseigné"}{" "}
                    <span>{item.amount?.taxBasis}</span>
                  </div>
                  <dl>
                    <div>
                      <dt>Champ</dt>
                      <dd>Montant contractuel</dd>
                    </div>
                    <div>
                      <dt>Devise / TVA du scénario</dt>
                      <dd>EUR · 21 %</dd>
                    </div>
                    <div>
                      <dt>Provenance</dt>
                      <dd>
                        {index === 0
                          ? "Ligne de feuille simulée"
                          : "Document signé simulé"}
                      </dd>
                    </div>
                    <div>
                      <dt>Observation</dt>
                      <dd>
                        {new Intl.DateTimeFormat("fr-FR", {
                          dateStyle: "short",
                          timeStyle: "short",
                          timeZone: "Asia/Bangkok",
                        }).format(new Date(item.observedAt))}{" "}
                        · Bangkok
                      </dd>
                    </div>
                  </dl>
                  <button
                    className="button button-secondary"
                    aria-pressed={selected === item.id}
                    disabled={resolved || !comparable}
                    onClick={() => setSelected(item.id)}
                  >
                    {selected === item.id ? (
                      <Check size={15} />
                    ) : (
                      <ArrowRight size={15} />
                    )}{" "}
                    Examiner cette valeur
                  </button>
                </article>
              ))}
            </div>
            <div className="validation-gap">
              <CircleAlert size={18} />
              <div>
                <strong>
                  {comparable
                    ? `Écart constaté : ${euros(Math.abs(evidence[0].amount!.cents - evidence[1].amount!.cents))} HT`
                    : "Comparaison suspendue : bases HT / TTC différentes"}
                </strong>
                <span>
                  Aucune valeur n’est remplacée automatiquement. La source ne
                  suffit pas, à elle seule, à décider.
                </span>
              </div>
            </div>
          </section>
          <div className="validation-bottom">
            <section className="validation-panel">
              <div className="validation-panel-title">
                <ShieldCheck size={19} />
                <h2>Vérifier, puis décider</h2>
              </div>
              <p>
                La justification et les versions examinées font partie de la
                décision.
              </p>
              {resolved ? (
                <div className="validation-resolved">
                  <CheckCheck size={28} />
                  <strong>Choix consigné dans le test</strong>
                  <p>
                    Les deux valeurs sources sont conservées. Aucune donnée du
                    portail, facture ou feuille n’a été modifiée.
                  </p>
                  <button
                    className="button button-secondary"
                    onClick={() => changeEvidence(false)}
                  >
                    Simuler une nouvelle version
                  </button>
                </div>
              ) : (
                <form onSubmit={decide}>
                  <label
                    className="validation-field-label"
                    htmlFor="decision-reason"
                  >
                    Justification de la décision de test
                  </label>
                  <textarea
                    id="decision-reason"
                    value={justification}
                    onChange={(e) => setJustification(e.target.value)}
                    placeholder="Expliquez pourquoi cette valeur doit être retenue…"
                    rows={3}
                  />
                  <label className="validation-checkbox">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setChecked(e.target.checked)}
                    />
                    <span>
                      Dans ce scénario fictif, je confirme avoir vérifié la
                      source sélectionnée.
                    </span>
                  </label>
                  <button
                    className="button button-primary"
                    disabled={
                      !selected ||
                      !justification.trim() ||
                      !checked ||
                      !comparable
                    }
                    type="submit"
                  >
                    <ShieldCheck size={16} /> Tester la validation humaine
                  </button>
                  <small className="validation-form-hint">
                    {selected
                      ? "Choix lié aux versions affichées."
                      : "Choisissez d’abord une valeur à examiner."}
                  </small>
                </form>
              )}
            </section>
            <section className="validation-panel">
              <div className="validation-panel-title">
                <LockKeyhole size={19} />
                <h2>Les conséquences restent contrôlées</h2>
              </div>
              <div
                className={`validation-deposit ${deposit.allowed ? "is-ready" : ""}`}
              >
                <span>Acompte de 30 % · test de préparation</span>
                <strong>
                  {deposit.allowed
                    ? euros(deposit.amount.cents) +
                      " " +
                      deposit.amount.taxBasis
                    : "Préparation bloquée"}
                </strong>
                <p>
                  {deposit.allowed
                    ? "Calcul préparatoire uniquement. Une émission de facture nécessitera une validation distincte."
                    : deposit.reasons[0]}
                </p>
              </div>
              <ul className="validation-guards">
                <li>
                  <Check size={15} /> Aucun envoi de facture ou de relance
                </li>
                <li>
                  <Check size={15} /> Aucun paiement déclenché
                </li>
                <li>
                  <Check size={15} /> Aucune écriture dans Google Sheets
                </li>
                <li>
                  <Check size={15} /> Un changement de source relance le
                  contrôle
                </li>
              </ul>
            </section>
          </div>
          <section className="validation-history">
            <div className="validation-panel-title">
              <History size={18} />
              <h2>Trace du contrôle</h2>
              <span>
                {control.history.length} événement
                {control.history.length > 1 ? "s" : ""}
              </span>
            </div>
            <ol>
              {control.history.map((event) => (
                <li key={event.id}>
                  <span className="validation-history-dot" />
                  <div>
                    <strong>
                      {event.type === "detected"
                        ? "Écart détecté"
                        : event.type === "resolved"
                          ? "Décision de test consignée"
                          : "Validation précédente invalidée"}
                    </strong>
                    <p>{event.reason}</p>
                  </div>
                  <Clock3 size={15} />
                </li>
              ))}
            </ol>
          </section>
          <div className="validation-scenarios">
            <span>Éprouver les garde-fous</span>
            <button onClick={() => changeEvidence(true)}>
              Simuler HT face à TTC
            </button>
            <button onClick={() => changeEvidence(false)}>
              Simuler un devis modifié
            </button>
          </div>
          <p className="validation-announcement" role="status">
            {notice}
          </p>
          <footer className="validation-footer">
            VDS Pools 360° · Socle préparatoire
            <span>Pas de connexion, pas de modification des dossiers.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ValidationPreview />
  </StrictMode>,
);

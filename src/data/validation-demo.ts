import {
  decideControl,
  reconcileControl,
  type ControlState,
  type Evidence,
} from "../domain/coherence";

export type DemoControlStatus = "open" | "waiting" | "resolved";
export interface DemoCase {
  id: string;
  client: string;
  title: string;
  description: string;
  issue: string;
  evidence: Evidence[];
  control: ControlState;
  waiting: boolean;
  workflow: { id: string; at: string; label: string; reason: string }[];
}
export type DemoCommand = {
  caseId: string;
  at: string;
  action:
    | "resolve"
    | "request-info"
    | "resume"
    | "update-source"
    | "complete-source";
  reason?: string;
  evidenceId?: string;
};
export const VALIDATION_STORAGE_KEY = "vds.validation-demo.v1";
export const initialStamp = "2026-10-19T12:00:00.000Z";
const money = (cents: number, taxBasis: "HT" | "TTC" = "HT") => ({
  cents,
  currency: "EUR" as const,
  taxBasis,
  vatRateBps: 2100,
});

export function initialDemoCases(): DemoCase[] {
  const items: Omit<DemoCase, "control" | "waiting" | "workflow">[] = [
    {
      id: "DEMO-001",
      client: "Client démonstration 001",
      title: "Montant du contrat",
      description: "Piscine Horizon · contrat de construction",
      issue: "Deux montants contractuels différents",
      evidence: [
        {
          id: "demo-001-sheet",
          revision: "1",
          dossierId: "DEMO-001",
          field: "contract_total",
          source: {
            id: "demo-sheet",
            label: "Google Sheets",
            kind: "google_sheets",
          },
          observedAt: initialStamp,
          amount: money(3_950_000),
        },
        {
          id: "demo-001-quote",
          revision: "1",
          dossierId: "DEMO-001",
          field: "contract_total",
          source: {
            id: "demo-quote-001",
            label: "Devis signé",
            kind: "signed_quote",
          },
          observedAt: "2026-10-19T09:00:00.000Z",
          amount: money(4_250_000),
          signed: true,
        },
      ],
    },
    {
      id: "DEMO-002",
      client: "Client démonstration 002",
      title: "Base fiscale de la facture",
      description: "Piscine Azur · facture finale",
      issue: "Une valeur HT comparée à une valeur TTC",
      evidence: [
        {
          id: "demo-002-sheet",
          revision: "1",
          dossierId: "DEMO-002",
          field: "invoice_total",
          source: {
            id: "demo-sheet",
            label: "Google Sheets",
            kind: "google_sheets",
          },
          observedAt: initialStamp,
          amount: money(3_000_000),
        },
        {
          id: "demo-002-invoice",
          revision: "1",
          dossierId: "DEMO-002",
          field: "invoice_total",
          source: {
            id: "demo-invoice-002",
            label: "Facture source",
            kind: "invoice",
          },
          observedAt: "2026-10-19T11:00:00.000Z",
          amount: money(3_630_000, "TTC"),
        },
      ],
    },
    {
      id: "DEMO-003",
      client: "Client démonstration 003",
      title: "Justificatif d’encaissement",
      description: "Piscine Jardin · suivi de l’acompte",
      issue: "Le justificatif de paiement manque",
      evidence: [
        {
          id: "demo-003-sheet",
          revision: "1",
          dossierId: "DEMO-003",
          field: "deposit_paid",
          source: {
            id: "demo-sheet",
            label: "Google Sheets",
            kind: "google_sheets",
          },
          observedAt: initialStamp,
          amount: money(1_016_400, "TTC"),
        },
        {
          id: "demo-003-payment",
          revision: "1",
          dossierId: "DEMO-003",
          field: "deposit_paid",
          source: {
            id: "demo-payment-003",
            label: "Preuve de paiement",
            kind: "payment",
          },
          observedAt: initialStamp,
          amount: null,
        },
      ],
    },
  ];
  return items.map((item) => ({
    ...item,
    waiting: false,
    workflow: [],
    control: reconcileControl({
      dossierId: item.id,
      field: item.evidence[0].field,
      evidence: item.evidence,
      at: initialStamp,
    }),
  }));
}

export const caseStatus = (item: DemoCase): DemoControlStatus =>
  item.control.resolution ? "resolved" : item.waiting ? "waiting" : "open";

export function applyDemoCommand(
  items: DemoCase[],
  command: DemoCommand,
): DemoCase[] {
  const current = items.find((item) => item.id === command.caseId);
  if (!current || !Number.isFinite(Date.parse(command.at)))
    throw new Error("Commande de démonstration invalide.");
  let next = { ...current };
  const log = (label: string, reason: string) => {
    next.workflow = [
      ...next.workflow,
      { id: `workflow-${next.workflow.length}`, at: command.at, label, reason },
    ];
  };
  if (command.action === "resolve") {
    if (!command.evidenceId || !command.reason?.trim())
      throw new Error("Choisissez une source et justifiez la décision.");
    next.evidence = current.evidence.map((item) =>
      item.id === command.evidenceId &&
      item.source.kind === "signed_quote" &&
      item.signed &&
      item.amount
        ? {
            ...item,
            verification: {
              actorId: "validateur-demo",
              at: command.at,
              reason: command.reason!.trim(),
              evidenceRevision: item.revision,
              verifiedAmount: item.amount,
            },
          }
        : item,
    );
    const refreshed = reconcileControl({
      dossierId: next.id,
      field: next.control.signal.field,
      evidence: next.evidence,
      previous: next.control,
      at: command.at,
    });
    next.control = decideControl(refreshed, next.evidence, {
      actorId: "validateur-demo",
      justification: command.reason,
      selectedEvidenceId: command.evidenceId,
      at: command.at,
      evidenceRefs: refreshed.signal.evidenceRefs,
    });
    next.waiting = false;
  } else if (command.action === "request-info") {
    if (!command.reason?.trim())
      throw new Error("Précisez le complément à vérifier.");
    if (current.control.resolution)
      throw new Error("Ce contrôle est déjà validé.");
    next.waiting = true;
    log("Complément demandé", command.reason.trim());
  } else if (command.action === "resume") {
    next.waiting = false;
    log("Contrôle repris", "La vérification du dossier reprend.");
  } else if (
    command.action === "update-source" ||
    command.action === "complete-source"
  ) {
    const complete = command.action === "complete-source";
    next.evidence = current.evidence.map((item, index) =>
      index === 1
        ? {
            ...item,
            revision: String(Number(item.revision) + 1),
            observedAt: command.at,
            // An old verification is deliberately retained, and is invalid for this revision.
            amount: complete
              ? current.evidence[0].amount
              : item.amount
                ? { ...item.amount, cents: item.amount.cents + 150_000 }
                : money(1_016_400, "TTC"),
          }
        : item,
    );
    next.control = reconcileControl({
      dossierId: next.id,
      field: next.control.signal.field,
      evidence: next.evidence,
      previous: next.control,
      at: command.at,
    });
    next.waiting = false;
    log(
      complete ? "Pièce fictive complétée" : "Nouvelle version fictive reçue",
      complete
        ? "Une nouvelle version documentaire est disponible pour la comparaison."
        : "La source a changé. Une nouvelle validation est nécessaire.",
    );
  } else {
    throw new Error("Action inconnue.");
  }
  return items.map((item) => (item.id === current.id ? next : item));
}

export function replayDemoCommands(commands: DemoCommand[]): DemoCase[] {
  return commands.reduce(applyDemoCommand, initialDemoCases());
}

/** Only known fictional cases and actions can be restored from browser storage. */
export function readDemoCommands(raw: string | null): DemoCommand[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("commands" in value) ||
    !Array.isArray(value.commands) ||
    value.commands.length > 500
  )
    throw new Error("Historique de démonstration invalide.");
  const validActions = [
    "resolve",
    "request-info",
    "resume",
    "update-source",
    "complete-source",
  ];
  const commands: DemoCommand[] = value.commands.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Action invalide.");
    const command = item as Record<string, unknown>;
    if (
      typeof command.caseId !== "string" ||
      !["DEMO-001", "DEMO-002", "DEMO-003"].includes(command.caseId) ||
      typeof command.at !== "string" ||
      !Number.isFinite(Date.parse(command.at)) ||
      typeof command.action !== "string" ||
      !validActions.includes(command.action) ||
      (command.reason !== undefined &&
        (typeof command.reason !== "string" || command.reason.length > 1200)) ||
      (command.evidenceId !== undefined &&
        (typeof command.evidenceId !== "string" ||
          !command.evidenceId.startsWith(command.caseId.toLowerCase() + "-")))
    )
      throw new Error("Historique de démonstration invalide.");
    return {
      caseId: command.caseId,
      at: command.at,
      action: command.action as DemoCommand["action"],
      ...(typeof command.reason === "string" ? { reason: command.reason } : {}),
      ...(typeof command.evidenceId === "string"
        ? { evidenceId: command.evidenceId }
        : {}),
    };
  });
  replayDemoCommands(commands);
  return commands;
}

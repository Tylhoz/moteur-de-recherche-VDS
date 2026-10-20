/** Pure coherence checks. Nothing here writes to a source or authorizes a financial transaction. */
export type FinancialField =
  | "contract_total"
  | "deposit_paid"
  | "invoice_total"
  | "credit_note_total"
  | "balance_due";

export interface Money {
  readonly cents: number;
  readonly currency: "EUR";
  readonly taxBasis: "HT" | "TTC" | "UNKNOWN";
  /** 2,000 basis points = 20%. null means unknown, never 0%. */
  readonly vatRateBps: number | null;
}

export interface EvidenceRef {
  readonly id: string;
  readonly revision: string;
  /** Exact content reference; catches a provider changing values without changing its revision. */
  readonly fingerprint: string;
}

export interface Evidence {
  readonly id: string;
  readonly revision: string;
  readonly dossierId: string;
  readonly field: FinancialField;
  readonly source: {
    readonly id: string;
    readonly label: string;
    readonly kind:
      | "google_sheets"
      | "signed_quote"
      | "invoice"
      | "payment"
      | "email"
      | "manual"
      | "ai";
  };
  readonly observedAt: string;
  readonly amount: Money | null;
  readonly signed?: boolean;
  readonly verification?: {
    readonly actorId: string;
    readonly at: string;
    readonly reason: string;
    /** The human verification applies only to this exact source revision and amount. */
    readonly evidenceRevision: string;
    readonly verifiedAmount: Money;
  };
  readonly derivedByAI?: boolean;
}

export interface ControlSignal {
  readonly id: string;
  readonly dossierId: string;
  readonly field: FinancialField;
  readonly kind: "divergence" | "incomparable" | "missing" | "aligned";
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface HumanResolution {
  readonly id: string;
  readonly actorId: string;
  readonly justification: string;
  readonly at: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly selectedEvidenceId: string;
  readonly confirmedAmount: Money;
}

export interface AuditEvent {
  readonly id: string;
  readonly type: "detected" | "resolved" | "invalidated";
  readonly signalId: string;
  readonly at: string;
  readonly reason: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly resolution?: HumanResolution;
}

export interface ControlState {
  readonly signal: ControlSignal;
  readonly resolution: HumanResolution | null;
  readonly history: readonly AuditEvent[];
}

export interface DecisionInput {
  readonly actorId: string;
  readonly justification: string;
  readonly at: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly selectedEvidenceId: string;
}

export type DepositPreparation =
  | {
      readonly allowed: true;
      readonly amount: Money;
      readonly contractAmount: Money;
      readonly ratePercent: 30;
      readonly rounding: "nearest-cent-half-up";
      readonly resolutionId: string;
      readonly authorizesIssuance: false;
      readonly authorizesSending: false;
      readonly authorizesPayment: false;
    }
  | {
      readonly allowed: false;
      readonly reasons: readonly string[];
      readonly authorizesIssuance: false;
      readonly authorizesSending: false;
      readonly authorizesPayment: false;
    };

const hasText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const validDate = (value: string): boolean =>
  hasText(value) && Number.isFinite(Date.parse(value));
const isAI = (evidence: Evidence): boolean =>
  evidence.derivedByAI === true || evidence.source.kind === "ai";

function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}

function assertMoney(amount: Money): void {
  if (!Number.isSafeInteger(amount.cents) || amount.currency !== "EUR") {
    throw new Error(
      "Le montant doit être exprimé en centimes entiers sûrs et en EUR.",
    );
  }
  if (!["HT", "TTC", "UNKNOWN"].includes(amount.taxBasis)) {
    throw new Error("La base fiscale doit être HT, TTC ou UNKNOWN.");
  }
  if (
    amount.vatRateBps !== null &&
    (!Number.isSafeInteger(amount.vatRateBps) ||
      amount.vatRateBps < 0 ||
      amount.vatRateBps > 10_000)
  ) {
    throw new Error(
      "Le taux de TVA doit être connu en points de base ou explicitement null.",
    );
  }
}

function reference(evidence: Evidence): EvidenceRef {
  return {
    id: evidence.id,
    revision: evidence.revision,
    fingerprint: JSON.stringify({
      dossierId: evidence.dossierId,
      field: evidence.field,
      source: {
        id: evidence.source.id,
        label: evidence.source.label,
        kind: evidence.source.kind,
      },
      amount:
        evidence.amount === null
          ? null
          : {
              cents: evidence.amount.cents,
              currency: evidence.amount.currency,
              taxBasis: evidence.amount.taxBasis,
              vatRateBps: evidence.amount.vatRateBps,
            },
      signed: evidence.signed === true,
      derivedByAI: isAI(evidence),
      verification: evidence.verification
        ? {
            actorId: evidence.verification.actorId,
            at: evidence.verification.at,
            reason: evidence.verification.reason,
            evidenceRevision: evidence.verification.evidenceRevision,
            verifiedAmount: evidence.verification.verifiedAmount
              ? {
                  cents: evidence.verification.verifiedAmount.cents,
                  currency: evidence.verification.verifiedAmount.currency,
                  taxBasis: evidence.verification.verifiedAmount.taxBasis,
                  vatRateBps: evidence.verification.verifiedAmount.vatRateBps,
                }
              : null,
          }
        : null,
    }),
  };
}

function matchingRefs(
  left: readonly EvidenceRef[],
  right: readonly EvidenceRef[],
): boolean {
  const stable = (refs: readonly EvidenceRef[]) =>
    JSON.stringify(
      [...refs]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(({ id, revision, fingerprint }) => [id, revision, fingerprint]),
    );
  return stable(left) === stable(right);
}

function scopedEvidence(
  dossierId: string,
  field: FinancialField,
  evidence: readonly Evidence[],
): Evidence[] {
  if (!hasText(dossierId))
    throw new Error("Un identifiant de dossier est obligatoire.");
  const unique = new Map<string, Evidence>();
  for (const item of evidence) {
    if (item.dossierId !== dossierId || item.field !== field) continue;
    if (
      ![item.id, item.revision, item.source.id, item.source.label].every(
        hasText,
      ) ||
      !validDate(item.observedAt)
    ) {
      throw new Error(
        "Chaque preuve exige une identité, une révision et une provenance datée.",
      );
    }
    if (item.amount !== null) assertMoney(item.amount);
    const existing = unique.get(item.id);
    if (existing && !matchingRefs([reference(existing)], [reference(item)])) {
      throw new Error(
        "Deux versions différentes d'une même preuve sont présentes dans le relevé courant.",
      );
    }
    unique.set(item.id, item);
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function sameMoney(left: Money, right: Money): boolean {
  return (
    left.cents === right.cents &&
    left.currency === right.currency &&
    left.taxBasis === right.taxBasis &&
    left.vatRateBps === right.vatRateBps
  );
}

function buildSignal(
  dossierId: string,
  field: FinancialField,
  evidence: readonly Evidence[],
): ControlSignal {
  const evidenceRefs = evidence.map(reference);
  const id = JSON.stringify([
    dossierId,
    field,
    evidenceRefs.map(({ id, revision }) => [id, revision]),
  ]);
  let kind: ControlSignal["kind"];
  let summary: string;
  const amounts = evidence.flatMap((item) =>
    item.amount === null ? [] : [item.amount],
  );
  if (evidence.length === 0 || amounts.length !== evidence.length) {
    kind = "missing";
    summary =
      "Une donnée manque. Aucun montant inconnu n'est remplacé par zéro.";
  } else if (
    amounts.some(
      (amount) => amount.taxBasis === "UNKNOWN" || amount.vatRateBps === null,
    ) ||
    amounts.some(
      (amount) =>
        amount.taxBasis !== amounts[0].taxBasis ||
        amount.vatRateBps !== amounts[0].vatRateBps,
    )
  ) {
    kind = "incomparable";
    summary =
      "Les bases HT/TTC ou les taux de TVA doivent être rapprochés avant toute décision.";
  } else if (amounts.some((amount) => amount.cents !== amounts[0].cents)) {
    kind = "divergence";
    summary =
      "Les sources indiquent des montants différents. Une validation humaine est nécessaire.";
  } else {
    kind = "aligned";
    summary =
      evidence.length === 1
        ? "Une seule preuve est disponible. Son montant exige une confirmation humaine."
        : "Les montants concordent. Cette concordance ne constitue pas une validation humaine.";
  }
  return { id, dossierId, field, kind, summary, evidenceRefs };
}

/** Refresh a control without losing a vanished conflict or an earlier decision from the audit trail. */
export function reconcileControl(input: {
  readonly dossierId: string;
  readonly field: FinancialField;
  readonly evidence: readonly Evidence[];
  readonly previous?: ControlState;
  /** A caller-supplied clock keeps this function deterministic. Defaults to the latest observation. */
  readonly at?: string;
}): ControlState {
  const evidence = scopedEvidence(input.dossierId, input.field, input.evidence);
  const signal = buildSignal(input.dossierId, input.field, evidence);
  const previous = input.previous;
  if (
    previous &&
    (previous.signal.dossierId !== input.dossierId ||
      previous.signal.field !== input.field)
  ) {
    throw new Error(
      "Le contrôle précédent concerne un autre dossier ou un autre champ.",
    );
  }
  if (
    previous &&
    matchingRefs(previous.signal.evidenceRefs, signal.evidenceRefs)
  )
    return previous;
  const at =
    input.at ??
    evidence
      .map((item) => item.observedAt)
      .sort()
      .at(-1) ??
    "1970-01-01T00:00:00.000Z";
  if (!validDate(at)) throw new Error("La date du contrôle est invalide.");
  const history: AuditEvent[] = [...(previous?.history ?? [])];
  if (previous?.resolution) {
    history.push({
      id: `${signal.id}:event:${history.length + 1}`,
      type: "invalidated",
      signalId: signal.id,
      at,
      reason:
        "Les preuves ont changé : la décision précédente est conservée dans le journal mais n'est plus applicable.",
      evidenceRefs: signal.evidenceRefs,
      resolution: previous.resolution,
    });
  }
  history.push({
    id: `${signal.id}:event:${history.length + 1}`,
    type: "detected",
    signalId: signal.id,
    at,
    reason: signal.summary,
    evidenceRefs: signal.evidenceRefs,
  });
  return immutable({ signal, resolution: null, history });
}

/** Records an explicit human choice; it does not alter any source value. Throws on stale or incomplete input. */
export function decideControl(
  state: ControlState,
  allEvidence: readonly Evidence[],
  input: DecisionInput,
): ControlState {
  if (
    !hasText(input.actorId) ||
    !hasText(input.justification) ||
    !validDate(input.at)
  ) {
    throw new Error(
      "Une personne, une justification et une date valides sont obligatoires.",
    );
  }
  const evidence = scopedEvidence(
    state.signal.dossierId,
    state.signal.field,
    allEvidence,
  );
  const current = buildSignal(
    state.signal.dossierId,
    state.signal.field,
    evidence,
  );
  if (
    !matchingRefs(state.signal.evidenceRefs, current.evidenceRefs) ||
    !matchingRefs(input.evidenceRefs, current.evidenceRefs)
  ) {
    throw new Error(
      "Les preuves ou leurs révisions ont changé. Actualisez le contrôle avant de décider.",
    );
  }
  if (current.kind === "missing" || current.kind === "incomparable") {
    throw new Error(
      "Les preuves doivent être complètes et comparables avant validation.",
    );
  }
  const chosen = evidence.find((item) => item.id === input.selectedEvidenceId);
  if (!chosen?.amount || isAI(chosen)) {
    throw new Error(
      "Le montant confirmé doit provenir d'une preuve documentaire, jamais de la seule analyse IA.",
    );
  }
  if (
    state.resolution &&
    state.resolution.actorId === input.actorId.trim() &&
    state.resolution.justification === input.justification.trim() &&
    state.resolution.selectedEvidenceId === chosen.id &&
    state.resolution.at === input.at
  )
    return state;
  const resolution: HumanResolution = {
    id: `${current.id}:decision:${state.history.length + 1}`,
    actorId: input.actorId.trim(),
    justification: input.justification.trim(),
    at: input.at,
    evidenceRefs: current.evidenceRefs,
    selectedEvidenceId: chosen.id,
    confirmedAmount: chosen.amount,
  };
  const event: AuditEvent = {
    id: `${current.id}:event:${state.history.length + 1}`,
    type: "resolved",
    signalId: current.id,
    at: input.at,
    reason: resolution.justification,
    evidenceRefs: current.evidenceRefs,
    resolution,
  };
  return immutable({
    signal: current,
    resolution,
    history: [...state.history, event],
  });
}

/**
 * Computes a preparation only, in the confirmed tax basis. 30% = cents × 3 / 10;
 * integer arithmetic rounds exactly to the nearest cent, with half a cent rounded up.
 * No invoice, message, bank instruction, payment or source update is authorized.
 */
export function prepareDeposit(
  state: ControlState,
  allEvidence: readonly Evidence[],
): DepositPreparation {
  const permissions = {
    authorizesIssuance: false,
    authorizesSending: false,
    authorizesPayment: false,
  } as const;
  const reasons: string[] = [];
  let evidence: Evidence[];
  try {
    evidence = scopedEvidence(
      state.signal.dossierId,
      state.signal.field,
      allEvidence,
    );
  } catch (error) {
    return immutable({
      allowed: false,
      reasons: [error instanceof Error ? error.message : "Preuves invalides."],
      ...permissions,
    });
  }
  const current = buildSignal(
    state.signal.dossierId,
    state.signal.field,
    evidence,
  );
  const resolution = state.resolution;
  if (state.signal.field !== "contract_total")
    reasons.push("La préparation exige le montant total du contrat.");
  if (
    !matchingRefs(state.signal.evidenceRefs, current.evidenceRefs) ||
    (resolution && !matchingRefs(resolution.evidenceRefs, current.evidenceRefs))
  ) {
    reasons.push(
      "La résolution est ancienne : les preuves ou leurs révisions ont changé.",
    );
  }
  if (
    !resolution ||
    !hasText(resolution.actorId) ||
    !hasText(resolution.justification) ||
    !validDate(resolution.at)
  ) {
    reasons.push(
      "Une validation humaine actuelle et justifiée est obligatoire.",
    );
  }
  if (current.kind === "missing" || current.kind === "incomparable")
    reasons.push(current.summary);
  if (current.kind === "divergence" && !resolution)
    reasons.push("Une divergence reste ouverte.");
  const chosen = evidence.find(
    (item) => item.id === resolution?.selectedEvidenceId,
  );
  const amount = chosen?.amount;
  if (!chosen || isAI(chosen) || !amount)
    reasons.push(
      "Une analyse IA seule ne constitue pas une preuve contractuelle.",
    );
  if (amount && (amount.taxBasis === "UNKNOWN" || amount.vatRateBps === null)) {
    reasons.push("La base HT/TTC et le taux de TVA doivent être connus.");
  }
  if (amount && resolution && !sameMoney(amount, resolution.confirmedAmount)) {
    reasons.push("Le montant ne correspond plus à la valeur confirmée.");
  }
  if (amount && amount.cents <= 0)
    reasons.push("Le montant contractuel doit être strictement positif.");
  const signedContract = evidence.find(
    (item) =>
      item.source.kind === "signed_quote" &&
      item.signed === true &&
      !isAI(item) &&
      item.amount !== null &&
      amount &&
      sameMoney(item.amount, amount) &&
      item.verification &&
      hasText(item.verification.actorId) &&
      hasText(item.verification.reason) &&
      validDate(item.verification.at) &&
      item.verification.evidenceRevision === item.revision &&
      item.verification.verifiedAmount &&
      sameMoney(item.verification.verifiedAmount, item.amount),
  );
  if (!signedContract)
    reasons.push(
      "Un devis signé et vérifié correspondant à la valeur confirmée est obligatoire.",
    );
  if (reasons.length || !amount || !resolution)
    return immutable({ allowed: false, reasons, ...permissions });
  const cents = Number((BigInt(amount.cents) * 3n + 5n) / 10n);
  return immutable({
    allowed: true,
    amount: { ...amount, cents },
    contractAmount: amount,
    ratePercent: 30,
    rounding: "nearest-cent-half-up",
    resolutionId: resolution.id,
    ...permissions,
  });
}

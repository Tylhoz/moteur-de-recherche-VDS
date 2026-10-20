import assert from "node:assert/strict";
import test from "node:test";
import {
  decideControl,
  prepareDeposit,
  reconcileControl,
  type ControlState,
  type DecisionInput,
  type Evidence,
  type Money,
} from "../src/domain/coherence";

const at = "2026-01-15T10:00:00.000Z";
const nextAt = "2026-01-16T10:00:00.000Z";
const dossierId = "dossier-test-001";
const money = (cents: number, changes: Partial<Money> = {}): Money => ({
  cents,
  currency: "EUR",
  taxBasis: "HT",
  vatRateBps: 2_100,
  ...changes,
});
const verification = (
  verifiedAmount = money(4_250_000),
  evidenceRevision = "1",
): NonNullable<Evidence["verification"]> => ({
  actorId: "controleur-test",
  at,
  reason: "Signature et total vérifiés pour ce test.",
  evidenceRevision,
  verifiedAmount,
});
const sheet = (changes: Partial<Evidence> = {}): Evidence => ({
  id: "preuve-tableau",
  revision: "1",
  dossierId,
  field: "contract_total",
  source: {
    id: "source-tableau",
    label: "Tableau de test",
    kind: "google_sheets",
  },
  observedAt: at,
  amount: money(3_950_000),
  ...changes,
});
const quote = (changes: Partial<Evidence> = {}): Evidence => ({
  id: "preuve-devis",
  revision: "1",
  dossierId,
  field: "contract_total",
  source: { id: "source-devis", label: "Devis de test", kind: "signed_quote" },
  observedAt: at,
  amount: money(4_250_000),
  signed: true,
  verification: verification(),
  ...changes,
});
const control = (evidence: readonly Evidence[], previous?: ControlState) =>
  reconcileControl({
    dossierId,
    field: "contract_total",
    evidence,
    previous,
    at,
  });
const decision = (
  state: ControlState,
  changes: Partial<DecisionInput> = {},
): DecisionInput => ({
  actorId: "utilisateur-test",
  justification: "Le devis signé confirme le montant retenu.",
  at,
  evidenceRefs: state.signal.evidenceRefs,
  selectedEvidenceId: "preuve-devis",
  ...changes,
});

test("a divergence requires an explicit choice and never changes its sources", () => {
  const evidence = [sheet(), quote()];
  const before = structuredClone(evidence);
  const open = control(evidence);
  assert.equal(open.signal.kind, "divergence");
  assert.equal(open.resolution, null);
  assert.equal(prepareDeposit(open, evidence).allowed, false);
  const resolved = decideControl(open, evidence, decision(open));
  assert.equal(resolved.resolution?.confirmedAmount.cents, 4_250_000);
  assert.deepEqual(evidence, before);
  assert.equal(open.resolution, null);
  assert.equal(open.history.length, 1);
  assert.equal(resolved.history.length, 2);
  assert.ok(Object.isFrozen(resolved));
  assert.ok(Object.isFrozen(resolved.history));
  assert.ok(Object.isFrozen(resolved.resolution?.confirmedAmount));
});

test("source order never selects an authoritative amount", () => {
  const evidence = [sheet(), quote()];
  assert.deepEqual(control(evidence), control([...evidence].reverse()));
  const state = control(evidence);
  const choseSheet = decideControl(
    state,
    evidence,
    decision(state, { selectedEvidenceId: "preuve-tableau" }),
  );
  assert.equal(choseSheet.resolution?.confirmedAmount.cents, 3_950_000);
  assert.equal(
    prepareDeposit(choseSheet, evidence).allowed,
    false,
    "a signed contract must support that exact choice",
  );
});

test("matching numerical totals in different tax bases stay incomparable", () => {
  const evidence = [
    sheet(),
    quote({ amount: money(3_950_000, { taxBasis: "TTC" }) }),
  ];
  const state = control(evidence);
  assert.equal(state.signal.kind, "incomparable");
  assert.throws(
    () => decideControl(state, evidence, decision(state)),
    /comparables/,
  );
  assert.equal(prepareDeposit(state, evidence).allowed, false);
});

test("unknown amount, base and VAT are explicit, never silently converted to zero", () => {
  assert.equal(
    control([sheet({ amount: null }), quote()]).signal.kind,
    "missing",
  );
  assert.equal(control([]).signal.kind, "missing");
  assert.equal(
    control([sheet({ amount: money(3_950_000, { taxBasis: "UNKNOWN" }) })])
      .signal.kind,
    "incomparable",
  );
  assert.equal(
    control([sheet({ amount: money(3_950_000, { vatRateBps: null }) })]).signal
      .kind,
    "incomparable",
  );
  assert.equal(
    control([sheet({ amount: money(3_950_000, { vatRateBps: 0 }) })]).signal
      .kind,
    "aligned",
  );
  assert.equal(
    control([
      sheet({ amount: money(3_950_000, { vatRateBps: 2_000 }) }),
      quote(),
    ]).signal.kind,
    "incomparable",
  );
  const missing = control([sheet({ amount: null }), quote()]);
  assert.throws(
    () =>
      decideControl(
        missing,
        [sheet({ amount: null }), quote()],
        decision(missing),
      ),
    /complètes/,
  );
});

test("a repeated observation is idempotent, including input order and exact duplicates", () => {
  const evidence = [sheet(), quote()];
  const state = control(evidence);
  assert.equal(control([...evidence].reverse(), state), state);
  assert.equal(control([...evidence, sheet()], state), state);
  const resolved = decideControl(state, evidence, decision(state));
  assert.equal(control(evidence, resolved), resolved);
  assert.equal(decideControl(resolved, evidence, decision(resolved)), resolved);
  assert.equal(resolved.history.length, 2);
});

test("every human choice must supply the exact IDs, revisions and content references", () => {
  const evidence = [sheet(), quote()];
  const state = control(evidence);
  for (const evidenceRefs of [
    [],
    state.signal.evidenceRefs.slice(1),
    state.signal.evidenceRefs.map((ref) => ({ ...ref, revision: "obsolete" })),
    state.signal.evidenceRefs.map((ref) => ({
      ...ref,
      fingerprint: "tampered",
    })),
  ]) {
    assert.throws(
      () => decideControl(state, evidence, decision(state, { evidenceRefs })),
      /révisions/,
    );
  }
  assert.throws(
    () => decideControl(state, evidence, decision(state, { actorId: " " })),
    /personne/,
  );
  assert.throws(
    () =>
      decideControl(state, evidence, decision(state, { justification: " " })),
    /justification/,
  );
  assert.throws(
    () => decideControl(state, evidence, decision(state, { at: "invalid" })),
    /date/,
  );
  assert.throws(
    () =>
      decideControl(
        state,
        evidence,
        decision(state, { selectedEvidenceId: "inconnu" }),
      ),
    /preuve/,
  );
});

test("AI-only analysis and AI-derived documents cannot confirm or prepare a deposit", () => {
  for (const evidence of [
    [
      quote({
        source: { id: "source-ia", label: "Analyse de test", kind: "ai" },
      }),
    ],
    [quote({ derivedByAI: true })],
  ]) {
    const state = control(evidence);
    assert.throws(() => decideControl(state, evidence, decision(state)), /IA/);
    assert.equal(prepareDeposit(state, evidence).allowed, false);
  }
});

test("an updated non-selected source invalidates the old decision and needs a new one", () => {
  const evidence = [sheet(), quote()];
  const state = control(evidence);
  const resolved = decideControl(state, evidence, decision(state));
  const changed = [
    sheet({ revision: "2", amount: money(4_250_000), observedAt: nextAt }),
    quote(),
  ];
  assert.equal(prepareDeposit(resolved, changed).allowed, false);
  assert.throws(
    () => decideControl(resolved, changed, decision(resolved)),
    /révisions/,
  );
  const refreshed = control(changed, resolved);
  assert.equal(refreshed.signal.kind, "aligned");
  assert.equal(
    refreshed.resolution,
    null,
    "a vanished divergence must not self-resolve",
  );
  assert.deepEqual(
    refreshed.history.map((event) => event.type),
    ["detected", "resolved", "invalidated", "detected"],
  );
  assert.equal(
    refreshed.history[1].resolution?.confirmedAmount.cents,
    4_250_000,
  );
  assert.equal(prepareDeposit(refreshed, changed).allowed, false);
  const confirmed = decideControl(
    refreshed,
    changed,
    decision(refreshed, { at: nextAt }),
  );
  assert.equal(prepareDeposit(confirmed, changed).allowed, true);
});

test("a selected-source revision change invalidates confirmation even if its total is unchanged", () => {
  const evidence = [sheet(), quote()];
  const state = control(evidence);
  const resolved = decideControl(state, evidence, decision(state));
  const changed = [sheet(), quote({ revision: "2" })];
  assert.equal(prepareDeposit(resolved, changed).allowed, false);
  assert.equal(control(changed, resolved).resolution, null);
});

test("an in-place source edit with an unchanged revision is detected by its exact content reference", () => {
  const evidence = [sheet(), quote()];
  const state = control(evidence);
  const resolved = decideControl(state, evidence, decision(state));
  const changed = [sheet({ amount: money(4_250_000) }), quote()];
  assert.equal(prepareDeposit(resolved, changed).allowed, false);
  assert.equal(control(changed, resolved).resolution, null);
  assert.equal(control(changed, resolved).history.at(-2)?.type, "invalidated");
});

test("a removed source or vanished conflict remains represented in the audit trail", () => {
  const state = control([sheet(), quote()]);
  const afterRemoval = control([quote()], state);
  assert.equal(afterRemoval.signal.kind, "aligned");
  assert.equal(afterRemoval.resolution, null);
  assert.equal(afterRemoval.history.length, 2);
  assert.equal(afterRemoval.history[0].evidenceRefs.length, 2);
  assert.equal(afterRemoval.history[1].evidenceRefs.length, 1);
  const nothing = control([], afterRemoval);
  assert.equal(nothing.signal.kind, "missing");
  assert.equal(nothing.history.length, 3);
});

test("30% is a preparation in the confirmed basis, never authorization to issue, send or pay", () => {
  const evidence = [sheet(), quote()];
  const state = control(evidence);
  const resolved = decideControl(state, evidence, decision(state));
  const result = prepareDeposit(resolved, evidence);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.amount, money(1_275_000));
  assert.equal(result.ratePercent, 30);
  assert.equal(result.rounding, "nearest-cent-half-up");
  assert.equal(result.authorizesIssuance, false);
  assert.equal(result.authorizesSending, false);
  assert.equal(result.authorizesPayment, false);
  assert.equal(result.resolutionId, resolved.resolution?.id);
});

test("cent calculations are exact with half-cent rounding and a known TTC base", () => {
  const amount = money(3_950_005, { taxBasis: "TTC" });
  const evidence = [quote({ amount, verification: verification(amount) })];
  const state = control(evidence);
  const resolved = decideControl(state, evidence, decision(state));
  const result = prepareDeposit(resolved, evidence);
  assert.equal(result.allowed, true);
  assert.equal(result.amount.cents, 1_185_002);
  assert.equal(result.amount.taxBasis, "TTC");
});

test("a known amount still requires a signed, human-verified contract", () => {
  for (const item of [
    quote({ signed: false }),
    quote({ verification: undefined }),
    quote({ verification: { ...verification(), actorId: " " } }),
    quote({ verification: { ...verification(), reason: " " } }),
  ]) {
    const evidence = [item];
    const state = control(evidence);
    const resolved = decideControl(state, evidence, decision(state));
    const result = prepareDeposit(resolved, evidence);
    assert.equal(result.allowed, false);
    if (!result.allowed)
      assert.ok(
        result.reasons.some((reason) => reason.includes("signé et vérifié")),
      );
  }
});

test("a copied signature verification cannot approve a new source revision after a new human decision", () => {
  const initialEvidence = [quote()];
  const initial = control(initialEvidence);
  const confirmed = decideControl(initial, initialEvidence, decision(initial));
  assert.equal(prepareDeposit(confirmed, initialEvidence).allowed, true);

  const changedEvidence = [quote({ revision: "2" })];
  const changed = control(changedEvidence, confirmed);
  const reconfirmed = decideControl(changed, changedEvidence, decision(changed, { at: nextAt }));
  const blocked = prepareDeposit(reconfirmed, changedEvidence);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes("signé et vérifié")));

  const verifiedEvidence = [quote({ revision: "2", verification: verification(money(4_250_000), "2") })];
  const verified = control(verifiedEvidence, reconfirmed);
  assert.equal(verified.resolution, null, "updating the verification also requires a current decision");
  const current = decideControl(verified, verifiedEvidence, decision(verified, { at: nextAt }));
  assert.equal(prepareDeposit(current, verifiedEvidence).allowed, true);
});

test("a copied signature verification cannot approve a different amount under the same source revision", () => {
  const initialEvidence = [quote()];
  const initial = control(initialEvidence);
  const confirmed = decideControl(initial, initialEvidence, decision(initial));
  const changedAmount = money(3_950_000);
  const changedEvidence = [quote({ amount: changedAmount })];
  const changed = control(changedEvidence, confirmed);
  const reconfirmed = decideControl(changed, changedEvidence, decision(changed, { at: nextAt }));
  const blocked = prepareDeposit(reconfirmed, changedEvidence);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes("signé et vérifié")));

  const verifiedEvidence = [quote({ amount: changedAmount, verification: verification(changedAmount) })];
  const verified = control(verifiedEvidence, reconfirmed);
  const current = decideControl(verified, verifiedEvidence, decision(verified, { at: nextAt }));
  assert.equal(prepareDeposit(current, verifiedEvidence).allowed, true);
});

test("fields and dossier identities cannot be mixed to manufacture a contract confirmation", () => {
  const evidence = [
    sheet(),
    quote({ field: "deposit_paid" }),
    quote({ id: "preuve-autre", dossierId: "dossier-test-002" }),
  ];
  const state = control(evidence);
  assert.equal(state.signal.evidenceRefs.length, 1);
  assert.throws(
    () => decideControl(state, evidence, decision(state)),
    /preuve/,
  );
  assert.throws(
    () =>
      reconcileControl({
        dossierId: "dossier-test-002",
        field: "contract_total",
        evidence,
        previous: state,
      }),
    /autre dossier/,
  );
  const depositEvidence = [quote({ field: "deposit_paid" })];
  const deposit = reconcileControl({
    dossierId,
    field: "deposit_paid",
    evidence: depositEvidence,
  });
  const resolved = decideControl(deposit, depositEvidence, decision(deposit));
  assert.equal(prepareDeposit(resolved, depositEvidence).allowed, false);
});

test("invalid monetary representations and contradictory duplicate evidence are rejected", () => {
  for (const cents of [
    3_950_000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => control([quote({ amount: money(cents) })]), /centimes/);
  }
  assert.throws(
    () => control([sheet(), sheet({ revision: "2" })]),
    /Deux versions/,
  );
  assert.throws(() => control([quote({ revision: "" })]), /révision/);
  assert.throws(
    () => control([quote({ amount: money(4_250_000, { vatRateBps: -1 }) })]),
    /TVA/,
  );
});

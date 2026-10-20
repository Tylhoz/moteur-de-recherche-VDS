import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyDossierFields,
  type ImportSnapshot,
  type ImportedObservation,
} from "../src/domain/records";
import {
  createSyncState,
  reduceSynchronization,
  validateColumnMapping,
  validateImportSnapshot,
} from "../src/domain/synchronization";

const time1 = "2026-01-01T10:00:00.000Z";
const time2 = "2026-01-01T10:01:00.000Z";
const time3 = "2026-01-01T10:02:00.000Z";
function observation(
  key = "alpha",
  revision = "version-1",
): ImportedObservation {
  return {
    clientId: `client:${key}`,
    dossierId: `dossier:${key}`,
    provenance: {
      sourceId: "source-test",
      revision,
      observedAt: time1,
      sheet: null,
      recordKey: key,
    },
    values: {
      ...emptyDossierFields(),
      label: `Dossier fictif ${key}`,
      contractHTCents: 100000,
      currency: "EUR",
    },
  };
}
function snapshot(
  observations = [observation()],
  revision = "version-1",
): ImportSnapshot {
  return {
    sourceId: "source-test",
    revision,
    complete: true,
    capturedAt: time1,
    observations,
  };
}
const receive = (value: unknown, attemptedAt = time1) => ({
  type: "snapshot-received" as const,
  snapshot: value,
  attemptedAt,
});

test("les statuts sont indépendants et les informations inconnues restent null", () => {
  const item = observation();
  item.values.statuses = {
    commercial: "accepte",
    chantier: "en_cours",
    finance: "partiel",
    sav: "ouvert",
  };
  const result = validateImportSnapshot(snapshot([item]));
  assert.equal(result.ok, true);
  assert.equal(item.values.depositCents, null);
  assert.equal(item.values.constructionDate, null);
});

test("un instantané incomplet, dupliqué ou mal formé est refusé intégralement", () => {
  assert.equal(
    validateImportSnapshot({ ...snapshot(), complete: false }).ok,
    false,
  );
  assert.equal(
    validateImportSnapshot(snapshot([observation(), observation()])).ok,
    false,
  );
  for (const mutate of [
    (item: ImportedObservation) => {
      item.values.contractHTCents = Number.NaN;
    },
    (item: ImportedObservation) => {
      item.values.contractHTCents = 12.34;
    },
    (item: ImportedObservation) => {
      item.values.constructionDate = "2026-02-30";
    },
    (item: ImportedObservation) => {
      item.provenance.revision = "autre";
    },
    (item: ImportedObservation) => {
      delete (item.values as Partial<typeof item.values>).depositCents;
    },
  ]) {
    const item = observation();
    mutate(item);
    assert.equal(validateImportSnapshot(snapshot([item])).ok, false);
  }
});

test("la configuration exige des clés persistantes et valide les colonnes disponibles", () => {
  const config = {
    sourceId: "source-test",
    sheet: null,
    clientKey: { column: "key_a", semantics: "persistent-key" },
    dossierKey: { column: "key_b", semantics: "persistent-key" },
    columns: { contractHTCents: "value_a" },
  };
  assert.equal(
    validateColumnMapping(config, ["key_a", "key_b", "value_a"]).ok,
    true,
  );
  assert.equal(validateColumnMapping(config, ["key_a", "key_b"]).ok, false);
  assert.equal(
    validateColumnMapping({
      ...config,
      dossierKey: { column: "row", semantics: "row-number" },
    }).ok,
    false,
  );
});

test("une erreur conserve les observations, la révision et la dernière réussite", () => {
  const initial = reduceSynchronization(
    createSyncState("source-test"),
    receive(snapshot()),
  );
  const failed = reduceSynchronization(initial, {
    type: "sync-failed",
    attemptedAt: time2,
    message: "Source temporairement indisponible.",
  });
  assert.equal(failed.observations, initial.observations);
  assert.equal(failed.revision, "version-1");
  assert.equal(failed.lastSuccessAt, time1);
  assert.equal(failed.lastAttemptAt, time2);
  assert.ok(failed.lastError);
  const invalid = reduceSynchronization(
    failed,
    receive({ ...snapshot(), complete: false }, time3),
  );
  assert.equal(invalid.observations, initial.observations);
  assert.equal(invalid.lastSuccessAt, time1);
});

test("un nouvel import ne remplace jamais un montant métier validé", () => {
  const item = observation();
  const approved = {
    clientId: item.clientId,
    dossierId: item.dossierId,
    values: { ...item.values, contractHTCents: 200000 },
    validatedAt: time1,
    validatedBy: "validateur-fictif",
  };
  const initial = createSyncState("source-test", {
    [item.dossierId]: approved,
  });
  const next = reduceSynchronization(initial, receive(snapshot([item])));
  assert.equal(next.validatedDossiers, initial.validatedDossiers);
  assert.equal(
    next.validatedDossiers[item.dossierId].values.contractHTCents,
    200000,
  );
  assert.equal(
    next.observations[item.dossierId].values.contractHTCents,
    100000,
  );
});

test("les imports identiques sont idempotents, même si les lignes changent de position", () => {
  const a = observation("alpha");
  const b = observation("beta");
  const initial = reduceSynchronization(
    createSyncState("source-test"),
    receive(snapshot([a, b])),
  );
  a.provenance.observedAt = time2;
  b.provenance.observedAt = time2;
  const next = reduceSynchronization(
    initial,
    receive({ ...snapshot([b, a]), capturedAt: time2 }, time2),
  );
  assert.equal(next.fingerprint, initial.fingerprint);
  assert.equal(next.observations, initial.observations);
  assert.equal(next.lastSuccessAt, time2);
  assert.equal(next.lastSnapshotCapturedAt, time2);
});

test("une ligne absente est conservée et marquée à vérifier puis rétablie si elle revient", () => {
  const initial = reduceSynchronization(
    createSyncState("source-test"),
    receive(snapshot([observation("alpha"), observation("beta")])),
  );
  const missing = reduceSynchronization(
    initial,
    receive(snapshot([observation("alpha", "version-2")], "version-2"), time2),
  );
  assert.deepEqual(missing.missingDossierIds, ["dossier:beta"]);
  assert.equal(Object.keys(missing.observations).length, 2);
  assert.equal(
    missing.observations["dossier:beta"].provenance.revision,
    "version-1",
  );
  const restored = reduceSynchronization(
    missing,
    receive(
      snapshot(
        [observation("alpha", "version-3"), observation("beta", "version-3")],
        "version-3",
      ),
      time3,
    ),
  );
  assert.deepEqual(restored.missingDossierIds, []);
});

test("une autre source ne peut pas écraser cet état et les entrées restent isolées", () => {
  const input = snapshot();
  const state = reduceSynchronization(
    createSyncState("source-test"),
    receive(input),
  );
  input.observations[0].values.contractHTCents = 999999;
  assert.equal(
    state.observations["dossier:alpha"].values.contractHTCents,
    100000,
  );
  const foreign = snapshot();
  foreign.sourceId = "autre-source";
  foreign.observations[0].provenance.sourceId = "autre-source";
  const next = reduceSynchronization(state, receive(foreign, time2));
  assert.equal(next.observations, state.observations);
  assert.equal(next.lastSuccessAt, time1);
  assert.ok(next.lastError);
});

test("des réponses reçues dans le désordre ne font régresser ni les données ni les horodatages", () => {
  const recent = {
    ...snapshot([observation("alpha", "version-2")], "version-2"),
    capturedAt: time2,
  };
  const state = reduceSynchronization(
    createSyncState("source-test"),
    receive(recent, time2),
  );
  const olderRequest = reduceSynchronization(state, receive(snapshot(), time1));
  assert.equal(olderRequest, state);
  const olderFailure = reduceSynchronization(state, {
    type: "sync-failed",
    attemptedAt: time1,
    message: "Ancienne tentative échouée.",
  });
  assert.equal(olderFailure, state);
  const staleSnapshot = reduceSynchronization(
    state,
    receive(snapshot(), time3),
  );
  assert.equal(staleSnapshot.observations, state.observations);
  assert.equal(staleSnapshot.revision, "version-2");
  assert.equal(staleSnapshot.lastSuccessAt, time2);
  assert.equal(staleSnapshot.lastAttemptAt, time3);
  assert.equal(staleSnapshot.lastSnapshotCapturedAt, time2);
  assert.ok(staleSnapshot.lastError);
});

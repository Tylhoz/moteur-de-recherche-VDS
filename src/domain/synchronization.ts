import type {
  DossierId,
  ImportSnapshot,
  ImportedObservation,
  MappedField,
  SheetColumnMapping,
  ValidatedDossier,
} from "./records";

type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isDate = (value: unknown): boolean =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
    value,
  ) &&
  isDate(value.slice(0, 10)) &&
  Number.isFinite(Date.parse(value));
const isId = (value: unknown, prefix: string): boolean =>
  typeof value === "string" &&
  value.startsWith(`${prefix}:`) &&
  value.length > prefix.length + 1 &&
  value.trim() === value &&
  !/[\u0000-\u001f]/.test(value);

const statusValues = {
  commercial: ["prospect", "devis_envoye", "accepte", "perdu"],
  chantier: ["a_planifier", "planifie", "en_cours", "termine"],
  finance: ["a_facturer", "partiel", "regle", "litige"],
  sav: ["ouvert", "en_cours", "resolu"],
};
const monetaryFields = [
  "contractHTCents",
  "depositCents",
  "paymentsReceivedCents",
  "creditNoteCents",
];
const mappedFields = new Set<string>([
  "label",
  ...monetaryFields,
  "currency",
  "constructionDate",
  ...Object.keys(statusValues),
]);

export function validateColumnMapping(
  input: unknown,
  availableColumns?: readonly string[],
): Validation<SheetColumnMapping> {
  if (!isObject(input))
    return { ok: false, errors: ["Configuration absente ou mal formée."] };
  const errors: string[] = [];
  if (!isText(input.sourceId)) errors.push("Identifiant de source requis.");
  if (input.sheet !== null && !isText(input.sheet))
    errors.push("Feuille invalide.");
  const checkColumn = (column: unknown, label: string) => {
    if (!isText(column)) errors.push(`${label} : colonne requise.`);
    else if (availableColumns && !availableColumns.includes(column))
      errors.push(`${label} : colonne absente de la source.`);
  };
  for (const key of ["clientKey", "dossierKey"]) {
    const binding = input[key];
    if (!isObject(binding) || binding.semantics !== "persistent-key") {
      errors.push(
        `${key} : une clé persistante est obligatoire, jamais un numéro de ligne.`,
      );
    } else checkColumn(binding.column, key);
  }
  if (!isObject(input.columns))
    errors.push("Correspondance des colonnes requise.");
  else {
    const usedColumns = new Set<string>();
    for (const [field, column] of Object.entries(input.columns)) {
      if (!mappedFields.has(field as MappedField))
        errors.push("Champ métier inconnu dans la correspondance.");
      checkColumn(column, field);
      if (typeof column === "string") {
        if (usedColumns.has(column))
          errors.push("Une colonne est affectée à plusieurs champs métier.");
        usedColumns.add(column);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  const valid = input as unknown as SheetColumnMapping;
  return {
    ok: true,
    value: {
      sourceId: valid.sourceId,
      sheet: valid.sheet,
      clientKey: {
        column: valid.clientKey.column,
        semantics: "persistent-key",
      },
      dossierKey: {
        column: valid.dossierKey.column,
        semantics: "persistent-key",
      },
      columns: { ...valid.columns },
    },
  };
}

export function validateImportSnapshot(
  input: unknown,
): Validation<ImportSnapshot> {
  if (!isObject(input))
    return { ok: false, errors: ["Instantané absent ou mal formé."] };
  const errors: string[] = [];
  if (!isText(input.sourceId)) errors.push("Identifiant de source requis.");
  if (!isText(input.revision)) errors.push("Révision requise.");
  if (input.complete !== true)
    errors.push("Import incomplet : aucune modification appliquée.");
  if (!isTimestamp(input.capturedAt)) errors.push("Date de capture invalide.");
  if (!Array.isArray(input.observations))
    return {
      ok: false,
      errors: [...errors, "Liste des observations requise."],
    };
  const dossiers = new Set<string>();
  const keys = new Set<string>();
  input.observations.forEach((observation: unknown, index: number) => {
    const prefix = `Observation ${index + 1}`;
    if (!isObject(observation)) {
      errors.push(`${prefix} : format invalide.`);
      return;
    }
    if (!isId(observation.clientId, "client"))
      errors.push(`${prefix} : identifiant client invalide.`);
    if (!isId(observation.dossierId, "dossier"))
      errors.push(`${prefix} : identifiant dossier invalide.`);
    if (typeof observation.dossierId === "string") {
      if (dossiers.has(observation.dossierId))
        errors.push(`${prefix} : identifiant dossier dupliqué.`);
      dossiers.add(observation.dossierId);
    }
    const provenance = observation.provenance;
    if (!isObject(provenance)) errors.push(`${prefix} : provenance requise.`);
    else {
      if (
        provenance.sourceId !== input.sourceId ||
        provenance.revision !== input.revision
      )
        errors.push(`${prefix} : source ou révision incohérente.`);
      if (!isTimestamp(provenance.observedAt))
        errors.push(`${prefix} : date d'observation invalide.`);
      if (provenance.sheet !== null && !isText(provenance.sheet))
        errors.push(`${prefix} : feuille invalide.`);
      if (!isText(provenance.recordKey))
        errors.push(`${prefix} : clé source persistante requise.`);
      else {
        const key = JSON.stringify([provenance.sheet, provenance.recordKey]);
        if (keys.has(key)) errors.push(`${prefix} : clé source dupliquée.`);
        keys.add(key);
      }
    }
    const values = observation.values;
    if (!isObject(values)) {
      errors.push(`${prefix} : valeurs requises.`);
      return;
    }
    if (values.label !== null && !isText(values.label))
      errors.push(`${prefix} : libellé invalide.`);
    for (const field of monetaryFields) {
      if (
        values[field] !== null &&
        !(
          typeof values[field] === "number" &&
          Number.isSafeInteger(values[field]) &&
          (values[field] as number) >= 0
        )
      ) {
        errors.push(
          `${prefix} : montant invalide, centimes entiers positifs ou null attendus.`,
        );
      }
    }
    if (values.currency !== null && values.currency !== "EUR")
      errors.push(`${prefix} : devise invalide.`);
    if (
      monetaryFields.some((field) => values[field] !== null) &&
      values.currency !== "EUR"
    )
      errors.push(`${prefix} : devise obligatoire pour les montants.`);
    if (values.constructionDate !== null && !isDate(values.constructionDate))
      errors.push(`${prefix} : date de chantier invalide.`);
    if (!isObject(values.statuses))
      errors.push(`${prefix} : statuts indépendants requis.`);
    else
      for (const [field, allowed] of Object.entries(statusValues)) {
        const value = values.statuses[field];
        if (
          value !== null &&
          !(typeof value === "string" && allowed.includes(value))
        )
          errors.push(`${prefix} : statut ${field} invalide.`);
      }
  });
  if (errors.length) return { ok: false, errors };
  // On ne conserve que les champs du contrat, jamais des propriétés étrangères non validées.
  const valid = input as unknown as ImportSnapshot;
  return {
    ok: true,
    value: {
      sourceId: valid.sourceId,
      revision: valid.revision,
      complete: true,
      capturedAt: valid.capturedAt,
      observations: valid.observations.map((item) => ({
        clientId: item.clientId,
        dossierId: item.dossierId,
        provenance: {
          sourceId: item.provenance.sourceId,
          revision: item.provenance.revision,
          observedAt: item.provenance.observedAt,
          sheet: item.provenance.sheet,
          recordKey: item.provenance.recordKey,
        },
        values: {
          label: item.values.label,
          contractHTCents: item.values.contractHTCents,
          depositCents: item.values.depositCents,
          paymentsReceivedCents: item.values.paymentsReceivedCents,
          creditNoteCents: item.values.creditNoteCents,
          currency: item.values.currency,
          constructionDate: item.values.constructionDate,
          statuses: {
            commercial: item.values.statuses.commercial,
            chantier: item.values.statuses.chantier,
            finance: item.values.statuses.finance,
            sav: item.values.statuses.sav,
          },
        },
      })),
    },
  };
}

/** Comparaison canonique exacte : pas de collision de hash ni de dépendance cryptographique. */
export function snapshotFingerprint(snapshot: ImportSnapshot): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!isObject(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  };
  return JSON.stringify(
    canonicalize({
      sourceId: snapshot.sourceId,
      revision: snapshot.revision,
      observations: [...snapshot.observations]
        .sort((a, b) => a.dossierId.localeCompare(b.dossierId))
        .map((item) => ({
          clientId: item.clientId,
          dossierId: item.dossierId,
          values: item.values,
          provenance: {
            sourceId: item.provenance.sourceId,
            revision: item.provenance.revision,
            sheet: item.provenance.sheet,
            recordKey: item.provenance.recordKey,
          },
        })),
    }),
  );
}

export interface SyncState {
  sourceId: string;
  revision: string | null;
  fingerprint: string | null;
  observations: Readonly<Record<DossierId, ImportedObservation>>;
  validatedDossiers: Readonly<Record<DossierId, ValidatedDossier>>;
  missingDossierIds: readonly DossierId[];
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSnapshotCapturedAt: string | null;
  lastError: string | null;
}

export type SyncEvent =
  | { type: "snapshot-received"; attemptedAt: string; snapshot: unknown }
  | { type: "sync-failed"; attemptedAt: string; message: string };

/**
 * Un état par source : les observations de deux services restent séparées.
 * Seule la dernière observation est conservée par dossier ; ce reducer n'est pas
 * un journal historique. L'historisation durable devra accompagner le connecteur.
 */
export function createSyncState(
  sourceId: string,
  validatedDossiers: SyncState["validatedDossiers"] = {},
): SyncState {
  if (!isText(sourceId)) throw new Error("Identifiant de source requis.");
  return {
    sourceId,
    revision: null,
    fingerprint: null,
    observations: {},
    validatedDossiers: structuredClone(validatedDossiers),
    missingDossierIds: [],
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastSnapshotCapturedAt: null,
    lastError: null,
  };
}

export function reduceSynchronization(
  state: SyncState,
  event: SyncEvent,
): SyncState {
  if (!isTimestamp(event.attemptedAt))
    throw new Error("Date de tentative invalide.");
  // Une réponse tardive d'une ancienne requête ne peut faire régresser l'état.
  if (
    state.lastAttemptAt &&
    Date.parse(event.attemptedAt) < Date.parse(state.lastAttemptAt)
  )
    return state;
  const fail = (message: string): SyncState => ({
    ...state,
    lastAttemptAt: event.attemptedAt,
    lastError: message,
  });
  if (event.type === "sync-failed") return fail(event.message);
  const validation = validateImportSnapshot(event.snapshot);
  if (!validation.ok) return fail(validation.errors.join(" "));
  const snapshot = validation.value;
  if (snapshot.sourceId !== state.sourceId)
    return fail("Cet instantané appartient à une autre source.");
  if (
    state.lastSnapshotCapturedAt &&
    Date.parse(snapshot.capturedAt) < Date.parse(state.lastSnapshotCapturedAt)
  ) {
    return fail(
      "Instantané ancien ignoré : la dernière version valide est conservée.",
    );
  }
  const fingerprint = snapshotFingerprint(snapshot);
  if (state.fingerprint === fingerprint) {
    return {
      ...state,
      lastAttemptAt: event.attemptedAt,
      lastSuccessAt: event.attemptedAt,
      lastSnapshotCapturedAt: snapshot.capturedAt,
      lastError: null,
    };
  }
  const observations = { ...state.observations };
  const received = new Set<DossierId>();
  for (const observation of snapshot.observations) {
    received.add(observation.dossierId);
    observations[observation.dossierId] = observation;
  }
  return {
    ...state,
    revision: snapshot.revision,
    fingerprint,
    observations,
    missingDossierIds: (Object.keys(observations) as DossierId[])
      .filter((id) => !received.has(id))
      .sort(),
    lastAttemptAt: event.attemptedAt,
    lastSuccessAt: event.attemptedAt,
    lastSnapshotCapturedAt: snapshot.capturedAt,
    lastError: null,
  };
}

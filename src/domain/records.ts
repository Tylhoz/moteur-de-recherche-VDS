/** Identifiants persistants issus d'une clé métier, jamais de la position d'une ligne. */
export type ClientId = `client:${string}`;
export type DossierId = `dossier:${string}`;

export interface DossierStatuses {
  commercial: "prospect" | "devis_envoye" | "accepte" | "perdu" | null;
  chantier: "a_planifier" | "planifie" | "en_cours" | "termine" | null;
  finance: "a_facturer" | "partiel" | "regle" | "litige" | null;
  sav: "ouvert" | "en_cours" | "resolu" | null;
}

/** Les montants sont exprimés en centimes. Une information absente reste null. */
export interface DossierFields {
  label: string | null;
  contractHTCents: number | null;
  depositCents: number | null;
  paymentsReceivedCents: number | null;
  creditNoteCents: number | null;
  currency: "EUR" | null;
  constructionDate: string | null;
  statuses: DossierStatuses;
}

export interface ObservationProvenance {
  sourceId: string;
  revision: string;
  /** Date de collecte, exclue de l'empreinte métier pour permettre des lectures répétées. */
  observedAt: string;
  sheet: string | null;
  /** Clé persistante du système source ; aucun numéro de ligne. */
  recordKey: string;
}

export interface ImportedObservation {
  clientId: ClientId;
  dossierId: DossierId;
  provenance: ObservationProvenance;
  values: DossierFields;
}

/** Cette partie métier ne peut être changée que par un futur workflow de validation. */
export interface ValidatedDossier {
  clientId: ClientId;
  dossierId: DossierId;
  values: DossierFields;
  validatedAt: string;
  validatedBy: string;
}

export interface ImportSnapshot {
  sourceId: string;
  revision: string;
  /** Un import incomplet ne permet jamais de conclure qu'un dossier a disparu. */
  complete: true;
  capturedAt: string;
  observations: readonly ImportedObservation[];
}

/** Contrat préparatoire uniquement : aucune méthode d'écriture, aucun appel réseau ici. */
export interface ReadOnlySourceAdapter {
  readonly sourceId: string;
  readSnapshot(signal?: AbortSignal): Promise<unknown>;
}

export interface PersistentKeyColumn {
  column: string;
  semantics: "persistent-key";
}

export type MappedField =
  | Exclude<keyof DossierFields, "statuses">
  | keyof DossierStatuses;

/** Les noms de feuilles et colonnes seront fournis lors de la préparation du connecteur. */
export interface SheetColumnMapping {
  sourceId: string;
  sheet: string | null;
  clientKey: PersistentKeyColumn;
  dossierKey: PersistentKeyColumn;
  columns: Partial<Record<MappedField, string>>;
}

export function emptyDossierFields(): DossierFields {
  return {
    label: null,
    contractHTCents: null,
    depositCents: null,
    paymentsReceivedCents: null,
    creditNoteCents: null,
    currency: null,
    constructionDate: null,
    statuses: { commercial: null, chantier: null, finance: null, sav: null },
  };
}

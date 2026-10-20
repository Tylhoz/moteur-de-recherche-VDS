export type Source = "local" | "api";
export type Category = "alerte" | "solde" | "sav" | "valide" | "non_verifie";
export type Section =
  | "dashboard"
  | "analysis"
  | "validation"
  | "clients"
  | "devis"
  | "ventes"
  | "chantiers"
  | "factures"
  | "sav";
export type RecordKind = Exclude<
  Section,
  "dashboard" | "analysis" | "clients" | "validation"
>;
export interface Client {
  id: string;
  client: string;
  contact: string;
  address: string;
  modelTeam: string;
  techMacon: string;
  finance: string;
  statusAction: string;
  category: Category;
  soldeAmount: number | null;
  contractHT: number | null;
}
export interface BusinessRecord {
  id: string;
  kind: RecordKind;
  clientId: string;
  title: string;
  status: string;
  amount: number | null;
  dueDate: string;
  owner: string;
  progress?: number;
  priority?: "normale" | "haute";
  updatedAt: string;
}
export interface SourceLink {
  label: string;
  url: string;
}
export interface SnapshotSourceState {
  /** Last successful reading of the business source, never the browser request time. */
  lastReadAt: string | null;
  lastAttemptAt: string | null;
  stale: boolean;
  status: "ready" | "stale" | "not_connected";
  reason?: string;
  revision?: string;
}
export interface Snapshot {
  source: Source;
  version: string;
  fetchedAt: string;
  clients: Client[];
  records: BusinessRecord[];
  links?: SourceLink[];
  sourceState?: SnapshotSourceState;
  enrichedClientIds?: string[];
  dataCoverage?: {historical:number;format360:number;sheetsRelated:number;sheetsContinuous:boolean;accountingRelated:number;accountingProjectionPending?:boolean;accountingConnected:boolean;humanVerified:number};
  moduleClientIds?: Partial<Record<RecordKind, string[]>>;
  connection: {
    mode: "offline" | "readonly-api";
    label: string;
    intervalMs: number;
    sheetReady: boolean;
  };
}
export interface ClientFilters {
  search: string;
  status: "all" | Category | "followup";
  team: string;
  model: string;
  sort: "id_asc" | "mixed" | "solde_desc" | "ht_desc" | "name_asc";
}
export type RecordDraft = Omit<BusinessRecord, "id" | "updatedAt">;

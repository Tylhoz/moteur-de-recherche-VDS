/** Public response types only; business records are projected by the private API. */
import type { PilotFieldStatus, PilotSource } from './pilot-contract.js';

export type AnalyticsMetric = 'clients' | 'contracts' | 'balances' | 'review' | 'activity';
export interface AnalyticsSource {
  id: string; label: string; url: string | null; kind: PilotSource['kind'];
  status: PilotSource['status']; occurredAt: string | null;
}
export interface AnalyticsObservation {
  id: string; label: string; value: string | null; status: PilotFieldStatus;
  category: 'contract' | 'invoice' | 'payment' | 'balance' | 'due_date' | 'financial';
  sources: AnalyticsSource[]; note: string | null;
  /** These are sourced observations, never certified monetary ledger entries. */
  humanValidated: false;
}
export interface AnalyticsDossier {
  id: string; name: string; enriched: boolean; category: string;
  counts: { fields: number; documented: number; missing: number; review: number;
    unverified: number; excluded: number; obsolete: number; contradictions: number;
    sources: number; documents: number; documentsRead: number; events: number };
  months: string[];
  owner: string | null; ownerSources: AnalyticsSource[];
  observations: AnalyticsObservation[];
}
export interface AnalyticsEvent {
  id: string; dossierId: string;
  /** Date of the evidence/communication, not proof that a planned activity happened. */
  date: string | null; month: string | null; dateOriginal: string | null;
  plannedEventDate: string | null;
  summary: string; category: string | null; status: PilotFieldStatus;
  sources: AnalyticsSource[];
}
export interface AnalyticsActivityPoint {
  month: string; count: number; documented: number; review: number; other: number;
  dossierIds: string[];
}
export interface AnalyticsCoveragePoint {
  id: PilotFieldStatus; label: string; count: number; dossierIds: string[];
}
export interface AnalyticsResponse {
  schemaVersion: 'analytics-1';
  meta: { sourceReadAt: string | null; sourceAuditDate: string | null;
    stale: boolean; state: string; revision: string; sourceRevision: string; readOnly: true;
    sourceMode: 'private_audit_snapshot'; activityDateBasis: 'source_communication_date_utc' };
  totals: { clients: number; enriched: number; unenriched: number; documentedFields: number;
    missingFields: number; reviewFields: number; contradictions: number; reviewDossiers: number;
    sources: number; documents: number; documentsRead: number; events: number;
    datedEvents: number; undatedEvents: number; humanValidated: 0 };
  dossiers: AnalyticsDossier[];
  events: AnalyticsEvent[];
  activity: AnalyticsActivityPoint[];
  /** Exclusive field-status distribution, not a partition of dossiers. */
  coverage: AnalyticsCoveragePoint[];
  finance: { currency: 'EUR'; contractsTotal: null; balancesTotal: null;
    series: []; reason: string };
  limitations: string[];
}

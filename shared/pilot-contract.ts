/** Public response types only. No customer data or credentials belong in this file. */
export type PilotFieldStatus = 'documented' | 'review' | 'missing' | 'unverified' | 'excluded' | 'obsolete';
export interface PilotSource {
  id: string; label: string; url: string | null; kind: 'gmail' | 'attachment' | 'agenda' | 'sheets';
  occurredAt: string | null; dateOriginal: string | null;
  status: 'read' | 'identified' | 'excluded';
}
export interface PilotField {
  id: string; label: string; value: string | null; status: PilotFieldStatus;
  sourceIds: string[]; note: string | null; sourceStatus: string | null;
  humanValidated: false;
}
export interface PilotSection { id: string; label: string; fields: PilotField[]; }
export interface PilotContradiction {
  id: string; field: string; existingValue: string | null; observedValue: string | null;
  sourceIds: string[]; reason: string | null; action: string | null; status: 'review';
}
export interface PilotTimelineEvent {
  id: string; dateOriginal: string | null; dateUTC: string | null;
  eventDate: string | null; summary: string; category: string | null;
  status: PilotFieldStatus; sourceStatus: string | null; sourceIds: string[];
}
export interface PilotDocument {
  id: string; filename: string; mimeType: string | null; sourceIds: string[];
  url: string | null; contentRead: boolean; visuallyChecked: boolean;
  status: 'documented' | 'unverified'; note: string;
}
export interface PilotAgendaEvent {
  id: string; title: string; start: string | null; end: string | null;
  location: string | null; url: string | null; sourceIds: string[];
  status: 'review'; sourceStatus: string | null; issues: string[];
  associationApproved: false; clientApprovalVerified: false; completionVerified: false;
}
export interface PilotCounts {
  documented: number; review: number; missing: number; unverified: number;
  excluded: number; obsolete: number; contradictions: number; humanValidated: 0;
}
export interface PilotDossier {
  id: string; name: string; scope: string; summary: string;
  matching: { status: 'proposed_strong' | 'uncertain'; description: string; keys: string[]; humanValidated: false };
  status: 'review'; sections: PilotSection[]; sources: PilotSource[];
  contradictions: PilotContradiction[]; nextActions: string[];
  timeline: PilotTimelineEvent[]; documents: PilotDocument[]; agenda: PilotAgendaEvent[];
  counts: PilotCounts; lastSourceReadAt: string | null;
  limitations: string[]; productionApplied: false;
}
export interface PilotBundle {
  schemaVersion: 'pilot-1'; generatedAt: string; sourceMode: 'private_audit_snapshot';
  sourceAuditDate: string; sourceDigest: string; dossiers: PilotDossier[];
  counts: PilotCounts & { dossiers: number; timelineEvents: number; documents: number; agendaCandidates: number };
  humanValidationRequired: true;
}
export interface PilotResponse {
  data: PilotDossier;
  meta: { lastReadAt: string; lastSourceReadAt: string | null; state: string;
    readOnly: true; revision: string; sourceMode: 'private_audit_snapshot' | 'sheets_observations'; continuous?: boolean };
}

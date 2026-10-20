import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildAnalytics } from '../server/analytics.js';
import { PortalStore, PrivateNativeReadProvider } from '../server/portal.js';
import type { Snapshot } from '../src/types.js';
import type { PilotDossier, PilotField, PilotResponse } from '../shared/pilot-contract.js';

// Isolated technical fixtures only. These records never enter the application bundle.
function fixture(): { snapshot: Snapshot; pilots: PilotResponse[] } {
  const field = (id: string, label: string, value: string | null, status: PilotField['status'] = 'documented'): PilotField => ({
    id, label, value, status, sourceIds: value ? ['source-1'] : [], note: null, sourceStatus: null, humanValidated: false,
  });
  const data: PilotDossier = {
    id: 'TEST-001', name: 'Dossier de test isolé', scope: 'test', summary: 'Exemple de test seulement',
    matching: { status: 'proposed_strong', description: 'test', keys: [], humanValidated: false }, status: 'review',
    sections: [
      { id: 'identite', label: 'Identité', fields: [field('identity-contact', 'Interlocutrice', 'Nom qui ne définit pas le responsable')] },
      { id: 'finances', label: 'Finances', fields: [field('contract', 'Contrat HT', '100 € HT, puis 150 € selon une autre version', 'review'), field('payment', 'Paiement déclaré', 'Le client annonce un virement de 30 €'), field('balance', 'Solde vérifié', null, 'missing')] },
    ],
    sources: [{ id: 'source-1', label: 'Message de test', url: 'https://mail.google.com/mail/u/0/#all/test-only', kind: 'gmail', occurredAt: '2026-01-20T10:00:00Z', dateOriginal: null, status: 'read' }],
    contradictions: [{ id: 'conflict-1', field: 'Contrat HT', existingValue: '100 €', observedValue: '150 €', sourceIds: ['source-1'], reason: 'Versions différentes', action: null, status: 'review' }],
    nextActions: [], timeline: [
      { id: 'event-1', dateUTC: '2026-01-31T23:30:00Z', dateOriginal: '31 janvier', eventDate: '2026-04-12', summary: 'Une date est envisagée', category: 'Planification', status: 'documented', sourceStatus: null, sourceIds: ['source-1'] },
      { id: 'event-2', dateUTC: '2026-02-03T10:00:00Z', dateOriginal: '3 février', eventDate: null, summary: 'Une autre date est proposée', category: 'Planification', status: 'review', sourceStatus: null, sourceIds: ['source-1'] },
      { id: 'event-undated', dateUTC: null, dateOriginal: 'vers février', eventDate: null, summary: 'Date inconnue', category: null, status: 'review', sourceStatus: null, sourceIds: ['source-1'] },
    ],
    documents: [{ id: 'doc-1', filename: 'document de test', mimeType: 'application/pdf', sourceIds: ['source-1'], url: null, contentRead: false, visuallyChecked: false, status: 'unverified', note: 'Identifié seulement' }],
    agenda: [], counts: { documented: 999, review: 999, missing: 999, unverified: 0, excluded: 0, obsolete: 0, contradictions: 999, humanValidated: 0 },
    lastSourceReadAt: null, limitations: [], productionApplied: false,
  };
  const client = { id: 'TEST-001', client: data.name, contact: 'private-test-contact', address: 'private-test-address', modelTeam: 'Narration mentionnant un employé', techMacon: '', finance: '18 millions et 3 millions sont non vérifiés', statusAction: '', category: 'non_verifie' as const, contractHT: 18_000_000, soldeAmount: 3_000_000 };
  return {
    snapshot: { source: 'api', version: 'isolated-test', fetchedAt: '2030-01-01T00:00:00Z', sourceState: { lastReadAt: '2026-03-01T00:00:00Z', lastAttemptAt: '2026-03-02T00:00:00Z', stale: true, status: 'not_connected' },
      clients: [client, { ...client, id: 'TEST-002', client: 'Dossier non enrichi' }], records: [], enrichedClientIds: ['TEST-001'],
      connection: { mode: 'readonly-api', label: 'test', intervalMs: 30_000, sheetReady: false } },
    pilots: [{ data, meta: { lastReadAt: '2030-01-01T00:00:00Z', lastSourceReadAt: null, state: 'private_audit_snapshot', readOnly: true, revision: 'test', sourceMode: 'private_audit_snapshot' } }],
  };
}

test('analytics retains sourced observations but never turns legacy amounts or payment declarations into financial totals', () => {
  const { snapshot, pilots } = fixture(); const before = JSON.stringify({ snapshot, pilots });
  const data = buildAnalytics(snapshot, pilots, { sourceAuditDate: '2026-03-01' });
  assert.equal(data.finance.contractsTotal, null); assert.equal(data.finance.balancesTotal, null); assert.deepEqual(data.finance.series, []);
  assert.equal(data.dossiers[0].observations[0].value, pilots[0].data.sections[1].fields[0].value);
  assert.equal(data.dossiers[0].observations[1].category, 'payment');
  assert.equal(data.dossiers[0].observations[1].humanValidated, false);
  assert.equal(data.totals.humanValidated, 0); assert.equal(data.totals.documentedFields, 2);
  assert.equal(data.totals.contradictions, 1); assert.equal(data.totals.missingFields, 1);
  assert.equal(data.meta.sourceReadAt, '2026-03-01T00:00:00Z'); assert.equal(data.meta.sourceAuditDate, '2026-03-01');
  assert.equal(data.meta.stale, true); assert.equal(data.meta.state, 'not_connected');
  const serialized = JSON.stringify(data);
  assert.ok(!serialized.includes('18000000')); assert.ok(!serialized.includes('3000000'));
  assert.ok(!serialized.includes('private-test-contact')); assert.ok(!serialized.includes('private-test-address'));
  assert.equal(JSON.stringify({ snapshot, pilots }), before, 'Projection must never mutate source data');
});

test('activity uses evidence dates, separates planned dates and preserves uncertain or undated events', () => {
  const { snapshot, pilots } = fixture(); const data = buildAnalytics(snapshot, pilots);
  assert.deepEqual(data.activity.map(row => [row.month, row.count, row.documented, row.review]), [['2026-01', 1, 1, 0], ['2026-02', 1, 0, 1]]);
  assert.equal(data.events[0].plannedEventDate, '2026-04-12'); assert.equal(data.events[0].month, '2026-01');
  assert.equal(data.events[2].month, null); assert.equal(data.totals.undatedEvents, 1);
  assert.equal(data.meta.sourceAuditDate, null); assert.equal(data.meta.activityDateBasis, 'source_communication_date_utc');
  assert.deepEqual(data.dossiers[0].months, ['2026-01', '2026-02']);
  assert.equal(data.coverage.reduce((sum, row) => sum + row.count, 0), 4);
  assert.deepEqual(data.coverage.find(row => row.id === 'missing')!.dossierIds, ['TEST-001']);
});

test('only eligible unique fiches contribute; unenriched dossiers are not represented as audited', () => {
  const { snapshot, pilots } = fixture();
  const forged = structuredClone(pilots[0]); forged.data.id = 'TEST-002'; forged.data.summary = 'must not appear';
  const data = buildAnalytics(snapshot, [...pilots, forged]);
  assert.equal(data.totals.enriched, 1); assert.equal(data.totals.unenriched, 1); assert.equal(data.dossiers[1].enriched, false);
  assert.deepEqual(data.dossiers[1].observations, []); assert.ok(!JSON.stringify(data).includes('must not appear'));
  const duplicate = buildAnalytics(snapshot, [...pilots, pilots[0]]);
  assert.equal(duplicate.totals.enriched, 0); assert.equal(duplicate.totals.events, 0);
  snapshot.enrichedClientIds = []; assert.equal(buildAnalytics(snapshot, pilots).totals.enriched, 0);
});

test('owners require explicit documented fields and source links are restricted', () => {
  const { snapshot, pilots } = fixture(); assert.equal(buildAnalytics(snapshot, pilots).dossiers[0].owner, null);
  const field: PilotField = { id: 'owner', label: 'Commercial responsable', value: 'Responsable explicitement attribué', status: 'documented', sourceIds: ['source-1'], note: null, sourceStatus: null, humanValidated: false };
  pilots[0].data.sections[0].fields.push(field);
  assert.equal(buildAnalytics(snapshot, pilots).dossiers[0].owner, field.value);
  field.status = 'review'; assert.equal(buildAnalytics(snapshot, pilots).dossiers[0].owner, null);
  field.status = 'documented'; field.sourceIds = []; assert.equal(buildAnalytics(snapshot, pilots).dossiers[0].owner, null);
  pilots[0].data.sources[0].url = 'javascript:alert(1)';
  assert.equal(buildAnalytics(snapshot, pilots).events[0].sources[0].url, null);
});

test('invalid, unsourced and duplicate events cannot fabricate a monthly trend', () => {
  const { snapshot, pilots } = fixture();
  pilots[0].data.timeline[0].dateUTC = '2026-02-30T00:00:00Z';
  pilots[0].data.timeline.push(structuredClone(pilots[0].data.timeline[1]));
  pilots[0].data.timeline.push({ ...pilots[0].data.timeline[1], id: 'unsourced', sourceIds: ['nonexistent'] });
  const data = buildAnalytics(snapshot, pilots, { sourceAuditDate: '2026-02-30' });
  assert.equal(data.events.length, 3); assert.equal(data.totals.datedEvents, 1);
  assert.equal(data.meta.sourceAuditDate, null); assert.equal(data.events[0].date, null);
  assert.equal(data.activity.length, 1); assert.equal(data.activity[0].count, 1);
});

const privateRoot = process.env.VDS_REAL_CHAIN_DATA_ROOT;
test('real private Sheets and eligible audit fiches produce 500 dossiers, 10 enrichments and the sourced timeline without money totals', { skip: !privateRoot }, async () => {
  const root = privateRoot!;
  const portal = new PortalStore({ provider: new PrivateNativeReadProvider(resolve(root, 'native-sheet-read.private.json'), root),
    privateRoot: root, pilotFile: resolve(root, 'pilot-10.private.json'), identityBaselineFile: resolve(root, 'portal-original.private.json') });
  await portal.refresh(); const snapshot = portal.current(); assert.ok(snapshot);
  const pilots = (snapshot.enrichedClientIds ?? []).map(id => portal.pilot(id)).filter((value): value is PilotResponse => !!value);
  const data = buildAnalytics(snapshot, pilots, { sourceAuditDate: portal.pilotSummary().auditDate });
  assert.equal(data.totals.clients, 500); assert.equal(data.totals.enriched, 10); assert.equal(data.totals.unenriched, 490);
  assert.equal(data.totals.documentedFields, 292); assert.equal(data.totals.missingFields, 165);
  assert.equal(data.totals.contradictions, 32); assert.equal(data.totals.events, 146); assert.equal(data.totals.datedEvents, 146);
  assert.equal(data.totals.documents, 46); assert.equal(data.totals.documentsRead, 35);
  assert.equal(data.activity.reduce((total, row) => total + row.count, 0), 146);
  assert.equal(data.coverage.reduce((total, row) => total + row.count, 0), 494);
  assert.equal(data.meta.sourceReadAt, snapshot.sourceState?.lastReadAt);
  assert.equal(data.meta.sourceAuditDate, portal.pilotSummary().auditDate);
  assert.equal(data.meta.stale, true); assert.equal(data.finance.contractsTotal, null); assert.equal(data.finance.balancesTotal, null);
  for (const event of data.events) assert.ok(event.sources.length > 0);
  for (const dossier of data.dossiers) {
    assert.equal('contact' in dossier, false); assert.equal('address' in dossier, false);
    if (dossier.owner) assert.ok(dossier.ownerSources.some(source => source.status === 'read'));
    for (const observation of dossier.observations) {
      const original = pilots.find(pilot => pilot.data.id === dossier.id)!.data.sections.flatMap(section => section.fields).find(field => field.id === observation.id)!;
      assert.equal(observation.value, original.value); assert.equal(observation.status, original.status);
    }
  }
});

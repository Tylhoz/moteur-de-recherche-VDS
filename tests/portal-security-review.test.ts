import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortalStore, sameAuditedIdentity, samePilotIdentity } from '../server/portal.js';
import { normalizeLegacyRows, LEGACY_SHEET_HEADERS } from '../server/google-legacy.js';
import { normalizePilotBundle } from '../server/pilot.js';

// Structural identity fixtures, never customer data and never used by the UI.
const readAt = '2026-10-20T00:00:00.000Z';
function snapshot() {
  return normalizeLegacyRows([LEGACY_SHEET_HEADERS, ...Array.from({ length: 500 }, (_, index) => [
    `VDS-${String(index + 1).padStart(3, '0')}`, `Structural identity ${index + 1}`,
    `+32 470 00 00 01 • structural-${index + 1}@example.invalid`, '', '', '', '', '',
  ])], readAt);
}
const bundle = () => normalizePilotBundle([{
  dossier_id: 'VDS-001', nom: 'Another structural identity',
  rapprochement: { statut: 'Correspondance forte', cles: ['Nom et contact déclarés dans le fichier'] },
  sections: { identite: [
    { champ: 'nom', valeur: 'Another structural identity', source_ids: [] },
    { champ: 'email', valeur: 'different-structural@example.invalid', source_ids: [] },
    { champ: 'telephone', valeur: '+32 470 99 99 99', source_ids: [] },
  ] },
}], { sourceAuditDate: '2026-10-20', generatedAt: readAt, sourceDigest: 'a'.repeat(64) });

test('review: a strong textual claim and matching legacy ID cannot attach another identity’s pilot dossier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vds-identity-review-'));
  try {
    const source = snapshot();
    const pilotFile = join(root, 'pilot.json'); const identityBaselineFile = join(root, 'baseline.json');
    await writeFile(pilotFile, JSON.stringify(bundle()), { mode: 0o600 });
    await writeFile(identityBaselineFile, JSON.stringify(source), { mode: 0o600 });
    const store = new PortalStore({ provider: { kind: 'private_native_read', async read() { return source; } }, privateRoot: root, pilotFile, identityBaselineFile });
    await store.refresh();
    assert.equal(store.current()?.clients.length, 500, 'The source remains available for identity review');
    assert.deepEqual(store.current()?.enrichedClientIds, []);
    assert.equal(store.pilot('VDS-001'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review: different explicit phone countries cannot become equal by deleting their country code', () => {
  const client = snapshot().clients[0];
  assert.equal(sameAuditedIdentity(
    { ...client, contact: '+32 612 34 56 78 • structural-1@example.invalid' },
    { ...client, contact: '+33 612 34 56 78 • structural-1@example.invalid' },
  ), false);
});

test('pilot identity requires sourced contacts and explicit country evidence for a national phone', () => {
  const source = { message_id: 'abcdef1234567890', subject: 'Isolated identity test', labels: ['INBOX'], date: readAt,
    display_url: 'https://mail.google.com/mail/u/0/#all/abcdef1234567890' };
  const pilot = normalizePilotBundle([{
    legacy_id: 'VDS-001', name: 'Structural identity 1', matching: 'E-mail et téléphone concordants', sources: [source],
    sections: { Identité: [
      ['Nom', 'Structural identity 1', source.message_id],
      ['E-mail', 'structural-1@example.invalid', source.message_id],
      ['Téléphone', '+32 470 00 00 01', source.message_id],
    ] },
  }], { sourceAuditDate: '2026-10-20', generatedAt: readAt, sourceDigest: 'a'.repeat(64) }).dossiers[0];
  const baseline = { ...snapshot().clients[0], contact: '0470 00 00 01 • structural-1@example.invalid', address: 'Secteur (BE)' };
  assert.equal(samePilotIdentity(pilot, baseline), true);
  assert.equal(samePilotIdentity(pilot, { ...baseline, address: '' }), false, 'No country inference from a national number');
  assert.equal(samePilotIdentity(pilot, { ...baseline, address: 'France' }), false, 'An explicit different country is a contradiction');
  assert.equal(samePilotIdentity({ ...pilot, name: 'Someone else' }, baseline), false);
  assert.equal(samePilotIdentity({ ...pilot, sources: pilot.sources.map(s => ({ ...s, status: 'identified' })) }, baseline), false, 'A source merely identified does not prove contact details');
  const changed = structuredClone(pilot); changed.sections[0].fields[1].value = 'another@example.invalid';
  assert.equal(samePilotIdentity(changed, baseline), false);
});

test('a failing Google provider does not retain a claim of operational continuous connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vds-connection-review-'));
  try {
    const source = snapshot(); let failed = false;
    const pilotFile = join(root, 'pilot.json'); const identityBaselineFile = join(root, 'baseline.json');
    await writeFile(pilotFile, JSON.stringify(bundle()), { mode: 0o600 });
    await writeFile(identityBaselineFile, JSON.stringify(source), { mode: 0o600 });
    const store = new PortalStore({ provider: { kind: 'google_sheets', async read() { if (failed) throw new Error('upstream unavailable'); return source; } },
      privateRoot: root, pilotFile, identityBaselineFile, refreshMs: 0 });
    await store.refresh(); assert.equal(store.status().continuousGoogleConnection, true);
    failed = true; await store.refresh();
    assert.equal(store.status().continuousGoogleConnection, false);
    assert.equal(store.status().state, 'stale');
    assert.equal(store.current()?.clients.length, 500);
  } finally { await rm(root, { recursive: true, force: true }); }
});

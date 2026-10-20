import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePilotBundle, normalizePilotDossier, loadPrivatePilot, validatePilotBundle, safePilotLink } from '../server/pilot.js';

// Synthetic fixtures are isolated technical tests, never imported by the app.
const sent = { message_id: 'abcdef1234567890', subject: 'Technical fixture', labels: ['SENT'], date: '2026-01-01T00:00:00Z', display_url: 'https://mail.google.com/mail/u/0/#all/abcdef1234567890' };
const draft = { message_id: 'abcdef1234567891', subject: 'Unsent fixture', labels: ['DRAFT'], date: '2026-01-02T00:00:00Z', display_url: 'https://mail.google.com/mail/u/0/#all/abcdef1234567891' };
function input() {
  return { legacy_id: 'VDS-999', name: 'TEST ONLY', matching: 'E-mail et téléphone concordants', scope: 'Isolated technical test',
    sources: [sent, draft], sections: {
      Identité: [['Nom', 'TEST ONLY', sent.message_id], ['Adresse', 'Information non retrouvée']],
      Finances: [['Paiement confirmé', 'Le client affirme avoir payé', sent.message_id]],
      Communications: [['Offre', 'Brouillon non envoyé', draft.message_id]],
    }, timeline: [{ date_original: sent.date, date_utc: sent.date, summary: 'Message', source_message_id: sent.message_id }, { date_original: draft.date, date_utc: draft.date, summary: 'Draft', source_message_id: draft.message_id }],
    documents: [{ filename: 'technical.pdf', message_id: sent.message_id, extraction_path: '/tmp/test-private.json', mime_type: 'application/pdf' }],
    next_actions: ['Review the fixture'], contradictions: [],
  };
}
const options = { sourceAuditDate: '2026-01-02', generatedAt: '2026-01-03T00:00:00Z', sourceDigest: 'a'.repeat(64) };
const bundle = () => normalizePilotBundle([input()], options);

test('drafts cannot create sent events; missing and accounting evidence remain distinct', () => {
  const d = normalizePilotDossier(input());
  assert.equal(d.timeline.length, 1);
  assert.equal(d.sections[0].fields[1].status, 'missing');
  assert.equal(d.sections[1].fields[0].status, 'review');
  assert.equal(d.sections[2].fields[0].status, 'excluded');
  assert.equal(d.sources.find(s => s.id === `gmail:${draft.message_id}`)?.url, null);
  assert.equal(d.matching.humanValidated, false);
  assert.equal(d.counts.humanValidated, 0);
  assert.equal(d.productionApplied, false);
  assert(!JSON.stringify(d).includes('/tmp/test-private.json'));
});

test('three field shapes preserve cents, source notes and explicit uncertainty', () => {
  const common = input();
  const commercial = normalizePilotDossier({ ...common, sections: { Finances: { Montant: { valeur: { montant_centimes: 12345, devise: 'EUR' }, statut: 'Confirmée dans la source', source_ids: [`gmail:${sent.message_id}`], note: 'An observed quote only' } } } });
  assert.match(commercial.sections[0].fields[0].value!, /123,45/);
  assert.equal(commercial.sections[0].fields[0].note, 'An observed quote only');
  const sav = normalizePilotDossier({ ...common, sections: { finances: [{ champ: 'contrat_ht_centimes', valeur: 12345, etat: 'À vérifier', source_ids: [sent.message_id] }] } });
  assert.match(sav.sections[0].fields[0].value!, /123,45/);
  assert.equal(sav.sections[0].fields[0].status, 'review');
});

test('calendar confirmation remains an unapproved association and not proof of completion', () => {
  const d = normalizePilotDossier({ ...input(), agenda_audit: { candidate_events: [{ id: 'fixture', summary: 'Test event', start: '2026-01-01T11:00:00+01:00', status: 'confirmed', url: 'https://www.google.com/calendar/event?eid=YWJj', issues: ['Identity needs review'] }] } });
  assert.equal(d.agenda[0].status, 'review');
  assert.equal(d.agenda[0].associationApproved, false);
  assert.equal(d.agenda[0].completionVerified, false);
  assert.equal(d.agenda[0].sourceStatus, 'confirmed');
});

test('validation rejects secrets, local paths, broken references and approval escalation', () => {
  for (const mutate of [
    (b: any) => { b.dossiers[0].sections[0].fields[0].value = 'https://drive.google.com/a?access_token=private'; },
    (b: any) => { b.dossiers[0].documents[0].url = 'https://untrusted.example/contract'; },
    (b: any) => { b.dossiers[0].sections[0].fields[0].sourceIds = ['missing:source']; },
    (b: any) => { b.dossiers[0].matching.humanValidated = true; },
    (b: any) => { b.dossiers[0].localFile = '/workspace/private.json'; },
    (b: any) => { b.counts.documented += 1; },
  ]) { const b = structuredClone(bundle()); mutate(b); assert.throws(() => validatePilotBundle(b)); }
  assert.equal(safePilotLink('https://www.google.com/calendar/event?eid=YWJj'), true);
  assert.equal(safePilotLink('https://www.google.com/calendar/event?eid=YWJj&token=secret'), false);
});

test('private loader requires private directories and files and rejects escapes/public roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vds-pilot-test-')); const privateRoot = join(root, 'private');
  try {
    await mkdir(privateRoot, { mode: 0o700 }); const file = join(privateRoot, 'pilot.json');
    await writeFile(file, JSON.stringify(bundle()), { mode: 0o600 });
    assert.equal((await loadPrivatePilot(file, privateRoot)).dossiers.length, 1);
    await assert.rejects(loadPrivatePilot(file, privateRoot, [root]), /public_pilot_source_forbidden/);
    await chmod(file, 0o644); await assert.rejects(loadPrivatePilot(file, privateRoot), /pilot_file_permissions_or_size/);
    await chmod(file, 0o600); await chmod(privateRoot, 0o755); await assert.rejects(loadPrivatePilot(file, privateRoot), /pilot_private_root_permissions/);
    await chmod(privateRoot, 0o700);
    const outside = join(root, 'outside.json'); await writeFile(outside, JSON.stringify(bundle()), { mode: 0o600 });
    const link = join(privateRoot, 'link.json'); await symlink(outside, link);
    await assert.rejects(loadPrivatePilot(link, privateRoot), /pilot_file_outside_private_root/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real audit import is structurally complete without public copying', { skip: !process.env.VDS_PILOT_AUDIT_TEST_INPUT }, async () => {
  const raw = JSON.parse(await readFile(process.env.VDS_PILOT_AUDIT_TEST_INPUT!, 'utf8'));
  const b = normalizePilotBundle(raw, options);
  assert.equal(b.dossiers.length, 10);
  assert.equal(b.counts.contradictions, 32);
  assert.equal(b.counts.timelineEvents, 146);
  assert.equal(b.counts.agendaCandidates, 1);
  assert.equal(b.counts.humanValidated, 0);
  for (const d of b.dossiers) {
    assert(d.sections.some(s => s.id === 'finances'));
    assert(d.sources.length > 0);
    assert(d.nextActions.length > 0);
    assert(d.timeline.every(e => e.dateUTC && e.sourceIds.length));
    assert(d.sections.flatMap(s => s.fields).every(f => f.status !== 'documented' || f.sourceIds.length));
  }
  assert(!JSON.stringify(b).includes('extraction_path'));
});

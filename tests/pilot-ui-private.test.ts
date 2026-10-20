import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PilotBundle, PilotResponse } from '../shared/pilot-contract';

// Real evidence stays outside the repository. No business fixture is substituted.
const evidencePath = process.env.VDS_PILOT_UI_DATA;
const skip = evidencePath ? false : 'Private audited dossier bundle not configured';
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

test('private audited dossiers render all twelve tabs with evidence, unknowns and protected links', { skip }, async () => {
  const bundle = JSON.parse(await readFile(evidencePath!, 'utf8')) as PilotBundle;
  assert.equal(bundle.schemaVersion, 'pilot-1');
  assert.equal(bundle.sourceMode, 'private_audit_snapshot');
  assert.ok(bundle.dossiers.length > 0);
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'silent' });
  try {
    const { PilotDetailView } = await vite.ssrLoadModule('/src/components/ClientDetail360.tsx');
    const sections = ['overview', 'commercial', 'technique', 'chantier', 'finances', 'communications', 'agenda', 'sav', 'documents', 'history', 'actions', 'sources'];
    for (const dossier of bundle.dossiers) {
      const response: PilotResponse = { data: dossier, meta: {
        lastReadAt: bundle.generatedAt, lastSourceReadAt: dossier.lastSourceReadAt,
        state: 'ready', readOnly: true, revision: bundle.sourceDigest, sourceMode: 'private_audit_snapshot',
      } };
      for (const section of sections) {
        const html = renderToStaticMarkup(createElement(PilotDetailView, { clientId: dossier.id, onClose() {}, response, initialTab: section, initialFullDetails:true }));
        assert.ok(html.includes(escapeHtml(dossier.name)), 'Audited identity is rendered');
        assert.equal((html.match(/role="tab"/g) || []).length, 12, 'All required tabs are exposed');
        assert.equal((html.match(/aria-selected="true"/g) || []).length, 1, 'One tab is selected');
        assert.equal((html.match(/role="tabpanel"/g) || []).length, 1, 'One accessible panel is exposed');
        assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="[^"]+"/);
        assert.match(html, /Connexion continue aux sources : non activée/);
        assert.ok(!html.includes('Bearer '), 'No authentication secret is rendered');
        assert.ok(!html.includes('/workspace/'), 'No private filesystem path is rendered');
        const fields = dossier.sections.find(item => item.id === (section === 'overview' ? 'identite' : section))?.fields || [];
        for (const field of fields) {
          assert.ok(html.includes(escapeHtml(field.value || 'Information non retrouvée')), 'Audited field appears without invented replacement');
        }
        for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
          const url = new URL(href.replace(/&amp;/g, '&'));
          assert.equal(url.protocol, 'https:');
          assert.ok(['mail.google.com', 'calendar.google.com', 'docs.google.com', 'drive.google.com'].includes(url.hostname)
            || (url.hostname === 'www.google.com' && url.pathname === '/calendar/event' && !!url.searchParams.get('eid')));
          assert.ok(![...url.searchParams.keys()].some(key => /token|secret|password|signature|credential|api[_-]?key/i.test(key)));
        }
        if (section === 'overview') for (const contradiction of dossier.contradictions) {
          assert.ok(html.includes(escapeHtml(contradiction.existingValue || 'Information non retrouvée')), 'Existing observation remains visible');
          assert.ok(html.includes(escapeHtml(contradiction.observedValue || 'Information non retrouvée')), 'Compared observation remains visible');
          assert.match(html, /Aucune modification appliquée/);
        }
        if (section === 'documents') for (const document of dossier.documents) {
          assert.ok(html.includes(escapeHtml(document.filename)), 'Real document identity is rendered');
          assert.ok(html.includes(document.contentRead ? 'Contenu lu' : 'Identifié · contenu non vérifié'));
        }
        if (section === 'agenda' && dossier.agenda.length) {
          assert.match(html, /Correspondance proposée uniquement/);
          for (const event of dossier.agenda) if (event.url) assert.ok(html.includes(`href="${escapeHtml(event.url)}"`), 'The actual authorized Google Calendar link is available');
        }
      }
      const denied = renderToStaticMarkup(createElement(PilotDetailView, { clientId: dossier.id, onClose() {}, response, problem: 'authentication' }));
      assert.ok(!denied.includes(escapeHtml(dossier.name)), 'Loss of authentication hides the private identity even before state purge');
      assert.match(denied, /Authentification requise/);
      const stale = renderToStaticMarkup(createElement(PilotDetailView, { clientId: dossier.id, onClose() {}, response, problem: 'unavailable' }));
      assert.match(stale, /Synchronisation indisponible · dernière version conservée/);
      assert.ok(stale.includes(escapeHtml(dossier.name)), 'A transport failure preserves the last authenticated dossier');
    }
    const empty = renderToStaticMarkup(createElement(PilotDetailView, { clientId: '', onClose() {}, response: null, problem: 'unavailable' }));
    assert.match(empty, /Source non connectée/);
    assert.match(empty, /Aucune donnée de remplacement/);
  } finally { await vite.close(); }
});

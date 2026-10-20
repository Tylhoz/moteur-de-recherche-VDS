import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PilotBundle, PilotTimelineEvent } from '../shared/pilot-contract.js';
import type { TimelineFilters } from '../src/components/ClientDetail360.js';

const evidencePath = process.env.VDS_PILOT_UI_DATA;
const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

test('timeline source, category, status and accent-insensitive filters preserve the actual audited history', { skip: !evidencePath }, async () => {
  const bundle = JSON.parse(await readFile(evidencePath!, 'utf8')) as PilotBundle;
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'silent' });
  try {
    const { selectTimelineEvents, groupTimelineDays, timelineDate, DEFAULT_TIMELINE_FILTERS } = await vite.ssrLoadModule('/src/components/ClientDetail360.tsx');
    let examined = 0;
    for (const dossier of bundle.dossiers) {
      const before = JSON.stringify(dossier.timeline);
      const sources = new Map(dossier.sources.map(source => [source.id, source]));
      const newest: PilotTimelineEvent[] = selectTimelineEvents(dossier.timeline, sources, DEFAULT_TIMELINE_FILTERS);
      assert.equal(newest.length, dossier.timeline.length);
      assert.equal(new Set(newest.map(e => e.id)).size, newest.length);
      const timestamps = newest.map(event => timelineDate(event).timestamp).filter((value): value is number => value !== null);
      assert.ok(timestamps.every((time, i) => !i || time <= timestamps[i - 1]));
      const oldest: PilotTimelineEvent[] = selectTimelineEvents(dossier.timeline, sources, { ...DEFAULT_TIMELINE_FILTERS, order: 'oldest' });
      const oldDates = oldest.map(event => timelineDate(event).timestamp).filter((value): value is number => value !== null);
      assert.ok(oldDates.every((time, i) => !i || time >= oldDates[i - 1]));
      const groups: Array<{ events: PilotTimelineEvent[] }> = groupTimelineDays(newest);
      assert.equal(groups.flatMap(g => g.events).length, dossier.timeline.length);
      for (const source of ['gmail', 'agenda', 'attachment']) {
        const filtered: PilotTimelineEvent[] = selectTimelineEvents(dossier.timeline, sources, { ...DEFAULT_TIMELINE_FILTERS, source });
        const expected = dossier.timeline.filter(event => event.sourceIds.some(id => sources.get(id)?.kind === source));
        assert.equal(filtered.length, expected.length); assert.ok(filtered.every(event => expected.some(item => item.id === event.id)));
      }
      for (const status of ['documented', 'review', 'unverified', 'missing', 'excluded', 'obsolete']) {
        const filtered: PilotTimelineEvent[] = selectTimelineEvents(dossier.timeline, sources, { ...DEFAULT_TIMELINE_FILTERS, status });
        assert.equal(filtered.length, dossier.timeline.filter(event => event.status === status).length);
      }
      const event = dossier.timeline[0];
      if (event) {
        const query = event.summary.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase();
        const filtered: PilotTimelineEvent[] = selectTimelineEvents(dossier.timeline, sources, { ...DEFAULT_TIMELINE_FILTERS, query, category: event.category || '', status: event.status });
        assert.ok(filtered.some(item => item.id === event.id));
      }
      assert.equal(selectTimelineEvents(dossier.timeline, sources, { ...DEFAULT_TIMELINE_FILTERS, query: 'absent-token-unique-for-regression' }).length, 0);
      assert.equal(JSON.stringify(dossier.timeline), before, 'Filtering and sorting must never mutate evidence');
      examined += newest.length;
    }
    assert.equal(examined, 146);
  } finally { await vite.close(); }
});

test('timeline rendering exposes one expanded sourced card, accessible controls, filtering and an explicit empty state', { skip: !evidencePath }, async () => {
  const bundle = JSON.parse(await readFile(evidencePath!, 'utf8')) as PilotBundle;
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'silent' });
  try {
    const { ActivityTimeline, DEFAULT_TIMELINE_FILTERS, selectTimelineEvents } = await vite.ssrLoadModule('/src/components/ClientDetail360.tsx');
    for (const dossier of bundle.dossiers) {
      const sources = new Map(dossier.sources.map(source => [source.id, source]));
      const render = (initialFilters: TimelineFilters, limit?: number) => renderToStaticMarkup(createElement(ActivityTimeline, { events: dossier.timeline, sources, initialFilters, limit, onShowAll() {} }));
      const html = render(DEFAULT_TIMELINE_FILTERS);
      assert.equal((html.match(/aria-expanded="true"/g) || []).length, 1);
      assert.equal((html.match(/class="vds360-timeline-toggle"/g) || []).length, dossier.timeline.length);
      for (const event of dossier.timeline) assert.ok(html.includes(escape(event.summary)), 'Every actual event is retained');
      assert.match(html, /Rechercher dans la chronologie/); assert.match(html, /Filtrer par type de source/);
      assert.match(html, /aria-controls=/); assert.match(html, /Retrouver la preuve/);
      assert.match(html, /referrerPolicy="no-referrer"/);
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) assert.ok(href.startsWith('https://'));
      const limited = render(DEFAULT_TIMELINE_FILTERS, 1);
      assert.equal((limited.match(/class="vds360-timeline-toggle"/g) || []).length, 1);
      if (dossier.timeline.length > 1) assert.match(limited, /Consulter l’historique complet/);
      const filter = { ...DEFAULT_TIMELINE_FILTERS, status: 'review' };
      const filtered = render(filter);
      const selected = selectTimelineEvents(dossier.timeline, sources, filter);
      assert.equal((filtered.match(/class="vds360-timeline-toggle"/g) || []).length, selected.length);
      const empty = render({ ...DEFAULT_TIMELINE_FILTERS, query: 'absent-token-unique-for-regression' });
      assert.match(empty, /Aucune activité pour ces critères/); assert.ok(!empty.includes('vds360-timeline-toggle'));
    }
  } finally { await vite.close(); }
});

test('timeline does not invent dates or hours from narrative text or normalize impossible calendar dates', async () => {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'silent' });
  try {
    const { timelineDate, selectTimelineEvents, ActivityTimeline, DEFAULT_TIMELINE_FILTERS } = await vite.ssrLoadModule('/src/components/ClientDetail360.tsx');
    // Isolated technical fixture, never imported by the application or private datasets.
    const event: PilotTimelineEvent = { id: 'isolated-date-test', summary: 'Technical date validation only', dateUTC: null,
      eventDate: null, dateOriginal: 'next month at noon', category: null, status: 'review', sourceStatus: null, sourceIds: [] };
    for (const dateUTC of [null, '2026-02-30T10:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T10:00:00', 'tomorrow']) {
      const result = timelineDate({ ...event, dateUTC });
      assert.equal(result.timestamp, null); assert.equal(result.dateTime, undefined); assert.equal(result.key, 'undated');
      if (dateUTC) {
        const html = renderToStaticMarkup(createElement(ActivityTimeline, { events: [{ ...event, dateUTC }], sources: new Map() }));
        assert.match(html, /Date non exploitable · voir la source/);
        assert.ok(!html.includes('dateTime='), 'An invalid date must not be converted even inside expanded details');
      }
    }
    const withoutHour = timelineDate({ ...event, eventDate: '2026-03-12' });
    assert.equal(withoutHour.dateTime, '2026-03-12'); assert.equal(withoutHour.timeLabel, 'Heure non retrouvée');
    assert.equal(timelineDate({ ...event, eventDate: '2026-02-30' }).timestamp, null);
    const instant = timelineDate({ ...event, dateUTC: '2026-01-31T23:30:00Z', eventDate: '2026-04-10' });
    assert.equal(instant.key, '2026-02-01'); assert.equal(instant.timeLabel, '06:30');
    const dated = { ...event, id: 'dated', dateUTC: '2026-01-01T10:00:00Z' };
    for (const order of ['newest', 'oldest']) {
      const result = selectTimelineEvents([event, dated], new Map(), { ...DEFAULT_TIMELINE_FILTERS, order });
      assert.equal(result.at(-1).id, event.id, 'Unknown dates remain last in both sort orders');
    }
  } finally { await vite.close(); }
});

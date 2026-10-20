import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PortalStore, PrivateNativeReadProvider } from '../server/portal.js';
import { createApi } from '../server/api.js';
import { ReadonlyStore } from '../server/sync.js';
import { UnconfiguredProvider } from '../server/providers.js';
import { createWebGateway } from '../server/web-gateway.js';
import { createAnalyticsClient, validateAnalytics } from '../src/data/useAnalytics.js';
import { filterAnalysisDossiers, selectAnalysisDossiers } from '../src/lib/analytics.js';
import { readRoute, routeUrl } from '../src/lib/navigation.js';
import type { AnalyticsMetric, AnalyticsResponse } from '../shared/analytics-contract.js';

const root = process.env.VDS_REAL_CHAIN_DATA_ROOT;
const skip = !root;
async function dispatch(app: Server, path: string, headers: Record<string, string> = {}, method = 'GET') {
  let status = 200; let body = ''; const outputHeaders = new Map<string, string>();
  const response = {
    setHeader(key: string, value: string) { outputHeaders.set(key.toLowerCase(), String(value)); },
    writeHead(code: number, values?: Record<string, string>) { status = code; for (const [key, value] of Object.entries(values ?? {})) outputHeaders.set(key.toLowerCase(), String(value)); },
    end(value: string | Buffer = '') { body = String(value); },
  };
  await (app.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => Promise<void>)({ url: path, method, headers } as IncomingMessage, response as unknown as ServerResponse);
  return { status, body, headers: outputHeaders };
}
async function context() {
  const privateRoot = root!;
  const portal = new PortalStore({ provider: new PrivateNativeReadProvider(resolve(privateRoot, 'native-sheet-read.private.json'), privateRoot),
    privateRoot, pilotFile: resolve(privateRoot, 'pilot-10.private.json'), identityBaselineFile: resolve(privateRoot, 'portal-original.private.json') });
  const token = randomBytes(48).toString('base64url');
  const api = createApi({ portal, store: new ReadonlyStore(new UnconfiguredProvider()), bearerSha256: createHash('sha256').update(token).digest('hex') });
  // Test-only session verifier. This is not a deployed hosting authentication test.
  const gateway = createWebGateway({ api, staticRoot: resolve('dist'), internalBearer: token, publicOrigin: 'https://analysis-test.invalid',
    authenticate: async request => request.headers.cookie === 'test_session=verified' ? { subject: 'isolated-test' } : null });
  const authorized = { host: 'analysis-test.invalid', cookie: 'test_session=verified', 'sec-fetch-site': 'same-origin' };
  const reply = await dispatch(gateway, '/api/v1/analytics', authorized);
  assert.equal(reply.status, 200);
  return { portal, api, gateway, authorized, token, data: validateAnalytics(JSON.parse(reply.body)) };
}
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  const result: Array<ReactElement<Record<string, unknown>>> = [];
  Children.forEach(node, child => { if (isValidElement<Record<string, unknown>>(child)) { result.push(child); result.push(...elements(child.props.children as ReactNode)); } });
  return result;
}
const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

test('analytics private API and browser transport enforce authentication, read-only access, validators and session purge', { skip }, async () => {
  const ctx = await context(); let authenticated = true;
  const calls: Array<{ etag: string | null; status: number }> = [];
  assert.equal((await dispatch(ctx.api, '/api/v1/analytics')).status, 401);
  assert.equal((await dispatch(ctx.gateway, '/api/v1/analytics', { host: 'analysis-test.invalid' })).status, 401);
  assert.equal((await dispatch(ctx.gateway, '/api/v1/analytics', ctx.authorized, 'POST')).status, 405);
  assert.equal((await dispatch(ctx.gateway, '/api/v1/analytics?unexpected=1', ctx.authorized)).status, 400);
  assert.equal((await dispatch(ctx.gateway, '/api/v1/analytics', { ...ctx.authorized, origin: 'https://unrelated.invalid' })).status, 403);
  const client = createAnalyticsClient(async (input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(String(input), '/api/v1/analytics'); assert.equal(init?.credentials, 'same-origin');
    assert.equal(headers.has('authorization'), false);
    const reply = await dispatch(ctx.gateway, String(input), { ...Object.fromEntries(headers.entries()), ...ctx.authorized,
      cookie: authenticated ? ctx.authorized.cookie : '' });
    calls.push({ etag: headers.get('if-none-match'), status: reply.status });
    assert.match(reply.headers.get('cache-control')!, /private, no-store/);
    assert.ok(!reply.body.includes(ctx.token));
    return new Response(reply.status === 304 ? null : reply.body, { status: reply.status, headers: Object.fromEntries(reply.headers) });
  });
  const [first, concurrent] = await Promise.all([client.read(), client.read()]);
  assert.equal(first, concurrent); assert.equal(calls.length, 1);
  assert.equal(first.totals.clients, 500); assert.equal(first.totals.enriched, 10);
  assert.equal(first.meta.sourceRevision, ctx.portal.current()!.version);
  assert.equal(first.finance.contractsTotal, null); assert.equal(first.finance.balancesTotal, null);
  await client.read(); assert.equal(calls[1].status, 304); assert.ok(calls[1].etag);
  authenticated = false; await assert.rejects(client.read(), /session/);
  authenticated = true; await client.read(); assert.equal(calls[3].etag, null, 'An expired session clears the private cache');
  client.clear();
});

test('analytics validates the actual private response and rejects malformed counts, unsafe source links and absent source revisions', { skip }, async () => {
  const { data } = await context();
  assert.equal(validateAnalytics(data), data);
  const withUnknownAuditDate = structuredClone(data); withUnknownAuditDate.meta.sourceAuditDate = null;
  assert.doesNotThrow(() => validateAnalytics(withUnknownAuditDate));
  for (const mutate of [
    (v: AnalyticsResponse) => { delete (v.meta as Partial<AnalyticsResponse['meta']>).sourceRevision; },
    (v: AnalyticsResponse) => { v.dossiers.push(v.dossiers[0]); },
    (v: AnalyticsResponse) => { v.dossiers[0].counts.events = -1; },
    (v: AnalyticsResponse) => { v.events[0].sources[0].url = 'https://drive.google.com/file/d/test?access_token=not-a-real-secret'; },
    (v: AnalyticsResponse) => { v.events[0].sources[0].url = 'javascript:alert(1)'; },
    (v: AnalyticsResponse) => { v.events[0].dossierId = 'VDS-999'; },
  ]) { const altered = structuredClone(data); mutate(altered); assert.throws(() => validateAnalytics(altered), /pas exploitables/); }
  const calendarAlias = structuredClone(data); calendarAlias.events[0].sources[0].url = 'https://www.google.com/calendar/event?eid=isolated-test';
  assert.doesNotThrow(() => validateAnalytics(calendarAlias));
});

test('dashboard handlers open all five dedicated analyses; chart handlers select dossiers before the actual private fiche is rendered', { skip }, async () => {
  const ctx = await context(); const snapshot = ctx.portal.current()!;
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'silent' });
  try {
    const { default: Dashboard } = await vite.ssrLoadModule('/src/components/Dashboard.tsx');
    const { AnalyticsView, BarChart, DonutChart } = await vite.ssrLoadModule('/src/components/AnalyticsPage.tsx');
    const { PilotDetailView } = await vite.ssrLoadModule('/src/components/ClientDetail360.tsx');
    const metrics: AnalyticsMetric[] = ['clients', 'contracts', 'balances', 'review', 'activity'];
    let route = readRoute(''); let clientOpened = false;
    const dashboard = Dashboard({ snapshot, onNavigate() { assert.fail('Metric must not use a generic navigation fallback'); },
      onSelectClient() { clientOpened = true; }, onAnalyze(metric: AnalyticsMetric) { route = readRoute(`#analysis?metric=${metric}`); } });
    for (const metric of metrics) {
      const button = elements(dashboard).find(element => element.props['data-dashboard-metric'] === metric);
      assert.ok(button); (button.props.onClick as () => void)();
      assert.equal(route.section, 'analysis'); assert.equal(route.metric, metric); assert.equal(route.selectedId, null); assert.equal(clientOpened, false);
      const html = renderToStaticMarkup(createElement(AnalyticsView, { metric, snapshot, data: ctx.data,
        onSelectClient() {}, onNavigateMetric() {}, onBack() {}, onRefresh() {} }));
      assert.match(html, /analysis-chart-grid/); assert.match(html, /Les dossiers derrière les chiffres/);
      assert.match(html, /Lecture seule/); assert.match(html, /Page 1 \/ 34/);
      assert.ok(!html.includes(ctx.token)); assert.ok(!html.includes('/workspace/'));
      if (metric === 'contracts' || metric === 'balances') assert.match(html, /Non vérifié/);
    }
    const scope = filterAnalysisDossiers(ctx.data.dossiers, snapshot, { search: '', month: 'all', coverage: 'all' });
    const point = { id: 'enriched', label: 'Fiches enrichies', count: 10, dossierIds: snapshot.enrichedClientIds! };
    let selected: string[] | null = null;
    const select = (value: typeof point) => { selected = value.dossierIds; };
    const bar = elements(BarChart({ points: [point], onSelect: select, selected: null })).find(element => element.type === 'button');
    assert.ok(bar); (bar.props.onClick as () => void)();
    let rows = selectAnalysisDossiers(scope, selected); assert.equal(rows.length, 10);
    const donut = elements(DonutChart({ points: [point], onSelect: select, selected: null })).find(element => element.type === 'circle' && element.props.role === 'button');
    assert.ok(donut); selected = null; let prevented = false;
    (donut.props.onKeyDown as (event: unknown) => void)({ key: 'Enter', preventDefault() { prevented = true; } });
    assert.equal(prevented, true); rows = selectAnalysisDossiers(scope, selected); assert.equal(rows.length, 10);
    assert.equal(clientOpened, false, 'Chart activation selects rows and never opens the client directly');
    route = readRoute(routeUrl({ ...route, selectedId: rows[0].id }));
    const fiche = await dispatch(ctx.gateway, `/api/v1/pilot/${route.selectedId}`, ctx.authorized);
    assert.equal(fiche.status, 200);
    const payload = JSON.parse(fiche.body);
    assert.equal(payload.data.id, rows[0].id);
    const html = renderToStaticMarkup(createElement(PilotDetailView, { clientId: rows[0].id, response: payload, onClose() {}, initialTab: 'history' }));
    assert.ok(html.includes(escape(rows[0].name))); assert.match(html, /ACTIVITY TIMELINE/);
    assert.equal(readRoute(routeUrl({ ...route, selectedId: null })).metric, route.metric);
    const changedSnapshot = { ...snapshot, version: `${snapshot.version}-changed` };
    const blocked = renderToStaticMarkup(createElement(AnalyticsView, { metric: 'clients', snapshot: changedSnapshot, data: ctx.data,
      onSelectClient() {}, onNavigateMetric() {}, onBack() {}, onRefresh() {} }));
    assert.match(blocked, /Les dossiers ont été actualisés/); assert.ok(!blocked.includes('analysis-table'));
  } finally { await vite.close(); }
});

test('analysis filters intersect chart selection with the current identity and preserve empty selections', { skip }, async () => {
  const { portal, data } = await context(); const snapshot = portal.current()!;
  const filters = { search: '', month: 'all', coverage: 'all' };
  assert.equal(filterAnalysisDossiers(data.dossiers, snapshot, filters).length, 500);
  assert.equal(filterAnalysisDossiers(data.dossiers, snapshot, { ...filters, coverage: 'enriched' }).length, 10);
  assert.equal(filterAnalysisDossiers(data.dossiers, snapshot, { ...filters, coverage: 'pending' }).length, 490);
  const dossier = data.dossiers.find(d => d.enriched)!;
  const text = `${dossier.id} ${dossier.name}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  assert.equal(filterAnalysisDossiers(data.dossiers, snapshot, { ...filters, search: text }).length, 1);
  const monthly = filterAnalysisDossiers(data.dossiers, snapshot, { ...filters, month: data.activity[0].month });
  assert.ok(monthly.every(d => d.months.includes(data.activity[0].month)));
  assert.equal(selectAnalysisDossiers(monthly, []).length, 0);
  assert.equal(selectAnalysisDossiers(monthly, ['VDS-999']).length, 0);
  const changed = structuredClone(snapshot); changed.clients.find(d => d.id === dossier.id)!.client = 'Identity mismatch used only in this test';
  assert.ok(!filterAnalysisDossiers(data.dossiers, changed, filters).some(d => d.id === dossier.id));
});

test('clearing analytics cancels an old in-flight response so private state cannot return after logout', { skip }, async () => {
  const { data } = await context(); let finish: ((response: Response) => void) | undefined;
  const client = createAnalyticsClient(() => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = client.read(); client.clear();
  finish!(new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(pending, /interrompue/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PortalStore, PrivateNativeReadProvider, sameAuditedIdentity } from '../server/portal.js';
import { createApi } from '../server/api.js';
import { ReadonlyStore } from '../server/sync.js';
import { UnconfiguredProvider } from '../server/providers.js';
import { createWebGateway } from '../server/web-gateway.js';
import { createPortalSnapshotClient } from '../src/data/api-client.js';
import { loadPrivatePilot } from '../server/pilot.js';

async function dispatch(app: Server, path: string, headers: Record<string, string> = {}, method = 'GET') {
  let status = 200; let output = ''; const responseHeaders = new Map<string, string>();
  const res = {
    setHeader(name: string, value: string) { responseHeaders.set(name.toLowerCase(), String(value)); },
    writeHead(code: number, headers?: Record<string, string>) { status = code; for (const [key, value] of Object.entries(headers ?? {})) responseHeaders.set(key.toLowerCase(), String(value)); },
    end(value: string | Buffer = '') { output = String(value); },
  };
  await (app.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => Promise<void>)({ url: path, method, headers } as IncomingMessage, res as unknown as ServerResponse);
  return { status, headers: responseHeaders, output, json: () => JSON.parse(output) };
}

const privateRoot = process.env.VDS_REAL_CHAIN_DATA_ROOT;
test('actual native Google read crosses private store, authenticated API and the React transport without public files', { skip: !privateRoot }, async () => {
  const root = privateRoot!;
  const provider = new PrivateNativeReadProvider(resolve(root, 'native-sheet-read.private.json'), root, [resolve('public'), resolve('dist'), resolve('src')]);
  let providerReads = 0;
  const countedProvider = { kind: provider.kind, async read() { providerReads++; return provider.read(); } };
  const portal = new PortalStore({ provider: countedProvider, privateRoot: root, pilotFile: resolve(root, 'pilot-10.private.json'), identityBaselineFile: resolve(root, 'portal-original.private.json') });
  const token = randomBytes(48).toString('base64url');
  const api = createApi({ store: new ReadonlyStore(new UnconfiguredProvider()), portal, bearerSha256: createHash('sha256').update(token).digest('hex') });
  assert.equal((await dispatch(api, '/api/v1/portal-snapshot')).status, 401);
  assert.equal(providerReads, 0);
  // A test-only verified-session callback exercises the real gateway. It does not
  // claim verification of a deployed hosting session or external Google OAuth.
  const gateway = createWebGateway({ api, staticRoot: resolve('dist'), publicOrigin: 'https://private-test.invalid', internalBearer: token,
    authenticate: async request => request.headers.cookie === 'test_verified_session=1' ? { subject: 'isolated-test-session' } : null });
  const browserCalls: { path: string; headers: Record<string, string> }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    assert.equal(headers.authorization, undefined); assert.equal(init?.credentials, 'same-origin');
    browserCalls.push({ path: String(input), headers });
    const response = await dispatch(gateway, String(input), { ...headers, host: 'private-test.invalid', cookie: 'test_verified_session=1', 'sec-fetch-site': 'same-origin' });
    return new Response(response.status === 304 ? null : response.output, { status: response.status, headers: Object.fromEntries(response.headers) });
  };
  const browserClient = createPortalSnapshotClient(fetcher);
  const result = await browserClient.read();
  assert.equal(result.snapshot.clients.length, 500);
  assert.equal(result.snapshot.enrichedClientIds?.length, 10);
  assert.equal(result.snapshot.connection.sheetReady, false);
  assert.equal(result.snapshot.sourceState?.status, 'not_connected');
  assert.equal(result.snapshot.sourceState?.lastReadAt, (await provider.read()).fetchedAt);
  assert.ok(result.snapshot.clients.every(row => row.contractHT === null && row.soldeAmount === null));
  const repeated = await browserClient.read();
  assert.equal(repeated.snapshot.version, result.snapshot.version);
  assert.ok(browserCalls[1].headers['if-none-match']); assert.equal(providerReads, 1);
  const originalPilot = await loadPrivatePilot(resolve(root, 'pilot-10.private.json'), root);
  for (const expected of originalPilot.dossiers) {
    const response = await dispatch(gateway, `/api/v1/pilot/${expected.id}`, { host: 'private-test.invalid', cookie: 'test_verified_session=1' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json().data, expected);
    assert.equal(response.json().meta.sourceMode, 'private_audit_snapshot');
  }
  // Render an actual protected API response through the same React view used by
  // the portal. This checks server rendering; it does not claim browser login,
  // interactive hydration or a continuous external Google connection.
  const actualResponse = await dispatch(gateway, '/api/v1/pilot/VDS-003', { host: 'private-test.invalid', cookie: 'test_verified_session=1' });
  const actualPayload = actualResponse.json();
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'silent' });
  try {
    const { PilotDetailView } = await vite.ssrLoadModule('/src/components/ClientDetail360.tsx');
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
    const html = renderToStaticMarkup(createElement(PilotDetailView, { clientId: actualPayload.data.id, onClose() {}, response: actualPayload, initialTab: 'finances' }));
    assert.ok(html.includes(escape(actualPayload.data.name)));
    for (const field of actualPayload.data.sections.find((section: { id: string }) => section.id === 'finances').fields) {
      assert.ok(html.includes(escape(field.value || 'Information non retrouvée')), 'The finance panel renders the exact value from the private API');
    }
    assert.match(html, /Connexion continue aux sources : non activée/);
    assert.ok(!html.includes(token));
  } finally { await vite.close(); }
  assert.equal((await dispatch(gateway, '/api/v1/pilot/VDS-003', { host: 'private-test.invalid' })).status, 401);
  assert.equal((await dispatch(gateway, '/vds-snapshot.json', { host: 'private-test.invalid', cookie: 'test_verified_session=1' })).status, 404);
  assert.equal((await dispatch(gateway, '/api/v1/portal-snapshot', { host: 'private-test.invalid', cookie: 'test_verified_session=1' }, 'POST')).status, 405);
  const example = result.snapshot.clients[0];
  assert.equal(sameAuditedIdentity(example, { ...example, id: 'VDS-999' }), false);
  assert.equal(sameAuditedIdentity(example, { ...example, contact: '' }), false);
  browserClient.clear();
});

test('actual source read retains its timestamp and goes stale on failure without inventing another version', { skip: !privateRoot }, async () => {
  const root = privateRoot!; const provider = new PrivateNativeReadProvider(resolve(root, 'native-sheet-read.private.json'), root);
  let failed = false; let now = Date.now();
  const portal = new PortalStore({ provider: { kind: provider.kind, async read() { if (failed) throw new Error('private diagnostic must not leak'); return provider.read(); } },
    privateRoot: root, pilotFile: resolve(root, 'pilot-10.private.json'), identityBaselineFile: resolve(root, 'portal-original.private.json'), now: () => new Date(now) });
  await portal.refresh(); const first = portal.current()!;
  failed = true; now += 30_001; await portal.refresh();
  assert.equal(portal.current()!.version, first.version);
  assert.equal(portal.current()!.sourceState!.lastReadAt, first.sourceState!.lastReadAt);
  assert.equal(portal.current()!.sourceState!.status, 'stale');
  assert.equal(portal.current()!.clients.length, 500);
  assert.equal(portal.status().error, 'portal_read_failed');
});

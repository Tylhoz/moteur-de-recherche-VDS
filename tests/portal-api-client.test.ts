import test from "node:test";
import assert from "node:assert/strict";
import { createPortalSnapshotClient, PortalApiError, validatePortalSnapshot } from "../src/data/api-client";
import { clientIdentityKey, DEFAULT_FILTERS, filterClients, getCounts } from "../src/lib/clients";
import type { Client, Snapshot } from "../src/types";
import { createHash } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createApi } from "../server/api";
import { ReadonlyStore } from "../server/sync";
import { UnconfiguredProvider } from "../server/providers";
import type { PortalStore } from "../server/portal";

// Protocol fixtures only; no fixture is imported into the application.
const payload = (): Snapshot => ({
  source: "api", version: "protocol-v1", fetchedAt: "2026-10-20T00:00:00Z",
  clients: [], records: [], enrichedClientIds: [],
  connection: { mode: "readonly-api", label: "Archive de test technique", intervalMs: 30_000, sheetReady: false },
  sourceState: { lastReadAt: "2026-10-19T00:00:00Z", lastAttemptAt: "2026-10-20T00:00:00Z", stale: false, status: "not_connected" },
});
const response = (value: unknown, etag = '"protocol-v1"') => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json", ETag: etag },
});
const fixtureClient: Client = {
  id: "VDS-999999", client: "Fixture technique isolée", contact: "", address: "", modelTeam: "",
  techMacon: "", finance: "", statusAction: "", category: "non_verifie", soldeAmount: null, contractHT: null,
};

test("API transport uses same-origin cookies, conditional GET and one concurrent request", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let finish: ((value: Response) => void) | undefined;
  const client = createPortalSnapshotClient((async (path, init) => {
    calls.push({ path: String(path), init });
    return new Promise<Response>(resolve => { finish = resolve; });
  }) as typeof fetch);
  const first = client.read(), second = client.read();
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/v1/portal-snapshot");
  assert.equal(calls[0].init?.credentials, "same-origin");
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal(new Headers(calls[0].init?.headers).has("Authorization"), false);
  finish!(response(payload()));
  await first;
  const next = client.read();
  assert.equal(new Headers(calls[1].init?.headers).get("If-None-Match"), '"protocol-v1"');
  finish!(new Response(null, { status: 304 }));
  const result = await next;
  assert.equal(result.snapshot.sourceState?.lastReadAt, payload().sourceState?.lastReadAt);
  assert.ok(result.checkedAt);
});

test("304 only advances source reading time when the server supplies it", async () => {
  let call = 0;
  const client = createPortalSnapshotClient((async () => ++call === 1 ? response(payload()) : new Response(null, {
    status: 304, headers: {
      "X-VDS-Last-Read-At": "2026-10-20T01:00:00Z", "X-VDS-Source-Stale": "true",
      "X-VDS-Last-Attempt-At": "2026-10-20T02:00:00Z", "X-VDS-Fetched-At": "2026-10-20T01:00:00Z",
    },
  })) as typeof fetch);
  await client.read();
  const result = await client.read();
  assert.equal(result.snapshot.sourceState?.lastReadAt, "2026-10-20T01:00:00Z");
  assert.equal(result.snapshot.sourceState?.lastAttemptAt, "2026-10-20T02:00:00Z");
  assert.equal(result.snapshot.fetchedAt, "2026-10-20T01:00:00Z");
  assert.equal(result.snapshot.sourceState?.stale, true);
});

test("invalid or absent 304 transport dates cannot replace known source timestamps", async () => {
  let calls = 0;
  const client = createPortalSnapshotClient((async () => ++calls === 1 ? response(payload()) : new Response(null, {
    status: 304, headers: { "X-VDS-Fetched-At": "not-a-date", "X-VDS-Last-Read-At": "invalid" },
  })) as typeof fetch);
  await client.read();
  const result = await client.read();
  assert.equal(result.snapshot.fetchedAt, payload().fetchedAt);
  assert.equal(result.snapshot.sourceState?.lastReadAt, payload().sourceState?.lastReadAt);
  assert.equal(result.snapshot.sourceState?.lastAttemptAt, payload().sourceState?.lastAttemptAt);
});

async function invokeApi(app: Server, headers: Record<string, string>) {
  let status = 200, body = '';
  const responseHeaders = new Map<string, string>();
  const result = {
    setHeader(name: string, value: string) { responseHeaders.set(name.toLowerCase(), String(value)); },
    writeHead(code: number, values?: Record<string, string>) { status = code; for (const [name, value] of Object.entries(values ?? {})) responseHeaders.set(name.toLowerCase(), value); },
    end(value = '') { body = value; },
  };
  const handler = app.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  await handler({ url: '/api/v1/portal-snapshot', method: 'GET', headers } as IncomingMessage, result as unknown as ServerResponse);
  return { status, body, headers: responseHeaders };
}

test("API weak validator ignores transport dates, but retains record, stale, recovery and authentication changes", async () => {
  let current: Snapshot = { ...payload(), clients: [{ ...fixtureClient }], connection: { ...payload().connection, sheetReady: true },
    sourceState: { ...payload().sourceState!, status: 'ready', stale: false } };
  // Structural protocol seam: exercise the actual protected request handler.
  const portal = { async refresh() {}, current: () => current } as unknown as PortalStore;
  const token = 'protocol-validator-credential-'.repeat(2);
  const app = createApi({ store: new ReadonlyStore(new UnconfiguredProvider()), portal, bearerSha256: createHash('sha256').update(token).digest('hex') });
  const auth = { authorization: `Bearer ${token}` };
  const initial = await invokeApi(app, auth);
  assert.equal(initial.status, 200);
  const initialTag = initial.headers.get('etag')!;
  assert.match(initialTag, /^W\/"[a-f0-9]+"$/);
  const later = '2026-10-20T03:00:00Z';
  current = { ...current, fetchedAt: later, sourceState: { ...current.sourceState!, lastReadAt: later, lastAttemptAt: later } };
  const unchanged = await invokeApi(app, { ...auth, 'if-none-match': initialTag });
  assert.equal(unchanged.status, 304); assert.equal(unchanged.body, '');
  assert.equal(unchanged.headers.get('x-vds-fetched-at'), later);
  assert.equal(unchanged.headers.get('x-vds-last-read-at'), later);
  assert.equal(unchanged.headers.get('x-vds-last-attempt-at'), later);
  // Contents are hashed too: a stale upstream version field cannot hide an edit.
  current = { ...current, clients: [{ ...fixtureClient, finance: 'Changed structural observation' }] };
  const changed = await invokeApi(app, { ...auth, 'if-none-match': initialTag });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), initialTag);
  current = { ...current, sourceState: { ...current.sourceState!, stale: true, status: 'stale', reason: 'Source temporarily unavailable' } };
  const failed = await invokeApi(app, { ...auth, 'if-none-match': changed.headers.get('etag')! });
  assert.equal(failed.status, 200); assert.equal(JSON.parse(failed.body).sourceState.stale, true);
  const failureTag = failed.headers.get('etag')!;
  current = { ...current, sourceState: { ...current.sourceState!, lastAttemptAt: '2026-10-20T04:00:00Z' } };
  const stillFailed = await invokeApi(app, { ...auth, 'if-none-match': failureTag });
  assert.equal(stillFailed.status, 304); assert.equal(stillFailed.headers.get('x-vds-source-stale'), 'true');
  assert.equal(stillFailed.headers.get('x-vds-last-attempt-at'), '2026-10-20T04:00:00Z');
  current = { ...current, sourceState: { ...current.sourceState!, stale: false, status: 'ready', reason: undefined } };
  const recovered = await invokeApi(app, { ...auth, 'if-none-match': failureTag });
  assert.equal(recovered.status, 200); assert.equal(JSON.parse(recovered.body).sourceState.stale, false);
  assert.equal((await invokeApi(app, { 'if-none-match': recovered.headers.get('etag')! })).status, 401);
});

test("expired authentication purges cached dossiers and ETag", async () => {
  const calls: RequestInit[] = [];
  let call = 0;
  const client = createPortalSnapshotClient((async (_, init) => {
    calls.push(init!);
    call++;
    return call === 1 ? response(payload()) : call === 2 ? new Response(null, { status: 401 }) : new Response(null, { status: 304 });
  }) as typeof fetch);
  await client.read();
  await assert.rejects(client.read(), (error: unknown) => error instanceof PortalApiError && error.requiresAuthentication);
  await assert.rejects(client.read(), PortalApiError);
  assert.equal(new Headers(calls[2].headers).has("If-None-Match"), false);
});

test("invalid and unavailable responses cannot replace a valid cached snapshot", async () => {
  let call = 0;
  const client = createPortalSnapshotClient((async () => {
    call++;
    if (call === 1) return response(payload());
    if (call === 2) return response({ ...payload(), source: "local", version: "invalid" });
    if (call === 3) return new Response(null, { status: 503 });
    return new Response(null, { status: 304 });
  }) as typeof fetch);
  await client.read();
  await assert.rejects(client.read(), PortalApiError);
  await assert.rejects(client.read(), PortalApiError);
  assert.equal((await client.read()).snapshot.version, "protocol-v1");
});

test("logout or unmount prevents a late response from repopulating the cache", async () => {
  let finish: ((value: Response) => void) | undefined;
  const client = createPortalSnapshotClient((async () => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch);
  const request = client.read();
  client.clear();
  finish!(response(payload()));
  await assert.rejects(request, PortalApiError);
});

test("schema rejects duplicate or simulated IDs and unsafe references, preserves null financial values", () => {
  const value = { ...payload(), clients: [{ ...fixtureClient }] };
  assert.equal(validatePortalSnapshot(value).clients[0].soldeAmount, null);
  assert.throws(() => validatePortalSnapshot({ ...value, clients: [fixtureClient, fixtureClient] }));
  assert.throws(() => validatePortalSnapshot({ ...value, clients: [{ ...fixtureClient, id: "DEMO-1" }] }));
  assert.throws(() => validatePortalSnapshot({ ...value, links: [{ label: "Private", url: "https://docs.google.com/document?access_token=secret" }] }));
  assert.throws(() => validatePortalSnapshot({ ...value, enrichedClientIds: ["VDS-000001"] }));
});

test("unknown classifications remain searchable and mixed sorting cannot omit them", () => {
  const rows = [fixtureClient, { ...fixtureClient, id: "VDS-999998", category: "alerte" as const, soldeAmount: 1 }];
  assert.equal(filterClients(rows, DEFAULT_FILTERS).length, 2);
  assert.equal(filterClients(rows, { ...DEFAULT_FILTERS, status: "non_verifie" }).length, 1);
  assert.equal(filterClients(rows, { ...DEFAULT_FILTERS, status: "followup" }).length, 1);
  assert.equal(filterClients(rows, { ...DEFAULT_FILTERS, sort: "solde_desc" }).at(-1)?.soldeAmount, null);
  assert.equal(getCounts(rows).non_verifie, 1);
});

test("an open selection identity changes on a different person or contact, never on a financial update", () => {
  const original = clientIdentityKey(fixtureClient);
  assert.notEqual(clientIdentityKey({ ...fixtureClient, client: "Autre fixture technique" }), original);
  assert.notEqual(clientIdentityKey({ ...fixtureClient, contact: "Contact de test isolé" }), original);
  const changedFinance: Client = { ...fixtureClient, finance: "Champ technique modifié" };
  assert.equal(clientIdentityKey(changedFinance), original);
});

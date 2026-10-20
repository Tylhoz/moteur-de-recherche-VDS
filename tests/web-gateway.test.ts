import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createWebGateway, type WebGatewayOptions } from '../server/web-gateway.js';
import { createApi } from '../server/api.js';
import { ReadonlyStore } from '../server/sync.js';
import { UnconfiguredProvider } from '../server/providers.js';

// Generic structural fixtures only. These tests contain no business records.
const origin = 'https://private-preview.example.invalid';
const token = 'structural-gateway-credential-'.repeat(2);
const sessionHeaders = { cookie: 'structural-session=verified' };
const authenticate: WebGatewayOptions['authenticate'] = async request => request.headers.cookie === sessionHeaders.cookie ? { subject: 'structural-authorized-user' } : null;
const api = () => createApi({ store: new ReadonlyStore(new UnconfiguredProvider()), bearerSha256: createHash('sha256').update(token).digest('hex') });
async function invoke(app: Server, path: string, headers: Record<string, string> = {}, method = 'GET') {
  const responseHeaders = new Map<string, string>(); let status = 200; let body = ''; let destroyed = false;
  const response = {
    headersSent: false,
    setHeader(name: string, value: string | number) { responseHeaders.set(name.toLowerCase(), String(value)); return this; },
    writeHead(code: number, values?: Record<string, string>) { status = code; this.headersSent = true; for (const [name, value] of Object.entries(values ?? {})) responseHeaders.set(name.toLowerCase(), String(value)); return this; },
    end(value?: string | Buffer) { body = value?.toString() ?? ''; },
    destroy() { destroyed = true; },
  };
  const handler = app.listeners('request')[0] as (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  await handler({ url: path, method, headers: { host: new URL(origin).host, ...headers } } as IncomingMessage, response as unknown as ServerResponse);
  return { status, headers: responseHeaders, body, destroyed };
}
async function workspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'vds-web-gateway-'));
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Private application</title><div id="root"></div>');
    await writeFile(join(root, 'assets', 'main-abc123.js'), 'export const structural = true;');
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
function options(root: string): WebGatewayOptions { return { api: api(), staticRoot: root, authenticate, internalBearer: token, publicOrigin: origin }; }

test('gateway refuses missing hosting verification, insecure origin and missing internal secret at construction', () => {
  assert.throws(() => createWebGateway({ ...options('/unused'), authenticate: undefined } as unknown as WebGatewayOptions), /session_verifier_required/);
  for (const publicOrigin of ['http://private-preview.example.invalid', `${origin}/`, `${origin}?token=secret`, 'https://user:pass@example.invalid']) assert.throws(() => createWebGateway({ ...options('/unused'), publicOrigin }), /https_public_origin_required/);
  assert.throws(() => createWebGateway({ ...options('/unused'), internalBearer: '' }), /internal_api_credential_required/);
});

test('HTML, assets and API require the trusted session; spoofed headers and API bearer cannot replace it', async () => {
  await workspace(async root => {
    const app = createWebGateway(options(root));
    for (const path of ['/', '/index.html', '/clients', '/assets/main-abc123.js', '/api/v1/status']) {
      const result = await invoke(app, path, { authorization: `Bearer ${token}`, 'x-user-id': 'claimed', 'x-authenticated-user': 'claimed', 'x-forwarded-user': 'claimed' });
      assert.equal(result.status, 401, path); assert.equal(result.body.includes(token), false);
      assert.equal(result.headers.get('cache-control'), 'private, no-store, max-age=0');
    }
    assert.equal((await invoke(app, '/', { cookie: 'structural-session=expired' })).status, 401);
  });
});

test('verified same-origin session dispatches through the actual API without a socket or browser bearer', async () => {
  await workspace(async root => {
    const app = createWebGateway(options(root));
    const shell = await invoke(app, '/', sessionHeaders);
    assert.equal(shell.status, 200); assert.match(shell.body, /<title>Private application/);
    assert.match(shell.headers.get('content-security-policy')!, /connect-src 'self'/);
    assert.match(shell.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
    const result = await invoke(app, '/api/v1/status', { ...sessionHeaders, origin, 'sec-fetch-site': 'same-origin' });
    assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).error, 'source_not_configured');
    assert.equal(result.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(result.headers.get('vary'), 'Cookie, Origin');
    assert.equal(result.body.includes(token), false);
    const asset = await invoke(app, '/assets/main-abc123.js', sessionHeaders, 'HEAD');
    assert.equal(asset.status, 200); assert.equal(asset.body, ''); assert.ok(Number(asset.headers.get('content-length')) > 0);
  });
});

test('gateway forwards only explicitly allowed API headers after authenticating the original request', async () => {
  await workspace(async root => {
    let observed: IncomingMessage | undefined;
    const app = createWebGateway({ ...options(root), api: (request, response) => { observed = request; response.writeHead(200, { 'Cache-Control': 'public', Vary: 'Authorization' }); response.end('{}'); } });
    const result = await invoke(app, '/api/v1/status', { ...sessionHeaders, authorization: 'Bearer client-controlled', 'x-user-id': 'untrusted', 'x-forwarded-host': 'untrusted', 'if-none-match': '"revision"', accept: 'application/json' });
    assert.equal(result.status, 200);
    assert.deepEqual(observed?.headers, { authorization: `Bearer ${token}`, accept: 'application/json', 'if-none-match': '"revision"' });
    assert.deepEqual(observed?.rawHeaders, Object.entries(observed!.headers).flat());
    assert.equal(result.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(result.headers.get('vary'), 'Cookie, Origin');
  });
});

test('cross-origin requests, proxy host spoofing and cross-site loads cannot reach session verification', async () => {
  await workspace(async root => {
    let verifications = 0;
    const app = createWebGateway({ ...options(root), authenticate: async () => { verifications++; return { subject: 'structural-user' }; } });
    const variants: Record<string, string>[] = [{ host: 'attacker.invalid', 'x-forwarded-host': new URL(origin).host }, { origin: 'https://attacker.invalid' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }];
    for (const headers of variants) {
      assert.equal((await invoke(app, '/api/v1/status', { ...sessionHeaders, ...headers })).status, 403);
    }
    assert.equal(verifications, 0);
  });
});

test('private data, source code, maps, directory traversal and non-allowlisted assets are inaccessible even with a valid session', async () => {
  await workspace(async root => {
    for (const filename of ['vds-snapshot.json', '.env', 'validation.html']) await writeFile(join(root, filename), 'must-not-be-served');
    await writeFile(join(root, 'assets', 'data.json'), 'must-not-be-served');
    await writeFile(join(root, 'assets', 'main.js.map'), 'must-not-be-served');
    const app = createWebGateway(options(root));
    for (const path of ['/vds-snapshot.json', '/.private/data.json', '/.env', '/server/api.ts', '/src/main.tsx', '/validation.html', '/assets/data.json', '/assets/main.js.map', '/assets/../index.html', '/assets/%2e%2e/index.html', '/assets/%252e%252e/index.html', '//assets/main-abc123.js', '/assets/main-abc123.js/extra', '/assets\\main-abc123.js']) {
      const result = await invoke(app, path, sessionHeaders); assert.equal(result.status, 404, path); assert.equal(result.body.includes('must-not-be-served'), false);
    }
  });
});

test('symlinked assets cannot expose a file outside the compiled application', async () => {
  await workspace(async root => {
    const outside = await mkdtemp(join(tmpdir(), 'vds-web-private-'));
    try {
      await writeFile(join(outside, 'source.js'), 'must-not-be-served');
      await symlink(join(outside, 'source.js'), join(root, 'assets', 'linked.js'));
      const result = await invoke(createWebGateway(options(root)), '/assets/linked.js', sessionHeaders);
      assert.equal(result.status, 404); assert.equal(result.body.includes('must-not-be-served'), false);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test('request bodies, mutating methods and URL credentials are rejected before API dispatch', async () => {
  await workspace(async root => {
    let calls = 0;
    const app = createWebGateway({ ...options(root), api: (_request, response) => { calls++; response.end('{}'); } });
    assert.equal((await invoke(app, '/api/v1/status', sessionHeaders, 'POST')).status, 405);
    assert.equal((await invoke(app, '/api/v1/status', sessionHeaders, 'HEAD')).status, 405);
    assert.equal((await invoke(app, '/api/v1/status', { ...sessionHeaders, 'content-length': '4' })).status, 400);
    assert.equal((await invoke(app, '/api/v1/status', { ...sessionHeaders, 'transfer-encoding': 'chunked' })).status, 400);
    for (const query of ['access_token=secret', 'api%255Fkey=secret', 'signature=secret', 'auth=secret']) assert.equal((await invoke(app, `/api/v1/status?${query}`, sessionHeaders)).status, 400);
    assert.equal((await invoke(app, '/?unrecognized=value', sessionHeaders)).status, 400);
    assert.equal(calls, 0);
  });
});

test('hosting verifier failure is fail-closed and exposes no provider error or internal token', async () => {
  await workspace(async root => {
    let calls = 0;
    const app = createWebGateway({ ...options(root), api: () => { calls++; }, authenticate: async () => { throw new Error(`secret-provider-error:${token}`); } });
    const result = await invoke(app, '/api/v1/status', sessionHeaders);
    assert.equal(result.status, 503); assert.equal(result.body, '{"error":"hosting_session_verification_unavailable"}'); assert.equal(calls, 0);
  });
});

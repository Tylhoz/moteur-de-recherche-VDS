import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleRefreshTokenProvider, googleOAuthConfiguration, googleOAuthCredentials,
  GOOGLE_TOKEN_ENDPOINT, GOOGLE_SHEETS_READONLY_SCOPE, readGoogleJson } from '../server/google-auth.js';

// Technical in-memory fixtures only; no customer records or real credentials.
const env = { VDS_GOOGLE_CLIENT_ID: 'structural-test.apps.googleusercontent.com',
  VDS_GOOGLE_CLIENT_SECRET: 'structural-test-secret', VDS_GOOGLE_REFRESH_TOKEN: 'structural-test-refresh' };
const grant = (patch: Record<string, unknown> = {}) => ({ access_token: 'structural-test-access', token_type: 'Bearer',
  expires_in: 3600, scope: GOOGLE_SHEETS_READONLY_SCOPE, ...patch });

test('Google OAuth fails closed when credentials are absent or malformed; diagnostics contain names only', () => {
  assert.deepEqual(googleOAuthConfiguration({}), { configured: false, missing: Object.keys(env) });
  assert.throws(() => new GoogleRefreshTokenProvider({}), /google_credentials_missing/);
  for (const patch of [{ VDS_GOOGLE_CLIENT_ID: 'https://untrusted.invalid' }, { VDS_GOOGLE_CLIENT_SECRET: 'bad\nvalue' }, { VDS_GOOGLE_REFRESH_TOKEN: 'bad value' }]) {
    assert.throws(() => googleOAuthCredentials({ ...env, ...patch }), /google_credentials_invalid/);
  }
  assert.equal(JSON.stringify(googleOAuthConfiguration(env)).includes(env.VDS_GOOGLE_CLIENT_SECRET), false);
});

test('Google OAuth uses the fixed POST endpoint, no redirects, bounded timeout and cached single-flight refresh', async () => {
  let now = 0; let calls = 0;
  const request: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), GOOGLE_TOKEN_ENDPOINT);
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    const body = init?.body as URLSearchParams;
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('client_id'), env.VDS_GOOGLE_CLIENT_ID);
    assert.equal(body.get('client_secret'), env.VDS_GOOGLE_CLIENT_SECRET);
    assert.equal(body.get('refresh_token'), env.VDS_GOOGLE_REFRESH_TOKEN);
    await Promise.resolve();
    return new Response(JSON.stringify(grant()));
  };
  const provider = new GoogleRefreshTokenProvider(env, request, () => now);
  const results = await Promise.all([provider.getAccessToken(), provider.getAccessToken(), provider.getAccessToken()]);
  assert.equal(new Set(results).size, 1); assert.equal(calls, 1);
  await provider.getAccessToken(); assert.equal(calls, 1);
  now = 3_540_000; await provider.getAccessToken(); assert.equal(calls, 2);
  provider.invalidate(); await provider.getAccessToken(); assert.equal(calls, 3);
  const serialized = JSON.stringify(provider);
  for (const secret of [...Object.values(env), 'structural-test-access']) assert.equal(serialized.includes(secret), false);
});

test('Google OAuth rejects missing, broad, non-Bearer, expired and malformed grants', async () => {
  for (const patch of [
    { scope: undefined }, { scope: `${GOOGLE_SHEETS_READONLY_SCOPE} https://www.googleapis.com/auth/drive` },
    { scope: 'https://www.googleapis.com/auth/spreadsheets' }, { token_type: 'Basic' },
    { access_token: 'token\r\nheader' }, { expires_in: '3600' }, { expires_in: 60 },
  ]) {
    const provider = new GoogleRefreshTokenProvider(env, async () => new Response(JSON.stringify(grant(patch))));
    await assert.rejects(() => provider.getAccessToken(), /google_oauth_(scope_not_readonly|response_invalid)/);
  }
});

test('Google OAuth never exposes upstream failures or secret response contents and retries after failure', async () => {
  let fail = true;
  const provider = new GoogleRefreshTokenProvider(env, async () => {
    if (fail) throw new Error(`provider echoed ${env.VDS_GOOGLE_REFRESH_TOKEN}`);
    return new Response(JSON.stringify(grant()));
  });
  await assert.rejects(() => provider.getAccessToken(), error => error instanceof Error && error.message === 'google_oauth_unavailable');
  fail = false; assert.equal(await provider.getAccessToken(), 'structural-test-access');
  const rejected = new GoogleRefreshTokenProvider(env, async () => new Response(env.VDS_GOOGLE_CLIENT_SECRET, { status: 400 }));
  await assert.rejects(() => rejected.getAccessToken(), error => error instanceof Error && error.message === 'google_oauth_reauthorization_required');
});

test('Google response decoding caps declared and streamed content and sanitizes malformed JSON', async () => {
  await assert.rejects(() => readGoogleJson(new Response('{}', { headers: { 'content-length': '1000' } }), 10), /google_response_too_large/);
  await assert.rejects(() => readGoogleJson(new Response('x'.repeat(30)), 10), /google_response_too_large/);
  await assert.rejects(() => readGoogleJson(new Response('invalid structural response'), 100), /google_response_invalid/);
});

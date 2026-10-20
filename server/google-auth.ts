import { DataError } from './model.js';

export const GOOGLE_SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const secretNames = ['VDS_GOOGLE_CLIENT_ID', 'VDS_GOOGLE_CLIENT_SECRET', 'VDS_GOOGLE_REFRESH_TOKEN'] as const;
export type GoogleOAuthEnvironment = Partial<Record<typeof secretNames[number], string>>;
export interface GoogleOAuthCredentials { clientId: string; clientSecret: string; refreshToken: string }

/** Reports names only. Credential values must never enter status responses or logs. */
export function googleOAuthConfiguration(env: GoogleOAuthEnvironment): { configured: boolean; missing: string[] } {
  const missing = secretNames.filter(name => !env[name]?.trim());
  return { configured: missing.length === 0, missing };
}

export function googleOAuthCredentials(env: GoogleOAuthEnvironment): GoogleOAuthCredentials {
  if (!googleOAuthConfiguration(env).configured) throw new DataError('google_credentials_missing');
  const credentials = { clientId: env.VDS_GOOGLE_CLIENT_ID!, clientSecret: env.VDS_GOOGLE_CLIENT_SECRET!, refreshToken: env.VDS_GOOGLE_REFRESH_TOKEN! };
  if (!/^[A-Za-z0-9._-]{8,250}\.apps\.googleusercontent\.com$/.test(credentials.clientId) ||
      [credentials.clientSecret, credentials.refreshToken].some(value => value.length > 8192 || !/^[\x21-\x7e]+$/.test(value))) {
    throw new DataError('google_credentials_invalid');
  }
  return credentials;
}

/** Bounded decoding prevents an unexpected upstream response from exhausting memory. */
export async function readGoogleJson(response: Response, maxBytes: number): Promise<unknown> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > maxBytes) throw new DataError('google_response_too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new DataError('google_response_invalid');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new DataError('google_response_too_large');
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new DataError('google_response_invalid'); }
}

/** Server-only OAuth refresh. No token, grant response or provider error is exposed to callers. */
export class GoogleRefreshTokenProvider {
  readonly #credentials: GoogleOAuthCredentials;
  #cached: { token: string; expiresAt: number } | undefined;
  #pending: Promise<string> | undefined;

  constructor(env: GoogleOAuthEnvironment, private request: typeof fetch = fetch, private now: () => number = Date.now) {
    this.#credentials = googleOAuthCredentials(env);
  }

  invalidate(): void { this.#cached = undefined; }

  getAccessToken = async (): Promise<string> => {
    if (this.#cached && this.#cached.expiresAt - 60_000 > this.now()) return this.#cached.token;
    if (this.#pending) return this.#pending;
    this.#pending = this.refresh();
    try { return await this.#pending; }
    finally { this.#pending = undefined; }
  };

  private async refresh(): Promise<string> {
    const requestedAt = this.now();
    try {
      const response = await this.request(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.#credentials.clientId,
          client_secret: this.#credentials.clientSecret, refresh_token: this.#credentials.refreshToken }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new DataError(response.status === 400 || response.status === 401 || response.status === 403 ? 'google_oauth_reauthorization_required' : 'google_oauth_unavailable');
      }
      const body = await readGoogleJson(response, 32 * 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DataError('google_oauth_response_invalid');
      const grant = body as Record<string, unknown>;
      if (typeof grant.access_token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(grant.access_token) ||
          grant.token_type !== 'Bearer' || typeof grant.expires_in !== 'number' || !Number.isInteger(grant.expires_in) ||
          grant.expires_in < 120 || grant.expires_in > 86_400) throw new DataError('google_oauth_response_invalid');
      // A refresh token granted broader access must not silently become this app's identity.
      const scopes = typeof grant.scope === 'string' ? grant.scope.split(/\s+/).filter(Boolean) : [];
      if (scopes.length !== 1 || scopes[0] !== GOOGLE_SHEETS_READONLY_SCOPE) throw new DataError('google_oauth_scope_not_readonly');
      const expiresAt = requestedAt + grant.expires_in * 1000;
      if (expiresAt - 60_000 <= this.now()) throw new DataError('google_oauth_response_expired');
      this.#cached = { token: grant.access_token, expiresAt };
      return grant.access_token;
    } catch (error) {
      this.#cached = undefined;
      if (error instanceof DataError) throw error;
      // Fetch errors can include URLs, request metadata or provider response text.
      throw new DataError('google_oauth_unavailable');
    }
  }
}

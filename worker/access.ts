import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify } from 'jose';

export interface AccessEnv {
  VDS_ACCESS_TEAM_DOMAIN?: string;
  VDS_ACCESS_AUD?: string;
  VDS_OWNER_EMAIL?: string;
}
export interface AccessConfig { issuer: string; audience: string; ownerEmail: string; }
export interface VerifiedAccessIdentity { subject: string; email: string; }
export class AccessFailure extends Error {
  constructor(readonly status: 401 | 403 | 503, readonly code: string) { super(code); }
}
const emailPattern = /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/;

export function readAccessConfig(env: AccessEnv): AccessConfig {
  try {
    if (!env.VDS_ACCESS_TEAM_DOMAIN || !env.VDS_ACCESS_AUD || !env.VDS_OWNER_EMAIL) throw new Error();
    const issuer = new URL(env.VDS_ACCESS_TEAM_DOMAIN);
    if (issuer.protocol !== 'https:' || issuer.origin !== env.VDS_ACCESS_TEAM_DOMAIN || issuer.username || issuer.password || issuer.port
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer.hostname)
      || !/^[A-Za-z0-9_-]{16,256}$/.test(env.VDS_ACCESS_AUD)
      || !emailPattern.test(env.VDS_OWNER_EMAIL) || env.VDS_OWNER_EMAIL.length > 319) throw new Error();
    return { issuer: issuer.origin, audience: env.VDS_ACCESS_AUD, ownerEmail: env.VDS_OWNER_EMAIL.toLowerCase() };
  } catch { throw new AccessFailure(503, 'access_configuration_required'); }
}

export interface AccessVerifierOptions {
  /** Test transport seam; deployed entry uses global fetch exclusively. */
  fetcher?: typeof fetch;
  now?: () => Date;
}
/** Verify Cloudflare's signature, application scope and explicit owner on EVERY request. */
export function createAccessVerifier(options: AccessVerifierOptions = {}) {
  const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  function keys(config: AccessConfig) {
    const existing = keySets.get(config.issuer); if (existing) return existing;
    const certs = new URL('/cdn-cgi/access/certs', config.issuer);
    const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    const keySet = createRemoteJWKSet(certs, {
      timeoutDuration: 5_000, cacheMaxAge: 5 * 60_000, cooldownDuration: 30_000,
      [customFetch]: async (input, init) => {
        // Never follow a JWT-provided jku/x5u/issuer or a certificate redirect.
        if (String(input) !== certs.href) throw new Error('unexpected_certificate_origin');
        const response = await fetcher(input, { ...init, redirect: 'error' });
        if (response.status !== 200) throw new Error('certificate_service_unavailable');
        const declared = Number(response.headers.get('Content-Length') || 0);
        if (declared > 65_536 || !response.body) throw new Error('invalid_certificate_response');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
            if (size > 65_536) throw new Error('invalid_certificate_response'); chunks.push(part.value); }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    if (keySets.size >= 4) keySets.delete(keySets.keys().next().value!);
    keySets.set(config.issuer, keySet); return keySet;
  }
  return {
    async verify(request: Request, config: AccessConfig): Promise<VerifiedAccessIdentity> {
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new AccessFailure(401, 'authentication_required');
      try {
        const header = decodeProtectedHeader(token);
        if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(header.kid)) throw new AccessFailure(401, 'authentication_required');
        const now = options.now?.() ?? new Date();
        const { payload } = await jwtVerify(token, keys(config), {
          algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
          requiredClaims: ['iss', 'aud', 'sub', 'email', 'type', 'iat', 'exp'], currentDate: now, clockTolerance: 0,
        });
        if (payload.type !== 'app' || typeof payload.sub !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(payload.sub)
          || typeof payload.email !== 'string' || !emailPattern.test(payload.email) || payload.email.length > 319
          || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
          || payload.iat! > Math.floor(now.getTime() / 1000) + 5 || payload.exp! <= payload.iat!) throw new AccessFailure(401, 'authentication_required');
        if (payload.email.toLowerCase() !== config.ownerEmail) throw new AccessFailure(403, 'access_forbidden');
        return { subject: payload.sub, email: payload.email.toLowerCase() };
      } catch (error) {
        if (error instanceof AccessFailure) throw error;
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (/^ERR_(JWT_|JWS_|JOSE_ALG_NOT_ALLOWED|JOSE_NOT_SUPPORTED|JWKS_NO_MATCHING_KEY)/.test(code)) throw new AccessFailure(401, 'authentication_required');
        throw new AccessFailure(503, 'access_service_unavailable');
      }
    },
  };
}

/** Caller-supplied identity headers are never evidence on a direct Worker URL. */
export function authenticatedRequest(request: Request, identity: VerifiedAccessIdentity): Request {
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (/^(?:oai-|x-user|x-authenticated|cf-access-|x-forwarded-|x-auth-request-|x-original-|forwarded$|remote-user$)/i.test(key)) headers.delete(key);
  }
  headers.delete('Cookie');
  headers.set('oai-authenticated-user-id', identity.subject);
  headers.set('oai-authenticated-user-email', identity.email);
  return new Request(request, { headers });
}

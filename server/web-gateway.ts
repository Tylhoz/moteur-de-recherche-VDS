import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

export interface VerifiedWebUser { subject: string; }
export type WebRequestHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
export interface WebGatewayOptions {
  api: Server | WebRequestHandler;
  /** The compiled, generic application directory. Never a data or source directory. */
  staticRoot: string;
  /** Must verify AND authorize the existing hosting session on every request. */
  authenticate: (request: IncomingMessage) => Promise<VerifiedWebUser | null>;
  /** Server-only credential matching createApi's bearerSha256. Never sent to the browser. */
  internalBearer: string;
  /** Exact public HTTPS origin, as seen in the browser. */
  publicOrigin: string;
  /** Exact SPA navigation paths; no arbitrary filesystem fallback. */
  spaPaths?: readonly string[];
}

const mimeTypes: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.avif': 'image/avif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const defaultSpaPaths = ['/', '/clients', '/devis', '/ventes', '/chantiers', '/factures', '/sav', '/validation', '/tableau-de-bord'];
const shellPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
const privateCache = 'private, no-store, max-age=0';

function send(response: ServerResponse, status: number, error: string) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error }));
}

function sensitiveQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some(key => {
    // Catch nested encoding too; there is never a legitimate credential in a URL.
    let decoded = key;
    for (let i = 0; i < 3; i++) {
      try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { return true; }
    }
    return /token|(?:^|[_-])key(?:$|[_-])|api.?key|signature|secret|password|passwd|credential|authorization|^auth$|^jwt$|^sig$/i.test(decoded);
  });
}

function privateResponse(response: ServerResponse): ServerResponse {
  // The inner API may select its own content type/CSP, but cannot loosen caching.
  // Bind methods to the real ServerResponse so its stream state is preserved.
  return new Proxy(response, {
    get(target, property) {
      if (property === 'setHeader') return (name: string, value: string | number | readonly string[]) => {
        if (name.toLowerCase() === 'cache-control') return target.setHeader(name, privateCache);
        if (name.toLowerCase() === 'vary') return target.setHeader(name, 'Cookie, Origin');
        return target.setHeader(name, value);
      };
      if (property === 'writeHead') return (status: number, messageOrHeaders?: string | Record<string, unknown> | readonly string[], suppliedHeaders?: Record<string, unknown> | readonly string[]) => {
        const headers = typeof messageOrHeaders === 'string' ? suppliedHeaders : messageOrHeaders;
        const clean: OutgoingHttpHeaders = {};
        if (Array.isArray(headers)) {
          for (let i = 0; i < headers.length; i += 2) clean[headers[i]] = headers[i + 1];
        } else if (headers) Object.assign(clean, headers);
        for (const name of Object.keys(clean)) if (['cache-control', 'vary'].includes(name.toLowerCase())) delete clean[name];
        clean['Cache-Control'] = privateCache; clean.Vary = 'Cookie, Origin';
        return typeof messageOrHeaders === 'string' ? target.writeHead(status, messageOrHeaders, clean) : target.writeHead(status, clean);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Same-origin adapter for a hosting provider's EXISTING, verified user session.
 * It implements no login/OAuth flow and trusts no browser identity headers.
 * The returned server is not started automatically and uses no loopback proxy.
 */
export function createWebGateway(options: WebGatewayOptions): Server {
  if (!options || typeof options.authenticate !== 'function') throw new Error('hosting_session_verifier_required');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.internalBearer ?? '')) throw new Error('internal_api_credential_required');
  let origin: URL;
  try { origin = new URL(options.publicOrigin); } catch { throw new Error('https_public_origin_required'); }
  if (origin.protocol !== 'https:' || origin.origin !== options.publicOrigin || origin.username || origin.password) throw new Error('https_public_origin_required');
  if (typeof options.staticRoot !== 'string' || !options.staticRoot.trim()) throw new Error('compiled_static_root_required');
  const staticRoot = resolve(options.staticRoot);
  const spaPaths = new Set(options.spaPaths ?? defaultSpaPaths);
  if ([...spaPaths].some(path => !/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/.test(path) || path.startsWith('/api') || path.startsWith('/assets'))) throw new Error('invalid_spa_path');
  spaPaths.add('/');
  let apiHandler: WebRequestHandler;
  if (typeof options.api === 'function') apiHandler = options.api;
  else {
    const handlers = options.api?.listeners?.('request');
    if (!handlers || handlers.length !== 1 || typeof handlers[0] !== 'function') throw new Error('single_api_request_handler_required');
    apiHandler = handlers[0].bind(options.api) as WebRequestHandler;
  }

  return createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, async (request, rawResponse) => {
    const response = privateResponse(rawResponse);
    response.setHeader('Cache-Control', privateCache);
    response.setHeader('Vary', 'Cookie, Origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow, nosnippet');
    response.setHeader('Content-Security-Policy', shellPolicy);
    response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      if (request.headers.host !== origin.host || (request.headers.origin && request.headers.origin !== origin.origin)
        || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))) {
        send(response, 403, 'same_origin_required'); return;
      }
      const raw = request.url ?? '';
      const rawPath = raw.split('?')[0];
      if (!rawPath.startsWith('/') || raw.length > 4096 || /[%\\#]|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath) || raw.includes('#')) {
        send(response, 404, 'not_found'); return;
      }
      const url = new URL(raw, origin);
      if (sensitiveQuery(url)) { send(response, 400, 'credentials_not_allowed_in_url'); return; }
      // This callback is the only trust boundary. Browser headers are not identity.
      let user: VerifiedWebUser | null;
      try { user = await options.authenticate(request); }
      catch { send(response, 503, 'hosting_session_verification_unavailable'); return; }
      if (!user || typeof user.subject !== 'string' || !user.subject.trim() || user.subject.length > 256) {
        send(response, 401, 'hosting_session_required'); return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD'); send(response, 405, 'read_only_gateway'); return;
      }
      if (request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0') {
        response.setHeader('Connection', 'close'); send(response, 400, 'request_body_not_allowed'); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); send(response, 405, 'read_only_api'); return; }
        const headers: Record<string, string> = { authorization: `Bearer ${options.internalBearer}` };
        // Explicit allowlist: no cookie, forwarded identity, client authorization,
        // arbitrary Host or proxy headers reach the internal API.
        for (const name of ['accept', 'if-none-match']) {
          const value = request.headers[name]; if (typeof value === 'string') headers[name] = value;
        }
        const internalRequest = Object.create(request) as IncomingMessage;
        internalRequest.headers = headers;
        internalRequest.rawHeaders = Object.entries(headers).flat();
        internalRequest.url = `${url.pathname}${url.search}`;
        internalRequest.method = 'GET';
        await apiHandler(internalRequest, response);
        return;
      }
      if (url.search) { send(response, 400, 'unsupported_query'); return; }
      let relative: string, contentType: string;
      if (spaPaths.has(url.pathname) || url.pathname === '/index.html') {
        relative = 'index.html'; contentType = 'text/html; charset=utf-8';
      } else {
        const asset = /^\/assets\/([a-zA-Z0-9][a-zA-Z0-9_-]*\.[a-zA-Z0-9]+)$/.exec(url.pathname);
        const type = mimeTypes[extname(url.pathname)];
        if (!asset || !type) { send(response, 404, 'not_found'); return; }
        relative = `assets/${asset[1]}`; contentType = type;
      }
      let file;
      try {
        const root = await realpath(staticRoot);
        // Do not serve symlinked roots/directories or symlinked individual assets.
        if (root !== staticRoot) { send(response, 503, 'compiled_application_unavailable'); return; }
        const filename = join(root, relative);
        if (await realpath(dirname(filename)) !== dirname(filename)) { send(response, 404, 'not_found'); return; }
        file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 10 * 1024 * 1024) { send(response, 404, 'not_found'); return; }
        response.setHeader('Content-Type', contentType);
        response.setHeader('Content-Length', stat.size);
        response.writeHead(200);
        response.end(request.method === 'HEAD' ? undefined : await file.readFile());
      } catch {
        if (!response.headersSent) send(response, 404, 'not_found');
        else response.destroy();
      } finally { await file?.close(); }
    } catch {
      if (!response.headersSent) send(response, 500, 'private_gateway_error');
      else response.destroy();
    }
  });
}

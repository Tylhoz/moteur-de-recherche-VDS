import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Intentionally bound to the new owner-private Site. Version 2 is never a target.
const origin = 'https://vds-intelligence-360-validation.spiffyswan35.chatgpt.site';
const maxBytes = 4 * 1024 * 1024;
class ImportFailure extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new ImportFailure(code); }
const inside = (root, file) => { const part = relative(root, file); return !part || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)); };

async function readPrivateExport(file) {
  const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const requested = resolve(file);
  const resolved = await realpath(requested);
  if (inside(root, requested) || inside(root, resolved)) fail('private_file_must_be_outside_repository');
  const before = await lstat(requested);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600 || before.size > maxBytes || before.size === 0) fail('private_file_requires_regular_0600_and_max_4MiB');
  const handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || (stat.mode & 0o777) !== 0o600 || stat.size > maxBytes) fail('private_file_changed');
    // Read at most one byte over the limit, even if the file grows concurrently.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail('private_file_changed');
    const bytes = buffer.subarray(0, offset);
    let bundle;
    try { bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('invalid_private_export'); }
    if (bundle?.schemaVersion !== 'worker-private-1' || !Array.isArray(bundle.snapshot?.clients) || bundle.snapshot.clients.length !== 500 || !Array.isArray(bundle.pilots) || bundle.pilots.length !== 10) fail('private_export_requires_500_dossiers_and_10_pilots');
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

async function readCredentials() {
  const input = process.stdin;
  const terminal = input.isTTY === true;
  const previousRaw = input.isRaw === true;
  if (terminal && typeof input.setRawMode !== 'function') fail('hidden_stdin_unavailable');
  if (terminal) input.setRawMode(true);
  process.stderr.write('Prêt pour le JSON des deux tokens sur stdin (saisie masquée).\n');
  try {
    const text = await new Promise((resolveInput, rejectInput) => {
      const chunks = [];
      let length = 0;
      const reject = code => { cleanup(); rejectInput(new ImportFailure(code)); };
      const finish = () => { cleanup(); resolveInput(Buffer.concat(chunks).toString('utf8')); };
      const data = chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (terminal && (bytes.includes(3) || bytes.includes(4))) return reject('credential_input_cancelled');
        length += bytes.length;
        if (length > 32 * 1024) return reject('credential_input_too_large');
        chunks.push(bytes);
        if (terminal && (bytes.includes(10) || bytes.includes(13))) finish();
      };
      const error = () => reject('credential_input_failed');
      const cleanup = () => { input.off('data', data); input.off('end', finish); input.off('error', error); input.pause(); };
      input.on('data', data); input.once('end', finish); input.once('error', error); input.resume();
    });
    let credentials;
    try { credentials = JSON.parse(text); } catch { fail('invalid_credential_json'); }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)
      || Object.keys(credentials).sort().join(',') !== 'importBearer,siteBearer'
      || typeof credentials.siteBearer !== 'string' || !/^[\x21-\x7e]{20,16384}$/.test(credentials.siteBearer)
      || typeof credentials.importBearer !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(credentials.importBearer)) fail('invalid_credential_shape');
    return credentials;
  } finally { if (terminal) input.setRawMode(previousRaw); }
}

async function request(path, credentials, body) {
  if (!['/api/internal/import', '/api/internal/import-status'].includes(path)) fail('invalid_import_route');
  const url = new URL(path, origin);
  if (url.origin !== origin || url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) fail('invalid_import_origin');
  let response;
  try {
    response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'OAI-Sites-Authorization': `Bearer ${credentials.siteBearer}`, Authorization: `Bearer ${credentials.importBearer}`,
        Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}) });
  } catch { fail('https_request_failed_or_timed_out'); }
  if (response.status !== 200 || response.url !== url.href || !/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') || '')) {
    await response.body?.cancel().catch(() => {});
    fail('private_import_response_rejected');
  }
  if (!response.body) fail('private_import_response_missing');
  const reader = response.body.getReader();
  let size = 0;
  const parts = [];
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16 * 1024) fail('private_import_response_oversized');
      parts.push(chunk.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ImportFailure) throw error;
    fail('private_import_response_invalid');
  } finally { reader.releaseLock(); }
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24 || !process.execArgv.includes('--use-env-proxy')) fail('requires_node24_with_use_env_proxy');
  if (process.argv.length !== 3 || process.argv[2].startsWith('--')) fail('usage_node_use_env_proxy_script_external_private_json');
  const prepared = await readPrivateExport(process.argv[2]);
  const credentials = await readCredentials();
  const receipt = await request('/api/internal/import', credentials, prepared.bytes);
  if (receipt?.imported !== true || receipt.digest !== prepared.digest || receipt.dossiers !== 500 || receipt.enriched !== 10 || receipt.sourceWrites !== 0) fail('private_import_receipt_mismatch');
  const status = await request('/api/internal/import-status', credentials);
  if (status?.ready !== true || status.digest !== prepared.digest || status.dossiers !== 500 || status.enriched !== 10) fail('private_import_verification_mismatch');
  process.stdout.write(JSON.stringify({ success: true, digest: prepared.digest, dossiers: 500, enriched: 10 }) + '\n');
} catch (error) {
  // Never print an HTTP body, URL supplied by an error, credential, file contents or stack trace.
  process.stderr.write(JSON.stringify({ success: false, error: error instanceof ImportFailure ? error.code : 'private_import_failed' }) + '\n');
  process.exitCode = 1;
}

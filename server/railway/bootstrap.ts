import { gunzipSync } from 'node:zlib';
import { createWorker, readActive, type WorkerEnv } from '../../worker/index.js';
import { sha256Text } from '../../shared/worker-bundle.js';

/** One-time private transfer through encrypted Railway variables, never build assets. */
export async function bootstrapPrivateArchive(env: WorkerEnv & { VDS_IMPORT_TOKEN?: string }, values: NodeJS.ProcessEnv) {
  const active = await readActive(env);
  if (active) return { dossiers: active.bundle.snapshot.clients.length, enriched: active.bundle.pilots.length, imported: false };
  const count = Number(values.VDS_BOOTSTRAP_CHUNKS || 0);
  if (!count) return null;
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error('invalid_private_transfer');
  let encoded = '';
  for (let i = 0; i < count; i++) {
    const part = values[`VDS_BOOTSTRAP_${i}`];
    if (!part || part.length > 30000 || !/^[A-Za-z0-9+/=]+$/.test(part)) throw new Error('invalid_private_transfer');
    encoded += part;
  }
  const body = gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8');
  if (await sha256Text(body) !== env.VDS_EXPECTED_BUNDLE_SHA256 || !env.VDS_IMPORT_TOKEN) throw new Error('private_transfer_integrity');
  const result = await createWorker().fetch(new Request(`${env.VDS_PUBLIC_ORIGIN}/api/internal/import`, {
    method: 'POST', headers: { Origin: env.VDS_PUBLIC_ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${env.VDS_IMPORT_TOKEN}` }, body,
  }), { ...env, VDS_IMPORT_TOKEN_SHA256: await sha256Text(env.VDS_IMPORT_TOKEN) });
  if (!result.ok) throw new Error('private_transfer_failed');
  const loaded = await readActive(env);
  if (!loaded || loaded.bundle.snapshot.clients.length !== 500 || loaded.bundle.pilots.length !== 10) throw new Error('private_transfer_incomplete');
  for (let i = 0; i < count; i++) delete values[`VDS_BOOTSTRAP_${i}`];
  delete values.VDS_BOOTSTRAP_CHUNKS;
  return { dossiers: 500, enriched: 10, imported: true };
}

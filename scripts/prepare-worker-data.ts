import { chmod, lstat, mkdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PortalStore, PrivateNativeReadProvider } from '../server/portal.js';
import { buildAnalytics } from '../server/analytics.js';
import type { PilotResponse } from '../shared/pilot-contract.js';
import { validateWorkerBundle, type WorkerPrivateBundle } from '../shared/worker-bundle.js';

const repository = resolve(fileURLToPath(new URL('../', import.meta.url)));
const inside = (root: string, file: string) => { const p = relative(root, file); return !p || (p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p)); };
export interface PrepareWorkerOptions { privateRoot: string; output: string; now?: Date; }

/** Offline only. Uses the same identity checks and exact API projections as Node. */
export async function prepareWorkerData(options: PrepareWorkerOptions) {
  const actualRepository = await realpath(repository);
  const inputRoot = await realpath(resolve(options.privateRoot));
  if (inside(actualRepository, inputRoot)) throw new Error('private_input_must_be_outside_repository');
  const sourceFiles = ['native-sheet-read.private.json', 'pilot-10.private.json', 'portal-original.private.json'].map(name => resolve(inputRoot, name));
  const destination = resolve(options.output);
  if (!destination.endsWith('.private.json') || inside(actualRepository, destination) || sourceFiles.includes(destination)) throw new Error('private_output_location_forbidden');
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const actualParent = await realpath(parent);
  if (inside(actualRepository, actualParent)) throw new Error('private_output_location_forbidden');
  const parentInfo = await stat(actualParent);
  if (!parentInfo.isDirectory() || parentInfo.mode & 0o077) throw new Error('private_output_directory_requires_mode_0700');
  const actualDestination = resolve(actualParent, destination.split(sep).at(-1)!);
  if (sourceFiles.includes(actualDestination)) throw new Error('original_private_sources_are_immutable');
  try { if ((await lstat(actualDestination)).isSymbolicLink()) throw new Error('private_output_symlink_forbidden'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const forbiddenRoots = [actualRepository];
  const portal = new PortalStore({
    provider: new PrivateNativeReadProvider(sourceFiles[0], inputRoot, forbiddenRoots),
    privateRoot: inputRoot, pilotFile: sourceFiles[1], identityBaselineFile: sourceFiles[2], forbiddenRoots,
    ...(options.now ? { now: () => options.now! } : {}),
  });
  await portal.refresh();
  const snapshot = portal.current();
  if (!snapshot || snapshot.clients.length !== 500 || snapshot.enrichedClientIds?.length !== 10) throw new Error('expected_private_500_dossiers_and_10_verified_associations');
  const pilots = snapshot.enrichedClientIds.map(id => portal.pilot(id)).filter((value): value is PilotResponse => !!value);
  if (pilots.length !== 10) throw new Error('private_pilot_projection_incomplete');
  const rawSummary = portal.pilotSummary();
  if (!rawSummary.counts || rawSummary.sourceMode !== 'private_audit_snapshot' || rawSummary.humanValidationRequired !== true) throw new Error('private_pilot_summary_incomplete');
  const summary: WorkerPrivateBundle['summary'] = { ...rawSummary, counts: rawSummary.counts, sourceMode: rawSummary.sourceMode, humanValidationRequired: rawSummary.humanValidationRequired };
  const analytics = buildAnalytics(snapshot, pilots, { sourceAuditDate: summary.auditDate });
  const bundle: WorkerPrivateBundle = {
    schemaVersion: 'worker-private-1', snapshot, pilots, summary,
    connections: { sheets: portal.status(), pilot: summary,
      gmail: { continuousConnection: false, mode: 'private_audit_snapshot' },
      agenda: { continuousConnection: false, mode: 'private_audit_snapshot' },
      drive: { continuousConnection: false, mode: 'references_only' },
      vosfactures: { connected: false, label: 'Source non connectée' } },
    analytics,
  };
  validateWorkerBundle(bundle);
  const text = JSON.stringify(bundle);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > 4 * 1024 * 1024) throw new Error('private_bundle_exceeds_import_limit');
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  const staging = resolve(actualParent, `.worker-${randomUUID()}.tmp`);
  try {
    await writeFile(staging, text, { mode: 0o600, flag: 'wx' });
    await rename(staging, actualDestination);
    await chmod(actualDestination, 0o600);
  } finally { await unlink(staging).catch(() => {}); }
  // This report contains no client identities, source URLs or financial observations.
  return { schemaVersion: bundle.schemaVersion, bytes, sha256: digest, clients: snapshot.clients.length,
    enriched: pilots.length, events: analytics.totals.events, contradictions: analytics.totals.contradictions,
    sourceReadAt: snapshot.sourceState!.lastReadAt, sourceState: snapshot.sourceState!.status,
    financialTotalsVerified: false, sourceWrites: 0, output: actualDestination };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [privateRoot, output] = process.argv.slice(2);
  if (!privateRoot || !output) throw new Error('Usage: node --import tsx scripts/prepare-worker-data.ts <private-source-directory> <external-output.private.json>');
  try { console.log(JSON.stringify(await prepareWorkerData({ privateRoot, output }))); }
  catch (error) { console.error(error instanceof Error ? error.message : 'private_worker_export_failed'); process.exitCode = 1; }
}

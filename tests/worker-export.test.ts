import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepareWorkerData } from '../scripts/prepare-worker-data.js';
import { PrivateNativeReadProvider } from '../server/portal.js';
import { validateWorkerBundle } from '../shared/worker-bundle.js';

const privateRoot = process.env.VDS_REAL_CHAIN_DATA_ROOT;
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

test('offline Worker export preserves actual 500 dossiers, 10 pilots, source dates and immutable inputs', { skip: !privateRoot }, async () => {
  const root = privateRoot!;
  const inputFiles = ['native-sheet-read.private.json', 'pilot-10.private.json', 'portal-original.private.json'].map(name => resolve(root, name));
  const originalHashes = await Promise.all(inputFiles.map(async file => sha(await readFile(file))));
  const directory = await mkdtemp(resolve(tmpdir(), 'vds-worker-export-'));
  try {
    const output = resolve(directory, 'worker.private.json');
    const options = { privateRoot: root, output, now: new Date('2026-10-20T00:00:00Z') };
    const report = await prepareWorkerData(options);
    const serialized = await readFile(output, 'utf8');
    const bundle = validateWorkerBundle(JSON.parse(serialized));
    assert.equal(report.sha256, sha(serialized));
    assert.equal(report.bytes, Buffer.byteLength(serialized));
    assert.ok(report.bytes <= 4 * 1024 * 1024);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(bundle.snapshot.clients.length, 500);
    assert.equal(bundle.pilots.length, 10);
    assert.equal(bundle.analytics.totals.events, 146);
    assert.equal(bundle.analytics.totals.contradictions, 32);
    assert.equal(bundle.analytics.finance.contractsTotal, null);
    assert.equal(bundle.analytics.finance.balancesTotal, null);
    assert.deepEqual(bundle.analytics.finance.series, []);
    const provider = new PrivateNativeReadProvider(inputFiles[0], root);
    assert.equal(bundle.snapshot.sourceState!.lastReadAt, (await provider.read()).fetchedAt);
    assert.equal(bundle.snapshot.sourceState!.status, 'not_connected');
    assert.equal(bundle.snapshot.sourceState!.stale, true);
    assert.equal((await prepareWorkerData(options)).sha256, report.sha256, 'Same source and transport time must yield the same import digest');
    assert.deepEqual(await Promise.all(inputFiles.map(async file => sha(await readFile(file)))), originalHashes, 'Source files must be byte-for-byte unchanged');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Worker exporter refuses repository outputs, original inputs and symlink targets', { skip: !privateRoot }, async () => {
  const root = privateRoot!;
  await assert.rejects(prepareWorkerData({ privateRoot: root, output: resolve('public/worker.private.json') }), /private_output_location_forbidden/);
  await assert.rejects(prepareWorkerData({ privateRoot: root, output: resolve(root, 'native-sheet-read.private.json') }), /private_output_location_forbidden/);
  const directory = await mkdtemp(resolve(tmpdir(), 'vds-worker-export-refusal-'));
  try {
    const output = resolve(directory, 'worker.private.json');
    await symlink(resolve(root, 'native-sheet-read.private.json'), output);
    await assert.rejects(prepareWorkerData({ privateRoot: root, output }), /private_output_symlink_forbidden/);
    await rm(output);
    await chmod(directory, 0o755);
    await assert.rejects(prepareWorkerData({ privateRoot: root, output }), /private_output_directory_requires_mode_0700/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

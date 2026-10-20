import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const workerName = 'moteur-de-recherche-vds-prive';
const privateOrigin = 'https://moteur-de-recherche-vds-prive.meert-val.workers.dev';

type Report = {
  staticChecksPassed: boolean;
  target: string;
  assetsChecked: number;
  publicationAttempted: boolean;
  errors: string[];
};
type FixtureOptions = {
  name?: string;
  origin?: string;
  env?: Record<string, string>;
};

async function inspect(options: FixtureOptions = {}) {
  // Execute the actual deployment preflight against a minimal, disposable
  // checkout. No real dossiers, runtime secrets, network or Wrangler are used.
  const root = await mkdtemp(resolve(tmpdir(), 'vds-deployment-test-'));
  try {
    await Promise.all(['scripts', 'worker', 'dist/assets'].map(directory => mkdir(resolve(root, directory), { recursive: true })));
    const script = await readFile(resolve(projectRoot, 'scripts/cloudflare-preflight.mjs'), 'utf8');
    await Promise.all([
      writeFile(resolve(root, 'scripts/cloudflare-preflight.mjs'), script),
      writeFile(resolve(root, 'worker/cloudflare.ts'), 'export default {};\n'),
      writeFile(resolve(root, 'package.json'), JSON.stringify({ devDependencies: { wrangler: '4.151.2' } })),
      writeFile(resolve(root, 'dist/index.html'), '<!doctype html><html><body><main id="root"></main></body></html>'),
      writeFile(resolve(root, 'dist/assets/app.js'), 'document.querySelector("main").textContent = "Interface";'),
      writeFile(resolve(root, 'wrangler.jsonc'), JSON.stringify({
        name: options.name ?? workerName,
        main: 'worker/cloudflare.ts',
        workers_dev: true,
        preview_urls: false,
        keep_vars: true,
        assets: {
          directory: './dist',
          binding: 'ASSETS',
          run_worker_first: true,
          html_handling: 'auto-trailing-slash',
          not_found_handling: 'none',
        },
        r2_buckets: [{ binding: 'BUCKET', bucket_name: 'vds-intelligence-360-private' }],
        vars: { VDS_PUBLIC_ORIGIN: options.origin ?? privateOrigin, VDS_RELEASE_ID: 'isolated-deployment-test' },
      })),
    ]);
    // Pass only the process basics and the scenario under test: the child must
    // never inherit production secrets or the caller's CI target.
    const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...options.env };
    let stdout: string;
    let exitCode = 0;
    try {
      ({ stdout } = await run(process.execPath, [resolve(root, 'scripts/cloudflare-preflight.mjs')], {
        cwd: root, env, timeout: 10_000, maxBuffer: 64 * 1024,
      }));
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string };
      assert.equal(typeof failure.code, 'number', 'The actual preflight must run to completion');
      assert.equal(failure.stderr || '', '', 'The preflight reports controlled failures as JSON');
      exitCode = failure.code as number;
      stdout = failure.stdout || '';
    }
    const report = JSON.parse(stdout.trim()) as Report;
    assert.equal(report.publicationAttempted, false);
    assert.equal(report.assetsChecked, 2);
    return { report, exitCode };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('private deployment preflight accepts the dedicated Worker from both authorized branches', async () => {
  for (const branch of ['feat/vds-live-portal-integration', 'release/vds-private-production']) {
    const { report, exitCode } = await inspect({ env: { WORKERS_CI_BRANCH: branch } });
    assert.equal(exitCode, 0);
    assert.equal(report.staticChecksPassed, true);
    assert.equal(report.target, privateOrigin);
    assert.deepEqual(report.errors, []);
  }
});

test('private deployment preflight rejects the existing Worker and its origin independently', async () => {
  for (const [options, expected] of [
    [{ name: 'moteur-de-recherche-vds' }, 'unexpected_worker_name'],
    [{ origin: 'https://moteur-de-recherche-vds.meert-val.workers.dev' }, 'unexpected_public_origin'],
  ] as const) {
    const { report, exitCode } = await inspect(options);
    assert.equal(exitCode, 1);
    assert.equal(report.staticChecksPassed, false);
    assert.ok(report.errors.includes(expected));
  }
});

test('private deployment preflight prevents CI from silently redirecting a correct manifest to the live Worker', async () => {
  const env = {
    WORKERS_CI_BRANCH: 'release/vds-private-production',
    WRANGLER_CI_OVERRIDE_NAME: 'moteur-de-recherche-vds',
  };
  const denied = await inspect({ env });
  assert.equal(denied.exitCode, 1);
  assert.equal(denied.report.staticChecksPassed, false);
  assert.ok(denied.report.errors.includes('unsafe_ci_worker_override'));
  const allowed = await inspect({ env: { ...env, WRANGLER_CI_OVERRIDE_NAME: workerName } });
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.report.staticChecksPassed, true);
});

test('private deployment preflight rejects an unrelated build branch', async () => {
  const { report, exitCode } = await inspect({ env: { WORKERS_CI_BRANCH: 'main' } });
  assert.equal(exitCode, 1);
  assert.equal(report.staticChecksPassed, false);
  assert.ok(report.errors.includes('unexpected_build_branch'));
});

test('private deployment preflight rejects an environment override that changes the deployment target', async () => {
  const denied = await inspect({ env: { CLOUDFLARE_ENV: 'production' } });
  assert.equal(denied.exitCode, 1);
  assert.equal(denied.report.staticChecksPassed, false);
  assert.ok(denied.report.errors.includes('alternate_cloudflare_environment_forbidden'));
  const allowed = await inspect({ env: { CLOUDFLARE_ENV: '' } });
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.report.staticChecksPassed, true);
});

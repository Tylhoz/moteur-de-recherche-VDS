import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { extname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const targetOrigin = 'https://moteur-de-recherche-vds.meert-val.workers.dev';
const errors = [];
const check = (condition, code) => { if (!condition) errors.push(code); };
const allowedArgs = process.argv.slice(2);
check(allowedArgs.length === 0 || allowedArgs.length === 1 && allowedArgs[0] === '--require-runtime', 'unknown_preflight_option');
const requireRuntime = allowedArgs[0] === '--require-runtime';
let config, assetsChecked = 0, runtimeConfiguration = [];

try {
  config = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
  check(config.name === 'moteur-de-recherche-vds', 'unexpected_worker_name');
  check(config.main === 'worker/cloudflare.ts', 'authenticated_worker_entry_required');
  check(config.workers_dev === true && config.preview_urls === false, 'production_origin_only_required');
  check(config.keep_vars === true, 'dashboard_variables_must_be_preserved');
  check(!config.route && !config.routes && !config.env && !config.site, 'alternate_deployment_targets_forbidden');
  check(!config.no_bundle && !config.find_additional_modules, 'unbounded_worker_files_forbidden');
  check(config.assets?.directory === './dist' && config.assets.binding === 'ASSETS' && config.assets.run_worker_first === true, 'authenticated_assets_required');
  check(config.assets?.html_handling === 'auto-trailing-slash' && config.assets?.not_found_handling === 'none', 'unexpected_asset_routing');
  check(Array.isArray(config.r2_buckets) && config.r2_buckets.length === 1 && config.r2_buckets[0].binding === 'BUCKET'
    && config.r2_buckets[0].bucket_name === 'vds-intelligence-360-private', 'dedicated_private_bucket_binding_required');
  check(config.vars?.VDS_PUBLIC_ORIGIN === targetOrigin, 'unexpected_public_origin');
  const publicVars = new Set(['VDS_PUBLIC_ORIGIN', 'VDS_RELEASE_ID']);
  check(Object.keys(config.vars || {}).every(key => publicVars.has(key)), 'runtime_identity_and_secrets_must_stay_out_of_tracked_config');
  const entry = await lstat(resolve(root, 'worker/cloudflare.ts'));
  check(entry.isFile() && !entry.isSymbolicLink(), 'authenticated_worker_entry_unavailable');
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  check(/^\d+\.\d+\.\d+$/.test(packageJson.devDependencies?.wrangler || ''), 'wrangler_version_must_be_pinned');
  const branch = process.env.WORKERS_CI_BRANCH || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  check(!branch || branch === 'feat/vds-live-portal-integration', 'unexpected_build_branch');
  const dist = resolve(root, 'dist');
  check(await realpath(dist) === dist, 'asset_directory_symlink_forbidden');
  const allowedTypes = new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2']);
  const textualTypes = new Set(['.html', '.js', '.css', '.svg']);
  const inspected = [];
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, item.name), name = relative(dist, file).split(sep).join('/');
      if (item.isSymbolicLink() || (await lstat(file)).isSymbolicLink()) { errors.push('asset_symlink_forbidden'); continue; }
      if (item.isDirectory()) {
        if (name !== 'assets' && !name.startsWith('assets/')) { errors.push('unexpected_asset_directory'); continue; }
        await visit(file); continue;
      }
      if (!item.isFile() || (name !== 'index.html' && !name.startsWith('assets/')) || !allowedTypes.has(extname(name))
        || /(?:private|snapshot|pilot|\.map$|\.json$|\.env|\.vars)/i.test(name)) { errors.push('private_or_unsupported_asset_forbidden'); continue; }
      const info = await lstat(file);
      if (info.size > 3 * 1024 * 1024) { errors.push('oversized_asset'); continue; }
      if (textualTypes.has(extname(name))) {
        const text = await readFile(file, 'utf8');
        check(!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,})|\/workspace\/|\/codex\//.test(text), 'secret_or_private_path_in_asset');
        check(!/["']?schemaVersion["']?\s*:\s*["']worker-private-1["']|["'](?:clients|pilots|dossiers)["']\s*:\s*\[\s*\{|<script[^>]+type=["']application\/json/i.test(text), 'private_dataset_in_asset');
      }
      inspected.push(name); assetsChecked++;
    }
  }
  await visit(dist);
  check(inspected.includes('index.html') && inspected.some(name => name.endsWith('.js')), 'built_frontend_missing');

  // Runtime values can exist only in the dashboard. Absence here is reported as
  // unknown remotely, never as proof of a missing or valid live configuration.
  const values = { ...config.vars, ...process.env };
  const rules = {
    VDS_PUBLIC_ORIGIN: value => value === targetOrigin,
    VDS_ACCESS_TEAM_DOMAIN: value => /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(value),
    VDS_ACCESS_AUD: value => /^[a-f0-9]{64}$/.test(value),
    VDS_OWNER_EMAIL: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length < 320,
    VDS_EXPECTED_BUNDLE_SHA256: value => /^[a-f0-9]{64}$/.test(value),
    VDS_IMPORT_TOKEN: value => /^[A-Za-z0-9_-]{32,256}$/.test(value),
    VDS_RELEASE_ID: value => /^[A-Za-z0-9._-]{1,80}$/.test(value),
  };
  runtimeConfiguration = Object.entries(rules).map(([name, validate]) => {
    const value = values[name];
    return { name, state: typeof value !== 'string' || !value ? 'not_available_locally' : validate(value) ? 'valid_format' : 'invalid_format' };
  });
  if (requireRuntime) check(runtimeConfiguration.every(item => item.state === 'valid_format'), 'runtime_configuration_incomplete_or_invalid');
} catch { errors.push('preflight_input_unavailable_or_invalid'); }

const uniqueErrors = [...new Set(errors)];
console.log(JSON.stringify({ staticChecksPassed: uniqueErrors.length === 0, target: targetOrigin, assetsChecked,
  authenticatedWorkerRequired: true, privateDataBundled: uniqueErrors.length === 0 ? false : null, runtimeConfiguration,
  remoteAuthenticationVerified: false, privateBucketProvisioningVerified: false, publicationAttempted: false,
  errors: uniqueErrors }));
if (uniqueErrors.length) process.exitCode = 1;

import { execFileSync } from 'node:child_process';
import { writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const commit = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VDS_COMMIT_SHA ||
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('actual_commit_required');
await writeFile('worker/release.generated.ts',
  `export const release = ${JSON.stringify({ id: 'vds-railway-2026-10', commit })} as const;\n`);
execFileSync('node_modules/.bin/tsc', ['--noEmit'], { stdio: 'inherit' });
execFileSync('node_modules/.bin/vite', ['build'], { stdio: 'inherit' });
const permitted = new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2']);
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('asset_symlink');
    if (entry.isDirectory()) {
      if (entry.name !== 'assets') throw new Error('unsupported_asset_directory');
      await check(path); continue;
    }
    if (!entry.isFile() || !permitted.has(extname(path)) || /private|snapshot|pilot|\.env|\.map$/i.test(entry.name))
      throw new Error('private_or_unsupported_asset');
    if ((await lstat(path)).size > 3 * 1024 * 1024) throw new Error('oversized_asset');
    if (['.html', '.js', '.css', '.svg'].includes(extname(path))) {
      const text = await readFile(path, 'utf8');
      if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\bghp_[A-Za-z0-9]{30,}|\/workspace\/|["'](?:clients|pilots|dossiers)["']\s*:\s*\[\s*\{|["']?schemaVersion["']?\s*:\s*["']worker-private-1["']/.test(text))
        throw new Error('private_content_in_static_asset');
    }
  }
}
await check(resolve('dist'));
console.log('Railway build and static asset checks passed');

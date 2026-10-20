import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
const value = (flag, fallback) => { const index = args.indexOf(flag); if (index < 0) return fallback; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${flag}`); return args[index + 1]; };
const permitted = new Set(['--manifest', '--frontend', '--outdir', '--release-id', '--commit']);
for (let i = 0; i < args.length; i += 2) if (!permitted.has(args[i]) || !args[i + 1]) throw new Error('Unknown or incomplete build option');
const manifestPath = resolve(root, value('--manifest', '.openai/hosting.preview.json'));
const frontend = resolve(root, value('--frontend', 'dist'));
const output = resolve(root, value('--outdir', 'worker-dist'));
const releaseId = value('--release-id', 'vds-360-workers-preview');
async function gitHead() {
  // No child process: some managed environments reject Node's spawnSync with EPERM.
  let directory = resolve(root, '.git');
  if (!(await lstat(directory)).isDirectory()) {
    const target = (await readFile(directory, 'utf8')).trim().match(/^gitdir: (.+)$/)?.[1];
    if (!target) throw new Error('Git metadata missing; pass --commit with the actual source commit');
    directory = resolve(root, target);
  }
  const head = (await readFile(resolve(directory, 'HEAD'), 'utf8')).trim();
  if (!head.startsWith('ref: ')) return head;
  const reference = head.slice(5);
  if (!/^refs\/[a-zA-Z0-9._/-]+$/.test(reference) || reference.includes('..')) throw new Error('Invalid Git HEAD reference');
  const common = await readFile(resolve(directory, 'commondir'), 'utf8').then(text => resolve(directory, text.trim())).catch(error => { if (error.code === 'ENOENT') return directory; throw error; });
  for (const candidate of [...new Set([directory, common])]) {
    const loose = await readFile(resolve(candidate, reference), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (loose) return loose.trim();
    const packed = await readFile(resolve(candidate, 'packed-refs'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    for (const line of packed.split('\n')) { const [hash, name] = line.split(' '); if (name === reference) return hash; }
  }
  throw new Error('Git source commit unresolved; pass --commit');
}
const commit = value('--commit', process.env.VDS_COMMIT_SHA || process.env.GITHUB_SHA || '') || await gitHead();
if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-zA-Z0-9._-]{1,80}$/.test(releaseId)) throw new Error('Invalid release identity');
if (output !== resolve(root, 'worker-dist') || frontend !== resolve(root, 'dist')) throw new Error('Build output/input must remain worker-dist/dist');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const previousManifest = JSON.parse(await readFile(resolve(root, '.openai/hosting.v2-backup.json'), 'utf8'));
if (typeof manifest.project_id !== 'string' || !manifest.project_id || manifest.project_id === previousManifest.project_id) throw new Error('Separate preview project_id required; version 2 is protected');
if (manifest.static) throw new Error('Worker preview must not be a static Site');
if (manifest.r2 !== 'BUCKET') throw new Error('Private R2 binding BUCKET must be declared');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const assets = {};
const assetsInfo = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), name = relative(frontend, path).split(sep).join('/');
    if (entry.isSymbolicLink() || (await lstat(path)).isSymbolicLink()) throw new Error('Symlinked build asset forbidden');
    if (entry.isDirectory()) { if (name !== 'assets' && !name.startsWith('assets/')) throw new Error('Unexpected asset directory'); await visit(path); continue; }
    if (!entry.isFile() || (name !== 'index.html' && !name.startsWith('assets/')) || !mime[extname(name)] || /private|snapshot|pilot|\.map$|\.json$/i.test(name)) throw new Error('Private or unsupported build asset forbidden');
    const content = await readFile(path);
    if (content.length > 3 * 1024 * 1024) throw new Error('Individual frontend asset exceeds limit');
    if (['.html', '.js', '.css', '.svg'].includes(extname(name)) && /\/workspace\/|PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}/.test(content.toString('utf8'))) throw new Error('Sensitive pattern found in generic asset');
    const url = `/${name}`;
    assets[url] = { body: content.toString('base64'), type: mime[extname(name)] };
    assetsInfo.push({ path: url, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
}
if (await realpath(frontend) !== frontend) throw new Error('Frontend root symlink forbidden');
await visit(frontend);
if (!assets['/index.html'] || !assetsInfo.some(asset => asset.path.endsWith('.js'))) throw new Error('Built application is missing');
const buildInfo = { releaseId, commit, assets: assetsInfo, businessDataEmbedded: false };
const wrapper = `
import runtime from './worker/index.ts';
const genericAssets = ${JSON.stringify(assets)};
export const buildInfo = ${JSON.stringify(buildInfo)};
function assetResponse(request) {
  const path = new URL(request.url).pathname;
  const asset = genericAssets[path === '/' ? '/index.html' : path];
  if (!asset || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', {status:404});
  const binary = atob(asset.body);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new Response(request.method === 'HEAD' ? null : bytes, {headers:{'Content-Type':asset.type,'Cache-Control':'private, no-store, max-age=0'}});
}
export default {
  fetch(request, env, ctx) {
    return runtime.fetch(request, { ...env, ASSETS:{fetch:assetResponse}, VDS_RELEASE_ID:buildInfo.releaseId, VDS_COMMIT_SHA:buildInfo.commit }, ctx);
  }
};
`;
const compiled = await build({ stdin: { contents: wrapper, sourcefile: 'vds-worker-entry.ts', resolveDir: root, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: false,
  metafile: true, logLevel: 'silent', legalComments: 'none',
  plugins: [{ name: 'reject-node-runtime', setup(build) { build.onResolve({ filter: /^node:|^(fs|path|http|https|crypto|buffer|stream|util|os)$/ }, () => ({ errors: [{ text: 'Node runtime import forbidden in Worker build' }] })); } }],
});
for (const result of Object.values(compiled.metafile.outputs)) if (result.imports.length) throw new Error('Worker output must be a self-contained ES module');
const workerText = compiled.outputFiles[0].text;
if (/from\s*["']node:|require\(["'](?:node:|fs|http|path)/.test(workerText)) throw new Error('Node import survived build');
const staging = resolve(root, `.worker-build-${process.pid}`);
await mkdir(resolve(staging, 'server'), { recursive: true });
await mkdir(resolve(staging, '.openai'), { recursive: true });
try {
  await writeFile(resolve(staging, 'server/index.js'), workerText);
  await writeFile(resolve(staging, '.openai/hosting.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
} finally { await rm(staging, { recursive: true, force: true }); }
console.log(JSON.stringify({ project_id: manifest.project_id, release: releaseId, commit, assets: assetsInfo.length,
  genericAssetBytes: assetsInfo.reduce((total, item) => total + item.bytes, 0), workerBytes: Buffer.byteLength(workerText), businessDataEmbedded: false,
  output: relative(root, output), runtime: 'cloudflare-worker-esm', storageBindingDeclared: !!manifest.r2 }));

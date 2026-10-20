import { cp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only build products move. The original v2 checkout and private inputs are never touched.
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const source = resolve(root, 'worker-dist');
const manifest = JSON.parse(await readFile(resolve(source, '.openai/hosting.json'), 'utf8'));
const expected = JSON.parse(await readFile(resolve(root, '.openai/hosting.json'), 'utf8'));
const backup = JSON.parse(await readFile(resolve(root, '.openai/hosting.v2-backup.json'), 'utf8'));
if (manifest.project_id !== expected.project_id || manifest.project_id === backup.project_id || manifest.static) throw new Error('Unsafe deployment identity');
if ((await readdir(source)).sort().join(',') !== '.openai,server') throw new Error('Unexpected Worker artifact');
const temp = resolve(root, '.worker-build-stage');
await rm(temp, { recursive: true, force: true });
await cp(source, temp, { recursive: true, errorOnExist: true });
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await rename(temp, resolve(root, 'dist'));
console.log('Worker artifact staged in dist; no private data included.');

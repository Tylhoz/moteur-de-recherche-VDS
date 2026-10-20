import { mkdir, readFile, realpath, chmod, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePilotBundle } from '../server/pilot.js';

// Explicit input/output; the production frontend never imports this dataset.
const [input, output, sourceAuditDate] = process.argv.slice(2);
if (!input || !output || !sourceAuditDate || !/^\d{4}-\d{2}-\d{2}$/.test(sourceAuditDate)) {
  throw new Error('Usage: node --import tsx scripts/prepare-private-pilot.ts <audit.json> <private-output.json> <YYYY-MM-DD>');
}
const destination = resolve(output); const privateRoot = dirname(destination);
const repository = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const inside = (root: string, file: string) => { const p = relative(root, file); return !p || (p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p)); };
if (inside(repository, destination)) throw new Error('Private data must stay outside the repository.');
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
const actualRoot = await realpath(privateRoot);
if (inside(repository, actualRoot)) throw new Error('Private output must not resolve into the repository.');
await chmod(actualRoot, 0o700);
const source = await readFile(input, 'utf8');
const bundle = normalizePilotBundle(JSON.parse(source), { sourceAuditDate, generatedAt: new Date().toISOString(), sourceDigest: createHash('sha256').update(source).digest('hex') });
const staging = resolve(actualRoot, `.pilot-${randomUUID()}.tmp`);
await writeFile(staging, JSON.stringify(bundle, null, 2), { mode: 0o600, flag: 'wx' });
await rename(staging, resolve(actualRoot, destination.split(sep).at(-1)!));
console.log(JSON.stringify({ schemaVersion: bundle.schemaVersion, sourceMode: bundle.sourceMode, counts: bundle.counts, humanValidationRequired: true }));

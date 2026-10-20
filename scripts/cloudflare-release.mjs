import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
async function readCommitFromGit() {
  let git = resolve(root, '.git');
  if (!(await lstat(git)).isDirectory()) {
    const target = (await readFile(git, 'utf8')).trim().match(/^gitdir: (.+)$/)?.[1];
    if (!target) throw new Error('invalid_git_directory');
    git = resolve(root, target);
  }
  const head = (await readFile(resolve(git, 'HEAD'), 'utf8')).trim();
  if (!head.startsWith('ref: ')) return head;
  const reference = head.slice(5);
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(reference) || reference.includes('..')) throw new Error('invalid_git_reference');
  const common = await readFile(resolve(git, 'commondir'), 'utf8').then(value => resolve(git, value.trim())).catch(error => { if (error.code === 'ENOENT') return git; throw error; });
  for (const directory of [...new Set([git, common])]) {
    const loose = await readFile(resolve(directory, reference), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (loose) return loose.trim();
    const packed = await readFile(resolve(directory, 'packed-refs'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    for (const line of packed.split('\n')) { const [hash, name] = line.split(' '); if (name === reference) return hash; }
  }
  throw new Error('source_commit_unresolved');
}

try {
  if (process.argv.length !== 2) throw new Error('unexpected_release_argument');
  const commit = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || await readCommitFromGit();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('invalid_source_commit');
  const release = { id: 'vds-cloudflare-2026-10', commit };
  await writeFile(resolve(root, 'worker/release.generated.ts'), `// Generated from the actual build commit; no runtime or business data.\nexport const release = ${JSON.stringify(release)} as const;\n`, { mode: 0o644 });
  console.log(JSON.stringify({ generated: true, release: release.id, commit }));
} catch {
  console.error('cloudflare_release_generation_failed: real_40_character_source_commit_required');
  process.exitCode = 1;
}

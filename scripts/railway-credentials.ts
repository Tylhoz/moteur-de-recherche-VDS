import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { passwordHash } from '../server/railway/auth.js';

// Never prints credentials. Output must be outside the source checkout.
const target = process.argv[2];
const owner = process.argv[3];
if (!target || !relative(process.cwd(), resolve(target)).startsWith('..')) throw new Error('private_output_directory_outside_project_required');
if (!owner || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) throw new Error('owner_email_required');
const directory = resolve(target);
await mkdir(directory, { recursive: true, mode: 0o700 });
const password = randomBytes(24).toString('base64url');
const values = { VDS_OWNER_EMAIL: owner.toLowerCase(), VDS_PASSWORD_HASH: await passwordHash(password),
  VDS_SESSION_SECRET: randomBytes(48).toString('base64url'), VDS_IMPORT_TOKEN: randomBytes(48).toString('base64url'),
  VDS_PRIVATE_DATA_ROOT: '/data' };
await writeFile(resolve(directory, 'railway-secrets.private.json'), JSON.stringify(values), { flag: 'wx', mode: 0o600 });
await writeFile(resolve(directory, 'railway-login.private.txt'),
  `Connexion propriétaire VDS Pools\nAdresse : ${values.VDS_OWNER_EMAIL}\nMot de passe : ${password}\nConserver dans un gestionnaire de mots de passe. Ne pas publier.\n`,
  { flag: 'wx', mode: 0o600 });
console.log('Configuration et identifiant enregistrés uniquement dans le répertoire privé choisi.');

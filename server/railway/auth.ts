import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const cookieName = '__Host-vds-session';
const ttl = 8 * 60 * 60;
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export function createOwnerAuth(owner: string, hash: string, secret: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner) ||
      !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(hash) ||
      !/^[A-Za-z0-9_-]{43,256}$/.test(secret)) throw new Error('owner_auth_configuration_required');
  const sign = (payload: string) => createHmac('sha256', secret).update(`${owner}\n${hash}\n${payload}`).digest('base64url');
  const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  // Global, bounded limiter: do not trust client-supplied forwarded IP addresses.
  let failures = 0, windowStart = Date.now(), inFlight = false;
  function resetWindow() { if (Date.now() - windowStart > 60_000) { failures = 0; windowStart = Date.now(); } }
  return {
    async login(email: string, password: string): Promise<string | null> {
      resetWindow();
      if (inFlight || failures >= 5 || password.length > 512 || email.length > 320) return null;
      inFlight = true;
      try {
        const [, salt, expected] = hash.split('$');
        const actual = await derive(password, salt, 64) as Buffer;
        if (!timingSafeEqual(actual, Buffer.from(expected, 'hex')) || email.toLowerCase() !== owner.toLowerCase()) { failures++; return null; }
        failures = 0;
        const payload = `${Math.floor(Date.now() / 1000) + ttl}.${randomBytes(24).toString('base64url')}`;
        return `${cookieName}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`;
      } finally { inFlight = false; }
    },
    verify(request: Request) {
      const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
      if (cookies.length !== 1) return false;
      const token = cookies[0].slice(cookieName.length + 1);
      if (!/^\d{10}\.[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
      const [expires, nonce, signature] = token.split('.');
      const now = Math.floor(Date.now() / 1000);
      return Number(expires) > now && Number(expires) <= now + ttl && equal(signature, sign(`${expires}.${nonce}`));
    },
    clear: `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  };
}

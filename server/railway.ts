import { createServer } from 'node:http';
import { resolve, relative } from 'node:path';
import { openPrivateStorage } from './railway/storage.js';
import { createRailwayApp } from './railway/app.js';
import { runScheduledSync } from '../worker/integration-router.js';

async function start() {
  const root = resolve(process.env.VDS_PRIVATE_DATA_ROOT || '/data');
  const dist = resolve('dist');
  if (!relative(dist, root).startsWith('..') || !relative(process.cwd(), root).startsWith('..'))
    throw new Error('private_volume_must_be_outside_application');
  if (process.env.VDS_VOLUME_LOCKED !== 'true') throw new Error('start_with_volume_lock');
  const storage = await openPrivateStorage(root);
  const app = createRailwayApp(process.env, storage.bucket, dist);
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.url === '/healthz' && ['GET', 'HEAD'].includes(incoming.method || '')) {
        outgoing.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        outgoing.end(incoming.method === 'HEAD' ? '' : 'ok'); return;
      }
      if (incoming.headers.host !== new URL(app.origin).host || !incoming.url?.startsWith('/') || incoming.url.startsWith('//'))
        { outgoing.writeHead(400); outgoing.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { outgoing.writeHead(413); outgoing.end(); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const method = incoming.method || 'GET';
      const request = new Request(`${app.origin}${incoming.url}`, { method, headers,
        ...(!['GET', 'HEAD'].includes(method) ? { body: Buffer.concat(chunks) } : {}) });
      const response = await app.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.maxHeadersCount = 64;
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port_invalid');
  server.listen(port, '0.0.0.0', () => console.log('VDS Railway server ready'));
  const sync = setInterval(() => void runScheduledSync(app.env).catch(() => {}), 5 * 60_000);
  sync.unref();
  const stop = () => { clearInterval(sync); server.close(() => void storage.close().then(() => process.exit(0))); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
start().catch(() => { console.error('VDS startup refused: verify private volume and required configuration'); process.exitCode = 1; });

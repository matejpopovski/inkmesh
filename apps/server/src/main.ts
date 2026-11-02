import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.env['PORT'] ?? 41510);
const host = process.env['HOST'] ?? '127.0.0.1';
const databasePath = resolve(process.env['INKMESH_DB'] ?? 'data/inkmesh.sqlite');
const staticDir = resolve(process.env['INKMESH_WEB_DIST'] ?? resolve(here, '../../web/dist'));
const retentionDays = Number(process.env['INKMESH_RETENTION_DAYS'] ?? 30);

mkdirSync(dirname(databasePath), { recursive: true });

const server = await createServer(port, host, {
  databasePath,
  staticDir,
  retentionMs: retentionDays * 24 * 3_600_000,
  log: (message) => console.log(message),
});

console.log(`inkmesh listening on http://${host}:${server.port}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

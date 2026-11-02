import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from '../apps/server/src/server.js';
import { MemoryStore, SyncEngine, type SocketLike } from '../packages/sync/src/index.js';
import { sampleShape, seeded, writeResult } from './support.js';

/**
 * One real server, real SQLite and real sockets on loopback, with the engine's default 40 ms flush.
 * Both clients share a process with the server, so this is a best case that leaves out any network.
 */
const ROUNDS = 2_000;
const BOARD = 'latency';

function percentile(sorted: readonly number[], fraction: number): number {
  return Math.round((sorted[Math.floor(sorted.length * fraction)] as number) * 100) / 100;
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 0));
}

const directory = mkdtempSync(join(tmpdir(), 'inkmesh-bench-'));
const server = await createServer(0, '127.0.0.1', { databasePath: join(directory, 'b.sqlite') });
const url = `ws://127.0.0.1:${server.port}/ws`;

function client(replica: string, flushMs?: number): SyncEngine {
  return new SyncEngine({
    board: BOARD,
    replica,
    store: new MemoryStore(),
    connect: () => new WebSocket(url) as unknown as SocketLike,
    ...(flushMs === undefined ? {} : { flushMs }),
  });
}

const writer = client('writer');
const reader = client('reader');
await writer.start();
await reader.start();
await until(
  () => writer.getSnapshot().status === 'online' && reader.getSnapshot().status === 'online',
);

const random = seeded(3);
const id = writer.doc.create(sampleShape(random));
await until(() => reader.doc.get(id) !== undefined);

const samples: number[] = [];
for (let i = 1; i <= ROUNDS; i++) {
  const started = performance.now();
  writer.doc.set(id, { pos: [i, i] });
  await until(() => (reader.doc.get(id)?.fields['pos'] as number[] | undefined)?.[0] === i);
  samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);
await writer.stop();
await reader.stop();

async function handshake(records: number): Promise<number> {
  const board = `join-${records}`;
  const seeder = new SyncEngine({
    board,
    replica: 'seed',
    store: new MemoryStore(),
    connect: () => new WebSocket(url) as unknown as SocketLike,
  });
  await seeder.start();
  await until(() => seeder.getSnapshot().status === 'online');
  const shapes = seeded(records);
  for (let i = 0; i < records; i++) seeder.doc.create(sampleShape(shapes));
  await until(() => seeder.pending() === 0);

  const started = performance.now();
  const joiner = new SyncEngine({
    board,
    replica: 'joiner',
    store: new MemoryStore(),
    connect: () => new WebSocket(url) as unknown as SocketLike,
  });
  await joiner.start();
  await until(() => joiner.doc.list().length === records);
  const elapsed = performance.now() - started;
  await joiner.stop();
  await seeder.stop();
  return Math.round(elapsed * 10) / 10;
}

const joins = [];
for (const records of [100, 1_000, 10_000]) {
  joins.push({ records, joinMs: await handshake(records) });
}

await server.close();
rmSync(directory, { recursive: true, force: true });

writeResult('latency', {
  command: 'npm run bench',
  note: 'Loopback, single process, default 40 ms flush. Measures the time from a local write until another replica shows it, so the flush delay is included on purpose.',
  rounds: ROUNDS,
  editToPeerMs: {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: Math.round((samples.at(-1) as number) * 100) / 100,
  },
  joins,
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, SyncEngine, type SocketLike } from '@inkmesh/sync';
import { WebSocket } from 'ws';
import { createServer, type RunningServer, type ServerOptions } from '../src/server.js';

export interface Harness {
  server: RunningServer;
  databasePath: string;
  url: string;
  restart(options?: Partial<ServerOptions>): Promise<void>;
  client(replica: string, board?: string, store?: MemoryStore): Promise<SyncEngine>;
  dispose(): Promise<void>;
}

export async function harness(options: Partial<ServerOptions> = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'inkmesh-server-'));
  const databasePath = join(directory, 'test.sqlite');
  const engines: SyncEngine[] = [];

  const self: Harness = {
    server: await createServer(0, '127.0.0.1', { databasePath, ...options }),
    databasePath,
    get url() {
      return `ws://127.0.0.1:${self.server.port}/ws`;
    },
    async restart(extra = {}) {
      const port = self.server.port;
      await self.server.close();
      self.server = await createServer(port, '127.0.0.1', { databasePath, ...options, ...extra });
    },
    async client(replica, board = 'test-board', store = new MemoryStore()) {
      const engine = new SyncEngine({
        board,
        replica,
        store,
        connect: () => new WebSocket(self.url) as unknown as SocketLike,
        flushMs: 5,
        presenceMs: 5,
      });
      engines.push(engine);
      await engine.start();
      await until(() => engine.getSnapshot().status === 'online');
      return engine;
    },
    async dispose() {
      await Promise.all(engines.map((engine) => engine.stop()));
      await self.server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return self;
}

export async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met: ${condition.toString()}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A socket that speaks raw frames, for what a well-behaved engine would never send. */
export async function rawSocket(url: string): Promise<{
  socket: WebSocket;
  received: unknown[];
  closed: Promise<number>;
}> {
  const socket = new WebSocket(url);
  const received: unknown[] = [];
  socket.on('message', (data) => received.push(JSON.parse(String(data))));
  const closed = new Promise<number>((resolve) => socket.on('close', resolve));
  await new Promise((resolve) => socket.once('open', resolve));
  return { socket, received, closed };
}

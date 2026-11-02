import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hlcFromWallTime } from '@inkmesh/crdt';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  isValidBoardId,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '@inkmesh/protocol';
import sirv from 'sirv';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { Room, type Peer } from './room.js';
import { BoardStore } from './store.js';

export interface ServerOptions {
  readonly databasePath: string;
  /** Directory with the built web client. Omitted, the server speaks WebSocket and JSON only. */
  readonly staticDir?: string;
  /** Tombstones older than this are forgotten. */
  readonly retentionMs?: number;
  readonly compactEveryMs?: number;
  readonly heartbeatMs?: number;
  readonly log?: (message: string) => void;
}

export interface RunningServer {
  readonly port: number;
  readonly rooms: ReadonlyMap<string, Room>;
  /** Runs tombstone compaction on every loaded board now. */
  compactAll(cutoffHlc?: number): number;
  close(): Promise<void>;
}

const DEFAULT_RETENTION_MS = 30 * 24 * 3_600_000;
const DEFAULT_COMPACT_EVERY_MS = 3_600_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * Past this much unsent data a peer is cut off rather than buffered for. Reconnecting costs one
 * delta computed from version vectors, so dropping a slow reader loses nothing.
 */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_PRESENCE_BYTES = 256 * 1024;

const CLOSE_POLICY = 1008;

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

export async function createServer(
  port: number,
  host: string,
  options: ServerOptions,
): Promise<RunningServer> {
  const log = options.log ?? (() => {});
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const store = new BoardStore(options.databasePath);
  const rooms = new Map<string, Room>();
  const serveStatic = options.staticDir
    ? sirv(options.staticDir, { single: true, etag: true })
    : null;

  const defaultCutoff = () => hlcFromWallTime(Date.now() - retentionMs);

  const openRoom = (board: string): Room => {
    let room = rooms.get(board);
    if (!room) {
      room = new Room(board, store);
      // Idle boards are not in memory for the periodic pass, so catch up on load.
      room.compact(defaultCutoff());
      rooms.set(board, room);
    }
    return room;
  };

  const http: Server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      writeJson(response, 200, { ok: true, boards: rooms.size });
      return;
    }
    const match = /^\/api\/boards\/([^/]+)\/stats$/.exec(url.pathname);
    if (match) {
      const board = match[1] as string;
      if (!isValidBoardId(board)) {
        writeJson(response, 400, { error: 'invalid board id' });
        return;
      }
      writeJson(response, 200, { board, ...store.stats(board) });
      return;
    }
    if (serveStatic) {
      serveStatic(request, response, () => writeJson(response, 404, { error: 'not found' }));
      return;
    }
    writeJson(response, 404, { error: 'not found' });
  });

  const sockets = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: MAX_MESSAGE_BYTES,
  });
  const alive = new WeakSet<WebSocket>();

  sockets.on('connection', (socket) => {
    alive.add(socket);
    let room: Room | null = null;
    let peer: Peer | null = null;

    const refuse = (reason: string) => {
      socket.send(JSON.stringify({ type: 'error', reason } satisfies ServerMessage));
      socket.close(CLOSE_POLICY, reason);
    };

    const handle = (message: ClientMessage) => {
      if (message.type === 'ping') {
        send(socket, { type: 'pong' });
        return;
      }
      if (message.type === 'hello') {
        if (message.protocol !== PROTOCOL_VERSION) {
          refuse(`protocol ${message.protocol} is not supported`);
          return;
        }
        if (peer) {
          // A client asking to resync on the socket it already holds.
          room?.join(peer, message.versions);
          return;
        }
        room = openRoom(message.board);
        peer = createPeer(socket, message.replica);
        room.join(peer, message.versions);
        return;
      }
      if (!room || !peer) {
        refuse('hello must come first');
        return;
      }
      if (message.type === 'presence') {
        room.receivePresence(peer, message.presence);
      } else if (message.delta.full) {
        // Absence in a full state deletes records, which no client is entitled to do.
        refuse('clients may not send a full state');
      } else {
        room.receiveDelta(peer, message.delta);
      }
    };

    socket.on('message', (data) => {
      const message = parseClientMessage(rawToString(data));
      if (!message) {
        refuse('malformed message');
        return;
      }
      try {
        handle(message);
      } catch (error) {
        log(`failed to handle ${message.type}: ${String(error)}`);
        socket.close(1011, 'internal error');
      }
    });

    socket.on('pong', () => alive.add(socket));
    socket.on('error', (error) => log(`socket error: ${error.message}`));
    socket.on('close', () => {
      if (!room || !peer) return;
      room.leave(peer);
      if (room.size === 0) rooms.delete(room.board);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  const compactAll = (cutoffHlc = defaultCutoff()): number => {
    let removed = 0;
    for (const room of rooms.values()) removed += room.compact(cutoffHlc);
    if (removed > 0) log(`compacted ${removed} tombstones`);
    return removed;
  };
  const compaction = setInterval(
    () => compactAll(),
    options.compactEveryMs ?? DEFAULT_COMPACT_EVERY_MS,
  );

  await new Promise<void>((resolve) => http.listen(port, host, resolve));

  return {
    port: (http.address() as AddressInfo).port,
    rooms,
    compactAll,
    async close() {
      clearInterval(heartbeat);
      clearInterval(compaction);
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      store.close();
    },
  };
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function createPeer(socket: WebSocket, replica: string): Peer {
  return {
    replica,
    presence: null,
    send(message) {
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.terminate();
        return;
      }
      send(socket, message);
    },
    sendVolatile(message) {
      if (socket.bufferedAmount <= MAX_BUFFERED_PRESENCE_BYTES) send(socket, message);
    },
    disconnect(code, reason) {
      socket.close(code, reason);
    },
  };
}

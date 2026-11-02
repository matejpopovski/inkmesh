import {
  RecordDoc,
  joinVectors,
  type DocOptions,
  type Entry,
  type VersionVector,
} from '@inkmesh/crdt';
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type Presence,
  type ServerMessage,
} from '@inkmesh/protocol';
import type { LocalStore } from './local-store.js';

/** The part of the WebSocket API the engine needs, so tests and Node can supply their own. */
export interface SocketLike {
  onopen: ((event: never) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: never) => void) | null;
  onerror: ((event: never) => void) | null;
  send(data: string): void;
  close(): void;
}

export type ConnectionStatus = 'offline' | 'connecting' | 'online';

export interface EngineOptions {
  readonly board: string;
  readonly replica: string;
  readonly store: LocalStore;
  readonly connect: () => SocketLike;
  readonly doc?: DocOptions;
  /** How long edits gather before a save and a push. Coalesces a drag into one register. */
  readonly flushMs?: number;
  readonly presenceMs?: number;
  readonly heartbeatMs?: number;
}

export interface EngineSnapshot {
  readonly status: ConnectionStatus;
  /** Records with changes the server has not acknowledged. */
  readonly unsent: number;
  readonly peers: ReadonlyMap<string, Presence>;
}

const MAX_BACKOFF_MS = 10_000;
const BASE_BACKOFF_MS = 250;

/**
 * Keeps one replica in step with the server and with local storage.
 *
 * Edits never wait for the network: they land in the document, and a timer later writes them to
 * the store and pushes whatever the server has not seen. Because a push is computed from version
 * vectors rather than from a queue of operations, being offline for a week and being offline for
 * a second are the same code path.
 */
export class SyncEngine {
  readonly doc: RecordDoc;

  private readonly dirty = new Set<string>();
  private readonly peers = new Map<string, Presence>();
  private readonly listeners = new Set<() => void>();
  private readonly flushMs: number;
  private readonly presenceMs: number;
  private readonly heartbeatMs: number;

  private socket: SocketLike | null = null;
  private status: ConnectionStatus = 'offline';
  private wantOnline = false;
  private stopped = false;
  private attempts = 0;
  private synced = false;
  private awaitingPong = false;
  private unsent = 0;
  private snapshot: EngineSnapshot;
  /** The newest state the server has confirmed. Edits beyond it count as unsent. */
  private acked: VersionVector = {};
  /** `acked` plus everything already handed to the socket. */
  private sent: VersionVector = {};
  private presence: Presence | null = null;
  private presenceDirty = false;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly options: EngineOptions) {
    this.flushMs = options.flushMs ?? 40;
    this.presenceMs = options.presenceMs ?? 50;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.doc = new RecordDoc(options.replica, {
      ...options.doc,
      onRecordChange: (id) => {
        this.dirty.add(id);
        options.doc?.onRecordChange?.(id);
        this.scheduleFlush();
      },
    });
    this.snapshot = { status: this.status, unsent: 0, peers: this.peers };
  }

  /** Restores the local copy, then goes online. Editing is possible as soon as this resolves. */
  async start(online = true): Promise<void> {
    const stored = await this.options.store.load();
    if (stored) {
      this.doc.applyDelta(stored);
      // Everything just read is already in the store.
      this.dirty.clear();
    }
    this.notify();
    this.setOnline(online);
  }

  /** Tracks the browser's online state. Going offline drops the socket straight away. */
  setOnline(online: boolean): void {
    if (this.stopped || online === this.wantOnline) return;
    this.wantOnline = online;
    if (online) {
      this.attempts = 0;
      this.connect();
    } else {
      this.clearReconnect();
      this.dropSocket();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wantOnline = false;
    this.clearReconnect();
    this.dropSocket();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    await this.persist();
  }

  /** Writes pending changes to the store now, for a page that is about to go away. */
  flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.push();
    return this.persist();
  }

  updatePresence(presence: Presence): void {
    this.presence = presence;
    this.presenceDirty = true;
    this.presenceTimer ??= setTimeout(() => {
      this.presenceTimer = null;
      this.sendPresence();
    }, this.presenceMs);
  }

  /** Records the server has not acknowledged yet, computed now rather than at the last flush. */
  pending(): number {
    return this.doc.deltaSince(this.acked).entries.length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A stable object until something changes, as `useSyncExternalStore` requires. */
  getSnapshot = (): EngineSnapshot => this.snapshot;

  private notify(): void {
    this.snapshot = { status: this.status, unsent: this.unsent, peers: new Map(this.peers) };
    for (const listener of this.listeners) listener();
  }

  private connect(): void {
    if (this.socket || this.stopped || !this.wantOnline) return;
    this.setStatus('connecting');
    const socket = this.options.connect();
    this.socket = socket;

    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.sendHello();
      this.startHeartbeat();
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      this.awaitingPong = false;
      const message = typeof event.data === 'string' ? parseServerMessage(event.data) : null;
      if (message) this.receive(message);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.afterDisconnect();
      this.scheduleReconnect();
    };
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.afterDisconnect();
  }

  private afterDisconnect(): void {
    this.synced = false;
    this.stopHeartbeat();
    this.peers.clear();
    // "Offline" is a promise that the browser has no network. A lost server is a retry in
    // progress, and telling the two apart is the point of the status stamp.
    this.setStatus(this.wantOnline ? 'connecting' : 'offline');
    this.notify();
  }

  private scheduleReconnect(): void {
    if (!this.wantOnline || this.stopped || this.reconnectTimer) return;
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempts);
    this.attempts++;
    // Full jitter, so a server restart does not bring every client back in the same instant.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.heartbeatTimer = setInterval(() => {
      // A dead network often closes nothing, so silence is the only reliable signal.
      if (this.awaitingPong) {
        const socket = this.socket;
        this.socket = null;
        socket?.close();
        this.afterDisconnect();
        this.scheduleReconnect();
        return;
      }
      this.awaitingPong = true;
      this.send({ type: 'ping' });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendHello(): void {
    this.synced = false;
    this.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      board: this.options.board,
      replica: this.options.replica,
      versions: this.doc.versions,
    });
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        const result = this.doc.applyDelta(message.delta);
        if (result.status === 'gap') {
          this.sendHello();
          return;
        }
        this.acked = message.delta.upto;
        this.sent = message.delta.upto;
        this.synced = true;
        this.attempts = 0;
        this.peers.clear();
        for (const peer of message.peers) this.peers.set(peer.replica, peer.presence);
        this.setStatus('online');
        this.presenceDirty = this.presence !== null;
        this.sendPresence();
        this.push();
        this.refreshUnsent();
        break;
      }
      case 'delta': {
        const result = this.doc.applyDelta(message.delta);
        if (result.status === 'gap') {
          this.sendHello();
          return;
        }
        this.acked = joinVectors(this.acked, message.delta.upto);
        this.sent = joinVectors(this.sent, message.delta.upto);
        break;
      }
      case 'ack':
        this.acked = joinVectors(this.acked, message.versions);
        this.refreshUnsent();
        break;
      case 'compacted':
        this.doc.adoptFloor(message.floor);
        break;
      case 'resync':
        this.sendHello();
        break;
      case 'presence':
        this.peers.set(message.replica, message.presence);
        this.notify();
        break;
      case 'left':
        this.peers.delete(message.replica);
        this.notify();
        break;
      case 'pong':
        break;
      case 'error':
        // Retrying a refused handshake would only be refused again.
        this.wantOnline = false;
        this.dropSocket();
        break;
    }
  }

  private scheduleFlush(): void {
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      this.push();
      void this.persist();
      this.refreshUnsent();
    }, this.flushMs);
  }

  private push(): void {
    if (!this.synced) return;
    const delta = this.doc.deltaSince(this.sent);
    if (delta.entries.length === 0) return;
    this.sent = delta.upto;
    this.send({ type: 'delta', delta });
  }

  private persist(): Promise<void> {
    if (this.dirty.size === 0) return this.saving;
    const records: Entry[] = [];
    const removed: string[] = [];
    for (const id of this.dirty) {
      const record = this.doc.exportRecord(id);
      if (record) records.push(record);
      else removed.push(id);
    }
    this.dirty.clear();

    const changes = {
      records,
      removed,
      versions: this.doc.versions,
      floor: this.doc.floor,
    };
    // One save at a time: transactions finishing out of order could store an older vector.
    this.saving = this.saving.then(() => this.options.store.save(changes));
    return this.saving;
  }

  private refreshUnsent(): void {
    const unsent = this.pending();
    if (unsent === this.unsent) return;
    this.unsent = unsent;
    this.notify();
  }

  private sendPresence(): void {
    if (!this.synced || !this.presence || !this.presenceDirty) return;
    this.presenceDirty = false;
    this.send({ type: 'presence', presence: this.presence });
  }

  private send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.notify();
  }
}

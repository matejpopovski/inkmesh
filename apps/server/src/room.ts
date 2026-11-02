import { RecordDoc, dominates, type Delta } from '@inkmesh/crdt';
import type { Presence, ServerMessage } from '@inkmesh/protocol';
import type { BoardStore } from './store.js';

/** One connected replica, as the room sees it. Sockets stay out of this file for testability. */
export interface Peer {
  readonly replica: string;
  presence: Presence | null;
  send(message: ServerMessage): void;
  /** Sends a message that can be dropped when the connection is falling behind. */
  sendVolatile(message: ServerMessage): void;
  disconnect(code: number, reason: string): void;
}

/** A board held in memory with the replicas currently connected to it. */
export class Room {
  private readonly peers = new Map<string, Peer>();
  private readonly touched = new Set<string>();
  readonly doc: RecordDoc;

  constructor(
    readonly board: string,
    private readonly store: BoardStore,
  ) {
    this.doc = new RecordDoc('server', { onRecordChange: (id) => this.touched.add(id) });
    const stored = store.load(board);
    if (stored) this.doc.applyDelta(stored);
    this.touched.clear();
  }

  get size(): number {
    return this.peers.size;
  }

  join(peer: Peer, versions: Delta['upto']): void {
    // A reconnect can arrive before the old socket has timed out. Two sockets for one replica
    // would double its cursor and race its pushes, so the newcomer takes over.
    this.peers.get(peer.replica)?.disconnect(4001, 'replaced by a newer connection');
    this.peers.set(peer.replica, peer);

    const others = [...this.peers.values()].filter((other) => other !== peer);
    peer.send({
      type: 'welcome',
      delta: this.doc.syncFor(versions),
      peers: others.flatMap((other) =>
        other.presence ? [{ replica: other.replica, presence: other.presence }] : [],
      ),
    });
  }

  leave(peer: Peer): void {
    if (this.peers.get(peer.replica) !== peer) return;
    this.peers.delete(peer.replica);
    this.forEachOther(peer, (other) => other.send({ type: 'left', replica: peer.replica }));
  }

  receiveDelta(peer: Peer, delta: Delta): void {
    const before = this.doc.versions;
    const result = this.doc.applyDelta(delta);
    if (result.status === 'gap') {
      peer.send({ type: 'resync' });
      return;
    }

    // Durable before anyone hears about it. A client treats an ack as permission to stop
    // re-offering a change, and peers must never see an edit a crash could still erase.
    this.persist();
    peer.send({ type: 'ack', versions: this.doc.versions });

    if (result.changed.length === 0 && dominates(before, this.doc.versions)) return;
    const forward: ServerMessage = {
      type: 'delta',
      delta: {
        since: before,
        upto: this.doc.versions,
        floor: this.doc.floor,
        entries: result.changed,
      },
    };
    this.forEachOther(peer, (other) => other.send(forward));
  }

  receivePresence(peer: Peer, presence: Presence): void {
    peer.presence = presence;
    const message: ServerMessage = { type: 'presence', replica: peer.replica, presence };
    this.forEachOther(peer, (other) => other.sendVolatile(message));
  }

  /** Forgets tombstones at or before `cutoffHlc`. Returns how many records were dropped. */
  compact(cutoffHlc: number): number {
    const removed = this.doc.compact(cutoffHlc);
    if (removed.length === 0) return 0;
    this.persist();
    for (const peer of this.peers.values()) peer.send({ type: 'compacted', floor: this.doc.floor });
    return removed.length;
  }

  private persist(): void {
    this.store.save(this.board, this.doc, this.touched);
    this.touched.clear();
  }

  private forEachOther(peer: Peer, visit: (other: Peer) => void): void {
    for (const other of this.peers.values()) {
      if (other !== peer) visit(other);
    }
  }
}

import { IndexedDbStore, SyncEngine, claimReplicaId, type SocketLike } from '@inkmesh/sync';
import { BoardController } from './board/controller';
import { inkForReplica, randomDisplayName } from './board/names';

const NAME_KEY = 'inkmesh.name';

export interface Session {
  readonly board: string;
  readonly engine: SyncEngine;
  readonly controller: BoardController;
  readonly name: string;
  readonly ink: string;
  /** Subscribes to document changes, for the canvas. */
  onDocumentChange(listener: () => void): () => void;
}

function socketUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

function displayName(): string {
  const stored = localStorage.getItem(NAME_KEY);
  if (stored) return stored;
  const created = randomDisplayName();
  localStorage.setItem(NAME_KEY, created);
  return created;
}

/** Opens a board from local storage and starts syncing. Works with no network at all. */
export async function openSession(board: string): Promise<Session> {
  const replica = await claimReplicaId(localStorage);
  const listeners = new Set<() => void>();
  const engine = new SyncEngine({
    board,
    replica,
    store: new IndexedDbStore(board),
    connect: () => new WebSocket(socketUrl()) as unknown as SocketLike,
    doc: {
      onRecordChange: () => {
        for (const listener of listeners) listener();
      },
    },
  });
  await engine.start(navigator.onLine);

  window.addEventListener('online', () => engine.setOnline(true));
  window.addEventListener('offline', () => engine.setOnline(false));
  // IndexedDB writes are not guaranteed to finish once a page starts unloading, so the last
  // chance that is reliable is the moment the page stops being visible.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void engine.flush();
  });
  window.addEventListener('pagehide', () => void engine.flush());

  return {
    board,
    engine,
    controller: new BoardController(engine.doc),
    name: displayName(),
    ink: inkForReplica(replica),
    onDocumentChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

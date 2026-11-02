import {
  covers,
  creationStamp,
  dominates,
  joinEntries,
  joinVectors,
  type Delta,
  type Entry,
  type VersionVector,
} from '@inkmesh/crdt';
import type { LocalStore, StoreChanges } from './local-store.js';

const DATABASE = 'inkmesh';
const RECORDS = 'records';
const BOARDS = 'boards';

interface BoardRow {
  readonly board: string;
  readonly versions: VersionVector;
  readonly floor: VersionVector;
}

interface RecordRow {
  readonly board: string;
  readonly id: string;
  readonly entry: Entry;
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(BOARDS, { keyPath: 'board' });
    request.result.createObjectStore(RECORDS, { keyPath: ['board', 'id'] });
  };
  return requested(request);
}

/**
 * One board in IndexedDB, one row per record, so a keystroke rewrites a row rather than the board.
 *
 * Two tabs of the same browser share this store but are different replicas. Each write therefore
 * joins with what is already stored instead of overwriting it, which makes the store behave like
 * one more replica and means neither tab can lose the other's offline edits.
 */
export class IndexedDbStore implements LocalStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly board: string,
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  async load(): Promise<Delta | null> {
    const database = await this.open();
    const transaction = database.transaction([BOARDS, RECORDS], 'readonly');
    const row = (await requested(transaction.objectStore(BOARDS).get(this.board))) as
      BoardRow | undefined;
    if (!row) return null;
    const range = IDBKeyRange.bound([this.board], [this.board, []]);
    const rows = (await requested(transaction.objectStore(RECORDS).getAll(range))) as RecordRow[];
    return {
      since: {},
      upto: row.versions,
      floor: row.floor,
      entries: rows.map((record) => record.entry),
      full: true,
    };
  }

  async save(changes: StoreChanges): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction([BOARDS, RECORDS], 'readwrite');
    const boards = transaction.objectStore(BOARDS);
    const records = transaction.objectStore(RECORDS);

    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    const stored = (await requested(boards.get(this.board))) as BoardRow | undefined;
    const known = stored?.versions ?? {};
    const floor = joinVectors(stored?.floor ?? {}, changes.floor);

    for (const entry of changes.records) {
      const key = [this.board, entry.id];
      const row = (await requested(records.get(key))) as RecordRow | undefined;
      // Absent but covered: another tab compacted this record away.
      if (!row && covers(known, creationStamp(entry.id))) continue;
      const joined = row ? joinEntries(row.entry, entry) : entry;
      records.put({ board: this.board, id: entry.id, entry: joined } satisfies RecordRow);
    }
    for (const id of changes.removed) records.delete([this.board, id]);

    const versions = joinVectors(known, changes.versions);
    if (!stored || !dominates(stored.versions, versions) || !dominates(stored.floor, floor)) {
      boards.put({ board: this.board, versions, floor } satisfies BoardRow);
    }
    await done;
  }

  close(): void {
    void this.database?.then((database) => database.close());
    this.database = null;
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= open(this.factory);
    return this.database;
  }
}

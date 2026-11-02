import Database from 'better-sqlite3';
import type { Delta, Entry, RecordDoc, VersionVector } from '@inkmesh/crdt';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS boards (
    id         TEXT PRIMARY KEY,
    versions   TEXT NOT NULL,
    floor      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS records (
    board_id  TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    record_id TEXT NOT NULL,
    entry     TEXT NOT NULL,
    PRIMARY KEY (board_id, record_id)
  ) WITHOUT ROWID;
`;

interface BoardRow {
  versions: string;
  floor: string;
}

export interface BoardStats {
  readonly records: number;
  readonly bytes: number;
}

/**
 * SQLite persistence, one row per record.
 *
 * WAL with synchronous=NORMAL survives a process crash, which is the failure this server has to
 * tolerate: an edit acknowledged to a client can only be lost if the machine itself dies, and in
 * that case the client still holds the edit and pushes it again, because the restored server's
 * version vector will not cover it.
 */
export class BoardStore {
  private readonly db: Database.Database;
  private readonly upsertBoard: Database.Statement;
  private readonly upsertRecord: Database.Statement;
  private readonly deleteRecord: Database.Statement;
  private readonly selectBoard: Database.Statement;
  private readonly selectRecords: Database.Statement;
  private readonly selectStats: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);

    this.upsertBoard = this.db.prepare(`
      INSERT INTO boards (id, versions, floor, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        versions = excluded.versions, floor = excluded.floor, updated_at = excluded.updated_at
    `);
    this.upsertRecord = this.db.prepare(`
      INSERT INTO records (board_id, record_id, entry) VALUES (?, ?, ?)
      ON CONFLICT (board_id, record_id) DO UPDATE SET entry = excluded.entry
    `);
    this.deleteRecord = this.db.prepare('DELETE FROM records WHERE board_id = ? AND record_id = ?');
    this.selectBoard = this.db.prepare('SELECT versions, floor FROM boards WHERE id = ?');
    this.selectRecords = this.db.prepare('SELECT entry FROM records WHERE board_id = ?');
    this.selectStats = this.db.prepare(
      'SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(entry)), 0) AS bytes FROM records WHERE board_id = ?',
    );
  }

  /** The stored board as a full state, ready for `applyDelta`, or null if it does not exist. */
  load(board: string): Delta | null {
    const row = this.selectBoard.get(board) as BoardRow | undefined;
    if (!row) return null;
    const rows = this.selectRecords.all(board) as { entry: string }[];
    return {
      since: {},
      upto: JSON.parse(row.versions) as VersionVector,
      floor: JSON.parse(row.floor) as VersionVector,
      entries: rows.map((record) => JSON.parse(record.entry) as Entry),
      full: true,
    };
  }

  /** Writes the touched records and the version vector in one transaction. */
  save(board: string, doc: RecordDoc, touched: Iterable<string>): void {
    this.saveTransaction(board, doc, touched);
  }

  stats(board: string): BoardStats {
    return this.selectStats.get(board) as BoardStats;
  }

  close(): void {
    this.db.close();
  }

  private readonly saveTransaction = (board: string, doc: RecordDoc, touched: Iterable<string>) => {
    this.db.transaction(() => {
      // The board row comes first so that the foreign key holds for a brand new board. A crash
      // cannot separate the two: a vector stored without its records would claim data the
      // server does not have, and clients would never send it again.
      this.upsertBoard.run(
        board,
        JSON.stringify(doc.versions),
        JSON.stringify(doc.floor),
        Date.now(),
      );
      for (const id of touched) {
        const entry = doc.exportRecord(id);
        if (entry) this.upsertRecord.run(board, id, JSON.stringify(entry));
        else this.deleteRecord.run(board, id);
      }
    })();
  };
}

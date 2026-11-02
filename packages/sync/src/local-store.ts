import type { Delta, Entry, VersionVector } from '@inkmesh/crdt';

export interface StoreChanges {
  readonly records: readonly Entry[];
  readonly removed: readonly string[];
  readonly versions: VersionVector;
  readonly floor: VersionVector;
}

/** Where a replica keeps its state between page loads. */
export interface LocalStore {
  /** The stored board as a full state, or null when this device has never seen it. */
  load(): Promise<Delta | null>;
  save(changes: StoreChanges): Promise<void>;
}

/** Keeps nothing past the process. Used by tests and by non-browser clients. */
export class MemoryStore implements LocalStore {
  private readonly records = new Map<string, Entry>();
  private versions: VersionVector = {};
  private floor: VersionVector = {};
  saves = 0;

  async load(): Promise<Delta | null> {
    if (this.records.size === 0 && Object.keys(this.versions).length === 0) return null;
    return {
      since: {},
      upto: this.versions,
      floor: this.floor,
      entries: [...this.records.values()],
      full: true,
    };
  }

  async save(changes: StoreChanges): Promise<void> {
    this.saves++;
    for (const record of changes.records) this.records.set(record.id, record);
    for (const id of changes.removed) this.records.delete(id);
    this.versions = changes.versions;
    this.floor = changes.floor;
  }
}

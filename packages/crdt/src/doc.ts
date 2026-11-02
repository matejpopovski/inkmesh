import { HybridClock } from './clock.js';
import { jitteredKeyBetween, type Random } from './order-key.js';
import { compareStamps, isValidReplicaId, type ReplicaId, type Stamp } from './stamp.js';
import { covers, dominates, joinVectors, maxTime, type VersionVector } from './version-vector.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Fields = Record<string, Json>;

/** A last-writer-wins register: its value and the stamp of the write that set it. */
export type Register = readonly [value: Json, hlc: number, replica: ReplicaId];

/**
 * Every delete of one record that a replica has seen, in stamp order. Keeping only the newest
 * stamp looks sufficient but strands tombstones: if two replicas delete concurrently and one
 * compacts its own stamp, the other holds a stamp the floor will never cover.
 */
export type Tombstone = readonly Stamp[];

/**
 * One record's contribution to a sync message. A tombstone travels without registers: deletion is
 * terminal, so nothing else about the record can matter to the receiver.
 */
export interface Entry {
  readonly id: string;
  readonly regs?: Readonly<Record<string, Register>>;
  readonly tomb?: Tombstone;
}

export interface Delta {
  /** The receiver must have seen at least this much, or the entries leave a gap in its history. */
  readonly since: VersionVector;
  /** What the receiver has seen once the delta is applied. */
  readonly upto: VersionVector;
  /** Tombstones at or below this vector have been forgotten by the sender. */
  readonly floor: VersionVector;
  readonly entries: readonly Entry[];
  /** Set when `entries` is the sender's whole state, so absence carries meaning. */
  readonly full?: true;
}

export type ApplyResult =
  | { readonly status: 'gap' }
  | {
      readonly status: 'applied';
      /** The parts of the incoming entries that won; exactly what other peers still need. */
      readonly changed: readonly Entry[];
      /** Records forgotten here because the sender had compacted them. */
      readonly removed: readonly string[];
    };

export interface LiveRecord {
  readonly id: string;
  readonly z: string;
  readonly fields: Readonly<Fields>;
}

export interface DocStats {
  readonly live: number;
  readonly tombstones: number;
  readonly registers: number;
  readonly replicas: number;
}

export interface DocOptions {
  readonly now?: () => number;
  readonly random?: Random;
  /** Called once for every record touched by a local write, a merge or compaction. */
  readonly onRecordChange?: (id: string) => void;
}

export type Reorder = 'front' | 'back' | 'forward' | 'backward';

interface RecordState {
  regs: Record<string, Register>;
  tomb: Tombstone | null;
  view: LiveRecord | null;
}

const Z_FIELD = 'z';
const NO_VERSIONS: VersionVector = {};

/**
 * A record's id is the stamp of its creation. That lets any replica answer "have I ever seen this
 * record?" from its version vector alone, which is what makes compaction work without keeping a
 * list of forgotten ids.
 */
function recordId(stamp: Stamp): string {
  return `${stamp[1]}.${stamp[0].toString(36)}`;
}

export function creationStamp(id: string): Stamp {
  const separator = id.lastIndexOf('.');
  const hlc = Number.parseInt(id.slice(separator + 1), 36);
  return [hlc, id.slice(0, separator)];
}

function registerStamp(register: Register): Stamp {
  return [register[1], register[2]];
}

function compareRecords(a: LiveRecord, b: LiveRecord): number {
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * The replicated state of a set of ordered records.
 *
 * Each record moves up a small lattice: unseen, then live (a product of LWW registers), then
 * deleted (a tombstone), then forgotten (compacted away). Join always moves up, so merges commute
 * and repeat safely, and compaction is just another upward step. "Forgotten" takes no storage
 * because it is represented by absence plus a version vector that covers the record's id.
 */
export class RecordDoc {
  readonly replica: ReplicaId;
  private readonly clock: HybridClock;
  private readonly random: Random;
  private readonly onRecordChange: ((id: string) => void) | undefined;
  private readonly records = new Map<string, RecordState>();
  private versionVector: VersionVector = NO_VERSIONS;
  private floorVector: VersionVector = NO_VERSIONS;
  /** Live ids from bottom to top. Survives field writes, so only reordering pays for a sort. */
  private order: string[] | null = null;
  private listed: LiveRecord[] | null = null;

  constructor(replica: ReplicaId, options: DocOptions = {}) {
    if (!isValidReplicaId(replica)) throw new RangeError(`invalid replica id: ${replica}`);
    this.replica = replica;
    this.clock = new HybridClock(options.now);
    this.random = options.random ?? Math.random;
    this.onRecordChange = options.onRecordChange;
  }

  get versions(): VersionVector {
    return this.versionVector;
  }

  get floor(): VersionVector {
    return this.floorVector;
  }

  /** Creates a record on top of the stack, or at `z` when restoring an earlier position. */
  create(fields: Fields, z?: string): string {
    const stamp = this.issueStamp();
    const id = recordId(stamp);
    const order = this.sortedIds();
    const key = z ?? jitteredKeyBetween(this.topKey(order), null, this.random);
    const regs: Record<string, Register> = { [Z_FIELD]: [key, stamp[0], stamp[1]] };
    for (const name of Object.keys(fields)) {
      regs[name] = [fields[name] as Json, stamp[0], stamp[1]];
    }
    this.records.set(id, { regs, tomb: null, view: null });
    if (z === undefined) order.push(id);
    else this.order = null;
    this.listed = null;
    this.onRecordChange?.(id);
    return id;
  }

  /** Writes fields as one stamp. Returns false when the record is gone or unknown. */
  set(id: string, patch: Fields): boolean {
    const record = this.records.get(id);
    if (!record || record.tomb) return false;
    const stamp = this.issueStamp();
    for (const name of Object.keys(patch)) {
      record.regs[name] = [patch[name] as Json, stamp[0], stamp[1]];
    }
    if (Z_FIELD in patch) this.order = null;
    this.touch(id, record);
    return true;
  }

  /**
   * Deletes a record for good. Delete wins over any concurrent edit and there is no undelete: a
   * reversible `deleted` flag would let a restore race with compaction. Undo re-creates the
   * record under a new id instead.
   */
  remove(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.tomb) return false;
    record.tomb = [this.issueStamp()];
    record.regs = {};
    this.dropFromOrder(id);
    this.touch(id, record);
    return true;
  }

  reorder(id: string, move: Reorder): boolean {
    const list = this.list();
    const index = list.findIndex((record) => record.id === id);
    if (index < 0) return false;
    const z = this.orderKeyFor(list, index, move);
    return z !== null && this.set(id, { [Z_FIELD]: z });
  }

  get(id: string): LiveRecord | undefined {
    const record = this.records.get(id);
    return record && !record.tomb ? this.viewOf(id, record) : undefined;
  }

  /** Live records from bottom to top. Equal order keys fall back to id, so the order is total. */
  list(): readonly LiveRecord[] {
    this.listed ??= this.sortedIds().map((id) =>
      this.viewOf(id, this.records.get(id) as RecordState),
    );
    return this.listed;
  }

  /** Whether a peer at `peerVersions` can catch up from a delta, or needs the whole state. */
  syncFor(peerVersions: VersionVector): Delta {
    return dominates(peerVersions, this.floorVector)
      ? this.deltaSince(peerVersions)
      : this.fullState();
  }

  /**
   * Every register and tombstone a peer at `since` has not seen. Overwritten values no longer
   * exist here, so a thousand drags of one shape cost one register, not a thousand operations.
   *
   * Callers must go through `syncFor` unless the peer is known to cover `floor`: a delta cannot
   * express a forgotten record, so a peer below the floor would keep it forever.
   */
  deltaSince(since: VersionVector): Delta {
    const entries: Entry[] = [];
    for (const [id, record] of this.records) {
      const entry = unseenPart(id, record, since);
      if (entry) entries.push(entry);
    }
    return { since, upto: this.versionVector, floor: this.floorVector, entries };
  }

  fullState(): Delta {
    return { ...this.deltaSince(NO_VERSIONS), full: true };
  }

  /** The complete replicated state of one record, including its tombstone if it has one. */
  exportRecord(id: string): Entry | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    return record.tomb ? { id, tomb: record.tomb } : { id, regs: { ...record.regs } };
  }

  applyDelta(delta: Delta): ApplyResult {
    if (!delta.full && !dominates(this.versionVector, delta.since)) return { status: 'gap' };

    const changed: Entry[] = [];
    for (const entry of delta.entries) {
      const won = this.mergeEntry(entry);
      if (won) changed.push(won);
    }

    const removed: string[] = [];
    if (delta.full) {
      const present = new Set(delta.entries.map((entry) => entry.id));
      for (const id of this.records.keys()) {
        // The sender has seen this record and does not hold it, so it compacted the tombstone.
        if (!present.has(id) && covers(delta.upto, creationStamp(id))) {
          this.forget(id);
          removed.push(id);
        }
      }
    }

    this.versionVector = joinVectors(this.versionVector, delta.upto);
    // Most deltas leave the floor alone, and scanning every record for each one would make a
    // keystroke cost time proportional to the board. Then only a new tombstone can be below it.
    const floorMoved = !dominates(this.floorVector, delta.floor);
    this.floorVector = joinVectors(this.floorVector, delta.floor);
    if (floorMoved) this.purgeBelowFloor(removed);
    else this.purgeEntries(changed, removed);
    this.clock.observe(maxTime(delta.upto));
    return { status: 'applied', changed, removed };
  }

  /**
   * Forgets tombstones issued at or before `cutoffHlc` and raises the floor to match. Any peer
   * that has not seen one of them falls below the floor and receives a full state on next sync.
   */
  compact(cutoffHlc: number): readonly string[] {
    const floor: Record<ReplicaId, number> = { ...this.floorVector };
    for (const record of this.records.values()) {
      for (const [hlc, replica] of record.tomb ?? []) {
        if (hlc <= cutoffHlc) floor[replica] = Math.max(floor[replica] ?? 0, hlc);
      }
    }
    this.floorVector = floor;
    const removed: string[] = [];
    this.purgeBelowFloor(removed);
    return removed;
  }

  /** Adopts a floor announced by a peer that compacted, dropping the same tombstones here. */
  adoptFloor(floor: VersionVector): readonly string[] {
    this.floorVector = joinVectors(this.floorVector, floor);
    const removed: string[] = [];
    this.purgeBelowFloor(removed);
    return removed;
  }

  stats(): DocStats {
    let live = 0;
    let tombstones = 0;
    let registers = 0;
    for (const record of this.records.values()) {
      if (record.tomb) tombstones++;
      else live++;
      registers += Object.keys(record.regs).length;
    }
    return { live, tombstones, registers, replicas: Object.keys(this.versionVector).length };
  }

  /** What a user can see, in a canonical form. Equal strings mean identical boards. */
  visibleState(): string {
    const live = this.list().map((record) => ({
      id: record.id,
      z: record.z,
      fields: sortKeys(record.fields),
    }));
    return JSON.stringify(live);
  }

  /** All replicated state in a canonical form, tombstones and version vectors included. */
  canonicalState(): string {
    const entries = [...this.records.keys()]
      .sort()
      .map((id) => this.exportRecord(id))
      .map((entry) => ({ ...entry, regs: sortKeys(entry?.regs ?? {}) }));
    return JSON.stringify({
      versions: sortKeys(this.versionVector),
      floor: sortKeys(this.floorVector),
      entries,
    });
  }

  private issueStamp(): Stamp {
    const hlc = this.clock.tick();
    this.versionVector = { ...this.versionVector, [this.replica]: hlc };
    return [hlc, this.replica];
  }

  private sortedIds(): string[] {
    if (!this.order) {
      const live: LiveRecord[] = [];
      for (const [id, record] of this.records) {
        if (!record.tomb) live.push(this.viewOf(id, record));
      }
      this.order = live.sort(compareRecords).map((record) => record.id);
    }
    return this.order;
  }

  private topKey(order: readonly string[]): string | null {
    const top = order.at(-1);
    return top === undefined ? null : this.viewOf(top, this.records.get(top) as RecordState).z;
  }

  private viewOf(id: string, record: RecordState): LiveRecord {
    if (!record.view) {
      const fields: Fields = {};
      for (const name of Object.keys(record.regs)) {
        if (name !== Z_FIELD) fields[name] = (record.regs[name] as Register)[0];
      }
      const z = record.regs[Z_FIELD]?.[0];
      record.view = { id, z: typeof z === 'string' ? z : '', fields };
    }
    return record.view;
  }

  private orderKeyFor(list: readonly LiveRecord[], index: number, move: Reorder): string | null {
    const last = list.length - 1;
    const keyAt = (at: number) => (list[at] as LiveRecord).z;
    switch (move) {
      case 'front':
        return index === last ? null : jitteredKeyBetween(keyAt(last), null, this.random);
      case 'back':
        return index === 0 ? null : jitteredKeyBetween(null, keyAt(0), this.random);
      case 'forward': {
        if (index === last) return null;
        const low = keyAt(index + 1);
        // Equal keys leave nothing between them, so skip past any run of them.
        const high = list.slice(index + 2).find((record) => record.z > low)?.z ?? null;
        return jitteredKeyBetween(low, high, this.random);
      }
      case 'backward': {
        if (index === 0) return null;
        const high = keyAt(index - 1);
        const low = list.slice(0, index - 1).findLast((record) => record.z < high)?.z ?? null;
        return jitteredKeyBetween(low, high, this.random);
      }
    }
  }

  private mergeEntry(entry: Entry): Entry | null {
    let record = this.records.get(entry.id);
    if (!record) {
      // Seen before but not held: its tombstone was compacted. Accepting this entry would bring
      // back a record that every other replica has forgotten.
      if (covers(this.versionVector, creationStamp(entry.id))) return null;
      record = { regs: {}, tomb: null, view: null };
      this.records.set(entry.id, record);
      this.order = null;
    }

    if (entry.tomb) {
      const merged = joinTombstones(record.tomb, entry.tomb);
      if (!merged) return null;
      record.tomb = merged;
      record.regs = {};
      this.dropFromOrder(entry.id);
      this.touch(entry.id, record);
      return { id: entry.id, tomb: merged };
    }
    if (record.tomb || !entry.regs) return null;

    let won: Record<string, Register> | undefined;
    for (const name of Object.keys(entry.regs)) {
      const incoming = entry.regs[name] as Register;
      const current = record.regs[name];
      if (!current || compareStamps(registerStamp(current), registerStamp(incoming)) < 0) {
        record.regs[name] = incoming;
        (won ??= {})[name] = incoming;
        if (name === Z_FIELD) this.order = null;
      }
    }
    if (!won) return null;
    this.touch(entry.id, record);
    return { id: entry.id, regs: won };
  }

  /**
   * Keeps the cached order valid instead of discarding it. Discarding means the next create scans
   * every record, tombstones included, which made drawing and erasing quadratic in a board's
   * lifetime. Scanning `order` is bounded by the live records alone.
   */
  private dropFromOrder(id: string): void {
    const index = this.order?.indexOf(id) ?? -1;
    if (index >= 0) this.order?.splice(index, 1);
  }

  private touch(id: string, record: RecordState): void {
    record.view = null;
    this.listed = null;
    this.onRecordChange?.(id);
  }

  private forget(id: string): void {
    this.records.delete(id);
    this.dropFromOrder(id);
    this.listed = null;
    this.onRecordChange?.(id);
  }

  private purgeEntries(entries: readonly Entry[], removed: string[]): void {
    for (const { id, tomb } of entries) {
      if (tomb?.some((stamp) => covers(this.floorVector, stamp))) {
        this.forget(id);
        removed.push(id);
      }
    }
  }

  private purgeBelowFloor(removed: string[]): void {
    for (const [id, record] of this.records) {
      if (record.tomb?.some((stamp) => covers(this.floorVector, stamp))) {
        this.forget(id);
        removed.push(id);
      }
    }
  }
}

function unseenPart(id: string, record: RecordState, since: VersionVector): Entry | null {
  if (record.tomb) {
    return record.tomb.every((stamp) => covers(since, stamp)) ? null : { id, tomb: record.tomb };
  }
  let regs: Record<string, Register> | undefined;
  for (const name of Object.keys(record.regs)) {
    const register = record.regs[name] as Register;
    if (!covers(since, registerStamp(register))) (regs ??= {})[name] = register;
  }
  return regs ? { id, regs } : null;
}

/** The union of two tombstones, or null when `incoming` adds nothing. */
function joinTombstones(current: Tombstone | null, incoming: Tombstone): Tombstone | null {
  if (!current) return incoming;
  const known = new Set(current.map((stamp) => stamp.join()));
  const fresh = incoming.filter((stamp) => !known.has(stamp.join()));
  return fresh.length > 0 ? [...current, ...fresh].sort(compareStamps) : null;
}

/** Joins two states of one record outside a document, as a local store does on write. */
export function joinEntries(a: Entry, b: Entry): Entry {
  if (a.tomb || b.tomb) {
    return { id: a.id, tomb: joinTombstones(a.tomb ?? null, b.tomb ?? []) ?? a.tomb ?? [] };
  }
  const regs: Record<string, Register> = { ...a.regs };
  for (const name of Object.keys(b.regs ?? {})) {
    const incoming = b.regs?.[name] as Register;
    const current = regs[name];
    if (!current || compareStamps(registerStamp(current), registerStamp(incoming)) < 0) {
      regs[name] = incoming;
    }
  }
  return { id: a.id, regs };
}

function sortKeys<T>(object: Readonly<Record<string, T>>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(object).sort()) sorted[key] = object[key] as T;
  return sorted;
}

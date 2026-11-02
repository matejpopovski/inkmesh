/**
 * Hybrid logical clock packed into one JavaScript number.
 *
 * A Lamport clock would let a device that stayed offline and made many edits outrank a person who
 * edited a minute ago, because its counter ran further. Using wall time as the high bits makes
 * "last write" match what people expect, while the logical bits keep the guarantee that anything a
 * replica has observed is older than what it writes next, even when clocks disagree.
 *
 * The packing is `(ms since EPOCH) * 2^12 + logical`. It stays a safe integer until 2093 and fits
 * in JSON without a bigint encoding. When more than 4096 writes land in one millisecond the
 * logical part simply carries into the millisecond bits: the clock runs slightly ahead of real
 * time and ordering is unaffected.
 */
const EPOCH_MS = Date.UTC(2024, 0, 1);
const LOGICAL_RANGE = 2 ** 12;

export class HybridClock {
  private last = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns a time strictly greater than every time this clock has issued or observed. */
  tick(): number {
    this.last = Math.max(this.last + 1, hlcFromWallTime(this.now()));
    return this.last;
  }

  /** Ratchets the clock forward so that later ticks sort after `remote`. */
  observe(remote: number): void {
    if (remote > this.last) this.last = remote;
  }

  get latest(): number {
    return this.last;
  }
}

export function hlcFromWallTime(wallMs: number): number {
  return (wallMs - EPOCH_MS) * LOGICAL_RANGE;
}

export function wallTimeFromHlc(hlc: number): number {
  return Math.floor(hlc / LOGICAL_RANGE) + EPOCH_MS;
}

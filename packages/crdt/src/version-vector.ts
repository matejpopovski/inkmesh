import type { ReplicaId, Stamp } from './stamp.js';

/**
 * For each replica, the newest hybrid time seen from it. Treated as immutable by every function
 * here. A replica's vector only ever describes a causally closed cut of history, because deltas
 * are applied atomically and refused when they would leave a gap.
 */
export type VersionVector = Readonly<Record<ReplicaId, number>>;

export function covers(vector: VersionVector, stamp: Stamp): boolean {
  const seen = vector[stamp[1]];
  return seen !== undefined && seen >= stamp[0];
}

/** True when `a` has seen everything `b` has seen. */
export function dominates(a: VersionVector, b: VersionVector): boolean {
  for (const replica in b) {
    if ((a[replica] ?? 0) < (b[replica] as number)) return false;
  }
  return true;
}

export function joinVectors(a: VersionVector, b: VersionVector): VersionVector {
  const joined: Record<ReplicaId, number> = { ...a };
  for (const replica in b) {
    const theirs = b[replica] as number;
    if ((joined[replica] ?? 0) < theirs) joined[replica] = theirs;
  }
  return joined;
}

export function maxTime(vector: VersionVector): number {
  let max = 0;
  for (const replica in vector) max = Math.max(max, vector[replica] as number);
  return max;
}

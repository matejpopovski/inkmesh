/** Identifies one writer. Must never contain `.`, which separates the parts of a record id. */
export type ReplicaId = string;

/**
 * A totally ordered write identity: one hybrid logical time plus the replica that issued it.
 *
 * The same pair does double duty. Comparing stamps picks the winner of a register, and a stamp is
 * also the "dot" a version vector covers. Keeping one concept instead of a Lamport stamp plus a
 * per-replica sequence number means a register carries no second counter.
 */
export type Stamp = readonly [hlc: number, replica: ReplicaId];

export function compareStamps(a: Stamp, b: Stamp): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] === b[1]) return 0;
  return a[1] < b[1] ? -1 : 1;
}

export function isValidReplicaId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

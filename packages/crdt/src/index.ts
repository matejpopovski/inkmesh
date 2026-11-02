export { HybridClock, hlcFromWallTime, wallTimeFromHlc } from './clock.js';
export {
  RecordDoc,
  creationStamp,
  joinEntries,
  type ApplyResult,
  type Delta,
  type DocOptions,
  type DocStats,
  type Entry,
  type Fields,
  type Json,
  type LiveRecord,
  type Register,
  type Reorder,
  type Tombstone,
} from './doc.js';
export { isValidOrderKey, jitteredKeyBetween, keyBetween, type Random } from './order-key.js';
export { compareStamps, isValidReplicaId, type ReplicaId, type Stamp } from './stamp.js';
export { covers, dominates, joinVectors, maxTime, type VersionVector } from './version-vector.js';

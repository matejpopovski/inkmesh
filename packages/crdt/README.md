# @inkmesh/crdt

A delta-state CRDT for a set of ordered records. No dependencies, no transport, no storage: it
takes writes and sync messages and it produces sync messages. The whiteboard in this repository
is one client of it, and nothing in here knows what a shape is.

```ts
import { RecordDoc } from '@inkmesh/crdt';

const alice = new RecordDoc('alice');
const bob = new RecordDoc('bob');

const id = alice.create({ pos: [0, 0], color: 'ink' });
bob.applyDelta(alice.syncFor(bob.versions));

alice.set(id, { pos: [10, 10] }); // concurrent edits to different fields
bob.set(id, { color: 'moss' });

bob.applyDelta(alice.syncFor(bob.versions));
alice.applyDelta(bob.syncFor(alice.versions));

alice.get(id)?.fields; // { pos: [10, 10], color: 'moss' }, on both replicas
```

## The API in one screen

| Call                                  | Does                                                   |
| ------------------------------------- | ------------------------------------------------------ |
| `create(fields, z?)`                  | Adds a record on top, or at an explicit order key      |
| `set(id, patch)`                      | Writes fields. All fields in one patch share one stamp |
| `remove(id)`                          | Deletes for good. Wins over any concurrent edit        |
| `reorder(id, move)`                   | `'front'`, `'back'`, `'forward'` or `'backward'`       |
| `get(id)`, `list()`                   | Reads live records, `list()` from bottom to top        |
| `syncFor(peerVersions)`               | The message that brings that peer up to date           |
| `applyDelta(delta)`                   | Merges a message. Returns `gap` if it cannot be placed |
| `compact(cutoffHlc)`, `adoptFloor(v)` | Forgets old tombstones, here and when told by a peer   |
| `exportRecord(id)`, `joinEntries`     | One record's state, for a store that writes row by row |

Pass `{ now, random }` to the constructor to make a replica deterministic. The test suite does.

## Rules the caller must keep

- **One writer per replica id.** A version vector assumes it. Two tabs need two ids.
- **Apply deltas whole.** Version vectors only mean something if a delta lands atomically.
- **Treat `gap` as "ask again".** Nothing was applied, and resending `syncFor` with the replica's
  current `versions` always works.
- **Use `syncFor`, not `deltaSince`,** unless you know the peer has reached the floor.

## What each record is

Each field is a last-writer-wins register stamped with a hybrid logical clock. Group fields that
must change together into one value: `pos: [x, y]` rather than `x` and `y`, or a concurrent move
could land on a position nobody chose. Text is a single register too, so two people typing in
one field means one of them loses that field. This package does not do character-level merging.

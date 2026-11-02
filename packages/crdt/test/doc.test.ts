import { describe, expect, it } from 'vitest';
import { RecordDoc, hlcFromWallTime, type Delta } from '../src/index.js';

function pair(now?: () => number): [RecordDoc, RecordDoc] {
  const options = now ? { now } : {};
  return [new RecordDoc('alice', options), new RecordDoc('bob', options)];
}

function sync(from: RecordDoc, to: RecordDoc): void {
  to.applyDelta(from.syncFor(to.versions));
}

function exchange(a: RecordDoc, b: RecordDoc): void {
  sync(a, b);
  sync(b, a);
}

function bytes(delta: Delta): number {
  return JSON.stringify(delta).length;
}

describe('registers', () => {
  it('keeps concurrent edits to different fields of a record', () => {
    const [alice, bob] = pair();
    const id = alice.create({ pos: [0, 0], color: 'ink' });
    exchange(alice, bob);
    alice.set(id, { pos: [10, 10] });
    bob.set(id, { color: 'moss' });
    exchange(alice, bob);
    expect(alice.get(id)?.fields).toEqual({ pos: [10, 10], color: 'moss' });
    expect(alice.visibleState()).toBe(bob.visibleState());
  });

  it('lets the later wall clock win a conflict on one field', () => {
    let wall = Date.UTC(2026, 0, 1);
    const [alice, bob] = pair(() => wall);
    const id = alice.create({ pos: [0, 0] });
    exchange(alice, bob);
    alice.set(id, { pos: [1, 1] });
    wall += 5_000;
    bob.set(id, { pos: [2, 2] });
    exchange(alice, bob);
    expect(alice.get(id)?.fields['pos']).toEqual([2, 2]);
  });

  it('does not let many offline writes outrank one newer write', () => {
    let wall = Date.UTC(2026, 0, 1);
    const [alice, bob] = pair(() => wall);
    const id = alice.create({ pos: [0, 0] });
    exchange(alice, bob);
    for (let i = 0; i < 1_000; i++) alice.set(id, { pos: [i, i] });
    wall += 60_000;
    bob.set(id, { pos: [-1, -1] });
    exchange(alice, bob);
    expect(bob.get(id)?.fields['pos']).toEqual([-1, -1]);
  });

  it('breaks an exact time tie by replica id', () => {
    const [alice, bob] = pair(() => Date.UTC(2026, 0, 1));
    const id = alice.create({ color: 'ink' });
    exchange(alice, bob);
    const fresh = new RecordDoc('carol', { now: () => Date.UTC(2026, 0, 1) });
    sync(alice, fresh);
    bob.set(id, { color: 'bob' });
    fresh.set(id, { color: 'carol' });
    exchange(bob, fresh);
    expect(bob.get(id)?.fields['color']).toBe('carol');
    expect(fresh.get(id)?.fields['color']).toBe('carol');
  });

  it('cannot shadow a causally later edit, even with a clock hours ahead', () => {
    const wall = Date.UTC(2026, 0, 1);
    const fast = new RecordDoc('fast', { now: () => wall + 6 * 3_600_000 });
    const slow = new RecordDoc('slow', { now: () => wall });
    const id = fast.create({ pos: [1, 1] });
    sync(fast, slow);
    slow.set(id, { pos: [2, 2] });
    exchange(fast, slow);
    expect(fast.get(id)?.fields['pos']).toEqual([2, 2]);
  });
});

describe('deletion', () => {
  it('wins over a concurrent edit that carries a later stamp', () => {
    let wall = Date.UTC(2026, 0, 1);
    const [alice, bob] = pair(() => wall);
    const id = alice.create({ pos: [0, 0] });
    exchange(alice, bob);
    alice.remove(id);
    wall += 10_000;
    bob.set(id, { pos: [5, 5] });
    exchange(alice, bob);
    expect(alice.get(id)).toBeUndefined();
    expect(bob.get(id)).toBeUndefined();
    expect(alice.canonicalState()).toBe(bob.canonicalState());
  });

  it('frees register storage as soon as a record is deleted', () => {
    const doc = new RecordDoc('alice');
    const id = doc.create({ points: new Array(5_000).fill(1) });
    doc.remove(id);
    expect(doc.stats()).toMatchObject({ live: 0, tombstones: 1, registers: 0 });
    expect(bytes(doc.fullState())).toBeLessThan(200);
  });

  it('holds no storage for an edit that arrives after the tombstone', () => {
    const [alice, bob] = pair();
    const id = alice.create({ pos: [0, 0] });
    exchange(alice, bob);
    alice.remove(id);
    bob.set(id, { text: 'x'.repeat(5_000) });
    sync(bob, alice);
    sync(alice, bob);
    expect(alice.stats()).toMatchObject({ tombstones: 1, registers: 0 });
    expect(bob.stats()).toMatchObject({ tombstones: 1, registers: 0 });
  });

  it('refuses edits to a deleted or unknown record', () => {
    const doc = new RecordDoc('alice');
    const id = doc.create({ pos: [0, 0] });
    doc.remove(id);
    expect(doc.set(id, { pos: [1, 1] })).toBe(false);
    expect(doc.remove(id)).toBe(false);
    expect(doc.set('nobody.1', { pos: [1, 1] })).toBe(false);
  });

  it('converges when two replicas delete the same record concurrently', () => {
    const [alice, bob] = pair();
    const id = alice.create({ pos: [0, 0] });
    exchange(alice, bob);
    alice.remove(id);
    bob.remove(id);
    exchange(alice, bob);
    exchange(alice, bob);
    expect(alice.canonicalState()).toBe(bob.canonicalState());
  });
});

describe('delta sync', () => {
  it('sends one register for many overwrites of the same field', () => {
    const [alice, bob] = pair();
    const id = alice.create({ pos: [0, 0], text: 'x'.repeat(2_000) });
    exchange(alice, bob);
    for (let i = 0; i < 500; i++) alice.set(id, { pos: [i, i] });
    const delta = alice.syncFor(bob.versions);
    expect(delta.entries).toHaveLength(1);
    expect(Object.keys(delta.entries[0]?.regs ?? {})).toEqual(['pos']);
    expect(bytes(delta)).toBeLessThan(300);
  });

  it('sends nothing to a peer that is up to date', () => {
    const [alice, bob] = pair();
    alice.create({ pos: [0, 0] });
    exchange(alice, bob);
    expect(alice.syncFor(bob.versions).entries).toHaveLength(0);
  });

  it('refuses a delta that would leave a gap, and accepts it after catching up', () => {
    const [alice, bob] = pair();
    const first = alice.create({ pos: [0, 0] });
    const early = alice.syncFor(bob.versions);
    const mid = alice.versions;
    alice.set(first, { pos: [1, 1] });
    const late = alice.deltaSince(mid);
    expect(bob.applyDelta(late).status).toBe('gap');
    expect(bob.get(first)).toBeUndefined();
    expect(bob.applyDelta(early).status).toBe('applied');
    expect(bob.applyDelta(late).status).toBe('applied');
    expect(bob.get(first)?.fields['pos']).toEqual([1, 1]);
  });

  it('reports only the parts that won, so a relay forwards no stale data', () => {
    let wall = Date.UTC(2026, 0, 1);
    const [alice, bob] = pair(() => wall);
    const server = new RecordDoc('server', { now: () => wall });
    const id = alice.create({ pos: [0, 0], color: 'ink' });
    sync(alice, server);
    sync(server, bob);
    alice.set(id, { pos: [1, 1], color: 'old' });
    wall += 1_000;
    bob.set(id, { color: 'new' });
    sync(bob, server);
    const result = server.applyDelta(alice.syncFor(server.versions));
    expect(result.status === 'applied' && result.changed).toEqual([
      { id, regs: { pos: [[1, 1], expect.any(Number), 'alice'] } },
    ]);
  });

  it('survives duplicate delivery', () => {
    const [alice, bob] = pair();
    alice.create({ pos: [0, 0] });
    const delta = alice.syncFor(bob.versions);
    bob.applyDelta(delta);
    const state = bob.canonicalState();
    const repeat = bob.applyDelta(delta);
    expect(repeat.status === 'applied' && repeat.changed).toEqual([]);
    expect(bob.canonicalState()).toBe(state);
  });

  it('restores a server that lost data from a client that still has it', () => {
    const [client, peer] = pair();
    const server = new RecordDoc('server');
    client.create({ pos: [0, 0] });
    peer.create({ pos: [1, 1] });
    sync(client, server);
    sync(peer, server);
    sync(server, client);
    sync(server, peer);

    const restored = new RecordDoc('server');
    restored.applyDelta(client.syncFor(restored.versions));
    expect(restored.visibleState()).toBe(client.visibleState());
    expect(restored.list()).toHaveLength(2);
  });
});

describe('order', () => {
  it('appends new records on top', () => {
    const doc = new RecordDoc('alice');
    const ids = [doc.create({ n: 1 }), doc.create({ n: 2 }), doc.create({ n: 3 })];
    expect(doc.list().map((record) => record.id)).toEqual(ids);
  });

  it('moves records one step and to either end', () => {
    const doc = new RecordDoc('alice');
    const [a, b, c] = [doc.create({}), doc.create({}), doc.create({})];
    expect(doc.reorder(a, 'forward')).toBe(true);
    expect(doc.list().map((record) => record.id)).toEqual([b, a, c]);
    expect(doc.reorder(c, 'back')).toBe(true);
    expect(doc.list().map((record) => record.id)).toEqual([c, b, a]);
    expect(doc.reorder(b, 'front')).toBe(true);
    expect(doc.list().map((record) => record.id)).toEqual([c, a, b]);
    expect(doc.reorder(a, 'backward')).toBe(true);
    expect(doc.list().map((record) => record.id)).toEqual([a, c, b]);
  });

  it('treats moves past the end as no-ops', () => {
    const doc = new RecordDoc('alice');
    const [a, b] = [doc.create({}), doc.create({})];
    expect(doc.reorder(a, 'back')).toBe(false);
    expect(doc.reorder(a, 'backward')).toBe(false);
    expect(doc.reorder(b, 'front')).toBe(false);
    expect(doc.reorder(b, 'forward')).toBe(false);
  });

  it('can move past records that ended up with equal keys', () => {
    const doc = new RecordDoc('alice');
    const low = doc.create({}, 'a1');
    const twinA = doc.create({}, 'a2');
    const twinB = doc.create({}, 'a2');
    const high = doc.create({}, 'a3');
    const order = () => doc.list().map((record) => record.id);
    expect(doc.reorder(high, 'backward')).toBe(true);
    expect(order()).toEqual([low, high, twinA, twinB]);
    expect(doc.reorder(high, 'front')).toBe(true);
    expect(doc.reorder(low, 'forward')).toBe(true);
    expect(order()).toEqual([twinA, twinB, low, high]);
  });

  it('keeps a stable total order for offline inserts at the same spot', () => {
    const [alice, bob] = pair();
    alice.create({ who: 'base' });
    exchange(alice, bob);
    const fromAlice = alice.create({ who: 'alice' });
    const fromBob = bob.create({ who: 'bob' });
    exchange(alice, bob);
    expect(alice.list().map((record) => record.id)).toEqual(bob.list().map((record) => record.id));
    expect(alice.get(fromAlice)?.z).not.toBe(alice.get(fromBob)?.z);
  });
});

describe('tombstone compaction', () => {
  const start = Date.UTC(2026, 0, 1);

  function board() {
    const wall = { now: start };
    const server = new RecordDoc('server', { now: () => wall.now });
    const alice = new RecordDoc('alice', { now: () => wall.now });
    const bob = new RecordDoc('bob', { now: () => wall.now });
    return { wall, server, alice, bob };
  }

  it('forgets old tombstones and keeps recent ones', () => {
    const { wall, alice } = board();
    const old = alice.create({});
    const recent = alice.create({});
    alice.remove(old);
    wall.now += 1_000_000;
    alice.remove(recent);
    expect(alice.compact(hlcFromWallTime(start + 500_000))).toEqual([old]);
    expect(alice.stats()).toMatchObject({ tombstones: 1 });
  });

  it('leaves no stranded tombstone when a concurrent delete meets compaction', () => {
    // Found by the property suite. Bob's newer stamp used to replace Alice's, so a floor raised
    // by Alice covered nothing Bob held and his tombstone stayed for the life of the board.
    const { wall, alice, bob } = board();
    const id = alice.create({});
    sync(alice, bob);
    alice.remove(id);
    wall.now += 1;
    bob.remove(id);
    const alicesDelete = alice.syncFor(bob.versions);
    alice.compact(hlcFromWallTime(wall.now));
    bob.applyDelta(alicesDelete);
    expect(bob.stats().tombstones).toBe(1);
    alice.applyDelta(bob.syncFor(alice.versions));
    bob.applyDelta(alice.syncFor(bob.versions));
    expect(alice.canonicalState()).toBe(bob.canonicalState());
    expect(bob.stats().tombstones).toBe(0);
  });

  it('keeps delta sync for a peer that already saw the compacted tombstone', () => {
    const { server, alice } = board();
    const id = alice.create({});
    sync(alice, server);
    alice.remove(id);
    sync(alice, server);
    sync(server, alice);
    server.compact(hlcFromWallTime(start + 1_000));
    expect(server.syncFor(alice.versions).full).toBeUndefined();
  });

  it('sends a full state to a peer below the floor, which then drops the record', () => {
    const { wall, server, alice, bob } = board();
    const id = alice.create({ pos: [0, 0] });
    sync(alice, server);
    sync(server, bob);

    alice.remove(id);
    sync(alice, server);
    wall.now += 10_000;
    server.compact(hlcFromWallTime(wall.now));

    const reply = server.syncFor(bob.versions);
    expect(reply.full).toBe(true);
    const result = bob.applyDelta(reply);
    expect(result.status === 'applied' && result.removed).toEqual([id]);
    expect(bob.get(id)).toBeUndefined();
  });

  it('does not resurrect a compacted record from a stale offline edit', () => {
    const { wall, server, alice, bob } = board();
    const id = alice.create({ pos: [0, 0] });
    sync(alice, server);
    sync(server, bob);

    bob.set(id, { pos: [9, 9] });
    alice.remove(id);
    sync(alice, server);
    wall.now += 10_000;
    server.compact(hlcFromWallTime(wall.now));

    // Bob's push reaches the server before he has heard about the deletion.
    const push = server.applyDelta(bob.syncFor(server.versions));
    expect(push.status === 'applied' && push.changed).toEqual([]);
    expect(server.get(id)).toBeUndefined();

    sync(server, bob);
    expect(bob.get(id)).toBeUndefined();
    expect(server.visibleState()).toBe(bob.visibleState());
  });

  it('keeps work a stale client created while the server compacted', () => {
    const { wall, server, alice, bob } = board();
    const doomed = alice.create({});
    sync(alice, server);
    sync(server, bob);
    const fresh = bob.create({ text: 'written offline' });

    alice.remove(doomed);
    sync(alice, server);
    wall.now += 10_000;
    server.compact(hlcFromWallTime(wall.now));

    sync(server, bob);
    expect(bob.get(fresh)).toBeDefined();
    sync(bob, server);
    expect(server.get(fresh)?.fields['text']).toBe('written offline');
    expect(server.get(doomed)).toBeUndefined();
  });

  it('propagates a floor so that every replica can drop the tombstone', () => {
    const { wall, server, alice, bob } = board();
    const id = alice.create({});
    sync(alice, server);
    sync(server, bob);
    alice.remove(id);
    sync(alice, server);
    sync(server, bob);
    expect(bob.stats().tombstones).toBe(1);
    wall.now += 10_000;
    server.compact(hlcFromWallTime(wall.now));
    expect(bob.adoptFloor(server.floor)).toEqual([id]);
    expect(bob.stats().tombstones).toBe(0);
  });

  it('adopts a floor carried on a delta', () => {
    const { wall, server, alice, bob } = board();
    const id = alice.create({});
    sync(alice, server);
    sync(server, bob);
    alice.remove(id);
    sync(alice, server);
    sync(server, bob);
    wall.now += 10_000;
    server.compact(hlcFromWallTime(wall.now));
    sync(server, bob);
    expect(bob.stats().tombstones).toBe(0);
  });
});

describe('observer', () => {
  it('reports each record touched by writes, merges and compaction', () => {
    const touched: string[] = [];
    const doc = new RecordDoc('alice', { onRecordChange: (id) => touched.push(id) });
    const id = doc.create({ a: 1 });
    doc.set(id, { a: 2 });
    doc.remove(id);
    doc.compact(Number.MAX_SAFE_INTEGER);
    expect(touched).toEqual([id, id, id, id]);
  });
});

describe('construction', () => {
  it('rejects replica ids that would corrupt record ids', () => {
    expect(() => new RecordDoc('has.dot')).toThrow(RangeError);
    expect(() => new RecordDoc('')).toThrow(RangeError);
  });

  it('never reissues a stamp after being restored from a snapshot', () => {
    const wall = Date.UTC(2026, 0, 1);
    const before = new RecordDoc('alice', { now: () => wall });
    const id = before.create({ pos: [0, 0] });
    const after = new RecordDoc('alice', { now: () => wall });
    after.applyDelta(before.fullState());
    after.set(id, { pos: [1, 1] });
    expect(after.versions['alice']).toBeGreaterThan(before.versions['alice'] as number);
  });
});

import 'fake-indexeddb/auto';
import { RecordDoc, type Delta } from '@inkmesh/crdt';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbStore } from '../src/index.js';

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

function saveAll(store: IndexedDbStore, doc: RecordDoc): Promise<void> {
  return store.save({
    records: doc.fullState().entries,
    removed: [],
    versions: doc.versions,
    floor: doc.floor,
  });
}

function restored(state: Delta | null, replica = 'reader'): RecordDoc {
  const doc = new RecordDoc(replica);
  if (state) doc.applyDelta(state);
  return doc;
}

describe('IndexedDbStore', () => {
  it('reports an unknown board as empty', async () => {
    expect(await new IndexedDbStore('nothing', factory).load()).toBeNull();
  });

  it('round-trips a board exactly', async () => {
    const doc = new RecordDoc('alice');
    const id = doc.create({ pos: [1, 2], text: 'note' });
    doc.remove(doc.create({ pos: [3, 4] }));
    doc.set(id, { color: '#000000' });

    const store = new IndexedDbStore('board', factory);
    await saveAll(store, doc);
    const copy = restored(await new IndexedDbStore('board', factory).load());
    expect(copy.visibleState()).toBe(doc.visibleState());
    expect(copy.versions).toEqual(doc.versions);
    expect(copy.stats()).toEqual(doc.stats());
  });

  it('keeps boards in the same database apart', async () => {
    const [left, right] = [new RecordDoc('a'), new RecordDoc('b')];
    left.create({ n: 1 });
    right.create({ n: 2 });
    await saveAll(new IndexedDbStore('board-1', factory), left);
    await saveAll(new IndexedDbStore('board-10', factory), right);
    const copy = restored(await new IndexedDbStore('board-1', factory).load());
    expect(copy.visibleState()).toBe(left.visibleState());
  });

  it('deletes removed records', async () => {
    const doc = new RecordDoc('alice');
    const id = doc.create({ a: 1 });
    const store = new IndexedDbStore('board', factory);
    await saveAll(store, doc);
    await store.save({ records: [], removed: [id], versions: doc.versions, floor: doc.floor });
    expect((await store.load())?.entries).toHaveLength(0);
  });

  it('merges two tabs writing different edits to the same record', async () => {
    const seed = new RecordDoc('seed');
    const id = seed.create({ pos: [0, 0], color: 'ink' });
    const [tabA, tabB] = [restored(seed.fullState(), 'tab-a'), restored(seed.fullState(), 'tab-b')];
    const [storeA, storeB] = [
      new IndexedDbStore('board', factory),
      new IndexedDbStore('board', factory),
    ];
    await saveAll(storeA, seed);

    tabA.set(id, { pos: [5, 5] });
    tabB.set(id, { color: 'moss' });
    await saveAll(storeA, tabA);
    await saveAll(storeB, tabB);

    const merged = restored(await storeA.load());
    expect(merged.get(id)?.fields).toEqual({ pos: [5, 5], color: 'moss' });
    expect(merged.versions['tab-a']).toBeDefined();
    expect(merged.versions['tab-b']).toBeDefined();
  });

  it('does not let a stale tab bring back a record another tab compacted', async () => {
    const seed = new RecordDoc('seed');
    const id = seed.create({ a: 1 });
    const stale = restored(seed.fullState(), 'stale-tab');
    const store = new IndexedDbStore('board', factory);
    await saveAll(store, seed);
    await store.save({ records: [], removed: [id], versions: seed.versions, floor: seed.floor });

    await saveAll(store, stale);
    expect((await store.load())?.entries).toHaveLength(0);
  });

  it('keeps vectors moving forward when writes arrive out of order', async () => {
    const doc = new RecordDoc('alice');
    const store = new IndexedDbStore('board', factory);
    doc.create({ a: 1 });
    const older = doc.versions;
    doc.create({ a: 2 });
    await saveAll(store, doc);
    await store.save({ records: [], removed: [], versions: older, floor: {} });
    expect((await store.load())?.upto).toEqual(doc.versions);
  });
});

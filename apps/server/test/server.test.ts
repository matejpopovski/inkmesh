import { hlcFromWallTime, RecordDoc } from '@inkmesh/crdt';
import { PROTOCOL_VERSION } from '@inkmesh/protocol';
import { MemoryStore, type SyncEngine } from '@inkmesh/sync';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, rawSocket, until, type Harness } from './support.js';

let h: Harness;

afterEach(async () => {
  await h.dispose();
});

const hello = (replica: string, versions = {}) =>
  JSON.stringify({
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    board: 'test-board',
    replica,
    versions,
  });

const converged = (a: SyncEngine, b: SyncEngine) => () =>
  a.doc.visibleState() === b.doc.visibleState();

const settled = (engine: SyncEngine) => () => engine.pending() === 0;

describe('live collaboration', () => {
  it('carries an edit from one client to another', async () => {
    h = await harness();
    const [a, b] = [await h.client('alice'), await h.client('bob')];
    const id = a.doc.create({ pos: [1, 2] });
    await until(() => b.doc.get(id) !== undefined);
    b.doc.set(id, { pos: [3, 4] });
    await until(() => a.doc.get(id)?.fields['pos']?.toString() === '3,4');
  });

  it('keeps boards apart', async () => {
    h = await harness();
    const a = await h.client('alice', 'board-a');
    const b = await h.client('bob', 'board-b');
    a.doc.create({ pos: [0, 0] });
    await until(settled(a));
    expect(b.doc.list()).toHaveLength(0);
  });

  it('merges concurrent edits made while both clients are connected', async () => {
    h = await harness();
    const [a, b] = [await h.client('alice'), await h.client('bob')];
    const shared = a.doc.create({ pos: [0, 0], color: 'ink' });
    await until(() => b.doc.get(shared) !== undefined);
    for (let i = 0; i < 50; i++) {
      a.doc.set(shared, { pos: [i, i] });
      b.doc.set(shared, { color: `c${i}` });
      if (i % 7 === 0) await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await until(converged(a, b));
    expect(a.doc.get(shared)?.fields).toEqual({ pos: [49, 49], color: 'c49' });
  });
});

describe('offline and reconnection', () => {
  it('merges edits made on both sides of a disconnection', async () => {
    h = await harness();
    const [a, b] = [await h.client('alice'), await h.client('bob')];
    const id = a.doc.create({ pos: [0, 0], color: 'ink' });
    await until(() => b.doc.get(id) !== undefined);

    a.setOnline(false);
    a.doc.set(id, { pos: [5, 5] });
    const offline = a.doc.create({ text: 'written offline' });
    b.doc.set(id, { color: 'moss' });
    await until(settled(b));
    expect(b.doc.get(offline)).toBeUndefined();

    a.setOnline(true);
    await until(converged(a, b));
    expect(b.doc.get(id)?.fields).toEqual({ pos: [5, 5], color: 'moss' });
    expect(b.doc.get(offline)?.fields['text']).toBe('written offline');
  });

  it('sends a returning client only what it missed', async () => {
    h = await harness();
    const [a, b] = [await h.client('alice'), await h.client('bob')];
    for (let i = 0; i < 200; i++) a.doc.create({ text: 'x'.repeat(100) });
    await until(() => b.doc.list().length === 200);
    b.setOnline(false);
    const id = a.doc.create({ text: 'just this one' });
    await until(settled(a));

    const room = h.server.rooms.get('test-board');
    const welcome = room?.doc.syncFor(b.doc.versions);
    expect(welcome?.full).toBeUndefined();
    expect(welcome?.entries.map((entry) => entry.id)).toEqual([id]);
    b.setOnline(true);
    await until(() => b.doc.get(id) !== undefined);
  });

  it('restores offline work from local storage after a reload', async () => {
    h = await harness();
    const store = new MemoryStore();
    const first = await h.client('alice', 'test-board', store);
    first.setOnline(false);
    const id = first.doc.create({ text: 'unsent' });
    await first.flush();
    await first.stop();

    const second = await h.client('alice', 'test-board', store);
    expect(second.doc.get(id)?.fields['text']).toBe('unsent');
    const observer = await h.client('bob');
    await until(() => observer.doc.get(id) !== undefined);
  });

  it('reconnects by itself when the server comes back', async () => {
    h = await harness();
    const [a, b] = [await h.client('alice'), await h.client('bob')];
    const id = a.doc.create({ pos: [0, 0] });
    await until(() => b.doc.get(id) !== undefined);

    await h.restart();
    await until(() => a.getSnapshot().status === 'online', 8_000);
    await until(() => b.getSnapshot().status === 'online', 8_000);
    a.doc.set(id, { pos: [7, 7] });
    await until(() => b.doc.get(id)?.fields['pos']?.toString() === '7,7');
  }, 20_000);

  it('recovers data from clients if the server loses its database', async () => {
    h = await harness();
    const a = await h.client('alice', 'lost-board');
    const id = a.doc.create({ text: 'keep me' });
    await until(settled(a));

    const db = new Database(h.databasePath);
    db.exec('DELETE FROM records; DELETE FROM boards;');
    db.close();
    const board = h.server.rooms.get('lost-board');
    expect(board).toBeDefined();
    a.setOnline(false);
    await until(() => h.server.rooms.get('lost-board') === undefined);
    a.setOnline(true);

    await until(() => a.getSnapshot().status === 'online');
    const b = await h.client('bob', 'lost-board');
    await until(() => b.doc.get(id) !== undefined);
  });
});

describe('durability', () => {
  it('has the edit in SQLite by the time the client hears the ack', async () => {
    h = await harness();
    const a = await h.client('alice');
    a.doc.create({ text: 'durable' });
    await until(settled(a));
    const db = new Database(h.databasePath, { readonly: true });
    const rows = db.prepare('SELECT entry FROM records').all() as { entry: string }[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entry).toContain('durable');
  });

  it('serves the stored board after a restart', async () => {
    h = await harness();
    const a = await h.client('alice');
    const id = a.doc.create({ text: 'survives restart' });
    const gone = a.doc.create({ text: 'deleted' });
    a.doc.remove(gone);
    await until(settled(a));
    await a.stop();

    await h.restart();
    const b = await h.client('bob');
    expect(b.doc.get(id)?.fields['text']).toBe('survives restart');
    expect(b.doc.get(gone)).toBeUndefined();
    expect(b.doc.stats()).toMatchObject({ live: 1, tombstones: 1 });
  });
});

describe('tombstone compaction', () => {
  it('forgets old tombstones everywhere, including the database', async () => {
    h = await harness();
    const [a, b] = [await h.client('alice'), await h.client('bob')];
    const id = a.doc.create({ pos: [0, 0] });
    a.doc.remove(id);
    await until(() => b.doc.stats().tombstones === 1);

    expect(h.server.compactAll(hlcFromWallTime(Date.now() + 60_000))).toBe(1);
    await until(() => a.doc.stats().tombstones === 0 && b.doc.stats().tombstones === 0);

    const db = new Database(h.databasePath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 });
    db.close();
  });

  it('keeps a stale client from bringing a compacted record back', async () => {
    h = await harness();
    const [a, b] = [await h.client('alice'), await h.client('bob')];
    const id = a.doc.create({ pos: [0, 0] });
    await until(() => b.doc.get(id) !== undefined);

    b.setOnline(false);
    b.doc.set(id, { pos: [9, 9] });
    const kept = b.doc.create({ text: 'new work' });
    a.doc.remove(id);
    await until(settled(a));
    h.server.compactAll(hlcFromWallTime(Date.now() + 60_000));

    b.setOnline(true);
    await until(() => b.getSnapshot().status === 'online');
    await until(() => a.doc.get(kept) !== undefined);
    expect(b.doc.get(id)).toBeUndefined();
    expect(a.doc.get(id)).toBeUndefined();
    await until(converged(a, b));
    const stats = await fetch(`http://127.0.0.1:${h.server.port}/api/boards/test-board/stats`);
    expect(await stats.json()).toMatchObject({ records: 1 });
  });
});

describe('presence', () => {
  it('relays cursors and announces departures', async () => {
    h = await harness();
    const [a, b] = [await h.client('alice'), await h.client('bob')];
    a.updatePresence({ name: 'Ana', color: '#112233', cursor: { x: 4, y: 5 } });
    await until(() => b.getSnapshot().peers.get('alice')?.cursor?.x === 4);

    a.setOnline(false);
    await until(() => !b.getSnapshot().peers.has('alice'));
  });

  it('tells a newcomer who is already here', async () => {
    h = await harness();
    const a = await h.client('alice');
    a.updatePresence({ name: 'Ana', color: '#112233', cursor: null });
    await until(() => h.server.rooms.get('test-board') !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const b = await h.client('bob');
    expect(b.getSnapshot().peers.get('alice')?.name).toBe('Ana');
  });

  it('never stores presence', async () => {
    h = await harness();
    const a = await h.client('alice');
    a.updatePresence({ name: 'Ana', color: '#112233', cursor: { x: 1, y: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const db = new Database(h.databasePath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM boards').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('hostile or broken clients', () => {
  it('closes the socket on a malformed frame and keeps serving others', async () => {
    h = await harness();
    const a = await h.client('alice');
    const raw = await rawSocket(h.url);
    raw.socket.send('{"this is":"not a message"}');
    expect(await raw.closed).toBe(1008);
    const id = a.doc.create({ pos: [0, 0] });
    await until(settled(a));
    expect(a.doc.get(id)).toBeDefined();
  });

  it('requires hello before anything else', async () => {
    h = await harness();
    const raw = await rawSocket(h.url);
    raw.socket.send(
      JSON.stringify({ type: 'delta', delta: { since: {}, upto: {}, floor: {}, entries: [] } }),
    );
    expect(await raw.closed).toBe(1008);
  });

  it('refuses an unknown protocol version', async () => {
    h = await harness();
    const raw = await rawSocket(h.url);
    raw.socket.send(
      JSON.stringify({ type: 'hello', protocol: 999, board: 'b', replica: 'r', versions: {} }),
    );
    expect(await raw.closed).toBe(1008);
    expect(raw.received).toEqual([expect.objectContaining({ type: 'error' })]);
  });

  it('will not let a client erase records with a forged full state', async () => {
    h = await harness();
    const a = await h.client('alice');
    const id = a.doc.create({ text: 'precious' });
    await until(settled(a));

    const raw = await rawSocket(h.url);
    raw.socket.send(hello('mallory'));
    await until(() => raw.received.length > 0);
    raw.socket.send(
      JSON.stringify({
        type: 'delta',
        delta: { since: {}, upto: a.doc.versions, floor: {}, entries: [], full: true },
      }),
    );
    expect(await raw.closed).toBe(1008);
    expect(h.server.rooms.get('test-board')?.doc.get(id)).toBeDefined();
  });

  it('answers a delta that leaves a gap with a resync', async () => {
    h = await harness();
    const raw = await rawSocket(h.url);
    raw.socket.send(hello('mallory'));
    await until(() => raw.received.length > 0);
    const doc = new RecordDoc('mallory');
    doc.create({ text: 'from the future' });
    const delta = { ...doc.fullState(), since: { someone: 123 } };
    delete (delta as { full?: true }).full;
    raw.socket.send(JSON.stringify({ type: 'delta', delta }));
    await until(() => raw.received.length > 1);
    expect(raw.received[1]).toEqual({ type: 'resync' });
    raw.socket.close();
  });

  it('lets a new connection for the same replica take over', async () => {
    h = await harness();
    const first = await rawSocket(h.url);
    first.socket.send(hello('alice'));
    await until(() => first.received.length > 0);
    const second = await rawSocket(h.url);
    second.socket.send(hello('alice'));
    expect(await first.closed).toBe(4001);
    await until(() => second.received.length > 0);
    second.socket.close();
  });

  it('rejects an invalid board id at the stats endpoint', async () => {
    h = await harness();
    const response = await fetch(`http://127.0.0.1:${h.server.port}/api/boards/NOPE!/stats`);
    expect(response.status).toBe(400);
  });
});

describe('many clients under random faults', () => {
  it('converges with four clients editing and dropping out', async () => {
    h = await harness();
    const clients = await Promise.all(['a', 'b', 'c', 'd'].map((name) => h.client(name)));
    let seed = 12345;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    for (let round = 0; round < 300; round++) {
      const client = clients[random(4)] as SyncEngine;
      const live = client.doc.list();
      const target = live[random(Math.max(live.length, 1))]?.id;
      switch (random(6)) {
        case 0:
          client.doc.create({ pos: [random(500), random(500)] });
          break;
        case 1:
        case 2:
          if (target) client.doc.set(target, { pos: [random(500), random(500)] });
          break;
        case 3:
          if (target) client.doc.remove(target);
          break;
        case 4:
          if (target) client.doc.reorder(target, 'front');
          break;
        case 5:
          client.setOnline(client.getSnapshot().status !== 'online');
          break;
      }
      if (round % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    }

    for (const client of clients) client.setOnline(true);
    await until(() => clients.every((client) => client.getSnapshot().status === 'online'), 8_000);
    const first = clients[0] as SyncEngine;
    await until(
      () => clients.every((client) => client.doc.visibleState() === first.doc.visibleState()),
      8_000,
    );
    await until(() => clients.every((client) => client.pending() === 0), 8_000);
    const server = h.server.rooms.get('test-board');
    expect(server?.doc.visibleState()).toBe(first.doc.visibleState());
  }, 30_000);
});

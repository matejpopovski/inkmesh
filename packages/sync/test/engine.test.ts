import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@inkmesh/protocol';
import { RecordDoc } from '@inkmesh/crdt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, SyncEngine, type SocketLike } from '../src/index.js';

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: ClientMessage[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    this.closed = true;
    this.onclose?.(undefined as never);
  }

  open(): void {
    this.onopen?.(undefined as never);
  }

  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  sentOfType<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }>[] {
    return this.sent.filter((message) => message.type === type) as never;
  }
}

function setup(store = new MemoryStore()) {
  const sockets: FakeSocket[] = [];
  const engine = new SyncEngine({
    board: 'board',
    replica: 'alice',
    store,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    flushMs: 10,
    presenceMs: 10,
    heartbeatMs: 1_000,
  });
  const welcome = (socket: FakeSocket, server = new RecordDoc('server')) =>
    socket.deliver({ type: 'welcome', delta: server.syncFor(engine.doc.versions), peers: [] });
  return { engine, sockets, store, welcome };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handshake', () => {
  it('announces its versions and goes online after the welcome', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    expect(engine.getSnapshot().status).toBe('connecting');
    const socket = sockets[0] as FakeSocket;
    socket.open();
    expect(socket.sent).toEqual([
      {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        board: 'board',
        replica: 'alice',
        versions: {},
      },
    ]);
    welcome(socket);
    expect(engine.getSnapshot().status).toBe('online');
  });

  it('pushes offline work right after the welcome', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start(false);
    const id = engine.doc.create({ text: 'offline' });
    engine.setOnline(true);
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    const [push] = socket.sentOfType('delta');
    expect(push?.delta.entries.map((entry) => entry.id)).toEqual([id]);
  });

  it('holds edits back until the handshake finishes', async () => {
    const { engine, sockets } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    engine.doc.create({ text: 'early' });
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.sentOfType('delta')).toHaveLength(0);
  });
});

describe('pushing edits', () => {
  it('coalesces a burst of writes into one register in one message', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    const id = engine.doc.create({ pos: [0, 0] });
    await vi.advanceTimersByTimeAsync(20);
    socket.sent.length = 0;

    for (let i = 0; i < 100; i++) engine.doc.set(id, { pos: [i, i] });
    await vi.advanceTimersByTimeAsync(20);
    const pushes = socket.sentOfType('delta');
    expect(pushes).toHaveLength(1);
    expect(Object.keys(pushes[0]?.delta.entries[0]?.regs ?? {})).toEqual(['pos']);
  });

  it('counts unsent records until the server acknowledges them', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    engine.doc.create({ a: 1 });
    await vi.advanceTimersByTimeAsync(20);
    expect(engine.getSnapshot().unsent).toBe(1);
    socket.deliver({ type: 'ack', versions: engine.doc.versions });
    expect(engine.getSnapshot().unsent).toBe(0);
  });

  it('re-offers unacknowledged edits on the next connection', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const first = sockets[0] as FakeSocket;
    first.open();
    welcome(first);
    const id = engine.doc.create({ a: 1 });
    await vi.advanceTimersByTimeAsync(20);
    expect(first.sentOfType('delta')).toHaveLength(1);

    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = sockets[1] as FakeSocket;
    second.open();
    welcome(second);
    expect(second.sentOfType('delta')[0]?.delta.entries[0]?.id).toBe(id);
  });
});

describe('receiving', () => {
  it('asks to resync when the server sends a delta it cannot place', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    socket.sent.length = 0;

    const server = new RecordDoc('server');
    server.create({ a: 1 });
    const seen = server.versions;
    server.create({ a: 2 });
    socket.deliver({ type: 'delta', delta: server.deltaSince(seen) });
    expect(socket.sentOfType('hello')).toHaveLength(1);
    expect(engine.doc.list()).toHaveLength(0);
  });

  it('resends hello when the server asks', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    socket.sent.length = 0;
    socket.deliver({ type: 'resync' });
    expect(socket.sentOfType('hello')).toHaveLength(1);
  });

  it('ignores frames it does not understand', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    socket.onmessage?.({ data: 'garbage' });
    socket.onmessage?.({ data: 42 });
    expect(engine.getSnapshot().status).toBe('online');
  });

  it('stops retrying once the server refuses it', async () => {
    const { engine, sockets } = setup();
    await engine.start();
    (sockets[0] as FakeSocket).deliver({ type: 'error', reason: 'protocol' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('local persistence', () => {
  it('saves edits made while offline and restores them', async () => {
    const store = new MemoryStore();
    const { engine } = setup(store);
    await engine.start(false);
    const id = engine.doc.create({ text: 'kept' });
    await vi.advanceTimersByTimeAsync(20);
    await engine.stop();

    const reopened = setup(store).engine;
    await reopened.start(false);
    expect(reopened.doc.get(id)?.fields['text']).toBe('kept');
  });

  it('coalesces a burst of writes into one save', async () => {
    const { engine, store } = setup();
    await engine.start(false);
    const id = engine.doc.create({ pos: [0, 0] });
    for (let i = 0; i < 100; i++) engine.doc.set(id, { pos: [i, i] });
    await vi.advanceTimersByTimeAsync(20);
    expect(store.saves).toBe(1);
  });

  it('does not rewrite what it just loaded', async () => {
    const store = new MemoryStore();
    const first = setup(store).engine;
    await first.start(false);
    first.doc.create({ a: 1 });
    await first.stop();
    const saves = store.saves;

    const second = setup(store).engine;
    await second.start(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.saves).toBe(saves);
  });

  it('removes compacted records from the store', async () => {
    const store = new MemoryStore();
    const { engine, sockets, welcome } = setup(store);
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    const id = engine.doc.create({ a: 1 });
    engine.doc.remove(id);
    await vi.advanceTimersByTimeAsync(20);
    expect((await store.load())?.entries).toHaveLength(1);

    const [hlc] = engine.doc.exportRecord(id)?.tomb?.[0] ?? [];
    socket.deliver({ type: 'compacted', floor: { alice: hlc as number } });
    await vi.advanceTimersByTimeAsync(20);
    expect((await store.load())?.entries).toHaveLength(0);
  });
});

describe('connection lifecycle', () => {
  it('backs off between attempts and resets after success', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    (sockets[0] as FakeSocket).close();
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets).toHaveLength(2);
    (sockets[1] as FakeSocket).close();
    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(sockets).toHaveLength(3);
    const third = sockets[2] as FakeSocket;
    third.open();
    welcome(third);
    third.close();
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets).toHaveLength(4);
  });

  it('reports a lost server as connecting and a lost network as offline', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    socket.close();
    expect(engine.getSnapshot().status).toBe('connecting');
    engine.setOnline(false);
    expect(engine.getSnapshot().status).toBe('offline');
  });

  it('does not reconnect while the browser says it is offline', async () => {
    const { engine, sockets } = setup();
    await engine.start();
    engine.setOnline(false);
    expect((sockets[0] as FakeSocket).closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    engine.setOnline(true);
    expect(sockets).toHaveLength(2);
  });

  it('treats two silent heartbeats as a dead connection', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.sentOfType('ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.getSnapshot().status).toBe('connecting');
    expect(socket.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(sockets).toHaveLength(2);
  });

  it('stays connected while the server answers pings', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      socket.deliver({ type: 'pong' });
    }
    expect(engine.getSnapshot().status).toBe('online');
  });

  it('clears peers when it loses the connection', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    socket.deliver({
      type: 'presence',
      replica: 'bob',
      presence: { name: 'Bob', color: '#000000', cursor: null },
    });
    expect(engine.getSnapshot().peers.size).toBe(1);
    engine.setOnline(false);
    expect(engine.getSnapshot().peers.size).toBe(0);
  });
});

describe('presence', () => {
  it('throttles cursor updates and sends only the latest', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    welcome(socket);
    for (let x = 0; x < 20; x++) {
      engine.updatePresence({ name: 'A', color: '#000000', cursor: { x, y: 0 } });
    }
    await vi.advanceTimersByTimeAsync(15);
    const sent = socket.sentOfType('presence');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.presence.cursor?.x).toBe(19);
  });

  it('re-announces itself after reconnecting', async () => {
    const { engine, sockets, welcome } = setup();
    await engine.start();
    const first = sockets[0] as FakeSocket;
    first.open();
    welcome(first);
    engine.updatePresence({ name: 'A', color: '#000000', cursor: null });
    await vi.advanceTimersByTimeAsync(15);
    first.close();
    await vi.advanceTimersByTimeAsync(400);
    const second = sockets[1] as FakeSocket;
    second.open();
    welcome(second);
    expect(second.sentOfType('presence')).toHaveLength(1);
  });
});

import { deflateRawSync } from 'node:zlib';
import { RecordDoc, type Delta, type Fields } from '../packages/crdt/src/index.js';
import { jsonBytes, sampleShape, seeded, writeResult } from './support.js';

const BOARD_SIZES = [100, 1_000, 10_000];
const OFFLINE_EDITS = [1, 10, 100, 1_000];

function compressed(delta: Delta): number {
  return deflateRawSync(JSON.stringify(delta)).length;
}

/** A board that two replicas agree on, then a client that edits while the other stays put. */
function offlineCatchUp(records: number, edits: number) {
  const random = seeded(records * 7 + edits);
  const server = new RecordDoc('server', { random });
  const ids: string[] = [];
  for (let i = 0; i < records; i++) ids.push(server.create(sampleShape(random)));

  const client = new RecordDoc('client', { random });
  client.applyDelta(server.fullState());
  const base = server.versions;

  // The same writes as a log of operations, which is what a CRDT that keeps history must send.
  const operations: { id: string; patch: Fields; hlc: number; replica: string }[] = [];
  for (let i = 0; i < edits; i++) {
    const id = ids[Math.floor(random() * ids.length)] as string;
    const patch = { pos: [Math.round(random() * 4000), Math.round(random() * 3000)] };
    server.set(id, patch);
    operations.push({ id, patch, hlc: server.versions['server'] as number, replica: 'server' });
  }

  const started = performance.now();
  const delta = server.deltaSince(base);
  const computeMs = performance.now() - started;
  const full = server.fullState();
  return {
    records,
    edits,
    entries: delta.entries.length,
    deltaBytes: jsonBytes(delta),
    deltaDeflatedBytes: compressed(delta),
    fullStateBytes: jsonBytes(full),
    fullStateDeflatedBytes: compressed(full),
    operationLogBytes: jsonBytes(operations),
    computeMs: Math.round(computeMs * 100) / 100,
  };
}

/** One shape dragged for a long time: the case where state-based deltas differ most from a log. */
function dragCoalescing(writes: number) {
  const random = seeded(writes);
  const doc = new RecordDoc('dragger', { random });
  const id = doc.create(sampleShape(random));
  const base = doc.versions;
  const log: unknown[] = [];
  for (let i = 0; i < writes; i++) {
    const patch = { pos: [i, i] };
    doc.set(id, patch);
    log.push({ id, patch, hlc: doc.versions['dragger'], replica: 'dragger' });
  }
  return { writes, deltaBytes: jsonBytes(doc.deltaSince(base)), operationLogBytes: jsonBytes(log) };
}

/** What a returning client pays once tombstones were compacted past what it has seen. */
function compactedRejoin(records: number) {
  const random = seeded(records + 1);
  const server = new RecordDoc('server', { random });
  const ids: string[] = [];
  for (let i = 0; i < records; i++) ids.push(server.create(sampleShape(random)));
  const client = new RecordDoc('client', { random });
  client.applyDelta(server.fullState());

  server.remove(ids[0] as string);
  const peerCaughtUp = jsonBytes(server.syncFor(client.versions));
  server.compact(Number.MAX_SAFE_INTEGER);
  const reply = server.syncFor(client.versions);
  return {
    records,
    beforeCompaction: peerCaughtUp,
    afterCompaction: jsonBytes(reply),
    full: reply.full === true,
  };
}

const catchUp = BOARD_SIZES.flatMap((records) =>
  OFFLINE_EDITS.map((edits) => offlineCatchUp(records, edits)),
);
for (const row of catchUp) console.log(row);

writeResult('payload', {
  command: 'npm run bench',
  note: 'Bytes of the JSON that goes over the socket. Deflated figures use zlib defaults and are for comparison: the server does not currently enable WebSocket compression.',
  catchUp,
  dragCoalescing: [100, 1_000, 10_000, 100_000].map(dragCoalescing),
  compactedRejoin: BOARD_SIZES.map(compactedRejoin),
});

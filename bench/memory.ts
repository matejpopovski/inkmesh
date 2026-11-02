import { RecordDoc, hlcFromWallTime } from '../packages/crdt/src/index.js';
import { sampleShape, seeded, writeResult } from './support.js';

/**
 * Heap after forced collection, so run with --expose-gc. These are live-object sizes in one V8
 * isolate: they show growth with history length, and are not a claim about a browser tab's total.
 */
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');

function heapMb(): number {
  (gc as () => void)();
  (gc as () => void)();
  return Math.round((process.memoryUsage().heapUsed / 2 ** 20) * 100) / 100;
}

const BOARD = 1_000;
const CHECKPOINTS = [0, 10_000, 100_000, 500_000, 1_000_000, 2_000_000];

/** The same long edit history kept two ways: as registers, and as a retained operation log. */
function longHistory() {
  const random = seeded(99);
  const base = heapMb();
  const doc = new RecordDoc('editor', { random });
  const ids: string[] = [];
  for (let i = 0; i < BOARD; i++) ids.push(doc.create(sampleShape(random)));

  const rows = [];
  let written = 0;
  for (const target of CHECKPOINTS) {
    for (; written < target; written++) {
      const id = ids[Math.floor(random() * BOARD)] as string;
      doc.set(id, { pos: [written % 4000, written % 3000] });
    }
    rows.push({ edits: target, heapMb: Math.round((heapMb() - base) * 100) / 100 });
  }
  return { records: BOARD, rows, stats: doc.stats() };
}

function operationLog() {
  const random = seeded(99);
  const base = heapMb();
  const doc = new RecordDoc('editor', { random });
  const ids: string[] = [];
  for (let i = 0; i < BOARD; i++) ids.push(doc.create(sampleShape(random)));

  const log: unknown[] = [];
  const rows = [];
  let written = 0;
  for (const target of CHECKPOINTS.filter((edits) => edits <= 1_000_000)) {
    for (; written < target; written++) {
      const id = ids[Math.floor(random() * BOARD)] as string;
      const pos = [written % 4000, written % 3000];
      doc.set(id, { pos });
      log.push({ id, field: 'pos', value: pos, hlc: doc.versions['editor'], replica: 'editor' });
    }
    rows.push({ edits: target, heapMb: Math.round((heapMb() - base) * 100) / 100 });
  }
  return { records: BOARD, rows, retained: log.length };
}

/** Shapes drawn and erased forever: tombstones are the only thing that can grow. */
function churn(compact: boolean) {
  const random = seeded(7);
  const base = heapMb();
  let wall = Date.UTC(2026, 0, 1);
  const doc = new RecordDoc('churner', { random, now: () => wall });
  const rows = [];
  let cycles = 0;
  for (const target of [0, 50_000, 100_000, 200_000]) {
    for (; cycles < target; cycles++) {
      wall += 1;
      doc.remove(doc.create({ kind: 'rect', pos: [cycles, cycles], size: [10, 10] }));
      if (compact && cycles % 1_000 === 0) doc.compact(hlcFromWallTime(wall - 5_000));
    }
    rows.push({
      cycles: target,
      heapMb: Math.round((heapMb() - base) * 100) / 100,
      tombstones: doc.stats().tombstones,
    });
  }
  return rows;
}

const history = longHistory();
console.log(history);
const log = operationLog();
console.log(log);
const churnWithout = churn(false);
const churnWith = churn(true);
console.log({ churnWithout, churnWith });

writeResult('memory', {
  command: 'npm run bench',
  note: 'V8 heap after forced GC, relative to the start of each scenario. Editing and logging are single-threaded in one Node process.',
  longHistory: history,
  operationLog: log,
  churn: { withoutCompaction: churnWithout, withCompaction: churnWith },
});

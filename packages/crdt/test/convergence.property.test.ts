import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RecordDoc, dominates } from '../src/index.js';
import { Simulation, scheduleArbitrary } from './support/sim.js';

const RUNS = Number(process.env.INKMESH_PROPERTY_RUNS ?? 200);
const TIMEOUT_MS = 10 * 60_000;

function expectAllEqual(values: readonly string[]): void {
  for (const value of values) expect(value).toBe(values[0]);
}

describe('strong eventual consistency', () => {
  it(
    'converges to identical state after any schedule of edits and faulty delivery',
    () => {
      fc.assert(
        fc.property(scheduleArbitrary(), ({ skews, actions }) => {
          const sim = new Simulation(skews);
          sim.run(actions);
          expect(sim.heal()).toBeLessThanOrEqual(4);
          expectAllEqual(sim.docs.map((doc) => doc.canonicalState()));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    'gives replicas with equal version vectors the same visible board at every step',
    () => {
      fc.assert(
        fc.property(scheduleArbitrary(), ({ skews, actions }) => {
          const sim = new Simulation(skews);
          sim.run(actions, () => {
            for (const a of sim.docs) {
              for (const b of sim.docs) {
                if (
                  a !== b &&
                  dominates(a.versions, b.versions) &&
                  dominates(b.versions, a.versions)
                ) {
                  expect(a.visibleState()).toBe(b.visibleState());
                }
              }
            }
          });
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    'never exposes a partial record, however delivery is interleaved',
    () => {
      fc.assert(
        fc.property(scheduleArbitrary(), ({ skews, actions }) => {
          const sim = new Simulation(skews);
          sim.run(actions, () => {
            for (const doc of sim.docs) {
              for (const record of doc.list()) expect(record.z).not.toBe('');
            }
          });
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    'keeps the same order on every replica with no duplicates',
    () => {
      fc.assert(
        fc.property(scheduleArbitrary(), ({ skews, actions }) => {
          const sim = new Simulation(skews);
          sim.run(actions);
          sim.heal();
          const orders = sim.docs.map((doc) => doc.list().map((record) => record.id));
          expect(new Set(orders[0]).size).toBe(orders[0]?.length);
          expectAllEqual(orders.map((order) => order.join(',')));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );
});

describe('simulation coverage', () => {
  it('reaches gaps, full syncs and compaction, or the properties above prove little', () => {
    const totals = { schedules: 0, withGap: 0, withFullSync: 0, withCompaction: 0, actions: 0 };
    for (const { skews, actions } of fc.sample(scheduleArbitrary(), { numRuns: 300, seed: 7 })) {
      const sim = new Simulation(skews);
      sim.run(actions);
      totals.schedules++;
      totals.actions += actions.length;
      if (sim.counters.gaps > 0) totals.withGap++;
      if (sim.counters.fullSyncs > 0) totals.withFullSync++;
      if (sim.counters.compactions > 0) totals.withCompaction++;
    }
    expect(totals.actions / totals.schedules).toBeGreaterThan(40);
    expect(totals.withGap / totals.schedules).toBeGreaterThan(0.25);
    expect(totals.withCompaction / totals.schedules).toBeGreaterThan(0.25);
    expect(totals.withFullSync / totals.schedules).toBeGreaterThan(0.1);
  });
});

describe('the merge is a join', () => {
  /** Runs a schedule and returns each replica's state as a full-state message. */
  const states = scheduleArbitrary(10, 60).map(({ skews, actions }) => {
    const sim = new Simulation(skews);
    sim.run(actions);
    return sim.docs.map((doc) => doc.fullState());
  });

  const merged = (...parts: ReadonlyArray<ReturnType<RecordDoc['fullState']>>) => {
    const doc = new RecordDoc('observer');
    for (const part of parts) doc.applyDelta(part);
    return doc.canonicalState();
  };

  it(
    'is commutative, associative and idempotent over reachable states',
    () => {
      fc.assert(
        fc.property(states, (parts) => {
          const [a, b] = parts;
          const c = parts[2] ?? a;
          if (!a || !b || !c) return;
          expect(merged(a, b)).toBe(merged(b, a));
          expect(merged(a, b, c)).toBe(merged(c, b, a));
          expect(merged(a, b, a, b)).toBe(merged(a, b));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );
});

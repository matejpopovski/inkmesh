import fc from 'fast-check';
import { Simulation, scheduleArbitrary } from '../packages/crdt/test/support/sim.js';
import { writeResult } from './support.js';

const SCHEDULES = Number(process.env['INKMESH_CONVERGENCE_RUNS'] ?? 100_000);
const SEED = 20261102;

/**
 * Convergence under faults, at a scale too slow for the test suite. Every schedule uses a replica
 * count, clock skews and an interleaving drawn from the seed, and ends with a reliable heal. A
 * single difference between replicas' canonical state counts as a failure.
 */
const totals = {
  schedules: 0,
  actions: 0,
  applied: 0,
  gaps: 0,
  fullSyncs: 0,
  compactions: 0,
  schedulesWithGap: 0,
  schedulesWithFullSync: 0,
  schedulesWithCompaction: 0,
  maxHealRounds: 0,
};
let failures = 0;

const started = performance.now();
fc.assert(
  fc.property(scheduleArbitrary(), ({ skews, actions }) => {
    const sim = new Simulation(skews);
    sim.run(actions);
    const rounds = sim.heal();
    const states = sim.docs.map((doc) => doc.canonicalState());
    const converged = states.every((state) => state === states[0]);
    if (!converged) failures++;

    totals.schedules++;
    totals.actions += actions.length;
    totals.applied += sim.counters.applied;
    totals.gaps += sim.counters.gaps;
    totals.fullSyncs += sim.counters.fullSyncs;
    totals.compactions += sim.counters.compactions;
    if (sim.counters.gaps > 0) totals.schedulesWithGap++;
    if (sim.counters.fullSyncs > 0) totals.schedulesWithFullSync++;
    if (sim.counters.compactions > 0) totals.schedulesWithCompaction++;
    totals.maxHealRounds = Math.max(totals.maxHealRounds, rounds);
    return converged;
  }),
  { numRuns: SCHEDULES, seed: SEED, endOnFailure: true },
);

writeResult('convergence', {
  command: 'npm run bench',
  seed: SEED,
  failures,
  seconds: Math.round((performance.now() - started) / 100) / 10,
  ...totals,
});

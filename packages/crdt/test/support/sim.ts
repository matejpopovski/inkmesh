import fc from 'fast-check';
import {
  RecordDoc,
  joinVectors,
  type Delta,
  type Fields,
  type VersionVector,
} from '../../src/index.js';

/**
 * A deterministic model of replicas talking over a network that loses, repeats and reorders
 * messages. Time, randomness and message delivery all come from the fast-check seed, so a failing
 * schedule shrinks and replays.
 */
export type Action =
  | { kind: 'create'; replica: number; fields: Fields }
  | { kind: 'set'; replica: number; pick: number; fields: Fields }
  | { kind: 'remove'; replica: number; pick: number }
  | {
      kind: 'reorder';
      replica: number;
      pick: number;
      move: 'front' | 'back' | 'forward' | 'backward';
    }
  | { kind: 'send'; from: number; to: number }
  | { kind: 'handshake'; from: number; to: number }
  | { kind: 'deliver'; pick: number; keep: boolean }
  | { kind: 'drop'; pick: number }
  | { kind: 'tick'; ms: number }
  | { kind: 'compact'; replica: number; ageMs: number };

interface Message {
  from: number;
  to: number;
  delta: Delta;
}

const fieldValue = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.constantFrom('ink', 'moss', 'ochre'),
  fc.tuple(fc.integer(), fc.integer()),
);
const fieldNames = fc.constantFrom('pos', 'size', 'color', 'text');
const fields = fc.dictionary(fieldNames, fieldValue, {
  minKeys: 1,
  maxKeys: 3,
}) as fc.Arbitrary<Fields>;

export function actionArbitrary(replicas: number): fc.Arbitrary<Action> {
  const replica = fc.nat({ max: replicas - 1 });
  const pick = fc.nat();
  return fc.oneof(
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('create' as const), replica, fields }) },
    {
      weight: 5,
      arbitrary: fc.record({ kind: fc.constant('set' as const), replica, pick, fields }),
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove' as const), replica, pick }) },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant('reorder' as const),
        replica,
        pick,
        move: fc.constantFrom(
          'front' as const,
          'back' as const,
          'forward' as const,
          'backward' as const,
        ),
      }),
    },
    {
      weight: 6,
      arbitrary: fc.record({ kind: fc.constant('send' as const), from: replica, to: replica }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant('handshake' as const), from: replica, to: replica }),
    },
    {
      weight: 6,
      arbitrary: fc.record({ kind: fc.constant('deliver' as const), pick, keep: fc.boolean() }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('drop' as const), pick }) },
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant('tick' as const), ms: fc.nat({ max: 2_000 }) }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('compact' as const),
        replica,
        ageMs: fc.nat({ max: 3_000 }),
      }),
    },
  );
}

export interface Schedule {
  skews: number[];
  actions: Action[];
}

export interface SimCounters {
  applied: number;
  gaps: number;
  fullSyncs: number;
  compactions: number;
}

export class Simulation {
  readonly docs: RecordDoc[];
  readonly counters: SimCounters = { applied: 0, gaps: 0, fullSyncs: 0, compactions: 0 };
  private wall = Date.UTC(2026, 5, 1);
  private readonly inFlight: Message[] = [];
  /**
   * What each sender believes a receiver has. As in the real client it advances optimistically on
   * send and is only corrected by a handshake, so a lost message makes later deltas leave a gap.
   */
  private readonly beliefs = new Map<string, VersionVector>();
  /** skews[i] is how far replica i's wall clock is from true time. */
  constructor(skews: readonly number[]) {
    this.docs = skews.map((skew, index) => {
      let seed = 0x9e3779b9 * (index + 1);
      return new RecordDoc(`r${index}`, {
        now: () => this.wall + skew,
        random: () => {
          seed = (seed + 0x6d2b79f5) | 0;
          let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
          return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
        },
      });
    });
  }

  run(actions: readonly Action[], onStep?: () => void): void {
    for (const action of actions) {
      this.step(action);
      onStep?.();
    }
  }

  /** Lets every pair exchange reliably until nothing changes. Returns the rounds it took. */
  heal(): number {
    this.inFlight.length = 0;
    for (let round = 1; round <= 8; round++) {
      const before = this.docs.map((doc) => doc.canonicalState()).join('\n');
      for (const source of this.docs) {
        for (const target of this.docs) {
          if (source === target) continue;
          const result = target.applyDelta(source.syncFor(target.versions));
          if (result.status === 'gap') throw new Error('reliable sync must never leave a gap');
        }
      }
      if (this.docs.map((doc) => doc.canonicalState()).join('\n') === before) return round;
    }
    throw new Error('replicas did not reach a fixed point');
  }

  private step(action: Action): void {
    switch (action.kind) {
      case 'create':
        (this.docs[action.replica] as RecordDoc).create(action.fields);
        break;
      case 'set': {
        const doc = this.docs[action.replica] as RecordDoc;
        const id = this.pickLive(doc, action.pick);
        if (id) doc.set(id, action.fields);
        break;
      }
      case 'remove': {
        const doc = this.docs[action.replica] as RecordDoc;
        const id = this.pickLive(doc, action.pick);
        if (id) doc.remove(id);
        break;
      }
      case 'reorder': {
        const doc = this.docs[action.replica] as RecordDoc;
        const id = this.pickLive(doc, action.pick);
        if (id) doc.reorder(id, action.move);
        break;
      }
      case 'send': {
        if (action.from === action.to) break;
        const source = this.docs[action.from] as RecordDoc;
        const link = `${action.from}>${action.to}`;
        const belief = this.beliefs.get(link) ?? {};
        const delta = source.syncFor(belief);
        if (delta.full) this.counters.fullSyncs++;
        this.beliefs.set(link, joinVectors(belief, delta.upto));
        this.inFlight.push({ from: action.from, to: action.to, delta });
        break;
      }
      case 'handshake':
        this.beliefs.set(
          `${action.from}>${action.to}`,
          (this.docs[action.to] as RecordDoc).versions,
        );
        break;
      case 'deliver': {
        if (this.inFlight.length === 0) break;
        const index = action.pick % this.inFlight.length;
        const message = this.inFlight[index] as Message;
        if (!action.keep) this.inFlight.splice(index, 1);
        const result = (this.docs[message.to] as RecordDoc).applyDelta(message.delta);
        if (result.status === 'gap') this.counters.gaps++;
        else this.counters.applied++;
        break;
      }
      case 'drop':
        if (this.inFlight.length > 0) this.inFlight.splice(action.pick % this.inFlight.length, 1);
        break;
      case 'tick':
        this.wall += action.ms;
        break;
      case 'compact': {
        const doc = this.docs[action.replica] as RecordDoc;
        const cutoff = (this.wall - action.ageMs - Date.UTC(2024, 0, 1)) * 4096;
        if (doc.compact(cutoff).length > 0) this.counters.compactions++;
        break;
      }
    }
  }

  private pickLive(doc: RecordDoc, pick: number): string | undefined {
    const live = doc.list();
    return live.length > 0 ? live[pick % live.length]?.id : undefined;
  }
}

/**
 * Schedules long enough to reach the interesting states. fast-check biases arrays towards short
 * lengths by default, and a five-step schedule never compacts or leaves a gap, so the length is
 * forced here and `simulation coverage` in the property suite fails if that stops being true.
 */
export function scheduleArbitrary(minActions = 40, maxActions = 160): fc.Arbitrary<Schedule> {
  return fc.integer({ min: 2, max: 5 }).chain((replicas) =>
    fc.record({
      skews: fc.array(fc.integer({ min: -3_000, max: 3_000 }), {
        minLength: replicas,
        maxLength: replicas,
      }),
      actions: fc.array(actionArbitrary(replicas), {
        minLength: minActions,
        maxLength: maxActions,
        size: 'max',
      }),
    }),
  );
}

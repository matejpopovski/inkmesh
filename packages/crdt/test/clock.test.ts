import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HybridClock, hlcFromWallTime, wallTimeFromHlc } from '../src/clock.js';

describe('HybridClock', () => {
  it('is strictly monotonic when the wall clock stalls or runs backwards', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -5_000, max: 5_000 }), { minLength: 1 }), (jumps) => {
        let wall = Date.UTC(2026, 0, 1);
        const clock = new HybridClock(() => wall);
        let previous = 0;
        for (const jump of jumps) {
          wall += jump;
          const time = clock.tick();
          expect(time).toBeGreaterThan(previous);
          previous = time;
        }
      }),
    );
  });

  it('issues times after anything it has observed', () => {
    const clock = new HybridClock(() => Date.UTC(2026, 0, 1));
    const future = hlcFromWallTime(Date.UTC(2027, 0, 1));
    clock.observe(future);
    expect(clock.tick()).toBeGreaterThan(future);
  });

  it('survives more writes in one millisecond than the logical range holds', () => {
    const clock = new HybridClock(() => Date.UTC(2026, 0, 1));
    let previous = 0;
    for (let i = 0; i < 10_000; i++) {
      const time = clock.tick();
      expect(time).toBeGreaterThan(previous);
      previous = time;
    }
  });

  it('keeps wall time recoverable and stays a safe integer for decades', () => {
    const wall = Date.UTC(2090, 5, 1);
    expect(wallTimeFromHlc(hlcFromWallTime(wall))).toBe(wall);
    expect(Number.isSafeInteger(hlcFromWallTime(wall))).toBe(true);
  });
});

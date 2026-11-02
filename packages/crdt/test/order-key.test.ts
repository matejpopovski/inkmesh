import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidOrderKey, jitteredKeyBetween, keyBetween } from '../src/order-key.js';

/** Builds a sorted list of valid keys by a random series of insertions. */
const sortedKeys = fc
  .array(fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }), {
    minLength: 2,
    maxLength: 60,
  })
  .map((positions) => {
    const keys = ['a0'];
    for (const position of positions) {
      const index = Math.floor(position * (keys.length + 1));
      keys.splice(index, 0, keyBetween(keys[index - 1] ?? null, keys[index] ?? null));
    }
    return keys;
  });

describe('keyBetween', () => {
  it('produces a key strictly between its neighbours at any position', () => {
    fc.assert(
      fc.property(sortedKeys, (keys) => {
        for (let i = 1; i < keys.length; i++) {
          const low = keys[i - 1] as string;
          const high = keys[i] as string;
          expect(low < high).toBe(true);
          const middle = keyBetween(low, high);
          expect(isValidOrderKey(middle)).toBe(true);
          expect(low < middle && middle < high).toBe(true);
        }
      }),
    );
  });

  it('keeps keys short when always appending to the top', () => {
    let key: string | null = null;
    for (let i = 0; i < 100_000; i++) key = keyBetween(key, null);
    expect((key as string).length).toBeLessThanOrEqual(4);
  });

  it('crosses integer length boundaries in both directions', () => {
    expect(keyBetween('az', null)).toBe('b00');
    expect(keyBetween('Zz', null)).toBe('a0');
    expect(keyBetween(null, 'a0')).toBe('Zz');
    expect(keyBetween(null, 'b00')).toBe('az');
    expect(keyBetween(null, 'Z0')).toBe('Yzz');
    expect(keyBetween('Yzz', null)).toBe('Z0');
  });

  it('stays usable when a gap is split thousands of times', () => {
    let low = 'a0';
    const high = 'a1';
    for (let i = 0; i < 5_000; i++) {
      const next = keyBetween(low, high);
      expect(low < next && next < high).toBe(true);
      low = next;
    }
  });

  it('rejects malformed and inverted input', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow(RangeError);
    expect(() => keyBetween('a1', 'a1')).toThrow(RangeError);
    expect(() => keyBetween('a10', null)).toThrow(RangeError);
    expect(() => keyBetween('!', null)).toThrow(RangeError);
    expect(isValidOrderKey('')).toBe(false);
    expect(isValidOrderKey('b0')).toBe(false);
    expect(isValidOrderKey('A' + '0'.repeat(26))).toBe(false);
  });
});

describe('jitteredKeyBetween', () => {
  it('stays strictly inside the gap for any random source', () => {
    fc.assert(
      fc.property(
        sortedKeys,
        fc.nat(),
        fc.infiniteStream(fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true })),
        (keys, pick, randoms) => {
          const index = pick % (keys.length + 1);
          const low = keys[index - 1] ?? null;
          const high = keys[index] ?? null;
          const key = jitteredKeyBetween(low, high, () => randoms.next().value as number);
          expect(isValidOrderKey(key)).toBe(true);
          if (low !== null) expect(low < key).toBe(true);
          if (high !== null) expect(key < high).toBe(true);
        },
      ),
    );
  });

  it('handles a neighbour that extends the deterministic midpoint', () => {
    for (const high of ['a11', 'a1000001', 'a0zzzzz1', 'a1V']) {
      const key = jitteredKeyBetween('a0', high, () => 0.999);
      expect(key > 'a0' && key < high).toBe(true);
    }
  });

  it('separates two replicas filling the same gap', () => {
    const left = jitteredKeyBetween('a0', 'a1');
    const right = jitteredKeyBetween('a0', 'a1');
    expect(left).not.toBe(right);
  });
});

import { describe, expect, it } from 'vitest';
import { claimReplicaId } from '../src/index.js';

class FakeLocks {
  held = new Set<string>();

  async request(
    name: string,
    _options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<void> {
    if (this.held.has(name)) {
      await callback(null);
      return;
    }
    this.held.add(name);
    await Promise.race([callback({ name }), Promise.resolve()]);
  }
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe('claimReplicaId', () => {
  it('gives two live tabs different ids', async () => {
    const [locks, store] = [new FakeLocks(), storage()];
    const first = await claimReplicaId(store, locks);
    const second = await claimReplicaId(store, locks);
    expect(first).not.toBe(second);
  });

  it('reuses a slot once its tab has gone, keeping version vectors small', async () => {
    const store = storage();
    const first = await claimReplicaId(store, new FakeLocks());
    const later = await claimReplicaId(store, new FakeLocks());
    expect(later).toBe(first);
  });

  it('falls back to a throwaway id without Web Locks', async () => {
    const store = storage();
    const first = await claimReplicaId(store, undefined);
    const second = await claimReplicaId(store, undefined);
    expect(first).toMatch(/^[a-z0-9]{1,32}$/);
    expect(first).not.toBe(second);
  });
});

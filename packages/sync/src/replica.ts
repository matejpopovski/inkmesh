const SLOT_PREFIX = 'inkmesh.replica.';

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

function randomReplicaId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

/**
 * Gives this tab a replica id no other live tab holds.
 *
 * A version vector assumes one writer per replica: if two tabs shared an id, a push from one could
 * advance the server past a write the other had not sent, and that write would never be sent.
 * A fresh id per page load would be safe but every session would add a permanent vector entry, so
 * ids live in numbered slots that are reused, guarded by a Web Lock held until the tab closes.
 * Web Locks only exist in secure contexts; without them each load gets a throwaway id.
 */
export async function claimReplicaId(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  locks: LockManagerLike | undefined = globalThis.navigator?.locks,
): Promise<string> {
  if (!locks) return randomReplicaId();

  for (let slot = 0; ; slot++) {
    const name = `${SLOT_PREFIX}${slot}`;
    const claimed = await new Promise<boolean>((resolve) => {
      void locks.request(name, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock === null ? undefined : new Promise<void>(() => {});
      });
    });
    if (!claimed) continue;
    const existing = storage.getItem(name);
    if (existing) return existing;
    const created = randomReplicaId();
    storage.setItem(name, created);
    return created;
  }
}

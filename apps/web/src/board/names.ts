const ADJECTIVES = [
  'warm',
  'quiet',
  'rough',
  'inky',
  'dusty',
  'gentle',
  'crooked',
  'faded',
  'amber',
];
const NOUNS = ['paper', 'margin', 'pencil', 'sketch', 'notebook', 'doodle', 'ribbon', 'graphite'];
const ANIMALS = ['Heron', 'Otter', 'Wren', 'Fox', 'Lynx', 'Marten', 'Finch', 'Badger', 'Hare'];
const PEER_INKS = ['#a8432a', '#2f4a8a', '#4c6b37', '#6d3a63', '#b07a12', '#1f6f6b'];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

export function randomBoardName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(Math.random() * 90 + 10)}`;
}

export function randomDisplayName(): string {
  return pick(ANIMALS);
}

/** Stable per replica, so a collaborator keeps one colour across reconnects. */
export function inkForReplica(replica: string): string {
  let hash = 0;
  for (let i = 0; i < replica.length; i++) hash = (hash * 31 + replica.charCodeAt(i)) | 0;
  return PEER_INKS[Math.abs(hash) % PEER_INKS.length] as string;
}

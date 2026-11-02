import {
  creationStamp,
  isValidOrderKey,
  isValidReplicaId,
  type Delta,
  type Entry,
  type Json,
  type Register,
  type Stamp,
  type VersionVector,
} from '@inkmesh/crdt';

export const PROTOCOL_VERSION = 1;

/** Largest WebSocket frame either side accepts. A long stroke is a few kilobytes. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const MAX_FIELD_NAME = 32;
const MAX_NAME = 40;
const MAX_JSON_DEPTH = 6;

export interface Cursor {
  readonly x: number;
  readonly y: number;
}

export interface Presence {
  readonly name: string;
  readonly color: string;
  readonly cursor: Cursor | null;
}

export type ClientMessage =
  | {
      readonly type: 'hello';
      readonly protocol: number;
      readonly board: string;
      readonly replica: string;
      readonly versions: VersionVector;
    }
  | { readonly type: 'delta'; readonly delta: Delta }
  | { readonly type: 'presence'; readonly presence: Presence }
  | { readonly type: 'ping' };

export type ServerMessage =
  | {
      readonly type: 'welcome';
      readonly delta: Delta;
      readonly peers: readonly { readonly replica: string; readonly presence: Presence }[];
    }
  | { readonly type: 'delta'; readonly delta: Delta }
  | { readonly type: 'ack'; readonly versions: VersionVector }
  | { readonly type: 'compacted'; readonly floor: VersionVector }
  | { readonly type: 'presence'; readonly replica: string; readonly presence: Presence }
  | { readonly type: 'left'; readonly replica: string }
  | { readonly type: 'resync' }
  | { readonly type: 'pong' }
  | { readonly type: 'error'; readonly reason: string };

export function isValidBoardId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStamp(value: unknown): value is Stamp {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isTime(value[0]) &&
    typeof value[1] === 'string' &&
    isValidReplicaId(value[1])
  );
}

function isVersionVector(value: unknown): value is VersionVector {
  if (!isObject(value)) return false;
  return Object.entries(value).every(
    ([replica, time]) => isValidReplicaId(replica) && isTime(time),
  );
}

function isJson(value: unknown, depth = 0): value is Json {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      return Array.isArray(value)
        ? value.every((item) => isJson(item, depth + 1))
        : Object.values(value).every((item) => isJson(item, depth + 1));
    default:
      return false;
  }
}

function isRegister(value: unknown): value is Register {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    isJson(value[0]) &&
    isTime(value[1]) &&
    typeof value[2] === 'string' &&
    isValidReplicaId(value[2])
  );
}

function isRecordId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}\.[0-9a-z]{1,11}$/.test(value))
    return false;
  return isTime(creationStamp(value)[0]);
}

function isEntry(value: unknown): value is Entry {
  if (!isObject(value) || !isRecordId(value['id'])) return false;
  const { regs, tomb } = value;
  if (tomb !== undefined) {
    return regs === undefined && Array.isArray(tomb) && tomb.length > 0 && tomb.every(isStamp);
  }
  if (!isObject(regs)) return false;
  for (const [name, register] of Object.entries(regs)) {
    if (name.length === 0 || name.length > MAX_FIELD_NAME || !isRegister(register)) return false;
  }
  // A bad order key would throw deep inside a later reorder on every replica that merged it.
  const z = regs['z'];
  return z === undefined || (isRegister(z) && typeof z[0] === 'string' && isValidOrderKey(z[0]));
}

function isDelta(value: unknown): value is Delta {
  return (
    isObject(value) &&
    isVersionVector(value['since']) &&
    isVersionVector(value['upto']) &&
    isVersionVector(value['floor']) &&
    Array.isArray(value['entries']) &&
    value['entries'].every(isEntry) &&
    (value['full'] === undefined || value['full'] === true)
  );
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e9;
}

function isPresence(value: unknown): value is Presence {
  if (!isObject(value)) return false;
  const { name, color, cursor } = value;
  if (typeof name !== 'string' || name.length > MAX_NAME) return false;
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return false;
  return (
    cursor === null || (isObject(cursor) && isCoordinate(cursor['x']) && isCoordinate(cursor['y']))
  );
}

/** Validates one frame from a client. Returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(message)) return null;
  switch (message['type']) {
    case 'hello': {
      const { protocol, board, replica, versions } = message;
      const valid =
        typeof protocol === 'number' &&
        typeof board === 'string' &&
        isValidBoardId(board) &&
        typeof replica === 'string' &&
        isValidReplicaId(replica) &&
        isVersionVector(versions);
      return valid ? { type: 'hello', protocol, board, replica, versions } : null;
    }
    case 'delta':
      return isDelta(message['delta']) ? { type: 'delta', delta: message['delta'] } : null;
    case 'presence':
      return isPresence(message['presence'])
        ? { type: 'presence', presence: message['presence'] }
        : null;
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

/**
 * Validates one frame from the server. Clients hold the same data as the server, so this guards
 * against a version mismatch rather than an attacker and only checks what would crash the client.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(message) || typeof message['type'] !== 'string') return null;
  switch (message['type']) {
    case 'welcome':
    case 'delta':
      return isDelta(message['delta']) ? (message as unknown as ServerMessage) : null;
    case 'ack':
      return isVersionVector(message['versions']) ? (message as unknown as ServerMessage) : null;
    case 'compacted':
      return isVersionVector(message['floor']) ? (message as unknown as ServerMessage) : null;
    case 'presence':
      return isPresence(message['presence']) ? (message as unknown as ServerMessage) : null;
    case 'left':
    case 'resync':
    case 'pong':
    case 'error':
      return message as unknown as ServerMessage;
    default:
      return null;
  }
}

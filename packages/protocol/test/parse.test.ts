import { RecordDoc } from '@inkmesh/crdt';
import { describe, expect, it } from 'vitest';
import { isValidBoardId, parseClientMessage, parseServerMessage } from '../src/index.js';

function realDelta() {
  const doc = new RecordDoc('alice');
  const id = doc.create({ pos: [1, 2], text: 'hello' });
  doc.remove(doc.create({ pos: [3, 4] }));
  doc.set(id, { color: '#aa0000' });
  return doc.fullState();
}

describe('parseClientMessage', () => {
  it('accepts every message the client really sends', () => {
    const delta = realDelta();
    const messages = [
      { type: 'hello', protocol: 1, board: 'sketch-1', replica: 'r_1', versions: { a: 5 } },
      { type: 'delta', delta },
      { type: 'presence', presence: { name: 'Ana', color: '#112233', cursor: { x: 1, y: 2 } } },
      { type: 'presence', presence: { name: 'Ana', color: '#112233', cursor: null } },
      { type: 'ping' },
    ];
    for (const message of messages) {
      expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    }
  });

  it.each([
    ['not json', '{'],
    ['an array', '[]'],
    ['unknown type', '{"type":"format-disk"}'],
    ['bad board', '{"type":"hello","protocol":1,"board":"../etc","replica":"a","versions":{}}'],
    ['bad replica', '{"type":"hello","protocol":1,"board":"b","replica":"a.b","versions":{}}'],
    [
      'negative time',
      '{"type":"hello","protocol":1,"board":"b","replica":"a","versions":{"a":-1}}',
    ],
    [
      'unsafe time',
      '{"type":"hello","protocol":1,"board":"b","replica":"a","versions":{"a":1e300}}',
    ],
  ])('rejects %s', (_name, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('rejects deltas that could corrupt a replica', () => {
    const base = { since: {}, upto: {}, floor: {} };
    const bad = [
      { ...base, entries: [{ id: 'no-separator', regs: {} }] },
      { ...base, entries: [{ id: 'a.1', regs: { z: ['not a key!', 1, 'a'] } }] },
      { ...base, entries: [{ id: 'a.1', regs: { z: [7, 1, 'a'] } }] },
      { ...base, entries: [{ id: 'a.1', regs: { pos: [1, 2] } }] },
      { ...base, entries: [{ id: 'a.1', regs: { pos: [1, 1, 'bad.replica'] } }] },
      { ...base, entries: [{ id: 'a.1', tomb: [[1]] }] },
      { ...base, entries: [{ id: 'a.1', tomb: [] }] },
      { ...base, entries: [{ id: 'a.1', tomb: [[1, 'a']], regs: {} }] },
      { ...base, entries: 'lots' },
      { ...base, entries: [], full: false },
    ];
    for (const delta of bad) {
      expect(parseClientMessage(JSON.stringify({ type: 'delta', delta }))).toBeNull();
    }
  });

  it('rejects values nested deep enough to threaten a recursive merge', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 12; i++) deep = [deep];
    const delta = {
      since: {},
      upto: {},
      floor: {},
      entries: [{ id: 'a.1', regs: { pos: [deep, 1, 'a'] } }],
    };
    expect(parseClientMessage(JSON.stringify({ type: 'delta', delta }))).toBeNull();
  });

  it('rejects presence that would inject markup or style', () => {
    const presence = { name: 'x', color: 'red;background:url(x)', cursor: null };
    expect(parseClientMessage(JSON.stringify({ type: 'presence', presence }))).toBeNull();
    const long = { name: 'x'.repeat(41), color: '#000000', cursor: null };
    expect(parseClientMessage(JSON.stringify({ type: 'presence', presence: long }))).toBeNull();
  });
});

describe('parseServerMessage', () => {
  it('accepts real server messages and rejects unknown ones', () => {
    const delta = realDelta();
    expect(parseServerMessage(JSON.stringify({ type: 'delta', delta }))?.type).toBe('delta');
    expect(parseServerMessage(JSON.stringify({ type: 'ack', versions: { a: 1 } }))?.type).toBe(
      'ack',
    );
    expect(parseServerMessage('{"type":"nope"}')).toBeNull();
    expect(parseServerMessage('nonsense')).toBeNull();
  });
});

describe('isValidBoardId', () => {
  it('allows url-safe slugs only', () => {
    expect(isValidBoardId('warm-paper-42')).toBe(true);
    expect(isValidBoardId('')).toBe(false);
    expect(isValidBoardId('Upper')).toBe(false);
    expect(isValidBoardId('a/b')).toBe(false);
    expect(isValidBoardId('-leading')).toBe(false);
    expect(isValidBoardId('x'.repeat(65))).toBe(false);
  });
});

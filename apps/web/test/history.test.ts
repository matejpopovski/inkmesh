import { RecordDoc } from '@inkmesh/crdt';
import { describe, expect, it } from 'vitest';
import { History } from '../src/board/history';

function setup() {
  const doc = new RecordDoc('alice');
  return { doc, history: new History(doc) };
}

describe('History', () => {
  it('undoes and redoes a create', () => {
    const { doc, history } = setup();
    history.record({ kind: 'create', id: doc.create({ n: 1 }) });
    history.undo();
    expect(doc.list()).toHaveLength(0);
    history.redo();
    expect(doc.list()[0]?.fields).toEqual({ n: 1 });
  });

  it('brings a deleted record back with its fields and position in the stack', () => {
    const { doc, history } = setup();
    const low = doc.create({ n: 1 });
    doc.create({ n: 2 });
    const snapshot = doc.get(low);
    doc.remove(low);
    history.record({ kind: 'delete', id: low, snapshot: snapshot as NonNullable<typeof snapshot> });
    history.undo();
    expect(doc.list().map((record) => record.fields['n'])).toEqual([1, 2]);
  });

  it('keeps older steps working after a delete was undone under a new id', () => {
    const { doc, history } = setup();
    const id = doc.create({ color: 'ink' });
    history.record({ kind: 'create', id });
    doc.set(id, { color: 'moss' });
    history.record({
      kind: 'patch',
      id,
      before: { color: 'ink' },
      after: { color: 'moss' },
    });
    const snapshot = doc.get(id);
    doc.remove(id);
    history.record({ kind: 'delete', id, snapshot: snapshot as NonNullable<typeof snapshot> });

    history.undo();
    history.undo();
    expect(doc.list()[0]?.fields['color']).toBe('ink');
    history.undo();
    expect(doc.list()).toHaveLength(0);
  });

  it('skips a step whose shape a collaborator deleted', () => {
    const { doc, history } = setup();
    const kept = doc.create({ n: 1 });
    const gone = doc.create({ n: 2 });
    history.record({ kind: 'create', id: kept });
    history.record({ kind: 'patch', id: gone, before: { n: 2 }, after: { n: 3 } });
    doc.remove(gone);
    history.undo();
    expect(doc.get(kept)).toBeUndefined();
  });

  it('only reverts the fields this user changed', () => {
    const { doc, history } = setup();
    const id = doc.create({ pos: [0, 0], color: 'ink' });
    doc.set(id, { pos: [5, 5] });
    history.record({ kind: 'patch', id, before: { pos: [0, 0] }, after: { pos: [5, 5] } });
    doc.set(id, { color: 'a collaborator changed this' });
    history.undo();
    expect(doc.get(id)?.fields).toEqual({ pos: [0, 0], color: 'a collaborator changed this' });
  });

  it('forgets redo after a new edit', () => {
    const { doc, history } = setup();
    history.record({ kind: 'create', id: doc.create({}) });
    history.undo();
    history.record({ kind: 'create', id: doc.create({}) });
    expect(history.canRedo).toBe(false);
  });
});

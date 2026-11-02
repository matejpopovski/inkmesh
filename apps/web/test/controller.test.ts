import { RecordDoc } from '@inkmesh/crdt';
import { describe, expect, it } from 'vitest';
import { BoardController } from '../src/board/controller';

function board() {
  const doc = new RecordDoc('alice');
  return { doc, controller: new BoardController(doc) };
}

function dragShape(controller: BoardController, from: [number, number], to: [number, number]) {
  controller.pointerDown(from);
  controller.pointerMove([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
  controller.pointerMove(to);
  controller.pointerUp();
}

function addBox(controller: BoardController) {
  controller.setTool('rect');
  dragShape(controller, [100, 100], [200, 200]);
  controller.setTool('select');
}

describe('drawing', () => {
  it('commits a box only when the gesture ends', () => {
    const { doc, controller } = board();
    controller.setTool('rect');
    controller.pointerDown([100, 100]);
    controller.pointerMove([200, 180]);
    expect(doc.list()).toHaveLength(0);
    expect(controller.draft).not.toBeNull();
    controller.pointerUp();
    expect(controller.draft).toBeNull();
    expect(controller.shapes()[0]).toMatchObject({
      kind: 'rect',
      pos: [100, 100],
      size: [100, 80],
    });
  });

  it('ignores a stray click with a shape tool', () => {
    const { doc, controller } = board();
    controller.setTool('ellipse');
    controller.pointerDown([100, 100]);
    controller.pointerUp();
    expect(doc.list()).toHaveLength(0);
  });

  it('keeps a pencil tap as a dot', () => {
    const { controller } = board();
    controller.setTool('pen');
    controller.pointerDown([50, 50]);
    controller.pointerUp();
    expect(controller.shapes()[0]).toMatchObject({ kind: 'stroke', points: [0, 0] });
  });

  it('stores a stroke relative to its own origin, so moving it touches one register', () => {
    const { controller } = board();
    controller.setTool('pen');
    dragShape(controller, [50, 60], [90, 100]);
    const stroke = controller.shapes()[0];
    expect(stroke?.pos).toEqual([50, 60]);
    expect(stroke?.kind === 'stroke' && stroke.points.slice(0, 2)).toEqual([0, 0]);
  });

  it('applies the camera to pointer input', () => {
    const { controller } = board();
    controller.camera = { x: 100, y: 50, zoom: 2 };
    controller.setTool('rect');
    dragShape(controller, [0, 0], [100, 100]);
    expect(controller.shapes()[0]).toMatchObject({ pos: [100, 50], size: [50, 50] });
  });
});

describe('moving and resizing', () => {
  it('writes the drag live and records one undo step', () => {
    const { doc, controller } = board();
    addBox(controller);
    const id = doc.list()[0]?.id as string;
    controller.pointerDown([150, 100]);
    controller.pointerMove([150, 150]);
    expect(controller.shape(id)?.pos).toEqual([100, 150]);
    controller.pointerMove([150, 200]);
    controller.pointerUp();
    expect(controller.shape(id)?.pos).toEqual([100, 200]);
    controller.undo();
    expect(controller.shape(id)?.pos).toEqual([100, 100]);
  });

  it('adds no undo step for a click that does not move anything', () => {
    const { controller } = board();
    addBox(controller);
    controller.pointerDown([150, 100]);
    controller.pointerUp();
    controller.undo();
    expect(controller.shapes()).toHaveLength(0);
  });

  it('resizes from the corner handle', () => {
    const { doc, controller } = board();
    addBox(controller);
    const id = doc.list()[0]?.id as string;
    controller.pointerDown([150, 100]);
    controller.pointerUp();
    dragShape(controller, [200, 200], [300, 260]);
    expect(controller.shape(id)).toMatchObject({ size: [200, 160] });
    controller.undo();
    expect(controller.shape(id)).toMatchObject({ size: [100, 100] });
  });

  it('pans when dragging empty paper', () => {
    const { controller } = board();
    dragShape(controller, [100, 100], [160, 130]);
    expect(controller.camera).toMatchObject({ x: -60, y: -30 });
  });
});

describe('selection', () => {
  it('recolours the selected shape and can undo it', () => {
    const { doc, controller } = board();
    addBox(controller);
    const id = doc.list()[0]?.id as string;
    controller.pointerDown([150, 100]);
    controller.pointerUp();
    controller.setColor('#a8432a');
    expect(controller.shape(id)?.color).toBe('#a8432a');
    controller.undo();
    expect(controller.shape(id)?.color).toBe('#2c2520');
  });

  it('lets go of a shape a collaborator deleted', () => {
    const { doc, controller } = board();
    addBox(controller);
    const id = doc.list()[0]?.id as string;
    controller.pointerDown([150, 100]);
    controller.pointerUp();
    doc.remove(id);
    controller.syncSelection();
    expect(controller.getState().selection).toBeNull();
  });
});

describe('notes', () => {
  it('opens the editor on the new note and records one step per session', () => {
    const { doc, controller } = board();
    controller.setTool('note');
    controller.pointerDown([300, 300]);
    controller.pointerUp();
    const id = controller.getState().editing as string;
    expect(id).toBe(doc.list()[0]?.id);

    controller.editText('h');
    controller.editText('he');
    controller.editText('hello');
    controller.commitEdit();
    expect(controller.shape(id)).toMatchObject({ text: 'hello' });

    controller.undo();
    expect(controller.shape(id)).toMatchObject({ text: '' });
    controller.undo();
    expect(doc.list()).toHaveLength(0);
  });

  it('reopens a note on double click', () => {
    const { doc, controller } = board();
    controller.setTool('note');
    controller.pointerDown([300, 300]);
    controller.pointerUp();
    controller.commitEdit();
    controller.doubleClick([300, 300]);
    expect(controller.getState().editing).toBe(doc.list()[0]?.id);
  });
});

describe('keyboard', () => {
  it('leaves keys alone while a note is being edited', () => {
    const { controller } = board();
    controller.setTool('note');
    controller.pointerDown([300, 300]);
    controller.pointerUp();
    expect(controller.key({ key: 'a', meta: false, shift: false })).toBe(false);
    expect(controller.key({ key: 'Backspace', meta: false, shift: false })).toBe(false);
    expect(controller.getState().tool).toBe('select');
    expect(controller.shapes()).toHaveLength(1);
  });

  it('switches tools and reorders the selection', () => {
    const { doc, controller } = board();
    addBox(controller);
    controller.setTool('rect');
    dragShape(controller, [400, 100], [500, 200]);
    controller.key({ key: 'v', meta: false, shift: false });
    expect(controller.getState().tool).toBe('select');

    const [lower, upper] = doc.list().map((record) => record.id);
    controller.pointerDown([150, 100]);
    controller.pointerUp();
    controller.key({ key: ']', meta: false, shift: false });
    expect(doc.list().map((record) => record.id)).toEqual([upper, lower]);
    controller.undo();
    expect(doc.list().map((record) => record.id)).toEqual([lower, upper]);
  });

  it('undoes and redoes with the usual chords', () => {
    const { controller } = board();
    addBox(controller);
    controller.key({ key: 'z', meta: true, shift: false });
    expect(controller.shapes()).toHaveLength(0);
    controller.key({ key: 'z', meta: true, shift: true });
    expect(controller.shapes()).toHaveLength(1);
  });

  it('pans with the space bar held', () => {
    const { controller } = board();
    addBox(controller);
    controller.key({ key: ' ', meta: false, shift: false });
    dragShape(controller, [150, 100], [170, 100]);
    controller.keyUp(' ');
    expect(controller.shapes()[0]?.pos).toEqual([100, 100]);
    expect(controller.camera.x).toBe(-20);
  });
});

describe('zoom', () => {
  it('keeps the point under the cursor in place', () => {
    const { controller } = board();
    const before = controller.toWorld([300, 200]);
    controller.zoomAt([300, 200], 2.5);
    const after = controller.toWorld([300, 200]);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it('stays within limits', () => {
    const { controller } = board();
    controller.zoomAt([0, 0], 100);
    expect(controller.camera.zoom).toBe(4);
    controller.zoomAt([0, 0], 0.001);
    expect(controller.camera.zoom).toBe(0.2);
  });
});

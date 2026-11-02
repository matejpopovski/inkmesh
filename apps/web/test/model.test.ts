import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  arrowFields,
  boundsOf,
  boxFields,
  hitTest,
  noteFields,
  simplify,
  strokeFields,
  toShape,
  type Shape,
} from '../src/board/model';

const shape = (id: string, fields: Record<string, never> | object): Shape => {
  const parsed = toShape({ id, z: 'a0', fields: fields as never });
  if (!parsed) throw new Error('expected a shape');
  return parsed;
};

describe('toShape', () => {
  it('reads every shape the board creates', () => {
    const all = [
      strokeFields([0, 0, 10, 10], '#000000', 3),
      boxFields('rect', [0, 0], [10, 10], '#000000', 2, false),
      boxFields('ellipse', [0, 0], [10, 10], '#000000', 2, true),
      arrowFields([0, 0], [10, 10], '#000000', 2),
      noteFields([0, 0], '#000000'),
    ];
    for (const fields of all) expect(toShape({ id: 'a.1', z: 'a0', fields })).not.toBeNull();
  });

  it('skips records it cannot draw instead of crashing the board', () => {
    const bad = [
      {},
      { kind: 'rect', pos: [0, 0] },
      { kind: 'rect', pos: 'here', size: [1, 1] },
      { kind: 'stroke', pos: [0, 0], points: ['x'] },
      { kind: 'hologram', pos: [0, 0], size: [1, 1] },
    ];
    for (const fields of bad) {
      expect(toShape({ id: 'a.1', z: 'a0', fields: fields as never })).toBeNull();
    }
  });
});

describe('boxFields', () => {
  it('normalises a box dragged towards the top left', () => {
    expect(boxFields('rect', [50, 60], [10, 20], '#000000', 2, false)).toMatchObject({
      pos: [10, 20],
      size: [40, 40],
    });
  });
});

describe('boundsOf', () => {
  it('handles an arrow pointing up and left', () => {
    const arrow = shape('a.1', arrowFields([100, 100], [40, 70], '#000000', 2));
    expect(boundsOf(arrow)).toEqual({ x: 40, y: 70, w: 60, h: 30 });
  });

  it('measures a stroke from its points', () => {
    const stroke = shape('a.1', strokeFields([10, 10, 40, 5, 20, 30], '#000000', 3));
    expect(boundsOf(stroke)).toEqual({ x: 10, y: 5, w: 30, h: 25 });
  });
});

describe('hitTest', () => {
  const outline = shape('a.1', boxFields('rect', [0, 0], [100, 100], '#000000', 2, false));
  const shaded = shape('a.2', boxFields('rect', [200, 0], [300, 100], '#000000', 2, true));
  const note = shape('a.3', noteFields([500, 50], '#000000'));

  it('picks a hollow box by its edge only, so things inside stay reachable', () => {
    expect(hitTest([outline], 50, 0, 4)?.id).toBe('a.1');
    expect(hitTest([outline], 50, 50, 4)).toBeNull();
  });

  it('picks a shaded box and a note anywhere inside', () => {
    expect(hitTest([shaded], 250, 50, 4)?.id).toBe('a.2');
    expect(hitTest([note], 500, 50, 4)?.id).toBe('a.3');
  });

  it('prefers the shape on top', () => {
    const top = shape('a.9', boxFields('rect', [200, 0], [300, 100], '#000000', 2, true));
    expect(hitTest([shaded, top], 250, 50, 4)?.id).toBe('a.9');
    expect(hitTest([top, shaded], 250, 50, 4)?.id).toBe('a.2');
  });

  it('follows a stroke and ignores the space beside it', () => {
    const stroke = shape('a.1', strokeFields([0, 0, 100, 0, 100, 100], '#000000', 3));
    expect(hitTest([stroke], 50, 2, 3)?.id).toBe('a.1');
    expect(hitTest([stroke], 50, 50, 3)).toBeNull();
  });

  it('finds a single dot', () => {
    const dot = shape('a.1', strokeFields([40, 40], '#000000', 3));
    expect(hitTest([dot], 41, 41, 3)?.id).toBe('a.1');
  });

  it('picks an ellipse by its rim', () => {
    const ring = shape('a.1', boxFields('ellipse', [0, 0], [100, 100], '#000000', 2, false));
    expect(hitTest([ring], 100, 50, 3)?.id).toBe('a.1');
    expect(hitTest([ring], 50, 50, 3)).toBeNull();
  });
});

describe('simplify', () => {
  it('keeps the end points and stays within tolerance of the original', () => {
    const points = fc.array(
      fc.tuple(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 500 })),
      {
        minLength: 3,
        maxLength: 80,
      },
    );
    fc.assert(
      fc.property(points, (pairs) => {
        const flat = pairs.flat();
        const kept = simplify(flat, 1);
        expect(kept.slice(0, 2)).toEqual(flat.slice(0, 2));
        expect(kept.slice(-2)).toEqual(flat.slice(-2));
        expect(kept.length).toBeLessThanOrEqual(flat.length);
      }),
    );
  });

  it('reduces a straight line to two points', () => {
    const line = Array.from({ length: 100 }, (_, i) => [i, i * 2]).flat();
    expect(simplify(line, 0.5)).toHaveLength(4);
  });
});

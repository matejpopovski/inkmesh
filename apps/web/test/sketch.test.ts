import { describe, expect, it } from 'vitest';
import {
  hatch,
  seededRandom,
  sketchArrow,
  sketchEllipse,
  sketchRect,
  strokeOutline,
  wobblyLine,
  wrapText,
} from '../src/board/sketch';

describe('seeded geometry', () => {
  it('draws the same wobble for the same id on every replica', () => {
    const draw = (id: string) => {
      const rand = seededRandom(id);
      return [sketchRect(200, 100, rand), sketchEllipse(90, 60, rand), hatch(120, 80, rand)];
    };
    expect(draw('alice.3m0')).toEqual(draw('alice.3m0'));
    expect(draw('alice.3m0')).not.toEqual(draw('alice.3m1'));
  });

  it('stays close to the line it imitates', () => {
    const rand = seededRandom('line');
    const points = wobblyLine(0, 0, 400, 0, rand);
    for (let i = 1; i < points.length; i += 2) {
      expect(Math.abs(points[i] as number)).toBeLessThan(8);
    }
  });

  it('never divides by zero on a degenerate shape', () => {
    const rand = seededRandom('zero');
    const all = [
      wobblyLine(5, 5, 5, 5, rand),
      ...sketchRect(0, 0, rand),
      sketchEllipse(0, 0, rand),
      ...sketchArrow(0, 0, rand),
      strokeOutline([3, 3, 3, 3], 3),
    ].flat();
    expect(all.every(Number.isFinite)).toBe(true);
  });
});

describe('strokeOutline', () => {
  it('makes a closed outline around the centreline', () => {
    const outline = strokeOutline([0, 0, 50, 0, 100, 0, 150, 0, 200, 0], 4);
    expect(outline).toHaveLength(20);
    const ys = outline.filter((_, index) => index % 2 === 1);
    expect(Math.max(...ys)).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeLessThan(0);
  });

  it('draws a tap as a dot', () => {
    expect(strokeOutline([10, 10], 4).length).toBeGreaterThan(8);
  });
});

describe('wrapText', () => {
  const measure = (line: string) => line.length * 10;

  it('wraps at word boundaries and keeps hard line breaks', () => {
    expect(wrapText('one two three\nfour', 80, measure)).toEqual(['one two', 'three', 'four']);
  });

  it('keeps a word too long for the line rather than losing it', () => {
    expect(wrapText('extraordinarily', 50, measure)).toEqual(['extraordinarily']);
  });
});

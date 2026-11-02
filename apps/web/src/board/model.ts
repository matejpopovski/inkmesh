import type { Fields, LiveRecord } from '@inkmesh/crdt';

export type Vec = readonly [x: number, y: number];

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface ShapeBase {
  readonly id: string;
  readonly pos: Vec;
  readonly color: string;
  readonly width: number;
}

export interface StrokeShape extends ShapeBase {
  readonly kind: 'stroke';
  /** Flat x,y pairs relative to `pos`. Written once, so a move rewrites one register. */
  readonly points: readonly number[];
}

export interface BoxShape extends ShapeBase {
  readonly kind: 'rect' | 'ellipse';
  readonly size: Vec;
  readonly fill: boolean;
}

export interface ArrowShape extends ShapeBase {
  readonly kind: 'arrow';
  /** Vector from tail to head; unlike a box this can point any way. */
  readonly size: Vec;
}

export interface NoteShape extends ShapeBase {
  readonly kind: 'note';
  readonly size: Vec;
  readonly text: string;
}

export type Shape = StrokeShape | BoxShape | ArrowShape | NoteShape;
export type ShapeKind = Shape['kind'];

export const INKS = ['#2c2520', '#a8432a', '#2f4a8a', '#4c6b37', '#6d3a63', '#c08a1e'] as const;

export const NOTE_PAPERS: Readonly<Record<string, string>> = {
  '#2c2520': '#f7e3a1',
  '#a8432a': '#f6c7b4',
  '#2f4a8a': '#bfd8e8',
  '#4c6b37': '#d2e2b8',
  '#6d3a63': '#e4c9e4',
  '#c08a1e': '#fbd98c',
};

export const NOTE_SIZE: Vec = [200, 170];

function asVec(value: unknown): Vec | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value as unknown[];
  return typeof x === 'number' && typeof y === 'number' ? [x, y] : null;
}

/**
 * Reads a record as a shape, or null if it is not one. Records come from other replicas, possibly
 * running a different version, so nothing about their fields is assumed.
 */
export function toShape(record: LiveRecord): Shape | null {
  const { fields, id } = record;
  const pos = asVec(fields['pos']);
  if (!pos) return null;
  const color = typeof fields['color'] === 'string' ? fields['color'] : (INKS[0] as string);
  const width = typeof fields['width'] === 'number' ? fields['width'] : 2;
  const base = { id, pos, color, width };
  const size = asVec(fields['size']);

  switch (fields['kind']) {
    case 'stroke': {
      const points = fields['points'];
      if (!Array.isArray(points) || !points.every((value) => typeof value === 'number')) {
        return null;
      }
      return { ...base, kind: 'stroke', points: points as number[] };
    }
    case 'rect':
    case 'ellipse':
      return size ? { ...base, kind: fields['kind'], size, fill: fields['fill'] === true } : null;
    case 'arrow':
      return size ? { ...base, kind: 'arrow', size } : null;
    case 'note':
      return size ? { ...base, kind: 'note', size, text: String(fields['text'] ?? '') } : null;
    default:
      return null;
  }
}

export function boundsOf(shape: Shape): Box {
  const [x, y] = shape.pos;
  if (shape.kind === 'stroke') {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 1 < shape.points.length; i += 2) {
      const [px, py] = [shape.points[i] as number, shape.points[i + 1] as number];
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    return { x: x + minX, y: y + minY, w: maxX - minX, h: maxY - minY };
  }
  const [w, h] = shape.size;
  return { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) };
}

export function intersects(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

function distanceToSegment(px: number, py: number, seg: readonly number[]): number {
  const [ax, ay, bx, by] = seg as [number, number, number, number];
  const [dx, dy] = [bx - ax, by - ay];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hits(shape: Shape, px: number, py: number, tolerance: number): boolean {
  const [x, y] = shape.pos;
  switch (shape.kind) {
    case 'stroke': {
      const reach = shape.width / 2 + tolerance;
      for (let i = 0; i + 3 < shape.points.length; i += 2) {
        const segment = [
          x + (shape.points[i] as number),
          y + (shape.points[i + 1] as number),
          x + (shape.points[i + 2] as number),
          y + (shape.points[i + 3] as number),
        ];
        if (distanceToSegment(px, py, segment) <= reach) return true;
      }
      return (
        shape.points.length === 2 &&
        Math.hypot(px - x - (shape.points[0] as number), py - y - (shape.points[1] as number)) <=
          reach
      );
    }
    case 'arrow':
      return (
        distanceToSegment(px, py, [x, y, x + shape.size[0], y + shape.size[1]]) <=
        shape.width / 2 + tolerance
      );
    case 'note': {
      const box = boundsOf(shape);
      return px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
    }
    case 'rect': {
      const box = boundsOf(shape);
      const inside = px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
      if (shape.fill) return inside;
      const nearEdge =
        Math.min(
          Math.abs(px - box.x),
          Math.abs(px - (box.x + box.w)),
          Math.abs(py - box.y),
          Math.abs(py - (box.y + box.h)),
        ) <= tolerance;
      const grown =
        px >= box.x - tolerance &&
        px <= box.x + box.w + tolerance &&
        py >= box.y - tolerance &&
        py <= box.y + box.h + tolerance;
      return nearEdge && grown;
    }
    case 'ellipse': {
      const box = boundsOf(shape);
      const [rx, ry] = [Math.max(box.w / 2, 1), Math.max(box.h / 2, 1)];
      const [dx, dy] = [px - (box.x + rx), py - (box.y + ry)];
      const radial = Math.hypot(dx / rx, dy / ry);
      if (shape.fill) return radial <= 1;
      return Math.abs(radial - 1) * Math.min(rx, ry) <= tolerance;
    }
  }
}

/** The topmost shape under a point. `shapes` runs from bottom to top. */
export function hitTest(
  shapes: readonly Shape[],
  x: number,
  y: number,
  tolerance: number,
): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i] as Shape;
    if (hits(shape, x, y, tolerance)) return shape;
  }
  return null;
}

export function resizeHandle(shape: Shape): Vec | null {
  if (shape.kind === 'stroke') return null;
  return [shape.pos[0] + shape.size[0], shape.pos[1] + shape.size[1]];
}

/** Ramer-Douglas-Peucker. A freehand stroke samples far more points than the eye needs. */
export function simplify(points: readonly number[], tolerance: number): number[] {
  const count = points.length / 2;
  if (count <= 2) return [...points];
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: [number, number][] = [[0, count - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    const segment = [
      points[start * 2] as number,
      points[start * 2 + 1] as number,
      points[end * 2] as number,
      points[end * 2 + 1] as number,
    ];
    let [farthest, distance] = [-1, tolerance];
    for (let i = start + 1; i < end; i++) {
      const d = distanceToSegment(points[i * 2] as number, points[i * 2 + 1] as number, segment);
      if (d > distance) [farthest, distance] = [i, d];
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  const kept: number[] = [];
  for (let i = 0; i < count; i++) {
    if (keep[i]) kept.push(points[i * 2] as number, points[i * 2 + 1] as number);
  }
  return kept;
}

/** Tenths of a pixel are invisible, and rounding saves a lot of JSON. */
function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

export function strokeFields(
  absolutePoints: readonly number[],
  color: string,
  width: number,
): Fields {
  const simplified = simplify(absolutePoints, 0.6);
  const [originX, originY] = [simplified[0] as number, simplified[1] as number];
  const points = simplified.map((value, index) =>
    rounded(value - (index % 2 === 0 ? originX : originY)),
  );
  return { kind: 'stroke', pos: [rounded(originX), rounded(originY)], points, color, width };
}

export function boxFields(
  kind: 'rect' | 'ellipse',
  start: Vec,
  end: Vec,
  color: string,
  width: number,
  fill: boolean,
): Fields {
  return {
    kind,
    pos: [rounded(Math.min(start[0], end[0])), rounded(Math.min(start[1], end[1]))],
    size: [rounded(Math.abs(end[0] - start[0])), rounded(Math.abs(end[1] - start[1]))],
    color,
    width,
    fill,
  };
}

export function arrowFields(start: Vec, end: Vec, color: string, width: number): Fields {
  return {
    kind: 'arrow',
    pos: [rounded(start[0]), rounded(start[1])],
    size: [rounded(end[0] - start[0]), rounded(end[1] - start[1])],
    color,
    width,
  };
}

export function noteFields(center: Vec, color: string): Fields {
  return {
    kind: 'note',
    pos: [rounded(center[0] - NOTE_SIZE[0] / 2), rounded(center[1] - NOTE_SIZE[1] / 2)],
    size: [...NOTE_SIZE],
    color,
    width: 2,
    text: '',
  };
}

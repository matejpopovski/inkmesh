/**
 * Hand-drawn geometry as plain numbers, so that it can be tested without a canvas.
 *
 * Everything is seeded from the record id: every replica draws the same wobble for the same shape,
 * and two clients with one document produce identical pixels. The end-to-end suite relies on that.
 */
export type Rand = () => number;

export type Polyline = readonly number[];

export function seededRandom(seed: string): Rand {
  let hash = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(rand: Rand, amount: number): number {
  return (rand() - 0.5) * 2 * amount;
}

/** A straight line as a person draws one: a slight bow, a tremor, and ends that miss by a hair. */
export function wobblyLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rand: Rand,
  roughness = 1,
): Polyline {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < 1) return [x1, y1, x2, y2];
  const [normalX, normalY] = [-(y2 - y1) / length, (x2 - x1) / length];
  const steps = Math.max(2, Math.min(7, Math.ceil(length / 55)));
  const amplitude = Math.min(1.8, length * 0.018) * roughness;
  const bow = jitter(rand, Math.min(4, length * 0.02)) * roughness;

  const points: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const offset = Math.sin(Math.PI * t) * bow + jitter(rand, amplitude);
    points.push(x1 + (x2 - x1) * t + normalX * offset, y1 + (y2 - y1) * t + normalY * offset);
  }
  return points;
}

export function sketchRect(w: number, h: number, rand: Rand): Polyline[] {
  const overshoot = () => 1 + rand() * 3;
  return [
    wobblyLine(-overshoot(), jitter(rand, 1), w + overshoot(), jitter(rand, 1), rand),
    wobblyLine(w + jitter(rand, 1), -overshoot(), w + jitter(rand, 1), h + overshoot(), rand),
    wobblyLine(w + overshoot(), h + jitter(rand, 1), -overshoot(), h + jitter(rand, 1), rand),
    wobblyLine(jitter(rand, 1), h + overshoot(), jitter(rand, 1), -overshoot(), rand),
  ];
}

export function sketchEllipse(w: number, h: number, rand: Rand): Polyline {
  const [rx, ry] = [w / 2, h / 2];
  const perimeter = 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2);
  const steps = Math.max(12, Math.min(48, Math.round(perimeter / 14)));
  const start = rand() * Math.PI * 2;
  // Going a little past a full turn leaves the small overlap of a pen closing a circle.
  const sweep = Math.PI * 2 * (1.04 + rand() * 0.05);
  const drift = 0.015 + rand() * 0.02;

  const points: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = start + sweep * t;
    const radius = 1 + drift * (t - 0.5) + jitter(rand, 0.008);
    points.push(rx + rx * radius * Math.cos(angle), ry + ry * radius * Math.sin(angle));
  }
  return points;
}

/** Diagonal pencil shading across a `w` by `h` box. The caller clips it to the shape. */
export function hatch(w: number, h: number, rand: Rand, gap = 9): Polyline[] {
  const lines: Polyline[] = [];
  const span = w + h;
  for (let d = gap / 2; d < span; d += gap + jitter(rand, 1.4)) {
    const [x1, y1] = d <= h ? [0, d] : [d - h, h];
    const [x2, y2] = d <= w ? [d, 0] : [w, d - w];
    lines.push(wobblyLine(x1, y1, x2, y2, rand, 0.7));
  }
  return lines;
}

export function sketchArrow(dx: number, dy: number, rand: Rand): Polyline[] {
  const length = Math.hypot(dx, dy);
  const shaft = wobblyLine(0, 0, dx, dy, rand);
  const barb = Math.min(22, Math.max(10, length * 0.22));
  const heading = Math.atan2(dy, dx);
  const side = (angle: number) =>
    wobblyLine(
      dx,
      dy,
      dx - barb * Math.cos(heading + angle),
      dy - barb * Math.sin(heading + angle),
      rand,
      0.6,
    );
  return [shaft, side(0.5 + jitter(rand, 0.08)), side(-0.5 + jitter(rand, 0.08))];
}

/**
 * Turns a centreline into a filled outline whose width follows the pen: thin when moving fast,
 * thick when slow, tapered at both ends. Point spacing stands in for speed, since pointer events
 * arrive at a steady rate and simplification keeps more points where the line bends.
 */
export function strokeOutline(points: readonly number[], width: number): Polyline {
  const count = points.length / 2;
  if (count === 1) return circle(points[0] as number, points[1] as number, width * 0.6);

  const radii: number[] = [];
  let smoothed = 1;
  for (let i = 0; i < count; i++) {
    const j = Math.min(i, count - 2);
    const step = Math.hypot(
      (points[j * 2 + 2] as number) - (points[j * 2] as number),
      (points[j * 2 + 3] as number) - (points[j * 2 + 1] as number),
    );
    const target = 1.2 - Math.min(0.7, step / 80);
    smoothed += (target - smoothed) * 0.4;
    const edge = Math.min(i, count - 1 - i);
    const taper = 0.35 + 0.65 * Math.min(1, edge / 3);
    radii.push((width / 2) * smoothed * taper);
  }

  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < count; i++) {
    const [previous, next] = [Math.max(0, i - 1), Math.min(count - 1, i + 1)];
    const dx = (points[next * 2] as number) - (points[previous * 2] as number);
    const dy = (points[next * 2 + 1] as number) - (points[previous * 2 + 1] as number);
    const length = Math.hypot(dx, dy) || 1;
    const radius = radii[i] as number;
    const [nx, ny] = [(-dy / length) * radius, (dx / length) * radius];
    const [x, y] = [points[i * 2] as number, points[i * 2 + 1] as number];
    left.push(x + nx, y + ny);
    right.push(x - nx, y - ny);
  }

  const outline = left;
  for (let i = right.length - 2; i >= 0; i -= 2) {
    outline.push(right[i] as number, right[i + 1] as number);
  }
  return outline;
}

function circle(x: number, y: number, radius: number): Polyline {
  const points: number[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    points.push(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
  }
  return points;
}

export function rectOutline(w: number, h: number): Polyline {
  return [0, 0, w, 0, w, h, 0, h];
}

export function ellipseOutline(w: number, h: number): Polyline {
  const points: number[] = [];
  for (let i = 0; i < 40; i++) {
    const angle = (i / 40) * Math.PI * 2;
    points.push(w / 2 + (w / 2) * Math.cos(angle), h / 2 + (h / 2) * Math.sin(angle));
  }
  return points;
}

/** A small tilt, seeded per note, so a wall of notes looks stuck on by hand. */
export function noteTilt(rand: Rand): number {
  return jitter(rand, 0.022);
}

export function wrapText(
  text: string,
  maxWidth: number,
  measure: (line: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

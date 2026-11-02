import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fields } from '../packages/crdt/src/index.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function environment() {
  return {
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
  };
}

export function writeResult(name: string, body: object): void {
  const path = resolve(REPO_ROOT, 'results', `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ environment: environment(), ...body }, null, 2)}\n`);
  console.log(`wrote results/${name}.json`);
}

/** A small seeded generator, so that every run measures the same board. */
export function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** The mix a real board has: mostly pencil strokes, then boxes, then notes. */
export function sampleShape(random: () => number): Fields {
  const roll = random();
  const pos = [Math.round(random() * 4000), Math.round(random() * 3000)];
  if (roll < 0.6) {
    const count = 20 + Math.floor(random() * 80);
    const points: number[] = [];
    let [x, y] = [0, 0];
    for (let i = 0; i < count; i++) {
      x = Math.round((x + (random() - 0.5) * 12) * 10) / 10;
      y = Math.round((y + (random() - 0.5) * 12) * 10) / 10;
      points.push(x, y);
    }
    return { kind: 'stroke', pos, points, color: '#2c2520', width: 3 };
  }
  if (roll < 0.85) {
    const size = [Math.round(random() * 300), Math.round(random() * 200)];
    return { kind: 'rect', pos, size, color: '#a8432a', width: 2.5, fill: random() < 0.3 };
  }
  const text = 'a few words on a sticky note '.repeat(1 + Math.floor(random() * 3)).trim();
  return { kind: 'note', pos, size: [200, 170], color: '#2f4a8a', width: 2, text };
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

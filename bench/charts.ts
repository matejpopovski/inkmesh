import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './support.js';

/**
 * Renders the README charts from results/*.json. Static SVG, because GitHub shows these as images:
 * there is no hover layer, so the README prints the same numbers as tables.
 *
 * Series colours passed the palette validator against the paper surface: lightness, chroma, CVD
 * separation (worst adjacent pair 21.1) and contrast.
 */
const SURFACE = '#f4ead5';
const GRID = '#e0d4bb';
const INK = '#2c2520';
const MUTED = '#6c5f52';
const SERIES = ['#a8432a', '#4066b4', '#5f8240'] as const;

const WIDTH = 720;
const HEIGHT = 380;
const PLOT = { left: 74, right: 150, top: 62, bottom: 52 };
const LABEL_GAP = 17;

interface Series {
  name: string;
  points: readonly (readonly [number, number])[];
}

interface ChartOptions {
  title: string;
  subtitle: string;
  xLabel: string;
  xTicks: readonly number[];
  yTicks: readonly number[];
  x: (value: number) => number;
  y: (value: number) => number;
  format: (value: number) => string;
  formatX: (value: number) => string;
}

function compactBytes(value: number): string {
  if (value >= 1e6) return `${Math.round(value / 1e5) / 10} MB`;
  if (value >= 1e3) return `${Math.round(value / 100) / 10} kB`;
  return `${Math.round(value)} B`;
}

/** Pushes end labels apart when series finish too close together to read. */
function labelPositions(ends: readonly number[]): number[] {
  const order = ends
    .map((_, index) => index)
    .sort((a, b) => (ends[a] as number) - (ends[b] as number));
  const placed = [...ends];
  for (let i = 1; i < order.length; i++) {
    const [above, below] = [order[i - 1] as number, order[i] as number];
    const gap = (placed[below] as number) - (placed[above] as number);
    if (gap < LABEL_GAP) {
      const shift = (LABEL_GAP - gap) / 2;
      placed[above] = (placed[above] as number) - shift;
      placed[below] = (placed[below] as number) + shift;
    }
  }
  return placed;
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}

function chart(series: readonly Series[], options: ChartOptions): string {
  const innerWidth = WIDTH - PLOT.left - PLOT.right;
  const innerHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const sx = (value: number) => PLOT.left + options.x(value) * innerWidth;
  const sy = (value: number) => PLOT.top + (1 - options.y(value)) * innerHeight;

  const gridlines = options.yTicks.map(
    (tick) =>
      `<line x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${sy(tick)}" y2="${sy(tick)}" stroke="${GRID}"/>` +
      `<text x="${PLOT.left - 10}" y="${sy(tick) + 4}" text-anchor="end" fill="${MUTED}">${options.format(tick)}</text>`,
  );
  const xTicks = options.xTicks.map(
    (tick) =>
      `<text x="${sx(tick)}" y="${HEIGHT - PLOT.bottom + 20}" text-anchor="middle" fill="${MUTED}">${options.formatX(tick)}</text>`,
  );

  const legend = series.map((item, index) => {
    const left = PLOT.left + index * 170;
    return (
      `<line x1="${left}" x2="${left + 18}" y1="50" y2="50" stroke="${SERIES[index]}" stroke-width="2" stroke-linecap="round"/>` +
      `<text x="${left + 24}" y="54" fill="${INK}">${escapeXml(item.name)}</text>`
    );
  });

  const ends = series.map((item) => sy((item.points.at(-1) as readonly [number, number])[1]));
  const labels = labelPositions(ends);

  const lines = series.map((item, index) => {
    const color = SERIES[index];
    const path = item.points.map(([x, y]) => `${sx(x)},${sy(y)}`).join(' ');
    const dots = item.points
      .map(
        ([x, y]) =>
          `<circle cx="${sx(x)}" cy="${sy(y)}" r="4" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`,
      )
      .join('');
    const [lastX, lastY] = item.points.at(-1) as readonly [number, number];
    const labelY = labels[index] as number;
    const moved = Math.abs(labelY - sy(lastY)) > 0.5;
    const leader = moved
      ? `<line x1="${sx(lastX) + 6}" y1="${sy(lastY)}" x2="${sx(lastX) + 20}" y2="${labelY}" stroke="${MUTED}"/>`
      : '';
    const labelX = sx(lastX) + (moved ? 24 : 10);
    const label = `${leader}<text x="${labelX}" y="${labelY + 4}" fill="${INK}">${options.format(lastY)}</text>`;
    return `<polyline points="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${dots}${label}`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(options.title)}" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="13">
<rect width="${WIDTH}" height="${HEIGHT}" fill="${SURFACE}"/>
<text x="${PLOT.left}" y="24" font-size="16" font-weight="600" fill="${INK}">${escapeXml(options.title)}</text>
<text x="${PLOT.left + 0}" y="${HEIGHT - 10}" fill="${MUTED}">${escapeXml(options.subtitle)}</text>
${legend.join('\n')}
${gridlines.join('\n')}
${xTicks.join('\n')}
<text x="${WIDTH - PLOT.right}" y="${HEIGHT - PLOT.bottom + 36}" text-anchor="end" fill="${MUTED}">${escapeXml(options.xLabel)}</text>
${lines.join('\n')}
</svg>
`;
}

function readResult<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'results', `${name}.json`), 'utf8')) as T;
}

interface PayloadResult {
  catchUp: {
    records: number;
    edits: number;
    deltaBytes: number;
    fullStateBytes: number;
    operationLogBytes: number;
  }[];
}

interface MemoryResult {
  longHistory: { rows: { edits: number; heapMb: number }[] };
  operationLog: { rows: { edits: number; heapMb: number }[] };
}

const payload = readResult<PayloadResult>('payload');
const board = payload.catchUp.filter((row) => row.records === 10_000);
const logScale = (min: number, max: number) => (value: number) =>
  (Math.log10(value) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));

const edits = board.map((row) => row.edits);
const smallest = Math.min(...board.map((row) => Math.min(row.deltaBytes, row.operationLogBytes)));
const largest = Math.max(...board.map((row) => row.fullStateBytes));
const yMin = 10 ** Math.floor(Math.log10(smallest));
const yMax = 10 ** Math.ceil(Math.log10(largest));
const decades: number[] = [];
for (let tick = yMin; tick <= yMax; tick *= 10) decades.push(tick);

writeFileSync(
  resolve(REPO_ROOT, 'docs/payload.svg'),
  chart(
    [
      { name: 'Delta sent', points: board.map((row) => [row.edits, row.deltaBytes]) },
      { name: 'Operation log', points: board.map((row) => [row.edits, row.operationLogBytes]) },
      { name: 'Full state', points: board.map((row) => [row.edits, row.fullStateBytes]) },
    ],
    {
      title: 'Catching up one client on a 10,000-record board',
      subtitle: 'Both axes are logarithmic. From results/payload.json.',
      xLabel: 'edits missed',
      xTicks: edits,
      yTicks: decades,
      x: logScale(Math.min(...edits), Math.max(...edits)),
      y: logScale(yMin, yMax),
      format: compactBytes,
      formatX: (value) => value.toLocaleString('en-US'),
    },
  ),
);

const memory = readResult<MemoryResult>('memory');
const registers = memory.longHistory.rows;
const log = memory.operationLog.rows;
const topEdits = Math.max(...registers.map((row) => row.edits));
const topHeap = Math.ceil(Math.max(...log.map((row) => row.heapMb)) / 50) * 50;
const heapTicks: number[] = [];
for (let tick = 0; tick <= topHeap; tick += 50) heapTicks.push(tick);

writeFileSync(
  resolve(REPO_ROOT, 'docs/memory.svg'),
  chart(
    [
      { name: 'Registers', points: registers.map((row) => [row.edits, row.heapMb]) },
      { name: 'Operation log', points: log.map((row) => [row.edits, row.heapMb]) },
    ],
    {
      title: 'Heap under a long edit history on 1,000 records',
      subtitle: 'V8 heap after forced GC. The log is a plain baseline, not a CRDT library.',
      xLabel: 'edits',
      xTicks: [0, 500_000, 1_000_000, 1_500_000, 2_000_000].filter((tick) => tick <= topEdits),
      yTicks: heapTicks,
      x: (value) => value / topEdits,
      y: (value) => value / topHeap,
      format: (value) => `${Math.round(value)} MB`,
      formatX: (value) => (value === 0 ? '0' : `${value / 1_000_000}M`),
    },
  ),
);

console.log('wrote docs/payload.svg and docs/memory.svg');

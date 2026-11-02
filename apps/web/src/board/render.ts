import type { Draft, Camera } from './controller';
import { NOTE_PAPERS, boundsOf, intersects, resizeHandle, type Box, type Shape } from './model';
import {
  ellipseOutline,
  hatch,
  noteTilt,
  rectOutline,
  seededRandom,
  sketchArrow,
  sketchEllipse,
  sketchRect,
  strokeOutline,
  wrapText,
  wobblyLine,
  type Polyline,
} from './sketch';

const NOTE_FONT = '600 25px Caveat, cursive';
const NOTE_LINE_HEIGHT = 27;
const NOTE_PADDING = 16;
const PENCIL_PASSES = 2;

interface Geometry {
  /** Pencil lines, drawn with a thin stroke. */
  readonly lines: Path2D[];
  /** Solid ink, for freehand strokes. */
  readonly solid: Path2D | null;
  /** Shading, clipped to `clip`. */
  readonly shading: Path2D | null;
  readonly clip: Path2D | null;
  readonly tilt: number;
}

function traced(path: Path2D, points: Polyline, closed: boolean): void {
  const count = points.length / 2;
  if (count < 2) return;
  path.moveTo(points[0] as number, points[1] as number);
  if (count === 2) {
    path.lineTo(points[2] as number, points[3] as number);
    return;
  }
  // Curving through segment midpoints turns a few samples into a smooth pencil line.
  for (let i = 1; i < count - 1; i++) {
    const [x, y] = [points[i * 2] as number, points[i * 2 + 1] as number];
    const [nextX, nextY] = [points[i * 2 + 2] as number, points[i * 2 + 3] as number];
    path.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
  }
  path.lineTo(points[(count - 1) * 2] as number, points[(count - 1) * 2 + 1] as number);
  if (closed) path.closePath();
}

function pathOf(polylines: readonly Polyline[], closed = false): Path2D {
  const path = new Path2D();
  for (const points of polylines) traced(path, points, closed);
  return path;
}

function geometryOf(shape: Shape): Geometry {
  const rand = seededRandom(shape.id);
  const empty = { lines: [], solid: null, shading: null, clip: null, tilt: 0 };

  switch (shape.kind) {
    case 'stroke':
      return { ...empty, solid: pathOf([strokeOutline(shape.points, shape.width)], true) };
    case 'rect':
    case 'ellipse': {
      const [w, h] = shape.size;
      const passes: Path2D[] = [];
      for (let pass = 0; pass < PENCIL_PASSES; pass++) {
        passes.push(
          pathOf(shape.kind === 'rect' ? sketchRect(w, h, rand) : [sketchEllipse(w, h, rand)]),
        );
      }
      if (!shape.fill) return { ...empty, lines: passes };
      return {
        ...empty,
        lines: passes,
        shading: pathOf(hatch(w, h, rand)),
        clip: pathOf([shape.kind === 'rect' ? rectOutline(w, h) : ellipseOutline(w, h)], true),
      };
    }
    case 'arrow': {
      const passes: Path2D[] = [];
      for (let pass = 0; pass < PENCIL_PASSES; pass++) {
        passes.push(pathOf(sketchArrow(shape.size[0], shape.size[1], rand)));
      }
      return { ...empty, lines: passes };
    }
    case 'note': {
      const [w, h] = shape.size;
      const edge = [
        wobblyLine(0, 0, w, 0, rand, 0.4),
        wobblyLine(w, 0, w, h, rand, 0.4),
        wobblyLine(w, h, 0, h, rand, 0.4),
        wobblyLine(0, h, 0, 0, rand, 0.4),
      ];
      return { ...empty, solid: pathOf([edge.flat()], true), tilt: noteTilt(rand) };
    }
  }
}

function geometryKey(shape: Shape): string {
  // Position is left out on purpose: moving a shape must not re-roll its wobble, and it should
  // not cost a rebuild either.
  switch (shape.kind) {
    case 'stroke':
      return `${shape.id}:${shape.width}`;
    case 'rect':
    case 'ellipse':
      return `${shape.id}:${shape.size.join()}:${shape.fill}`;
    case 'arrow':
    case 'note':
      return `${shape.id}:${shape.size.join()}`;
  }
}

function drawNoteText(ctx: CanvasRenderingContext2D, text: string, w: number, h: number): void {
  ctx.font = NOTE_FONT;
  ctx.fillStyle = '#2c2520';
  ctx.textBaseline = 'top';
  const lines = wrapText(text, w - NOTE_PADDING * 2, (line) => ctx.measureText(line).width);
  const visible = Math.floor((h - NOTE_PADDING * 2) / NOTE_LINE_HEIGHT);
  lines.slice(0, visible).forEach((line, index) => {
    ctx.fillText(line, NOTE_PADDING, NOTE_PADDING + 6 + index * NOTE_LINE_HEIGHT);
  });
}

export interface Scene {
  readonly shapes: readonly Shape[];
  readonly camera: Camera;
  readonly draft: Draft | null;
  readonly draftColor: string;
  readonly draftFill: boolean;
  readonly selection: string | null;
  /** The note open in the text editor, whose text the editor draws instead. */
  readonly editing: string | null;
}

export class BoardRenderer {
  private readonly cache = new Map<string, Geometry>();

  render(
    ctx: CanvasRenderingContext2D,
    scene: Scene,
    width: number,
    height: number,
    ratio: number,
  ): void {
    const { camera } = scene;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width * ratio, height * ratio);
    ctx.setTransform(
      ratio * camera.zoom,
      0,
      0,
      ratio * camera.zoom,
      -camera.x * camera.zoom * ratio,
      -camera.y * camera.zoom * ratio,
    );
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const viewport: Box = {
      x: camera.x - 40,
      y: camera.y - 40,
      w: width / camera.zoom + 80,
      h: height / camera.zoom + 80,
    };

    let selected: Shape | null = null;
    for (const shape of scene.shapes) {
      if (shape.id === scene.selection) selected = shape;
      if (intersects(boundsOf(shape), viewport)) {
        this.drawShape(ctx, shape, scene.editing === shape.id);
      }
    }
    if (scene.draft) this.drawDraft(ctx, scene);
    if (selected) this.drawSelection(ctx, selected, camera.zoom);
    this.pruneCache(scene.shapes.length);
  }

  private geometry(shape: Shape): Geometry {
    const key = geometryKey(shape);
    let geometry = this.cache.get(key);
    if (!geometry) {
      geometry = geometryOf(shape);
      this.cache.set(key, geometry);
    }
    return geometry;
  }

  private drawShape(ctx: CanvasRenderingContext2D, shape: Shape, editing: boolean): void {
    const geometry = this.geometry(shape);
    ctx.save();
    ctx.translate(shape.pos[0], shape.pos[1]);

    if (shape.kind === 'note') {
      this.drawNote(ctx, shape.size[0], shape.size[1], shape.color, geometry);
      if (!editing) drawNoteText(ctx, shape.text, shape.size[0], shape.size[1]);
      ctx.restore();
      return;
    }

    if (geometry.solid) {
      ctx.fillStyle = shape.color;
      ctx.fill(geometry.solid);
    }
    if (geometry.shading && geometry.clip) {
      ctx.save();
      ctx.clip(geometry.clip);
      ctx.strokeStyle = shape.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.4;
      ctx.stroke(geometry.shading);
      ctx.restore();
    }
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.width * 0.72;
    ctx.globalAlpha = 0.86;
    for (const line of geometry.lines) ctx.stroke(line);
    ctx.restore();
  }

  private drawNote(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    color: string,
    geometry: Geometry,
  ): void {
    ctx.translate(w / 2, h / 2);
    ctx.rotate(geometry.tilt);
    ctx.translate(-w / 2, -h / 2);

    ctx.save();
    ctx.translate(3, 4);
    ctx.fillStyle = 'rgba(70, 48, 22, 0.18)';
    if (geometry.solid) ctx.fill(geometry.solid);
    ctx.restore();

    ctx.fillStyle = NOTE_PAPERS[color] ?? '#f7e3a1';
    if (geometry.solid) ctx.fill(geometry.solid);

    ctx.save();
    ctx.translate(w / 2, -3);
    ctx.rotate(-0.03);
    ctx.fillStyle = 'rgba(224, 205, 160, 0.72)';
    ctx.fillRect(-36, -9, 72, 20);
    ctx.restore();
  }

  private drawDraft(ctx: CanvasRenderingContext2D, scene: Scene): void {
    const draft = scene.draft as Draft;
    const rand = seededRandom('draft');
    ctx.save();
    ctx.strokeStyle = scene.draftColor;
    ctx.fillStyle = scene.draftColor;
    if (draft.kind === 'stroke') {
      ctx.fill(pathOf([strokeOutline(draft.points, 3)], true));
    } else {
      const [x, y] = [
        draft.kind === 'arrow' ? draft.start[0] : Math.min(draft.start[0], draft.end[0]),
        draft.kind === 'arrow' ? draft.start[1] : Math.min(draft.start[1], draft.end[1]),
      ];
      const [w, h] = [draft.end[0] - draft.start[0], draft.end[1] - draft.start[1]];
      ctx.translate(x, y);
      ctx.lineWidth = 1.8;
      ctx.globalAlpha = 0.8;
      if (draft.kind === 'arrow') ctx.stroke(pathOf(sketchArrow(w, h, rand)));
      else if (draft.kind === 'rect')
        ctx.stroke(pathOf(sketchRect(Math.abs(w), Math.abs(h), rand)));
      else ctx.stroke(pathOf([sketchEllipse(Math.abs(w), Math.abs(h), rand)]));
    }
    ctx.restore();
  }

  private drawSelection(ctx: CanvasRenderingContext2D, shape: Shape, zoom: number): void {
    const box = boundsOf(shape);
    const pad = 8 / zoom;
    ctx.save();
    ctx.strokeStyle = '#a8432a';
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([7 / zoom, 6 / zoom]);
    ctx.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2);
    ctx.setLineDash([]);
    const handle = resizeHandle(shape);
    if (handle) {
      ctx.fillStyle = '#fbf4e4';
      ctx.beginPath();
      ctx.arc(handle[0], handle[1], 6 / zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private pruneCache(liveShapes: number): void {
    // Resizing leaves one stale entry per step. Clearing occasionally is simpler than tracking
    // which keys are still in use, and rebuilding a few paths costs less than a frame.
    if (this.cache.size > liveShapes * 3 + 256) this.cache.clear();
  }
}

import type { Fields, Reorder, RecordDoc } from '@inkmesh/crdt';
import { History } from './history';
import {
  INKS,
  arrowFields,
  boxFields,
  hitTest,
  noteFields,
  resizeHandle,
  strokeFields,
  toShape,
  type Shape,
  type Vec,
} from './model';

export type Tool = 'select' | 'pen' | 'rect' | 'ellipse' | 'arrow' | 'note' | 'hand';

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export type Draft =
  | { readonly kind: 'stroke'; readonly points: readonly number[] }
  | { readonly kind: 'rect' | 'ellipse' | 'arrow'; readonly start: Vec; readonly end: Vec };

/** What the React toolbar renders. Replaced, never mutated, so it works with useSyncExternalStore. */
export interface ControllerState {
  readonly tool: Tool;
  readonly color: string;
  readonly fill: boolean;
  readonly selection: string | null;
  readonly editing: string | null;
  readonly zoom: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

type Gesture =
  | { readonly kind: 'pan'; readonly lastX: number; readonly lastY: number }
  | { readonly kind: 'move'; readonly id: string; readonly offset: Vec; readonly from: Vec }
  | { readonly kind: 'resize'; readonly id: string; readonly from: Vec; readonly origin: Vec }
  | { readonly kind: 'draw' };

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const HIT_TOLERANCE_PX = 6;
const HANDLE_RADIUS_PX = 10;
const MIN_NEW_SHAPE_PX = 4;

const TOOL_KEYS: Readonly<Record<string, Tool>> = {
  v: 'select',
  p: 'pen',
  r: 'rect',
  o: 'ellipse',
  a: 'arrow',
  n: 'note',
  h: 'hand',
};

const REORDER_KEYS: Readonly<Record<string, Reorder>> = {
  ']': 'forward',
  '[': 'backward',
  '}': 'front',
  '{': 'back',
};

export interface KeyInput {
  readonly key: string;
  readonly meta: boolean;
  readonly shift: boolean;
}

/**
 * Everything a pointer or key can do to the board, with no DOM in sight.
 *
 * Input is in screen pixels, relative to the canvas. The React layer forwards events and draws
 * state; this class decides what they mean and writes to the document.
 */
export class BoardController {
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  draft: Draft | null = null;

  private readonly history: History;
  private readonly listeners = new Set<() => void>();
  private gesture: Gesture | null = null;
  private tool: Tool = 'select';
  private color: string = INKS[0];
  private fill = false;
  private selection: string | null = null;
  private editing: string | null = null;
  private editingBefore: string | null = null;
  private spaceHeld = false;
  private state: ControllerState;

  constructor(private readonly doc: RecordDoc) {
    this.history = new History(doc);
    this.state = this.buildState();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): ControllerState => this.state;

  /** Bottom-to-top shapes the current document holds, skipping records this version cannot read. */
  shapes(): Shape[] {
    return this.doc.list().flatMap((record) => toShape(record) ?? []);
  }

  shape(id: string | null): Shape | null {
    const record = id ? this.doc.get(id) : undefined;
    return record ? toShape(record) : null;
  }

  toWorld(screen: Vec): Vec {
    const { x, y, zoom } = this.camera;
    return [screen[0] / zoom + x, screen[1] / zoom + y];
  }

  toScreen(world: Vec): Vec {
    const { x, y, zoom } = this.camera;
    return [(world[0] - x) * zoom, (world[1] - y) * zoom];
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    if (tool !== 'select') this.selection = null;
    this.commitEdit();
    this.emit();
  }

  setColor(color: string): void {
    this.color = color;
    if (this.selection) this.patch(this.selection, { color });
    this.emit();
  }

  toggleFill(): void {
    this.fill = !this.fill;
    const shape = this.shape(this.selection);
    if (shape?.kind === 'rect' || shape?.kind === 'ellipse') {
      this.patch(shape.id, { fill: this.fill });
    }
    this.emit();
  }

  deleteSelection(): void {
    if (!this.selection) return;
    const snapshot = this.doc.get(this.selection);
    if (snapshot && this.doc.remove(this.selection)) {
      this.history.record({ kind: 'delete', id: this.selection, snapshot });
    }
    this.selection = null;
    this.editing = null;
    this.emit();
  }

  reorderSelection(move: Reorder): void {
    if (!this.selection) return;
    const before = this.doc.get(this.selection)?.z;
    if (before === undefined || !this.doc.reorder(this.selection, move)) return;
    const after = this.doc.get(this.selection)?.z as string;
    this.history.record({
      kind: 'patch',
      id: this.selection,
      before: { z: before },
      after: { z: after },
    });
    this.emit();
  }

  undo(): void {
    this.commitEdit();
    this.selection = this.history.undo();
    this.emit();
  }

  redo(): void {
    this.commitEdit();
    this.selection = this.history.redo();
    this.emit();
  }

  beginEdit(id: string): void {
    const shape = this.shape(id);
    if (shape?.kind !== 'note') return;
    this.commitEdit();
    this.selection = id;
    this.editing = id;
    this.editingBefore = shape.text;
    this.emit();
  }

  editText(text: string): void {
    if (this.editing) this.doc.set(this.editing, { text });
  }

  /** Records one undo step for a whole editing session rather than one per keystroke. */
  commitEdit(): void {
    const id = this.editing;
    const before = this.editingBefore;
    this.editing = null;
    this.editingBefore = null;
    if (id === null || before === null) return;
    const shape = this.shape(id);
    if (shape?.kind === 'note' && shape.text !== before) {
      this.history.record({
        kind: 'patch',
        id,
        before: { text: before },
        after: { text: shape.text },
      });
    }
    this.emit();
  }

  pointerDown(screen: Vec, button = 0): void {
    if (this.editing) this.commitEdit();
    const world = this.toWorld(screen);

    if (button === 1 || this.tool === 'hand' || this.spaceHeld) {
      this.gesture = { kind: 'pan', lastX: screen[0], lastY: screen[1] };
      return;
    }

    switch (this.tool) {
      case 'select':
        this.beginSelectGesture(screen, world);
        break;
      case 'pen':
        this.gesture = { kind: 'draw' };
        this.draft = { kind: 'stroke', points: [world[0], world[1]] };
        break;
      case 'rect':
      case 'ellipse':
      case 'arrow':
        this.gesture = { kind: 'draw' };
        this.draft = { kind: this.tool, start: world, end: world };
        break;
      case 'note': {
        const id = this.doc.create(noteFields(world, this.color));
        this.history.record({ kind: 'create', id });
        this.tool = 'select';
        this.beginEdit(id);
        break;
      }
    }
    this.emit();
  }

  pointerMove(screen: Vec): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const world = this.toWorld(screen);

    switch (gesture.kind) {
      case 'pan': {
        const { zoom } = this.camera;
        this.camera = {
          ...this.camera,
          x: this.camera.x - (screen[0] - gesture.lastX) / zoom,
          y: this.camera.y - (screen[1] - gesture.lastY) / zoom,
        };
        this.gesture = { ...gesture, lastX: screen[0], lastY: screen[1] };
        this.emit();
        break;
      }
      case 'move':
        // Written on every move, so a collaborator watches the drag live. The flush timer folds
        // these into one register per flush, and a register has no history to grow.
        this.doc.set(gesture.id, {
          pos: [world[0] - gesture.offset[0], world[1] - gesture.offset[1]],
        });
        break;
      case 'resize':
        this.doc.set(gesture.id, {
          size: [world[0] - gesture.origin[0], world[1] - gesture.origin[1]],
        });
        break;
      case 'draw':
        this.extendDraft(world);
        this.emit();
        break;
    }
  }

  pointerUp(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    if (gesture.kind === 'move' || gesture.kind === 'resize') {
      this.finishTransform(gesture);
    } else if (gesture.kind === 'draw') {
      this.commitDraft();
    }
    this.emit();
  }

  doubleClick(screen: Vec): void {
    const [x, y] = this.toWorld(screen);
    const hit = hitTest(this.shapes(), x, y, HIT_TOLERANCE_PX / this.camera.zoom);
    if (hit?.kind === 'note') this.beginEdit(hit.id);
  }

  wheel(screen: Vec, deltaY: number, zoomGesture: boolean, deltaX = 0): void {
    if (zoomGesture) {
      this.zoomAt(screen, this.camera.zoom * Math.exp(-deltaY * 0.002));
    } else {
      const { zoom } = this.camera;
      this.camera = {
        ...this.camera,
        x: this.camera.x + deltaX / zoom,
        y: this.camera.y + deltaY / zoom,
      };
      this.emit();
    }
  }

  zoomAt(screen: Vec, target: number): void {
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, target));
    const [worldX, worldY] = this.toWorld(screen);
    this.camera = { x: worldX - screen[0] / zoom, y: worldY - screen[1] / zoom, zoom };
    this.emit();
  }

  key(input: KeyInput): boolean {
    if (this.editing) return false;
    const lower = input.key.toLowerCase();
    if (input.meta) {
      if (lower !== 'z') return false;
      if (input.shift) this.redo();
      else this.undo();
      return true;
    }
    if (input.key === ' ') {
      this.spaceHeld = true;
      return true;
    }
    if (input.key === 'Delete' || input.key === 'Backspace') {
      this.deleteSelection();
      return true;
    }
    if (input.key === 'Escape') {
      this.selection = null;
      this.emit();
      return true;
    }
    const reorder = REORDER_KEYS[input.key];
    if (reorder) {
      this.reorderSelection(reorder);
      return true;
    }
    const tool = TOOL_KEYS[lower];
    if (tool) {
      this.setTool(tool);
      return true;
    }
    return false;
  }

  keyUp(key: string): void {
    if (key === ' ') this.spaceHeld = false;
  }

  /** Drops a selection whose shape a collaborator just deleted. */
  syncSelection(): void {
    if (this.selection && !this.doc.get(this.selection)) {
      this.selection = null;
      this.editing = null;
      this.emit();
    }
  }

  private beginSelectGesture(screen: Vec, world: Vec): void {
    const selected = this.shape(this.selection);
    if (selected) {
      const handle = resizeHandle(selected);
      if (handle) {
        const [hx, hy] = this.toScreen(handle);
        if (Math.hypot(screen[0] - hx, screen[1] - hy) <= HANDLE_RADIUS_PX) {
          this.gesture = {
            kind: 'resize',
            id: selected.id,
            from: selected.kind === 'stroke' ? [0, 0] : selected.size,
            origin: selected.pos,
          };
          return;
        }
      }
    }

    const hit = hitTest(this.shapes(), world[0], world[1], HIT_TOLERANCE_PX / this.camera.zoom);
    this.selection = hit?.id ?? null;
    if (hit) {
      this.color = hit.color;
      this.gesture = {
        kind: 'move',
        id: hit.id,
        offset: [world[0] - hit.pos[0], world[1] - hit.pos[1]],
        from: hit.pos,
      };
    } else {
      this.gesture = { kind: 'pan', lastX: screen[0], lastY: screen[1] };
    }
  }

  private finishTransform(gesture: Extract<Gesture, { kind: 'move' | 'resize' }>): void {
    const shape = this.shape(gesture.id);
    if (!shape) return;
    const field = gesture.kind === 'move' ? 'pos' : 'size';
    const current = gesture.kind === 'move' || shape.kind === 'stroke' ? shape.pos : shape.size;
    if (current[0] === gesture.from[0] && current[1] === gesture.from[1]) return;
    this.history.record({
      kind: 'patch',
      id: gesture.id,
      before: { [field]: [...gesture.from] },
      after: { [field]: [...current] },
    });
  }

  private extendDraft(world: Vec): void {
    const draft = this.draft;
    if (!draft) return;
    if (draft.kind === 'stroke') {
      const { points } = draft;
      const [lastX, lastY] = [points.at(-2) as number, points.at(-1) as number];
      if (Math.hypot(world[0] - lastX, world[1] - lastY) >= 1 / this.camera.zoom) {
        this.draft = { kind: 'stroke', points: [...points, world[0], world[1]] };
      }
    } else {
      this.draft = { ...draft, end: world };
    }
  }

  private commitDraft(): void {
    const draft = this.draft;
    this.draft = null;
    if (!draft) return;
    let fields: Fields | null = null;
    if (draft.kind === 'stroke') {
      fields = strokeFields(draft.points, this.color, 3);
    } else {
      const span = Math.hypot(draft.end[0] - draft.start[0], draft.end[1] - draft.start[1]);
      if (span * this.camera.zoom < MIN_NEW_SHAPE_PX) return;
      fields =
        draft.kind === 'arrow'
          ? arrowFields(draft.start, draft.end, this.color, 2.5)
          : boxFields(draft.kind, draft.start, draft.end, this.color, 2.5, this.fill);
    }
    this.history.record({ kind: 'create', id: this.doc.create(fields) });
  }

  private patch(id: string, after: Fields): void {
    const record = this.doc.get(id);
    if (!record) return;
    const before: Fields = {};
    for (const name of Object.keys(after)) before[name] = record.fields[name] ?? null;
    if (this.doc.set(id, after)) this.history.record({ kind: 'patch', id, before, after });
  }

  private buildState(): ControllerState {
    return {
      tool: this.tool,
      color: this.color,
      fill: this.fill,
      selection: this.selection,
      editing: this.editing,
      zoom: this.camera.zoom,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
    };
  }

  private emit(): void {
    this.state = this.buildState();
    for (const listener of this.listeners) listener();
  }
}

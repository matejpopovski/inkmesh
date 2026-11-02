import type { Fields, LiveRecord, RecordDoc } from '@inkmesh/crdt';

export type Step =
  | { readonly kind: 'create'; readonly id: string }
  | { readonly kind: 'delete'; readonly id: string; readonly snapshot: LiveRecord }
  | {
      readonly kind: 'patch';
      readonly id: string;
      readonly before: Fields;
      readonly after: Fields;
    };

/**
 * Per-user undo built from ordinary writes, so an undo syncs and merges like any other edit and
 * never rewinds what somebody else did.
 *
 * Every step knows how to apply its opposite and returns the step that reverses that. Deletes are
 * terminal in the CRDT, so undoing one re-creates the shape under a new id; `aliases` lets older
 * steps on the stack keep finding it.
 */
export class History {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private readonly aliases = new Map<string, string>();

  constructor(private readonly doc: RecordDoc) {}

  record(step: Step): void {
    this.undoStack.push(step);
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Reverses the latest step that still applies. Returns the id to select, if any. */
  undo(): string | null {
    return this.travel(this.undoStack, this.redoStack);
  }

  redo(): string | null {
    return this.travel(this.redoStack, this.undoStack);
  }

  private travel(from: Step[], to: Step[]): string | null {
    for (let step = from.pop(); step; step = from.pop()) {
      const inverse = this.apply(step);
      // Skipped when a collaborator deleted the shape: an undo must not act on air.
      if (inverse) {
        to.push(inverse);
        return inverse.kind === 'delete' ? null : inverse.id;
      }
    }
    return null;
  }

  private resolve(id: string): string {
    let current = id;
    for (let next = this.aliases.get(current); next; next = this.aliases.get(current)) {
      current = next;
    }
    return current;
  }

  private apply(step: Step): Step | null {
    const id = this.resolve(step.id);
    switch (step.kind) {
      case 'create': {
        const snapshot = this.doc.get(id);
        if (!snapshot) return null;
        this.doc.remove(id);
        return { kind: 'delete', id, snapshot };
      }
      case 'delete': {
        const restored = this.doc.create({ ...step.snapshot.fields }, step.snapshot.z);
        this.aliases.set(id, restored);
        return { kind: 'create', id: restored };
      }
      case 'patch':
        if (!this.doc.get(id)) return null;
        this.doc.set(id, step.before);
        return { kind: 'patch', id, before: step.after, after: step.before };
    }
  }
}

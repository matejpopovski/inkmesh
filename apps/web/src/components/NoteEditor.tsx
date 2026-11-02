import { useEffect, useReducer, useRef } from 'react';
import type { BoardController } from '../board/controller';

/**
 * A textarea laid over the note being edited. Canvas has no text input of its own, and the system
 * caret, selection and IME support are worth keeping.
 */
export function NoteEditor({ controller, id }: { controller: BoardController; id: string }) {
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => controller.subscribe(redraw), [controller]);

  const shape = controller.shape(id);
  const text = shape?.kind === 'note' ? shape.text : null;

  useEffect(() => {
    field.current?.focus();
  }, []);

  useEffect(() => {
    // A collaborator typing in this note overwrites the register, so show what merged.
    if (field.current && text !== null && field.current.value !== text) {
      field.current.value = text;
    }
  }, [text]);

  if (shape?.kind !== 'note') return null;
  const [x, y] = controller.toScreen(shape.pos);
  const { zoom } = controller.camera;

  return (
    <textarea
      ref={field}
      className="note-editor"
      data-testid="note-editor"
      aria-label="Note text"
      defaultValue={shape.text}
      style={{
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
        width: shape.size[0],
        height: shape.size[1],
      }}
      onChange={(event) => controller.editText(event.target.value)}
      onBlur={() => controller.commitEdit()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') controller.commitEdit();
      }}
    />
  );
}

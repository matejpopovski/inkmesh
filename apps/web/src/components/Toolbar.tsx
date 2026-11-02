import type { ReactNode } from 'react';
import type { BoardController, ControllerState, Tool } from '../board/controller';
import { INKS } from '../board/model';

const icon = (paths: ReactNode) => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    {paths}
  </svg>
);

const TOOLS: readonly { tool: Tool; label: string; shortcut: string; glyph: ReactNode }[] = [
  {
    tool: 'select',
    label: 'Pick up',
    shortcut: 'V',
    glyph: icon(
      <path d="M8.4 5.2c4.7 6.6 9.7 12 15.8 15.9-3 .3-5.5.8-7.1 1.3-.5 1.8-1.1 3.9-1.2 5.9C12.8 21 10.3 12.9 8.4 5.2Z" />,
    ),
  },
  {
    tool: 'pen',
    label: 'Pencil',
    shortcut: 'P',
    glyph: icon(
      <>
        <path d="M6.3 26c.8-3.2 1.4-5.2 2.5-6.6L21.7 6.2c1.3-1.1 3-1 4.1.2 1.1 1.3 1.1 2.9 0 4.1L12.7 23.8c-1.4 1.1-3.5 1.6-6.4 2.2Z" />
        <path d="M19.3 8.8c1.6.5 3.1 2 3.8 3.7" />
      </>,
    ),
  },
  {
    tool: 'rect',
    label: 'Box',
    shortcut: 'R',
    glyph: icon(
      <path d="M5.8 8.4c6.7-.8 13.7-.9 20.6-.3.3 5.1.5 10.5.2 15.7-6.9.4-13.9.6-20.9.2-.4-5.1-.3-10.4.3-15.9" />,
    ),
  },
  {
    tool: 'ellipse',
    label: 'Circle',
    shortcut: 'O',
    glyph: icon(
      <path d="M16.5 6.2c5.9-.3 10.8 4 10.7 9.8-.1 5.9-5.1 10.1-11.3 9.8C10 25.5 4.8 21.5 5.1 15.7 5.4 9.7 10.6 5.6 17.3 6.4" />,
    ),
  },
  {
    tool: 'arrow',
    label: 'Arrow',
    shortcut: 'A',
    glyph: icon(
      <>
        <path d="M6 25.5c5.5-6 11.3-11.8 19.2-18.7" />
        <path d="M15.8 7.7c3.1-.8 6.3-1.1 9.7-1.2-.2 3.3-.8 6.7-1.8 10" />
      </>,
    ),
  },
  {
    tool: 'note',
    label: 'Note',
    shortcut: 'N',
    glyph: icon(
      <>
        <path d="M6.2 6.6c6.6-.5 13.2-.6 19.8-.2.5 5.1.5 10.2 0 15.3l-5.2 4.7c-4.7.3-9.7.3-14.7 0-.5-6.5-.5-13 .1-19.8Z" />
        <path d="M20.3 26.1c-.3-1.9-.2-3.5.2-4.8 1.9-.2 3.8-.1 5.4.3" />
        <path d="M10.7 12.3c3.4-.3 7-.3 10.6-.1M10.7 17c2.4-.2 4.8-.3 7.3-.2" />
      </>,
    ),
  },
  {
    tool: 'hand',
    label: 'Move page',
    shortcut: 'H',
    glyph: icon(
      <path d="M10.6 17.3 8.2 13c-.8-1.8 1.3-3 2.5-1.7l2 2.7-.5-8c-.1-2.2 2.8-2.3 3-.2l.5 6.3.3-7.7c.1-2.2 3-2.1 3 .1l-.2 7.9 1.5-6.3c.5-2 3.3-1.3 2.9.7l-1.7 8c1.1-1.4 2-2.4 3.2-2.5 1.7-.1 1.9 1.7 1 2.9l-3.8 6.6c-1.8 3.2-4.3 4.9-7.7 4.9-3.8 0-6-1.9-7.1-5.2l-1.5-4.1Z" />,
    ),
  },
];

export function Toolbar({
  controller,
  state,
}: {
  controller: BoardController;
  state: ControllerState;
}) {
  return (
    <aside className="pencil-case" aria-label="Drawing tools">
      <div className="tool-group" role="toolbar">
        {TOOLS.map(({ tool, label, shortcut, glyph }) => (
          <button
            key={tool}
            type="button"
            className="tool"
            aria-pressed={state.tool === tool}
            aria-label={label}
            title={`${label} (${shortcut})`}
            data-testid={`tool-${tool}`}
            onClick={() => controller.setTool(tool)}
          >
            {glyph}
          </button>
        ))}
      </div>

      <div className="ink-well" role="group" aria-label="Ink colour">
        {INKS.map((ink, index) => (
          <button
            key={ink}
            type="button"
            className="ink"
            style={{ '--ink': ink, '--turn': `${(index * 47) % 40}deg` } as React.CSSProperties}
            aria-label={`Ink ${index + 1}`}
            aria-pressed={state.color === ink}
            data-testid={`ink-${index}`}
            onClick={() => controller.setColor(ink)}
          />
        ))}
      </div>

      <button
        type="button"
        className="shade"
        aria-pressed={state.fill}
        data-testid="toggle-fill"
        title="Shade new boxes and circles"
        onClick={() => controller.toggleFill()}
      >
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M6 9c6.5-.6 13.5-.7 20-.2.4 5 .4 9.8 0 14.8-6.5.4-13.3.4-20 0-.3-5-.3-9.8 0-14.6Z" />
          <path d="M8 19 15 11M11 22l10-11M17 22l7-8" />
        </svg>
        <span>shade</span>
      </button>

      <div className="tool-group tool-group--tight">
        <button
          type="button"
          className="tool"
          aria-label="Undo"
          title="Undo"
          disabled={!state.canUndo}
          data-testid="undo"
          onClick={() => controller.undo()}
        >
          {icon(<path d="M12 7.2 6.3 13l6.2 5M7 13.2c6.7-1 13.3-.3 15.9 3.7 2 3.2 1 6.7-1.9 9" />)}
        </button>
        <button
          type="button"
          className="tool"
          aria-label="Redo"
          title="Redo"
          disabled={!state.canRedo}
          data-testid="redo"
          onClick={() => controller.redo()}
        >
          {icon(
            <path d="M20 7.2 25.7 13l-6.2 5M25 13.2c-6.7-1-13.3-.3-15.9 3.7-2 3.2-1 6.7 1.9 9" />,
          )}
        </button>
      </div>
    </aside>
  );
}

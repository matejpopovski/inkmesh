import { useEffect, useRef, type PointerEvent, type WheelEvent } from 'react';
import { BoardRenderer } from '../board/render';
import type { Vec } from '../board/model';
import type { Session } from '../session';

const DOT_SPACING = 26;

function screenPoint(event: { clientX: number; clientY: number }, canvas: HTMLElement): Vec {
  const bounds = canvas.getBoundingClientRect();
  return [event.clientX - bounds.left, event.clientY - bounds.top];
}

/** The drawing surface. Renders on demand: one frame per change, nothing while idle. */
export function BoardCanvas({ session }: { session: Session }) {
  const { controller, engine } = session;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const page = pageRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !page || !context) return;

    const renderer = new BoardRenderer();
    let frame = 0;
    let size = { width: 0, height: 0, ratio: 1 };

    const draw = () => {
      frame = 0;
      const state = controller.getState();
      const { camera } = controller;
      renderer.render(
        context,
        {
          shapes: controller.shapes(),
          camera,
          draft: controller.draft,
          draftColor: state.color,
          draftFill: state.fill,
          selection: state.selection,
          editing: state.editing,
        },
        size.width,
        size.height,
        size.ratio,
      );
      // Paper dots live in CSS so they stay crisp and never slow down the canvas.
      const spacing = DOT_SPACING * camera.zoom;
      page.style.backgroundSize = `${spacing}px ${spacing}px`;
      page.style.backgroundPosition = `${-camera.x * camera.zoom}px ${-camera.y * camera.zoom}px`;
    };

    const requestDraw = () => {
      frame ||= requestAnimationFrame(draw);
    };

    const resize = () => {
      const bounds = page.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      size = { width: bounds.width, height: bounds.height, ratio };
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
      requestDraw();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(page);
    resize();

    const stopController = controller.subscribe(requestDraw);
    const stopDocument = session.onDocumentChange(() => {
      controller.syncSelection();
      requestDraw();
    });
    // The first frame may use a fallback font; redraw when the handwriting face arrives.
    void document.fonts.load('600 25px Caveat').then(requestDraw);

    return () => {
      observer.disconnect();
      stopController();
      stopDocument();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [controller, session]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).tagName === 'TEXTAREA') return;
      const handled = controller.key({
        key: event.key,
        meta: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
      });
      if (handled) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => controller.keyUp(event.key);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [controller]);

  const announceCursor = (screen: Vec | null) => {
    const [x, y] = screen ? controller.toWorld(screen) : [0, 0];
    engine.updatePresence({
      name: session.name,
      color: session.ink,
      cursor: screen ? { x: Math.round(x), y: Math.round(y) } : null,
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    // Cancelled so that the browser's mousedown cannot pull focus back out of a note editor that
    // this very press just opened.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    controller.pointerDown(screenPoint(event, event.currentTarget), event.button);
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const screen = screenPoint(event, event.currentTarget);
    controller.pointerMove(screen);
    announceCursor(screen);
  };

  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    controller.wheel(
      screenPoint(event, event.currentTarget),
      event.deltaY,
      event.ctrlKey || event.metaKey,
      event.deltaX,
    );
  };

  return (
    <div className="page" ref={pageRef} data-tool={controller.getState().tool}>
      <canvas
        ref={canvasRef}
        className="board"
        data-testid="board-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => controller.pointerUp()}
        onPointerCancel={() => controller.pointerUp()}
        onPointerLeave={() => announceCursor(null)}
        onDoubleClick={(event) => controller.doubleClick(screenPoint(event, event.currentTarget))}
        onWheel={onWheel}
      />
    </div>
  );
}

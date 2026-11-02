import { useEffect, useReducer } from 'react';
import type { EngineSnapshot } from '@inkmesh/sync';
import type { BoardController } from '../board/controller';

/** Collaborators' pencils on the page, and name tags clipped to its edge. */
export function PeerCursors({
  controller,
  snapshot,
}: {
  controller: BoardController;
  snapshot: EngineSnapshot;
}) {
  // Cursors are positioned from the camera, which moves without any React state changing.
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => controller.subscribe(redraw), [controller]);

  return (
    <div className="cursors" aria-hidden="true">
      {[...snapshot.peers].flatMap(([replica, peer]) => {
        if (!peer.cursor) return [];
        const [x, y] = controller.toScreen([peer.cursor.x, peer.cursor.y]);
        return (
          <div
            key={replica}
            className="cursor"
            data-testid="peer-cursor"
            style={{ transform: `translate(${x}px, ${y}px)`, color: peer.color }}
          >
            <svg viewBox="0 0 22 26">
              <path d="M2 2c3.8 7.4 8 14.4 16.7 18.9-3.8.2-6.6.7-8.2 1.2-1 1.2-1.7 2.3-2.1 3.7C6.5 18 3.7 9.8 2 2Z" />
            </svg>
            <span>{peer.name}</span>
          </div>
        );
      })}
    </div>
  );
}

export function PeerTags({ snapshot, name }: { snapshot: EngineSnapshot; name: string }) {
  return (
    <ul className="peers" aria-label="People on this page">
      <li className="peer peer--self">{name} (you)</li>
      {[...snapshot.peers].map(([replica, peer]) => (
        <li key={replica} className="peer" style={{ '--peer': peer.color } as React.CSSProperties}>
          {peer.name}
        </li>
      ))}
    </ul>
  );
}

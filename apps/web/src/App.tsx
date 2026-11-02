import { useEffect, useState, useSyncExternalStore } from 'react';
import { BoardCanvas } from './components/BoardCanvas';
import { NoteEditor } from './components/NoteEditor';
import { PeerCursors, PeerTags } from './components/Presence';
import { StatusStamp } from './components/StatusStamp';
import { Toolbar } from './components/Toolbar';
import { openSession, type Session } from './session';

function Sheet({ session }: { session: Session }) {
  const { controller, engine } = session;
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const snapshot = useSyncExternalStore(
    (listener) => engine.subscribe(listener),
    engine.getSnapshot,
  );
  const empty = useSyncExternalStore(
    session.onDocumentChange,
    () => engine.doc.list().length === 0,
  );
  const [copied, setCopied] = useState(false);

  const copyLink = () => {
    void navigator.clipboard?.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <main className="sketchbook">
      <div className="binding" aria-hidden="true" />
      <Toolbar controller={controller} state={state} />

      <div className="sheet">
        <BoardCanvas session={session} />
        <PeerCursors controller={controller} snapshot={snapshot} />
        {state.editing && (
          <NoteEditor key={state.editing} controller={controller} id={state.editing} />
        )}

        {empty && (
          <p className="first-page">
            A blank page. Draw something, then send the link to a friend.
            <small>It saves to this device first, so it does not mind losing the internet.</small>
          </p>
        )}

        <header className="masthead">
          <h1>inkmesh</h1>
          <button type="button" className="washi" onClick={copyLink} title="Copy link to this page">
            {copied ? 'link copied' : session.board}
          </button>
        </header>

        <div className="corner">
          <StatusStamp snapshot={snapshot} />
          <PeerTags snapshot={snapshot} name={session.name} />
        </div>

        <div className="zoom" data-testid="zoom">
          {Math.round(state.zoom * 100)}%
        </div>
      </div>
    </main>
  );
}

export function App({ board }: { board: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    openSession(board)
      .then((opened) => {
        if (!live) return;
        setSession(opened);
        (window as unknown as { __inkmesh: unknown }).__inkmesh = {
          replica: opened.engine.doc.replica,
          visibleState: () => opened.engine.doc.visibleState(),
          shapes: () => opened.controller.shapes(),
          stats: () => opened.engine.doc.stats(),
          pending: () => opened.engine.pending(),
          flush: () => opened.engine.flush(),
          selection: () => opened.controller.getState().selection,
        };
      })
      .catch((error: unknown) => {
        if (live) setFailure(String(error));
      });
    return () => {
      live = false;
    };
  }, [board]);

  if (failure) return <p className="fallback">This page could not be opened: {failure}</p>;
  if (!session) return <p className="fallback">Finding the page...</p>;
  return <Sheet session={session} />;
}

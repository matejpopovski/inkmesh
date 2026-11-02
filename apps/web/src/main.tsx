import '@fontsource/caveat/latin-600.css';
import '@fontsource/patrick-hand/latin-400.css';
import './styles.css';
import { isValidBoardId } from '@inkmesh/protocol';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { randomBoardName } from './board/names';

function boardFromUrl(): string {
  const match = /^\/b\/([^/]+)\/?$/.exec(location.pathname);
  if (match?.[1] && isValidBoardId(match[1])) return match[1];
  const board = randomBoardName();
  history.replaceState(null, '', `/b/${board}`);
  return board;
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js');
}

const root = document.getElementById('root') as HTMLElement;
createRoot(root).render(
  <StrictMode>
    <App board={boardFromUrl()} />
  </StrictMode>,
);

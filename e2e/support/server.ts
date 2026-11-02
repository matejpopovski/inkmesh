import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const E2E_PORT = 41520;

const PID_FILE = join(tmpdir(), `inkmesh-e2e-${E2E_PORT}.pid`);
const ROOT = resolve(import.meta.dirname, '../..');

const SERVER_ENTRY = 'apps/server/dist/main.js';

async function isUp(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${E2E_PORT}/healthz`)).ok;
  } catch {
    return false;
  }
}

/** True only if `pid` is still a running inkmesh server, which a recycled pid would not be. */
function isOurServer(pid: number): boolean {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='])
      .toString()
      .includes(SERVER_ENTRY);
  } catch {
    return false;
  }
}

export async function startServer(): Promise<void> {
  // Otherwise the new process would exit on the busy port, the health check would pass against
  // the old one, and the suite would record a pid that belongs to nothing.
  if (await isUp()) throw new Error(`port ${E2E_PORT} is already serving`);

  const child: ChildProcess = spawn('node', [SERVER_ENTRY], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(E2E_PORT),
      HOST: '127.0.0.1',
      INKMESH_DB: process.env['INKMESH_E2E_DB'],
    },
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isUp()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('e2e server did not start');
}

/** Restarts the server if a failed test left it down, so one failure stays one failure. */
export async function ensureServer(): Promise<void> {
  if (!(await isUp())) await startServer();
}

/** Stops the process abruptly, as a crash would, so that nothing gets a clean shutdown. */
export async function killServer(): Promise<void> {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, 'utf8'));
  unlinkSync(PID_FILE);
  if (!isOurServer(pid)) return;
  process.kill(pid, 'SIGKILL');

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await isUp())) {
    await new Promise((done) => setTimeout(done, 25));
  }
}

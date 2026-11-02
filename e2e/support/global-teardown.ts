import { killServer } from './server.js';

export default async function globalTeardown(): Promise<void> {
  await killServer();
}

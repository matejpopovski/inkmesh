import { startServer } from './server.js';

export default async function globalSetup(): Promise<void> {
  await startServer();
}

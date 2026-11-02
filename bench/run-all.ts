import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './support.js';

const steps: readonly (readonly string[])[] = [
  ['tsx', 'bench/convergence.ts'],
  ['tsx', 'bench/payload.ts'],
  ['node', '--expose-gc', '--import', 'tsx', 'bench/memory.ts'],
  ['tsx', 'bench/latency.ts'],
  ['tsx', 'bench/charts.ts'],
];

for (const [command, ...args] of steps) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const run = spawnSync(
    command === 'tsx' ? 'npx' : (command as string),
    command === 'tsx' ? ['tsx', ...args] : args,
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    },
  );
  if (run.status !== 0) process.exit(run.status ?? 1);
}

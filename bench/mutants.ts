import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, writeResult } from './support.js';

/**
 * Deliberately breaks the CRDT in ways that matter and checks that the tests notice, once with the
 * property suite alone and once with everything. A green suite only means something if it can go
 * red, and the first version of the simulator could not: see "How the tests earned trust".
 */
const DOC = 'packages/crdt/src/doc.ts';

const MUTANTS = [
  {
    name: 'always send a delta, never a full state',
    find: `return dominates(peerVersions, this.floorVector)
      ? this.deltaSince(peerVersions)
      : this.fullState();`,
    replace: 'return this.deltaSince(peerVersions);',
  },
  {
    name: 'apply deltas that leave a gap',
    find: "if (!delta.full && !dominates(this.versionVector, delta.since)) return { status: 'gap' };",
    replace: '',
  },
  {
    name: 'accept entries for forgotten records',
    find: 'if (covers(this.versionVector, creationStamp(entry.id))) return null;',
    replace: '',
  },
  {
    name: 'full state does not forget compacted records',
    find: 'if (!present.has(id) && covers(delta.upto, creationStamp(id))) {',
    replace: 'if (id === "") {',
  },
  {
    name: 'late edits land inside a tombstone',
    find: 'if (record.tomb || !entry.regs) return null;',
    replace: 'if (!entry.regs) return null;',
  },
  {
    name: 'register ties ignore the replica id',
    find: 'if (!current || compareStamps(registerStamp(current), registerStamp(incoming)) < 0) {\n        record.regs[name] = incoming;',
    replace:
      'if (!current || registerStamp(current)[0] < registerStamp(incoming)[0]) {\n        record.regs[name] = incoming;',
  },
  {
    name: 'tombstone keeps only its first stamp',
    find: 'return fresh.length > 0 ? [...current, ...fresh].sort(compareStamps) : null;',
    replace: 'return null;',
  },
  {
    name: 'tombstone stamps are left unsorted',
    find: '[...current, ...fresh].sort(compareStamps)',
    replace: '[...current, ...fresh]',
  },
  {
    name: 'clock ignores what it receives',
    find: 'this.clock.observe(maxTime(delta.upto));',
    replace: '',
  },
  {
    name: 'floor from a peer is ignored',
    find: 'this.floorVector = joinVectors(this.floorVector, delta.floor);',
    replace: '',
  },
  {
    name: 'no purge after adopting a floor',
    find: 'if (floorMoved) this.purgeBelowFloor(removed);\n    else this.purgeEntries(changed, removed);',
    replace: '',
  },
  {
    name: 'a tombstone below the floor is kept when the floor did not move',
    find: 'else this.purgeEntries(changed, removed);',
    replace: '',
  },
  {
    name: 'cached order keeps a deleted record',
    find: 'if (index >= 0) this.order?.splice(index, 1);',
    replace: '',
  },
  {
    name: 'tombstone resent only by its first stamp',
    find: 'record.tomb.every((stamp) => covers(since, stamp))',
    replace: 'covers(since, record.tomb[0] as Stamp)',
  },
];

function testsFail(paths: readonly string[]): boolean {
  const run = spawnSync('npx', ['vitest', 'run', '--project', 'crdt', ...paths], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  return run.status !== 0;
}

const path = resolve(REPO_ROOT, DOC);
const original = readFileSync(path, 'utf8');
const rows = [];

try {
  for (const mutant of MUTANTS) {
    if (!original.includes(mutant.find))
      throw new Error(`mutant no longer applies: ${mutant.name}`);
    writeFileSync(path, original.replace(mutant.find, mutant.replace));
    const row = {
      name: mutant.name,
      killedByProperties: testsFail(['packages/crdt/test/convergence']),
      killedByAllTests: testsFail([]),
    };
    rows.push(row);
    console.log(row);
  }
} finally {
  writeFileSync(path, original);
}

writeResult('mutants', {
  command: 'npx tsx bench/mutants.ts',
  total: rows.length,
  killedByProperties: rows.filter((row) => row.killedByProperties).length,
  killedByAllTests: rows.filter((row) => row.killedByAllTests).length,
  rows,
});

#!/usr/bin/env node
// Print the current test count from `npm test`. Used to keep the
// README's `tests-XXX passing` badge honest. Run as:
//   node scripts/test-count.mjs
// Reads vitest's "Tests  N passed" summary line. Exits 0 on a clean
// run, 1 if no passing tests are reported (so a broken suite fails
// loud rather than silently reporting 0).

import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["test", "--", "--reporter=default"], {
  encoding: "utf8",
  shell: true,
});

if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(1);
}

const match = result.stdout.match(/Tests\s+(\d+)\s+passed/);
if (!match) {
  console.error("Could not parse test count from vitest output.");
  process.exit(1);
}

const count = Number(match[1]);
console.log(count);
process.exit(count > 0 ? 0 : 1);

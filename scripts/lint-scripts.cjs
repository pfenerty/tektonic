#!/usr/bin/env node
/**
 * Dev harness: lint/syntax-check standalone script files (the ones authored for
 * `scriptFromFile`). Infers each file's language from its extension and runs the
 * language's lint command (shellcheck / nu-check / py_compile).
 *
 * Usage:
 *   node scripts/lint-scripts.cjs <file-or-dir> [more...]
 *
 * A linter that isn't installed is skipped with a warning (not a failure), so
 * this is safe to run anywhere; install the linters for full coverage.
 * Exits non-zero only when an available linter reports a problem.
 *
 * Requires a prior build (reads dist/). `npm run lint:scripts` chains both.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { lintCommandForFile, languageNameForFile } = require('../dist/lib/script/from-file');

const EXTENSIONS = ['.bash', '.sh', '.nu', '.py'];

function collect(target, acc) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      collect(path.join(target, entry), acc);
    }
  } else if (EXTENSIONS.includes(path.extname(target).toLowerCase())) {
    acc.push(target);
  }
  return acc;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: lint-scripts <file-or-dir> [more...]');
  process.exit(2);
}

const files = targets.flatMap((t) => collect(t, []));
let failures = 0;
let checked = 0;
const skippedLinters = new Set();

for (const file of files) {
  const cmd = lintCommandForFile(file);
  const res = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
  if (res.error && res.error.code === 'ENOENT') {
    skippedLinters.add(`${languageNameForFile(file)} (${cmd[0]})`);
    console.warn(`SKIP ${file} — linter "${cmd[0]}" not installed`);
    continue;
  }
  checked++;
  if (res.status !== 0) {
    failures++;
    console.error(`FAIL ${file}`);
    if (res.stdout) process.stderr.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  } else {
    console.log(`ok   ${file}`);
  }
}

console.log(`\n${checked} checked, ${failures} failed, ${files.length - checked} skipped`);
if (skippedLinters.size) {
  console.log(`Install for full coverage: ${[...skippedLinters].join(', ')}`);
}
process.exit(failures ? 1 : 0);

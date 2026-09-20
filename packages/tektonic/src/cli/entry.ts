import * as fs from 'fs';
import * as path from 'path';

/**
 * Paths searched, in order, for a project entrypoint — the file that constructs a
 * {@link TektonicProject} and therefore synthesizes when run. Overridden by an explicit
 * argument or by a `tektonic.entry` field in the nearest `package.json`.
 */
export const ENTRY_CANDIDATES = [
  'tektonic.ts',
  'tektonic.config.ts',
  '.tektonic/pipeline.ts',
  '.tektonic/main.ts',
  '.tektonic/index.ts',
  'tektonic.js',
  '.tektonic/pipeline.js',
  '.tektonic/main.js',
  '.tektonic/index.js',
];

/** Reads `tektonic.entry` (and `tektonic.runner`) from `<cwd>/package.json`, if present. */
export function packageJsonConfig(cwd: string): { entry?: string; runner?: string } {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const cfg = (JSON.parse(raw) as { tektonic?: { entry?: string; runner?: string } }).tektonic;
    return cfg ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolves the entrypoint to run: an explicit path wins, then `tektonic.entry` from
 * package.json, then the first existing {@link ENTRY_CANDIDATES}.
 *
 * @throws when nothing matches, listing what was looked for.
 */
export function resolveEntry(explicit: string | undefined, cwd: string): string {
  const named = explicit ?? packageJsonConfig(cwd).entry;
  if (named) {
    const abs = path.resolve(cwd, named);
    if (!fs.existsSync(abs)) throw new Error(`entrypoint '${named}' does not exist`);
    return abs;
  }
  for (const candidate of ENTRY_CANDIDATES) {
    const abs = path.resolve(cwd, candidate);
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error(
    `no project entrypoint found. Pass one explicitly (tektonic synth <file>), set ` +
      `"tektonic": { "entry": "..." } in package.json, or use one of: ${ENTRY_CANDIDATES.join(', ')}`,
  );
}

/**
 * The command that runs `entry`.
 *
 * Both JavaScript and TypeScript run on bare `node`, which strips types itself from Node
 * 22.18 on. No loader is probed for or depended on: an entrypoint written in non-erasable
 * syntax (`enum`, parameter properties, `namespace`) is the one case node cannot run, and it
 * is served by `"tektonic": { "runner": "npx tsx" }` in package.json rather than by this
 * library carrying a transpiler of its own.
 */
export function runnerFor(entry: string, cwd: string): { command: string; args: string[] } {
  const configured = packageJsonConfig(cwd).runner;
  if (configured) {
    const [command, ...args] = configured.split(' ').filter(Boolean);
    return { command, args: [...args, entry] };
  }
  // A `.ts` entrypoint in a package without "type": "module" parses as ESM by syntax
  // detection, and node warns about the reparse on every synthesis. The reparse is the
  // intended path here, so the warning is noise in a CLI's output rather than a signal.
  const args = entry.endsWith('.ts')
    ? ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', entry]
    : [entry];
  return { command: process.execPath, args };
}

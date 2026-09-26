import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ScriptLanguage, ScriptCtx } from '../script';

/**
 * Conformance harness for a {@link ScriptLanguage}, for authors registering one out of tree.
 *
 * Everything else about a language is a matter of taste — its shebang, its preamble, whether
 * it wraps the body in a function. The exit-code contract is not: a `wrap` that ignores
 * {@link ScriptCtx.captureExitCode} makes a failed step report *green*, because the status
 * reporter reads the contract file rather than the step. That failure mode is silent, which
 * is exactly why it needs a test an implementer can run rather than a paragraph they can
 * skim.
 *
 * ```ts
 * import { assertExitCodeContract, interpreterAvailable } from '@tektonic-ci/core/testing';
 *
 * it.skipIf(!interpreterAvailable('deno'))('honours the exit-code contract', () => {
 *   assertExitCodeContract(new DenoLanguage(), {
 *     interpreter: 'deno',
 *     args: ['run', '-A'],
 *     extension: '.ts',
 *     failing: code => `Deno.exit(${code})`,
 *     succeeding: 'console.log("ok")',
 *   });
 * });
 * ```
 */

/** Whether `bin` is on PATH, for skipping a case rather than failing it. */
export function interpreterAvailable(bin: string, versionArgs: string[] = ['--version']): boolean {
  return !spawnSync(bin, versionArgs, { stdio: 'ignore' }).error;
}

/** How to execute a body rendered by the language under test. */
export interface ExitCodeContractOptions {
  /** Interpreter binary, e.g. `'nu'`, `'python3'`, `'deno'`. */
  interpreter: string;
  /** Argv passed before the script file, e.g. `['run', '-A']`. */
  args?: string[];
  /** Extension for the rendered file — some interpreters dispatch on it. Default `.script`. */
  extension?: string;
  /** A body that terminates with exit code `code`. */
  failing: (code: number) => string;
  /** A body that succeeds. Checked when given; the failing case alone leaves `0` untested. */
  succeeding?: string;
  /** Exit code the failing body uses. Default `3` — distinct from the shell's own 1 and 2. */
  code?: number;
}

/** What {@link assertExitCodeContract} checked, and what it could not. */
export interface ConformanceResult {
  /** Names of the checks that passed. */
  checks: string[];
  /** Set when the interpreter is absent: only the static checks ran. */
  skipped?: string;
}

function fail(language: ScriptLanguage, what: string, detail: string): never {
  throw new Error(`script language "${language.name}" ${what}: ${detail}`);
}

/** Renders `body` and runs it, returning the process exit code and the contract file. */
function run(
  language: ScriptLanguage,
  body: string,
  opts: ExitCodeContractOptions,
): { status: number | null; contract: string; stderr: string; rendered: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tek-conformance-'));
  try {
    const exitCodePath = path.join(dir, 'exit-code');
    const file = path.join(dir, `step${opts.extension ?? '.script'}`);
    const rendered = language.wrap(body, { exitCodePath, captureExitCode: true });
    fs.writeFileSync(file, rendered);
    fs.chmodSync(file, 0o755);
    const res = spawnSync(opts.interpreter, [...(opts.args ?? []), file], { encoding: 'utf8' });
    if (res.error) fail(language, 'could not be executed', `${opts.interpreter}: ${res.error.message}`);
    const contract = fs.existsSync(exitCodePath)
      ? fs.readFileSync(exitCodePath, 'utf8').trim()
      : '<no contract file written>';
    return { status: res.status, contract, stderr: res.stderr ?? '', rendered };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Asserts that a language honours the exit-code contract, throwing a described failure if not.
 *
 * Static checks always run. The execute-and-assert checks need the interpreter, and are
 * reported as skipped when it is absent — gate the whole case with
 * {@link interpreterAvailable} if you would rather see the skip in your test output.
 *
 * @param language - The implementation under test.
 * @param opts - How to execute a rendered body.
 */
export function assertExitCodeContract(
  language: ScriptLanguage,
  opts: ExitCodeContractOptions,
): ConformanceResult {
  const checks: string[] = [];
  const code = opts.code ?? 3;
  const ctx = (captureExitCode: boolean): ScriptCtx => ({
    exitCodePath: '/tmp/tek-exit-code',
    captureExitCode,
  });

  if (!language.name?.trim()) fail(language, 'has no name', 'ScriptLanguage.name must be non-empty');
  if (!language.shebang?.startsWith('#!')) {
    fail(language, 'has no shebang', `expected a '#!' line, got ${JSON.stringify(language.shebang)}`);
  }
  checks.push('name and shebang');

  const plain = language.wrap('# body-marker', ctx(false));
  if (!plain.startsWith(language.shebang)) {
    fail(language, 'does not lead with its shebang', `wrap() returned ${JSON.stringify(plain.slice(0, 40))}`);
  }
  if (!plain.includes('# body-marker')) {
    fail(language, 'dropped the body', 'wrap() must emit the body it was given');
  }
  checks.push('non-capturing wrap emits shebang + body');

  const captured = language.wrap('# body-marker', ctx(true));
  if (!captured.includes('/tmp/tek-exit-code')) {
    fail(
      language,
      'ignores ScriptCtx.exitCodePath',
      'a capturing wrap() must write the exit code to the path it is given, not a hardcoded one',
    );
  }
  checks.push('capturing wrap references ctx.exitCodePath');

  if (!interpreterAvailable(opts.interpreter)) {
    return { checks, skipped: `interpreter "${opts.interpreter}" is not installed` };
  }

  const failed = run(language, opts.failing(code), opts);
  if (failed.status !== code) {
    fail(
      language,
      'does not re-exit with the body’s code',
      `expected exit ${code}, got ${failed.status}. A wrapper that swallows the code makes ` +
        `Tekton mark a failed step successful.${failed.stderr ? `\n${failed.stderr.trimEnd()}` : ''}`,
    );
  }
  if (failed.contract !== String(code)) {
    fail(
      language,
      'does not write the real exit code to the contract file',
      `expected "${code}" at ctx.exitCodePath, got "${failed.contract}". A status reporter ` +
        `reads that file, so a failed step would report green.`,
    );
  }
  checks.push(`failing body exits ${code} and writes ${code}`);

  if (opts.succeeding !== undefined) {
    const ok = run(language, opts.succeeding, opts);
    if (ok.status !== 0) {
      fail(
        language,
        'fails a succeeding body',
        `expected exit 0, got ${ok.status}${ok.stderr ? `\n${ok.stderr.trimEnd()}` : ''}`,
      );
    }
    if (ok.contract !== '0') {
      fail(
        language,
        'does not write 0 for a succeeding body',
        `expected "0" at ctx.exitCodePath, got "${ok.contract}"`,
      );
    }
    checks.push('succeeding body exits 0 and writes 0');
  }

  return { checks };
}

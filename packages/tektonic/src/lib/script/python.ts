import type { ScriptLanguage, ScriptCtx } from './types';

/** Indents every non-blank line by one level (4 spaces); blank lines stay blank. */
function indent(body: string): string {
  return body
    .split('\n')
    .map((line) => (line.trim().length ? `    ${line}` : line))
    .join('\n');
}

/**
 * Python scripting language plugin.
 *
 * The preamble provides a `log` helper. When capturing, the body is placed
 * inside `def _tek_main()` (re-indented one level) so `sys.exit(N)` raises
 * `SystemExit`, which the wrapper catches and maps to an exit code; any other
 * uncaught exception maps to `1` after printing a traceback. The contract file
 * keeps the *worst* code seen across a task's steps (a later success cannot mask
 * an earlier failure); the step re-exits its own. Bodies just `sys.exit(N)`.
 */
export class Python implements ScriptLanguage {
  readonly name = 'python';
  readonly shebang = '#!/usr/bin/env python3';

  private preamble(): string {
    return [
      this.shebang,
      'import sys',
      'from datetime import datetime as _dt',
      'def log(_m): print(f"[{_dt.now():%H:%M:%S}] {_m}", flush=True)',
    ].join('\n');
  }

  wrap(body: string, ctx: ScriptCtx): string {
    if (!ctx.captureExitCode) {
      return `${this.preamble()}\n${body}`;
    }
    const indented = indent(body).replace(/\s+$/, '');
    const mainBody = indented.trim().length ? indented : '    pass';
    return [
      this.preamble(),
      // See Sh.wrap: the contract file is shared across steps that may run as
      // different uids, so seed it and make it group/other-writable before the
      // body. Best-effort — a non-owner's chmod raises, and by then need not run.
      'import os as _tek_os',
      'try:',
      `    if not _tek_os.path.exists("${ctx.exitCodePath}"):`,
      `        with open("${ctx.exitCodePath}", "w") as _f: _f.write("0")`,
      `    _tek_os.chmod("${ctx.exitCodePath}", 0o666)`,
      'except OSError:',
      '    pass',
      'def _tek_main():',
      mainBody,
      '_tek_rc = 0',
      'try:',
      '    _tek_main()',
      'except SystemExit as _e:',
      '    _tek_rc = _e.code if isinstance(_e.code, int) else (0 if _e.code is None else 1)',
      'except BaseException:',
      '    import traceback; traceback.print_exc(); _tek_rc = 1',
      'try:',
      `    with open("${ctx.exitCodePath}") as _f: _tek_prev = int(_f.read().strip() or 0)`,
      'except Exception:',
      '    _tek_prev = 0',
      `with open("${ctx.exitCodePath}", "w") as _f:`,
      '    _f.write(str(max(_tek_prev, _tek_rc)))',
      'sys.exit(_tek_rc)',
    ].join('\n');
  }

  lintCommand(file: string): string[] {
    return ['python3', '-m', 'py_compile', file];
  }
}

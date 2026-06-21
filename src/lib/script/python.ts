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
 * uncaught exception maps to `1` after printing a traceback. The code is written
 * to the contract path and re-raised. Bodies just `sys.exit(N)` or return.
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
      'def _tek_main():',
      mainBody,
      '_tek_rc = 0',
      'try:',
      '    _tek_main()',
      'except SystemExit as _e:',
      '    _tek_rc = _e.code if isinstance(_e.code, int) else (0 if _e.code is None else 1)',
      'except BaseException:',
      '    import traceback; traceback.print_exc(); _tek_rc = 1',
      `with open("${ctx.exitCodePath}", "w") as _f:`,
      '    _f.write(str(_tek_rc))',
      'sys.exit(_tek_rc)',
    ].join('\n');
  }

  lintCommand(file: string): string[] {
    return ['python3', '-m', 'py_compile', file];
  }
}

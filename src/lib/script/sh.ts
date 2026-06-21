import type { ScriptLanguage, ScriptCtx } from './types';

/**
 * POSIX `sh` scripting language plugin (the portable default for Alpine/BusyBox
 * and Wolfi images that ship `/bin/sh` but not bash).
 *
 * The preamble provides a `log` helper. When {@link ScriptCtx.captureExitCode}
 * is set, the user body runs inside a subshell `( … )` so a mid-script `exit N`
 * is contained. The contract file keeps the *worst* exit code seen across a
 * task's steps (so a later success cannot mask an earlier failure); the step
 * then re-exits with its own code. All constructs are POSIX-clean, so
 * {@link Bash} reuses this implementation verbatim with a bash shebang.
 */
export class Sh implements ScriptLanguage {
  readonly name: string = 'sh';
  readonly shebang: string = '#!/bin/sh';

  protected preamble(): string {
    return [
      this.shebang,
      `log() { printf '[%s] %s\\n' "$(date +%H:%M:%S)" "$*"; }`,
    ].join('\n');
  }

  wrap(body: string, ctx: ScriptCtx): string {
    if (!ctx.captureExitCode) {
      return `${this.preamble()}\n${body}`;
    }
    return [
      this.preamble(),
      '(',
      body,
      ')',
      '__tek_rc=$?',
      `__tek_prev=$(cat ${ctx.exitCodePath} 2>/dev/null || echo 0)`,
      'if [ "$__tek_rc" -gt "$__tek_prev" ]; then __tek_prev="$__tek_rc"; fi',
      `printf '%s' "$__tek_prev" > ${ctx.exitCodePath}`,
      'exit "$__tek_rc"',
    ].join('\n');
  }

  lintCommand(file: string): string[] {
    // shellcheck infers the sh/bash dialect from the shebang.
    return ['shellcheck', file];
  }
}

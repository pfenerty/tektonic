import type { ScriptLanguage, ScriptCtx } from './types';

/**
 * Bash scripting language plugin.
 *
 * The preamble provides a `log` helper. When {@link ScriptCtx.captureExitCode}
 * is set, the user body runs inside a subshell `( … )` so a mid-script `exit N`
 * is contained rather than terminating the wrapper; the resulting code is
 * written to the exit-code contract path and re-exited. The body therefore just
 * ends naturally or calls `exit N` — no manual `/tekton/home/.exit-code` writes.
 */
export class Bash implements ScriptLanguage {
  readonly name = 'bash';
  readonly shebang = '#!/usr/bin/env bash';

  private preamble(): string {
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
      `printf '%s' "$__tek_rc" > ${ctx.exitCodePath}`,
      'exit "$__tek_rc"',
    ].join('\n');
  }

  lintCommand(file: string): string[] {
    return ['shellcheck', file];
  }
}

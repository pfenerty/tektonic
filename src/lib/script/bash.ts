import type { ScriptLanguage, ScriptCtx } from './types';

/**
 * Bash scripting language plugin.
 *
 * The preamble provides a `log` helper. When {@link ScriptCtx.captureExitCode}
 * is set, the user body runs inside a subshell `( … )` so a mid-script `exit N`
 * is contained rather than terminating the wrapper. The contract file keeps the
 * *worst* exit code seen so far across a task's steps (so a later success cannot
 * mask an earlier failure); the step then re-exits with its own code. The body
 * just ends naturally or calls `exit N` — no manual contract-file writes.
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
      `__tek_prev=$(cat ${ctx.exitCodePath} 2>/dev/null || echo 0)`,
      'if [ "$__tek_rc" -gt "$__tek_prev" ]; then __tek_prev="$__tek_rc"; fi',
      `printf '%s' "$__tek_prev" > ${ctx.exitCodePath}`,
      'exit "$__tek_rc"',
    ].join('\n');
  }

  lintCommand(file: string): string[] {
    return ['shellcheck', file];
  }
}

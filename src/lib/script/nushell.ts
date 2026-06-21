import type { ScriptLanguage, ScriptCtx } from './types';

/**
 * Nushell scripting language plugin.
 *
 * The preamble provides the `log` helper previously copy-pasted as `nuHeader`
 * in consumers. Nushell's `exit` terminates the process immediately and cannot
 * be trapped, so the captured-exit contract runs the body inside `def main []`
 * wrapped in `try/catch`: clean completion records `0`, a raised nushell error
 * records `1`. Bodies signal failure by raising (`error make`) or by a failing
 * external command — not by calling `exit` directly, which would bypass the
 * capture. The recorded code is written to the contract path and re-exited.
 */
export class Nushell implements ScriptLanguage {
  readonly name = 'nushell';
  readonly shebang = '#!/usr/bin/env nu';

  private preamble(): string {
    return [
      this.shebang,
      `def log [msg: string] { print $"[(date now | format date '%H:%M:%S')] ($msg)" }`,
    ].join('\n');
  }

  wrap(body: string, ctx: ScriptCtx): string {
    if (!ctx.captureExitCode) {
      return `${this.preamble()}\n${body}`;
    }
    return [
      this.preamble(),
      'def main [] {',
      body,
      '}',
      'let __tek_rc = (try { main; 0 } catch { |e| print $"error: ($e.msg)"; 1 })',
      `$"($__tek_rc)" | save -f ${ctx.exitCodePath}`,
      'exit $__tek_rc',
    ].join('\n');
  }

  lintCommand(file: string): string[] {
    return ['nu', '--ide-check', file];
  }
}

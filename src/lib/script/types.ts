/**
 * Canonical path where a wrapped step writes its captured exit code.
 *
 * This is the single source of truth for the exit-code contract shared between
 * a task's work step and a {@link StatusReporter}'s final step: the work step
 * runs with `onError: 'continue'` and writes its exit code here, and the
 * reporter step reads it to decide success/failure. Centralizing the literal
 * here replaces the hand-written `/tekton/home/.exit-code` strings previously
 * scattered across the reporter and consumer scripts.
 */
export const EXIT_CODE_PATH = '/tekton/home/.exit-code' as const;

/**
 * Context passed to {@link ScriptLanguage.wrap} at synth time.
 *
 * Carries the framework concerns a language plugin must honour when wrapping a
 * user-authored body — chiefly the exit-code/status contract — so that the
 * plumbing lives in the library rather than being hand-written in every script.
 */
export interface ScriptCtx {
  /**
   * Absolute path the wrapper writes the captured exit code to.
   * Defaults to {@link EXIT_CODE_PATH}; injectable for testing.
   */
  exitCodePath: string;
  /**
   * When `true`, the wrapper must run the body, capture its exit code to
   * {@link ScriptCtx.exitCodePath}, and still exit with that code — so a
   * later status step can read it. Set when the task reports status.
   * When `false`, the body runs without exit-code capture.
   */
  captureExitCode: boolean;
}

/**
 * A pluggable scripting language for step bodies.
 *
 * Each implementation (bash, nushell, python, …) knows how to render a shebang,
 * wrap a user-authored body with the framework's exit-code/status contract and
 * a small helper preamble, and produce the dev-harness command that lints an
 * extracted script file. Languages are an internal abstraction of tektonic:
 * no language is mandated, and the helper preamble is generated here at synth
 * time rather than sourced from any external image module.
 */
export interface ScriptLanguage {
  /** Stable identifier, e.g. `'bash'`, `'nushell'`, `'python'`. */
  readonly name: string;
  /** Shebang line prepended to the rendered script (without trailing newline). */
  readonly shebang: string;
  /**
   * Wraps a user-authored body into a complete script: shebang + helper
   * preamble + the body, honouring the exit-code contract in {@link ScriptCtx}.
   */
  wrap(body: string, ctx: ScriptCtx): string;
  /**
   * Returns the argv used to syntax-check/lint an extracted script `file`
   * in the local dev harness (e.g. `['shellcheck', file]`).
   */
  lintCommand(file: string): string[];
}

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Nushell } from './nushell';
import { EXIT_CODE_PATH } from './types';

const ctx = (captureExitCode: boolean) => ({ exitCodePath: EXIT_CODE_PATH, captureExitCode });

describe('Nushell plugin', () => {
  const nu = new Nushell();

  it('identifies as nushell with a nu shebang', () => {
    expect(nu.name).toBe('nushell');
    expect(nu.shebang).toBe('#!/usr/bin/env nu');
  });

  it('lints with a nu-check wrapper that yields a real exit code', () => {
    expect(nu.lintCommand('step.nu')).toEqual([
      'nu',
      '-c',
      'if (nu-check "step.nu") { exit 0 } else { exit 1 }',
    ]);
  });

  it('provides the log helper in the preamble', () => {
    const out = nu.wrap('print hi', ctx(false));
    expect(out.startsWith('#!/usr/bin/env nu')).toBe(true);
    expect(out).toContain('def log [msg: string]');
    expect(out).toContain('print hi');
    expect(out).not.toContain(EXIT_CODE_PATH);
  });

  it('with capture, runs body in main under try/catch and records the worst exit code', () => {
    const out = nu.wrap('^gofmt -l .', ctx(true));
    expect(out).toContain('def main [] {\n^gofmt -l .\n}');
    expect(out).toContain('try { main; 0 } catch');
    expect(out).toContain('[$__tek_prev $__tek_rc] | math max');
    expect(out).toContain(`$"($__tek_worst)" | save -f ${EXIT_CODE_PATH}`);
    expect(out).toContain('exit $__tek_rc');
  });

  it('with capture, seeds the contract file and opens it up to other uids', () => {
    const out = nu.wrap('print hi', ctx(true));
    expect(out).toContain(
      `if not ("${EXIT_CODE_PATH}" | path exists) { try { "0" | save -f ${EXIT_CODE_PATH} } }`,
    );
    expect(out).toContain(`try { ^chmod 0666 ${EXIT_CODE_PATH} }`);
    // Must precede the body: a step running as another uid has to find it already open.
    expect(out.indexOf('^chmod 0666')).toBeLessThan(out.indexOf('def main [] {'));
  });

  describe('failure attribution', () => {
    it('names the task and step in the catch line', () => {
      const out = nu.wrap('^gofmt -l .', {
        ...ctx(true),
        taskName: 'gofmt-check',
        stepName: 'fmt',
      });
      expect(out).toContain('print $"error [gofmt-check/fmt]: ($e.msg)"');
    });

    it('falls back to an unlabelled line when the ctx carries no names', () => {
      const out = nu.wrap('^gofmt -l .', ctx(true));
      expect(out).toContain('print $"error: ($e.msg)"');
    });

    it('uses whichever name is present', () => {
      const out = nu.wrap('^gofmt -l .', { ...ctx(true), taskName: 'gofmt-check' });
      expect(out).toContain('print $"error [gofmt-check]: ($e.msg)"');
    });
  });

  describe('non-zero exit in a capturing body', () => {
    // The failure mode this guards: nushell's exit is untrappable, so the wrapper never runs
    // and the contract file keeps its seeded 0 — a real failure that reported green.
    it('fails synthesis, naming the task, step and the replacement', () => {
      expect(() =>
        nu.wrap('if $bad { exit 1 }', { ...ctx(true), taskName: 'fmt', stepName: 'check' }),
      ).toThrow(/\[fmt\/check\].*error make/s);
    });

    it('points at the opt-out for a deliberate exit', () => {
      expect(() => nu.wrap('exit 99', ctx(true))).toThrow(/unsafeAllowExit/);
    });

    it('renders the body when the author opted out', () => {
      const out = nu.wrap('exit 99', { ...ctx(true), allowExit: true });
      expect(out).toContain('exit 99');
    });

    it('allows exit 0, an early return that cannot hide a failure', () => {
      expect(() => nu.wrap('if $skip { exit 0 }\nlog "work"', ctx(true))).not.toThrow();
    });

    it('ignores an exit inside a raw string bound for another interpreter', () => {
      expect(() => nu.wrap(`^sh -c r#'if [ -n "$x" ]; then exit 99; fi'#`, ctx(true))).not.toThrow();
    });

    it('allows exit in a non-capturing body, which owns its own exit code', () => {
      expect(() => nu.wrap('exit 1', ctx(false))).not.toThrow();
    });
  });
});

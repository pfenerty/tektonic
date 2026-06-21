import { describe, it, expect } from 'vitest';
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
});

import { describe, it, expect } from 'vitest';
import { Sh } from './sh';
import { Bash } from './bash';
import { EXIT_CODE_PATH } from './types';

const ctx = (captureExitCode: boolean) => ({ exitCodePath: EXIT_CODE_PATH, captureExitCode });

describe('Sh plugin', () => {
  const shp = new Sh();

  it('identifies as sh with a POSIX shebang', () => {
    expect(shp.name).toBe('sh');
    expect(shp.shebang).toBe('#!/bin/sh');
  });

  it('lints with shellcheck', () => {
    expect(shp.lintCommand('step.sh')).toEqual(['shellcheck', 'step.sh']);
  });

  it('without capture, emits shebang + log + body only', () => {
    const out = shp.wrap('echo hi', ctx(false));
    expect(out.startsWith('#!/bin/sh')).toBe(true);
    expect(out).toContain('log()');
    expect(out).toContain('echo hi');
    expect(out).not.toContain(EXIT_CODE_PATH);
  });

  it('with capture, records the worst exit code in a subshell', () => {
    const out = shp.wrap('exit 3', ctx(true));
    expect(out).toContain('(\nexit 3\n)');
    expect(out).toContain(`__tek_prev=$(cat ${EXIT_CODE_PATH} 2>/dev/null || echo 0)`);
    expect(out).toContain('exit "$__tek_rc"');
  });
});

describe('Bash extends Sh', () => {
  it('reuses the sh capture but with a bash shebang', () => {
    const out = new Bash().wrap('exit 3', ctx(true));
    expect(out.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(out).toContain('if [ "$__tek_rc" -gt "$__tek_prev" ]; then');
    expect(new Bash()).toBeInstanceOf(Sh);
  });
});

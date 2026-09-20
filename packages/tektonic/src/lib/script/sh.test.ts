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

  it('with capture, seeds the contract file and opens it up to other uids', () => {
    const out = shp.wrap('exit 3', ctx(true));
    expect(out).toContain(`[ -e ${EXIT_CODE_PATH} ] || printf '%s' 0 > ${EXIT_CODE_PATH}`);
    expect(out).toContain(`chmod 0666 ${EXIT_CODE_PATH} 2>/dev/null || true`);
    // Must precede the body: a step running as another uid has to find it already open.
    expect(out.indexOf('chmod 0666')).toBeLessThan(out.indexOf('(\nexit 3\n)'));
  });

  it('names the task and step on a non-zero body, unlabelled without them', () => {
    const named = shp.wrap('exit 3', { ...ctx(true), taskName: 'go-test', stepName: 'test' });
    expect(named).toContain(
      'if [ "$__tek_rc" -ne 0 ]; then log "error [go-test/test]: exited with status $__tek_rc"; fi',
    );
    expect(shp.wrap('exit 3', ctx(true))).toContain(
      'log "error: exited with status $__tek_rc"',
    );
  });

  it('does not attribute anything when not capturing', () => {
    const out = shp.wrap('exit 3', { ...ctx(false), taskName: 'go-test', stepName: 'test' });
    expect(out).not.toContain('__tek_rc');
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

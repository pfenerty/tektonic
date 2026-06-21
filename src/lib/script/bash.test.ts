import { describe, it, expect } from 'vitest';
import { Bash } from './bash';
import { EXIT_CODE_PATH } from './types';

const ctx = (captureExitCode: boolean) => ({ exitCodePath: EXIT_CODE_PATH, captureExitCode });

describe('Bash plugin', () => {
  const bash = new Bash();

  it('identifies as bash with a bash shebang', () => {
    expect(bash.name).toBe('bash');
    expect(bash.shebang).toBe('#!/usr/bin/env bash');
  });

  it('lints with shellcheck', () => {
    expect(bash.lintCommand('step.bash')).toEqual(['shellcheck', 'step.bash']);
  });

  it('without capture, emits shebang + log + body only', () => {
    const out = bash.wrap('echo hi', ctx(false));
    expect(out.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(out).toContain('log()');
    expect(out).toContain('echo hi');
    expect(out).not.toContain(EXIT_CODE_PATH);
  });

  it('with capture, runs body in a subshell and records the worst exit code', () => {
    const out = bash.wrap('exit 3', ctx(true));
    expect(out).toContain('(\nexit 3\n)');
    expect(out).toContain('__tek_rc=$?');
    expect(out).toContain(`__tek_prev=$(cat ${EXIT_CODE_PATH} 2>/dev/null || echo 0)`);
    expect(out).toContain('if [ "$__tek_rc" -gt "$__tek_prev" ]; then __tek_prev="$__tek_rc"; fi');
    expect(out).toContain(`printf '%s' "$__tek_prev" > ${EXIT_CODE_PATH}`);
    expect(out).toContain('exit "$__tek_rc"');
  });
});

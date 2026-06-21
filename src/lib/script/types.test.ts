import { describe, it, expect } from 'vitest';
import { EXIT_CODE_PATH } from './types';
import type { ScriptCtx, ScriptLanguage } from './types';

describe('script contract', () => {
  it('exposes the canonical exit-code path', () => {
    expect(EXIT_CODE_PATH).toBe('/tekton/home/.exit-code');
  });

  it('lets ScriptCtx default its exitCodePath to the canonical constant', () => {
    const ctx: ScriptCtx = { exitCodePath: EXIT_CODE_PATH, captureExitCode: true };
    expect(ctx.exitCodePath).toBe(EXIT_CODE_PATH);
  });

  it('admits a conforming ScriptLanguage implementation', () => {
    // A minimal stand-in proving the interface shape compiles and is usable.
    // Real plugins (bash/nushell/python) land in follow-up issues.
    const fake: ScriptLanguage = {
      name: 'fake',
      shebang: '#!/usr/bin/env fake',
      wrap: (body, ctx) =>
        ctx.captureExitCode ? `${body}\n# capture -> ${ctx.exitCodePath}` : body,
      lintCommand: (file) => ['fake-lint', file],
    };

    expect(fake.name).toBe('fake');
    expect(fake.shebang).toContain('fake');
    expect(fake.lintCommand('s.fake')).toEqual(['fake-lint', 's.fake']);
    expect(fake.wrap('echo hi', { exitCodePath: EXIT_CODE_PATH, captureExitCode: true })).toContain(
      EXIT_CODE_PATH,
    );
    expect(fake.wrap('echo hi', { exitCodePath: EXIT_CODE_PATH, captureExitCode: false })).toBe(
      'echo hi',
    );
  });
});

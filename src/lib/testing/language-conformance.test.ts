import { describe, it, expect } from 'vitest';
import { assertExitCodeContract, interpreterAvailable } from './language-conformance';
import { Sh } from '../script/sh';
import { Nushell } from '../script/nushell';
import { Python } from '../script/python';
import { EXIT_CODE_PATH } from '../script/types';
import type { ScriptCtx, ScriptLanguage } from '../script';

/** A language whose wrapper runs the body but drops the code — the silent-green failure. */
class Swallowing implements ScriptLanguage {
  readonly name = 'swallowing';
  readonly shebang = '#!/bin/sh';
  wrap(body: string, ctx: ScriptCtx): string {
    return [this.shebang, `printf '%s' 0 > ${ctx.exitCodePath}`, '(', body, ')', 'exit 0'].join('\n');
  }
  lintCommand(file: string): string[] {
    return ['shellcheck', file];
  }
}

const shOpts = {
  interpreter: 'sh',
  extension: '.sh',
  failing: (code: number) => `echo failing\nexit ${code}`,
  succeeding: 'echo ok',
};

describe('assertExitCodeContract', () => {
  it.skipIf(!interpreterAvailable('sh'))('passes the built-in sh language', () => {
    const r = assertExitCodeContract(new Sh(), shOpts);
    expect(r.skipped).toBeUndefined();
    expect(r.checks).toContain('failing body exits 3 and writes 3');
    expect(r.checks).toContain('succeeding body exits 0 and writes 0');
  });

  it.skipIf(!interpreterAvailable('nu'))('passes the built-in nushell language', () => {
    const r = assertExitCodeContract(new Nushell(), {
      interpreter: 'nu',
      extension: '.nu',
      // nushell's own `exit` bypasses the wrapper by design; a raised error is the
      // failure path the contract covers, and it maps to 1.
      code: 1,
      failing: () => 'error make {msg: "boom"}',
      succeeding: 'print ok',
    });
    expect(r.skipped).toBeUndefined();
  });

  it.skipIf(!interpreterAvailable('python3'))('passes the built-in python language', () => {
    const r = assertExitCodeContract(new Python(), {
      interpreter: 'python3',
      extension: '.py',
      failing: code => `sys.exit(${code})`,
      succeeding: 'log("ok")',
    });
    expect(r.skipped).toBeUndefined();
  });

  it.skipIf(!interpreterAvailable('sh'))('catches a wrapper that swallows the exit code', () => {
    expect(() => assertExitCodeContract(new Swallowing(), shOpts)).toThrow(
      /does not re-exit with the body/,
    );
  });

  it('catches a wrapper that hardcodes the contract path', () => {
    class Hardcoded extends Sh {
      readonly name = 'hardcoded';
      wrap(body: string, ctx: ScriptCtx): string {
        return super.wrap(body, { ...ctx, exitCodePath: EXIT_CODE_PATH });
      }
    }
    expect(() => assertExitCodeContract(new Hardcoded(), shOpts)).toThrow(
      /ignores ScriptCtx.exitCodePath/,
    );
  });

  it('catches a missing shebang and a dropped body before running anything', () => {
    const noShebang: ScriptLanguage = {
      name: 'no-shebang',
      shebang: 'sh',
      wrap: body => body,
      lintCommand: file => ['true', file],
    };
    expect(() => assertExitCodeContract(noShebang, shOpts)).toThrow(/has no shebang/);

    class Dropping extends Sh {
      readonly name = 'dropping';
      wrap(): string {
        return this.shebang;
      }
    }
    expect(() => assertExitCodeContract(new Dropping(), shOpts)).toThrow(/dropped the body/);
  });

  it('reports the static checks and skips execution when the interpreter is absent', () => {
    const r = assertExitCodeContract(new Sh(), { ...shOpts, interpreter: 'no-such-interpreter-9x' });
    expect(r.skipped).toMatch(/no-such-interpreter-9x/);
    expect(r.checks).toContain('capturing wrap references ctx.exitCodePath');
  });
});

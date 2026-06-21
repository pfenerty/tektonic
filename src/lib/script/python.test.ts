import { describe, it, expect } from 'vitest';
import { Python } from './python';
import { EXIT_CODE_PATH } from './types';

const ctx = (captureExitCode: boolean) => ({ exitCodePath: EXIT_CODE_PATH, captureExitCode });

describe('Python plugin', () => {
  const py = new Python();

  it('identifies as python with a python3 shebang', () => {
    expect(py.name).toBe('python');
    expect(py.shebang).toBe('#!/usr/bin/env python3');
  });

  it('lints with py_compile', () => {
    expect(py.lintCommand('step.py')).toEqual(['python3', '-m', 'py_compile', 'step.py']);
  });

  it('provides the log helper in the preamble', () => {
    const out = py.wrap('print("hi")', ctx(false));
    expect(out.startsWith('#!/usr/bin/env python3')).toBe(true);
    expect(out).toContain('def log(_m):');
    expect(out).toContain('print("hi")');
    expect(out).not.toContain(EXIT_CODE_PATH);
  });

  it('with capture, indents the body into _tek_main and catches SystemExit', () => {
    const out = py.wrap('log("checking")\nsys.exit(2)', ctx(true));
    expect(out).toContain('def _tek_main():\n    log("checking")\n    sys.exit(2)');
    expect(out).toContain('except SystemExit as _e:');
    expect(out).toContain(`with open("${EXIT_CODE_PATH}", "w") as _f:`);
    expect(out).toContain('sys.exit(_tek_rc)');
  });

  it('falls back to pass for an empty body', () => {
    const out = py.wrap('   ', ctx(true));
    expect(out).toContain('def _tek_main():\n    pass');
  });
});

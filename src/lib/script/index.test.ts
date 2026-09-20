import { describe, it, expect } from 'vitest';
import { bash, nu, py, script, Script, rawScript, unsafeAllowExit, dedent, languageFor, renderScript } from './index';
import { EXIT_CODE_PATH } from './types';

const ctx = (captureExitCode = false) => ({ exitCodePath: EXIT_CODE_PATH, captureExitCode });

describe('dedent', () => {
  it('strips common indentation and surrounding blank lines', () => {
    const out = dedent('\n      log "a"\n        nested\n\n');
    expect(out).toBe('log "a"\n  nested');
  });
});

describe('tagged-template helpers', () => {
  it('bash/nu/py carry the right language and a dedented body', () => {
    expect(bash`echo hi`.language.name).toBe('bash');
    expect(nu`print hi`.language.name).toBe('nushell');
    expect(py`print("hi")`.language.name).toBe('python');
    const s = bash`
      echo one
      echo two
    `;
    expect(s).toBeInstanceOf(Script);
    expect(s.body).toBe('echo one\necho two');
  });

  it('interpolates values via String() (e.g. Param-like handles)', () => {
    const url = { toString: () => '$(params.url)' };
    const s = bash`git clone ${url} .`;
    expect(s.body).toBe('git clone $(params.url) .');
  });
});

describe('script() object helper', () => {
  it('builds a Script from a {language, body}', () => {
    const s = script({ language: 'python', body: 'print("x")' });
    expect(s.language.name).toBe('python');
    expect(s.body).toBe('print("x")');
  });
});

describe('languageFor', () => {
  // An unregistered name is a runtime error now, not a type error: LanguageName is open so
  // a language registered by another package is nameable. See registry.test.ts.
  it('throws on an unregistered language, listing the registered names', () => {
    expect(() => languageFor('ruby')).toThrow(/Unknown script language "ruby" \(expected one of/);
  });
});

describe('renderScript', () => {
  it('passes through a raw shebang string unchanged', () => {
    const raw = '#!/bin/sh\necho hi';
    expect(renderScript(raw, ctx())).toBe(raw);
  });

  it('passes through a non-shebang string when no default language is set', () => {
    expect(renderScript('echo hi', ctx())).toBe('echo hi');
  });

  it('wraps a non-shebang string with the default language', () => {
    const out = renderScript('echo hi', ctx(), 'bash');
    expect(out.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(out).toContain('echo hi');
  });

  it('renders a Script via its own language', () => {
    const out = renderScript(py`print("hi")`, ctx());
    expect(out.startsWith('#!/usr/bin/env python3')).toBe(true);
  });

  it('renders an object form via the named language', () => {
    const out = renderScript({ language: 'nushell', body: 'print hi' }, ctx());
    expect(out.startsWith('#!/usr/bin/env nu')).toBe(true);
  });

  // A verbatim body writes no exit code, so in a reporting task it silently opts out of the
  // contract the reporter reads — the shape that lets a real failure report green.
  it('rejects a raw shebang string in a capturing task', () => {
    expect(() => renderScript('#!/bin/sh\nfalse', { ...ctx(true), taskName: 'lint' })).toThrow(
      /raw '#!' script string.*rawScript\(\)/s,
    );
  });

  it('emits a rawScript() body verbatim, capturing or not', () => {
    const body = '#!/bin/sh\nfalse';
    expect(renderScript(rawScript(body), ctx(true))).toBe(body);
    expect(renderScript(rawScript(body), ctx())).toBe(body);
  });

  it('carries a Script opt-out through to the language wrapper', () => {
    expect(() => renderScript(nu`exit 7`, ctx(true))).toThrow(/unsafeAllowExit/);
    expect(renderScript(unsafeAllowExit(nu`exit 7`), ctx(true))).toContain('exit 7');
  });
});

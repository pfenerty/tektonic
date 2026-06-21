import { describe, it, expect } from 'vitest';
import { bash, nu, py, script, Script, dedent, languageFor, renderScript } from './index';
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
  it('throws on an unknown language', () => {
    // @ts-expect-error intentionally invalid name
    expect(() => languageFor('ruby')).toThrow(/Unknown script language/);
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
});

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { fragment, Fragment, sh, nu, embedSh } from './index';
import { Param } from '../core/param';

const has = (bin: string): boolean => !spawnSync(bin, ['--version'], { stdio: 'ignore' }).error;

describe('fragment', () => {
  it('dedents on its own', () => {
    const f = fragment`
      set -e
        indented
    `;
    expect(f.body).toBe('set -e\n  indented');
  });

  // The bug this exists for: a plain multi-line string keeps the column it was written at, so
  // one flush-left snippet makes dedent() leave the whole surrounding template indented.
  it('re-indents to the interpolation column', () => {
    const retry = fragment`
      n=0
      until [ $n -ge 3 ]; do "$@" && break; n=$((n+1)); done
    `;
    const body = sh`
      set -e
      retry() {
        ${retry}
      }
    `.body;
    expect(body).toBe(
      ['set -e', 'retry() {', '  n=0', '  until [ $n -ge 3 ]; do "$@" && break; n=$((n+1)); done', '}'].join('\n'),
    );
  });

  // Unchanged for plain strings: their lines keep the column they were written at, and the
  // flush-left one pins dedent's common minimum at 0 so the template stays indented. That is
  // the breakage fragment() exists to avoid, kept here so the difference is visible.
  it('leaves a plain multi-line string at the column it was written', () => {
    const body = sh`
      before
      ${'a\nb'}
      after
    `.body;
    expect(body).toBe('      before\n      a\nb\n      after');

    const fixed = sh`
      before
      ${fragment`a\nb`}
      after
    `.body;
    expect(fixed).toBe('before\na\nb\nafter');
  });

  it('composes with other fragments and values', () => {
    const inner = fragment`echo inner`;
    const outer = fragment`
      if true; then
        ${inner}
      fi
    `;
    const rev = new Param({ name: 'revision' });
    const body = sh`
      ${outer}
      echo "${rev}"
    `.body;
    expect(body).toBe('if true; then\n  echo inner\nfi\necho "$(params.revision)"');
  });

  it('stringifies to its body, so it also works in a plain template', () => {
    expect(`${fragment`echo hi`}`).toBe('echo hi');
    expect(fragment`echo hi`).toBeInstanceOf(Fragment);
  });
});

describe('embedSh', () => {
  it('wraps the body in a nushell raw string with positional args', () => {
    const limit = new Param({ name: 'mem-limit' });
    const f = embedSh(`echo "$1"`, { args: [limit] });
    expect(f.body).toBe(`^sh -c r#'echo "$1"'# sh "$(params.mem-limit)"`);
  });

  it('widens the raw-string fence when the body would close it', () => {
    const f = embedSh(`echo "it'#s fine"`);
    expect(f.body).toContain(`r##'`);
    expect(f.body).toContain(`'##`);
  });

  it('dedents the embedded body', () => {
    const f = embedSh(`
      set -e
      echo hi
    `);
    expect(f.body).toContain(`r#'set -e\necho hi'#`);
  });

  it('honours a different shell', () => {
    expect(embedSh('echo hi', { shell: 'bash' }).body).toBe(`^bash -c r#'echo hi'# bash`);
  });

  // An exit inside the embedded body belongs to the sh process, so the nushell plugin's
  // exit check — which strips raw strings before scanning — must not fire on it.
  it('does not trip the nushell exit guard', () => {
    const body = nu`
      ${embedSh(`[ "$1" -gt 10 ] && exit 99`, { args: ['42'] })}
      log "done"
    `;
    expect(() => body.language.wrap(body.body, { exitCodePath: '/tmp/ec', captureExitCode: true })).not.toThrow();
  });

  it.skipIf(!has('nu'))('runs the embedded body with its arguments', () => {
    const script = nu`${embedSh(`echo "arg is $1"`, { args: ['hello'] })}`;
    const rendered = script.language.wrap(script.body, { exitCodePath: '/tmp/tek-ec', captureExitCode: false });
    const r = spawnSync('nu', ['-c', rendered.split('\n').slice(1).join('\n')], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('arg is hello');
  });

  it.skipIf(!has('nu'))('surfaces the embedded body exit code to nushell', () => {
    const script = nu`${embedSh(`exit 3`)}`;
    const r = spawnSync('nu', ['-c', script.body], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
  });
});

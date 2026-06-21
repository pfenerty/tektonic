import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scriptFromFile, lintCommandForFile, languageNameForFile } from './from-file';

let dir: string;
const write = (name: string, content: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tek-script-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scriptFromFile', () => {
  it('infers nushell from .nu and strips a leading shebang', () => {
    const p = write('a.nu', '#!/usr/bin/env nu\nlog "hi"\n');
    const s = scriptFromFile(p);
    expect(s.language.name).toBe('nushell');
    expect(s.body).toBe('log "hi"');
  });

  it('infers bash from .bash and POSIX sh from .sh', () => {
    expect(scriptFromFile(write('b.bash', 'echo hi')).language.name).toBe('bash');
    expect(scriptFromFile(write('c.sh', 'echo hi')).language.name).toBe('sh');
  });

  it('infers python from .py and preserves relative indentation', () => {
    const p = write('d.py', '#!/usr/bin/env python3\nif True:\n    print("hi")\n');
    const s = scriptFromFile(p);
    expect(s.language.name).toBe('python');
    expect(s.body).toBe('if True:\n    print("hi")');
  });

  it('throws on an unknown extension', () => {
    const p = write('e.rb', 'puts 1');
    expect(() => scriptFromFile(p)).toThrow(/cannot infer language/);
  });

  it('honours an explicit language override', () => {
    const p = write('f.txt', 'print hi');
    expect(scriptFromFile(p, { language: 'nushell' }).language.name).toBe('nushell');
  });
});

describe('lint helpers', () => {
  it('returns the per-language lint command by extension', () => {
    expect(lintCommandForFile('s.bash')).toEqual(['shellcheck', 's.bash']);
    expect(lintCommandForFile('s.sh')).toEqual(['shellcheck', 's.sh']);
    expect(lintCommandForFile('s.nu')).toEqual(['nu', '-c', 'if (nu-check "s.nu") { exit 0 } else { exit 1 }']);
    expect(lintCommandForFile('s.py')).toEqual(['python3', '-m', 'py_compile', 's.py']);
  });

  it('honours a language override and rejects unknown extensions', () => {
    expect(lintCommandForFile('s.txt', { language: 'python' })).toEqual([
      'python3', '-m', 'py_compile', 's.txt',
    ]);
    expect(() => languageNameForFile('s.txt')).toThrow(/cannot infer language/);
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Script,
  languageFor,
  languageNameForExtension,
  registerLanguage,
  registeredExtensions,
  registeredLanguageNames,
  renderScript,
  script,
  unregisterLanguage,
} from './index';
import type { ScriptCtx, ScriptLanguage } from './types';
import { scriptFromFile, lintCommandForFile } from './from-file';
import { collectScripts, lintableExtensions } from '../../cli/lint';
import { Task } from '../core/task';
import { synthTask } from '../testing';

/**
 * A stand-in for a language shipped by another package: it knows nothing about tektonic's
 * internals and reaches the registry through the published `registerLanguage` alone. Every
 * assertion below is a path a third party would otherwise have had to fork the core to reach.
 */
class Ruby implements ScriptLanguage {
  readonly name = 'ruby';
  readonly shebang = '#!/usr/bin/env ruby';

  wrap(body: string, ctx: ScriptCtx): string {
    if (!ctx.captureExitCode) return `${this.shebang}\n${body}`;
    return [
      this.shebang,
      'rc = 0',
      'begin',
      body,
      'rescue SystemExit => e',
      '  rc = e.status',
      'end',
      `File.write(${JSON.stringify(ctx.exitCodePath)}, rc.to_s)`,
      'exit rc',
    ].join('\n');
  }

  lintCommand(file: string): string[] {
    return ['ruby', '-c', file];
  }
}

/** A minimal stand-in used where only the registry's bookkeeping is under test. */
const stub = (name: string): ScriptLanguage => ({
  name,
  shebang: `#!/usr/bin/env ${name}`,
  wrap: body => body,
  lintCommand: file => ['true', file],
});

const registered: string[] = [];
const register = (lang: ScriptLanguage, extensions?: string[]) => {
  registered.push(lang.name);
  return registerLanguage(lang, extensions ? { extensions } : {});
};

afterEach(() => {
  while (registered.length) unregisterLanguage(registered.pop() as string);
  vi.restoreAllMocks();
});

const ctx = (captureExitCode = false): ScriptCtx => ({
  exitCodePath: '/tekton/home/.exit-code',
  captureExitCode,
});

describe('the built-ins go through the registry', () => {
  it('registers all four languages and their extensions', () => {
    expect(registeredLanguageNames()).toEqual(expect.arrayContaining(['sh', 'bash', 'nushell', 'python']));
    expect(registeredExtensions()).toEqual(expect.arrayContaining(['.sh', '.bash', '.nu', '.py']));
    expect(languageNameForExtension('.nu')).toBe('nushell');
  });

  it('normalises an extension lookup (dot optional, case-insensitive)', () => {
    expect(languageNameForExtension('PY')).toBe('python');
  });
});

describe('registerLanguage', () => {
  it('returns a tagged-template helper, so no name is needed at the call site', () => {
    const rb = register(new Ruby(), ['.rb']);
    const s = rb`
      puts "hi"
    `;
    expect(s).toBeInstanceOf(Script);
    expect(s.language.name).toBe('ruby');
    expect(s.body).toBe('puts "hi"');
  });

  it('reaches languageFor and the { language, body } object form', () => {
    register(new Ruby(), ['.rb']);
    expect(languageFor('ruby').shebang).toBe('#!/usr/bin/env ruby');
    expect(script({ language: 'ruby', body: 'puts 1' }).language.name).toBe('ruby');
    expect(renderScript({ language: 'ruby', body: 'puts 1' }, ctx())).toBe('#!/usr/bin/env ruby\nputs 1');
  });

  it('serves as a task-level defaultLanguage for a bare body', () => {
    register(new Ruby(), ['.rb']);
    const task = new Task({
      name: 'rb',
      defaultLanguage: 'ruby',
      steps: [{ name: 'run', image: 'ruby:3', script: 'puts 1' }],
    });
    expect(synthTask(task).script('run')).toBe('#!/usr/bin/env ruby\nputs 1');
  });

  it('serves as a project-level defaultLanguage', () => {
    register(new Ruby(), ['.rb']);
    const task = new Task({ name: 'rb', steps: [{ name: 'run', image: 'ruby:3', script: 'puts 1' }] });
    expect(synthTask(task, { defaultLanguage: 'ruby' }).script('run')).toBe('#!/usr/bin/env ruby\nputs 1');
  });

  it('rejects a language with no name', () => {
    expect(() => registerLanguage(stub('  '))).toThrow(/non-empty `name`/);
  });

  it('refuses to override a registered name', () => {
    register(new Ruby(), ['.rb']);
    expect(() => registerLanguage(new Ruby())).toThrow(/already registered/);
    // The built-ins are no more privileged than anyone else.
    expect(() => registerLanguage(stub('nushell'))).toThrow(/already registered/);
  });

  it('warns on a conflicting extension and lets the last registration win', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    register(new Ruby(), ['.rb']);
    register(stub('ruby-next'), ['.rb']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"ruby"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"ruby-next"'));
    expect(languageNameForExtension('.rb')).toBe('ruby-next');
  });
});

describe('unregisterLanguage', () => {
  it('removes the language and the extensions it owned', () => {
    register(new Ruby(), ['.rb']);
    expect(unregisterLanguage('ruby')).toBe(true);
    registered.pop();
    expect(languageNameForExtension('.rb')).toBeUndefined();
    expect(() => languageFor('ruby')).toThrow(/Unknown script language "ruby" \(expected one of .*nushell/);
    expect(unregisterLanguage('ruby')).toBe(false);
  });
});

describe('file-based ergonomics', () => {
  it('infers a registered language from its extension and lints with its own command', () => {
    register(new Ruby(), ['.rb']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tek-registry-'));
    try {
      const file = path.join(dir, 'check.rb');
      fs.writeFileSync(file, '#!/usr/bin/env ruby\nputs 1\n');
      const s = scriptFromFile(file);
      expect(s.language.name).toBe('ruby');
      expect(s.body).toBe('puts 1');
      expect(lintCommandForFile(file)).toEqual(['ruby', '-c', file]);
      expect(collectScripts(dir)).toEqual([file]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the registered extensions when inference fails', () => {
    expect(() => scriptFromFile('nope.rb')).toThrow(/cannot infer language.*\.nu/s);
  });

  it('keeps `tektonic lint` discovery in step with the registry', () => {
    expect(lintableExtensions()).not.toContain('.rb');
    register(new Ruby(), ['.rb']);
    expect(lintableExtensions()).toContain('.rb');
  });
});

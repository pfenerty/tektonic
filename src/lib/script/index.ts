import { Bash } from './bash';
import { Nushell } from './nushell';
import { Python } from './python';
import type { ScriptLanguage, ScriptCtx } from './types';

export type { ScriptLanguage, ScriptCtx } from './types';
export { EXIT_CODE_PATH } from './types';
export { Bash } from './bash';
export { Nushell } from './nushell';
export { Python } from './python';

/** Names of the built-in script languages. */
export type LanguageName = 'bash' | 'nushell' | 'python';

const LANGUAGES: Record<LanguageName, ScriptLanguage> = {
  bash: new Bash(),
  nushell: new Nushell(),
  python: new Python(),
};

/** Resolves a language name to its plugin, throwing on an unknown name. */
export function languageFor(name: LanguageName): ScriptLanguage {
  const lang = LANGUAGES[name];
  if (!lang) {
    throw new Error(`Unknown script language "${name}" (expected one of ${Object.keys(LANGUAGES).join(', ')})`);
  }
  return lang;
}

/** A script body paired with the {@link ScriptLanguage} that should render it. */
export class Script {
  constructor(readonly language: ScriptLanguage, readonly body: string) {}
}

/** Object form accepted by `TaskStepSpec.script`, e.g. `{ language: 'python', body: '…' }`. */
export interface ScriptObject {
  language: LanguageName;
  body: string;
}

/** Anything accepted by `TaskStepSpec.script`. */
export type ScriptInput = string | Script | ScriptObject;

/**
 * Removes surrounding blank lines and the common leading indentation from a
 * template body, preserving relative indentation (important for Python). Tabs
 * are normalised to four spaces first.
 */
export function dedent(text: string): string {
  const lines = text.replace(/\t/g, '    ').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indents = lines
    .filter((l) => l.trim().length)
    .map((l) => (l.match(/^ */) ?? [''])[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

function interpolate(strings: TemplateStringsArray, values: unknown[]): string {
  let out = '';
  strings.forEach((s, i) => {
    out += s + (i < values.length ? String(values[i]) : '');
  });
  return out;
}

function tag(language: ScriptLanguage) {
  return (strings: TemplateStringsArray, ...values: unknown[]): Script =>
    new Script(language, dedent(interpolate(strings, values)));
}

/** Tagged-template helper authoring a bash step body, e.g. ``bash`echo hi` ``. */
export const bash = tag(LANGUAGES.bash);
/** Tagged-template helper authoring a nushell step body, e.g. ``nu`print hi` ``. */
export const nu = tag(LANGUAGES.nushell);
/** Tagged-template helper authoring a python step body, e.g. ``py`print("hi")` ``. */
export const py = tag(LANGUAGES.python);

/** Object-form helper: `script({ language: 'python', body: '…' })`. */
export function script(spec: ScriptObject): Script {
  return new Script(languageFor(spec.language), dedent(spec.body));
}

/**
 * Resolves a {@link ScriptInput} to the final step `script` string at synth time.
 *
 * - A {@link Script} (from a tag or {@link script}) is rendered by its language.
 * - A {@link ScriptObject} is rendered by the named language.
 * - A raw string that begins with a shebang is passed through unchanged
 *   (legacy/back-compat, including the library's own injected steps).
 * - A raw string without a shebang is rendered with `defaultLanguage` if one is
 *   set, otherwise passed through unchanged.
 */
export function renderScript(
  input: ScriptInput,
  ctx: ScriptCtx,
  defaultLanguage?: LanguageName,
): string {
  if (typeof input === 'string') {
    if (input.startsWith('#!')) return input;
    if (defaultLanguage) return languageFor(defaultLanguage).wrap(dedent(input), ctx);
    return input;
  }
  if (input instanceof Script) return input.language.wrap(input.body, ctx);
  return languageFor(input.language).wrap(dedent(input.body), ctx);
}

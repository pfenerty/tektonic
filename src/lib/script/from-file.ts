import * as fs from 'fs';
import * as path from 'path';
import { Script, dedent, languageFor, languageNameForExtension, registeredExtensions } from './index';
import type { LanguageName } from './index';

/** Removes a leading shebang line so it isn't duplicated by the language wrapper. */
function stripShebang(text: string): string {
  if (!text.startsWith('#!')) return text;
  const nl = text.indexOf('\n');
  return nl === -1 ? '' : text.slice(nl + 1);
}

/**
 * Infers the script language of a file from its extension (overridable),
 * throwing when the extension is unknown and no override is given.
 */
export function languageNameForFile(filePath: string, override?: LanguageName): LanguageName {
  const ext = path.extname(filePath).toLowerCase();
  const language = override ?? languageNameForExtension(ext);
  if (!language) {
    throw new Error(
      `cannot infer language from "${filePath}" (extension "${ext}"). ` +
        `Pass a language explicitly or use one of ${registeredExtensions().join(', ')}. ` +
        `A language registered with registerLanguage(lang, { extensions }) claims its own.`,
    );
  }
  return language;
}

/**
 * Returns the dev-harness lint/syntax-check command for a script file, chosen by
 * the file's language (e.g. `['shellcheck', file]`). See {@link scriptFromFile}
 * for the extension mapping.
 */
export function lintCommandForFile(filePath: string, opts?: { language?: LanguageName }): string[] {
  return languageFor(languageNameForFile(filePath, opts?.language)).lintCommand(filePath);
}

/**
 * Authors a step script from a file on disk, inferring the language from the
 * extension (`.sh` → sh, `.bash` → bash, `.nu` → nushell, `.py` → python, plus any
 * extension a registered language claims).
 *
 * The file is read immediately (relative to the current working directory unless
 * an absolute path is given) and returned as a {@link Script}, so it composes
 * with `TaskStepSpec.script` exactly like the inline tagged-template helpers.
 * A leading shebang in the file is stripped (the language wrapper adds its own),
 * which lets scripts be authored as standalone, editor- and lint-friendly files
 * while still being rendered through the framework's exit-code contract.
 *
 * @param filePath - Path to the script file.
 * @param opts.language - Overrides extension-based inference.
 */
export function scriptFromFile(filePath: string, opts?: { language?: LanguageName }): Script {
  const language = languageNameForFile(filePath, opts?.language);
  const raw = fs.readFileSync(filePath, 'utf8');
  return new Script(languageFor(language), dedent(stripShebang(raw)));
}

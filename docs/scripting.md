# Scripting

Steps run scripts. Tektonic treats those scripts as a first-class, typed, **testable**
part of your pipeline rather than as opaque strings buried in YAML. You can author a step
body inline with a language-tagged template, or — better for anything non-trivial — keep it
in a real `.sh`/`.bash`/`.nu`/`.py` file that your editor highlights, your linter checks,
and your test suite can execute.

This guide covers the four ways to author a script, how the language plugins work, the
exit-code contract the framework owns for you, and how to test scripts.

## The four authoring forms

`TaskStepSpec.script` accepts a `ScriptInput`, which is one of:

```typescript
import { sh, bash, nu, py, script, scriptFromFile } from '@pfenerty/tektonic';

// 1. Tagged template — inline, language inferred from the tag
script: sh`echo "hello from POSIX sh"`
script: bash`set -euo pipefail; echo "bashisms allowed"`
script: nu`print "hello from nushell"`
script: py`print("hello from python")`

// 2. Object form — when the language name is dynamic
script: script({ language: 'python', body: 'print("hi")' })

// 3. From a separate file — language inferred from the extension
script: scriptFromFile(path.join(__dirname, 'build.sh'))   // → sh
script: scriptFromFile(path.join(__dirname, 'fmt.nu'))     // → nushell

// 4. Raw string (legacy / back-compat)
script: '#!/bin/sh\necho hi'   // a shebang string is passed through unchanged
```

Tagged templates and `scriptFromFile` both run through `dedent()`, so you can indent the body
to match the surrounding TypeScript and the common leading indentation is stripped (relative
indentation is preserved, which matters for Python).

### Extension → language mapping

`scriptFromFile` infers the language from the file extension:

| Extension | Language |
|-----------|----------|
| `.sh`     | `sh` (POSIX) |
| `.bash`   | `bash` |
| `.nu`     | `nushell` |
| `.py`     | `python` |

Override the inference when the extension is ambiguous or unconventional:

```typescript
scriptFromFile(path.join(__dirname, 'check'), { language: 'sh' })
```

A leading shebang in the file is **stripped** when loaded (the language plugin adds its own at
synth time). This lets the file keep a shebang so it stays runnable and lint-friendly on its
own, without that shebang being duplicated in the rendered step.

## Scripts in separate files (recommended)

Keeping step bodies in real files is the point of the scripting system: you get syntax
highlighting, `shellcheck`/`py_compile`/`nu-check` linting, and — crucially — the ability to
run the script directly in a test. A task then becomes a thin, declarative wrapper:

```typescript
// jobs/go-fmt/spec.ts
import * as path from 'path';
import { Task, scriptFromFile } from '@pfenerty/tektonic';
import { goImage, statusReporter } from '../../shared';

export const goFmt = new Task({
  name: 'go-fmt',
  statusReporter,
  steps: [
    { name: 'fmt', image: goImage, script: scriptFromFile(path.join(__dirname, 'fmt.nu')) },
  ],
});
```

```nu
# jobs/go-fmt/fmt.nu
#!/usr/bin/env nu
log "Checking gofmt"
let unformatted = (^gofmt -l . | complete | get stdout | str trim)
if ($unformatted | str length) > 0 {
  print "Unformatted files:"; print $unformatted
  error make {msg: "gofmt: formatting issues found"}
}
log "OK: all files formatted"
```

The `log` helper used above is **provided by the language preamble** — every plugin injects a
timestamped `log` at synth time, so you don't define it yourself.

A static script can be loaded once and reused across many tasks with per-task differences
passed as step `env`. ocidex's image-build does exactly this: one `build.sh` shared across five
image tasks, parameterised by `IMAGE`/`DOCKERFILE`/`TARGET` env vars.

## Interpolating params, workspaces, and results

`Param`, `Workspace`, and `Result` stringify to Tekton expressions, so they drop straight into
a tagged template:

```typescript
const ref = new Param({ name: 'ref' });
const ws = new Workspace({ name: 'source' });

script: sh`
  cd ${ws.path}          # → $(workspaces.source.path)
  git checkout ${ref}    # → $(params.ref)
`
```

This works for inline tags only. For `scriptFromFile`, pass values through step `env` instead
(the file can't see your TypeScript variables), e.g. `env: [{ name: 'REF', value: `${ref}` }]`
and reference `$REF` in the script.

## The language plugins

Each language is a `ScriptLanguage` plugin that knows three things: its shebang, how to `wrap`
a user body (preamble + exit-code contract), and the command used to lint an extracted file.

| Language  | Shebang | Lint command | Notes |
|-----------|---------|--------------|-------|
| `sh`      | `#!/bin/sh` | `shellcheck` | Portable default for Alpine/BusyBox/Wolfi |
| `bash`    | `#!/usr/bin/env bash` | `shellcheck` | Extends `sh`; same body handling, bash shebang |
| `nushell` | `#!/usr/bin/env nu` | `nu-check` (wrapped) | Body runs inside `def main []` for capture |
| `python`  | `#!/usr/bin/env python3` | `python3 -m py_compile` | Body runs inside `def _tek_main()` |

All four inject a timestamped `log` helper in their preamble.

### Default language for bare bodies

A raw string **without** a shebang is rendered with a default language when one is set —
`Task.defaultLanguage`, falling back to the project-level `defaultLanguage`
(`TektonProject`/`PACProject`). A tagged body always carries its own language and ignores the
default; a raw string **with** a shebang is always passed through untouched.

```typescript
new Task({
  name: 'build',
  defaultLanguage: 'sh',
  steps: [{ name: 'build', image, script: 'echo hi' }], // wrapped as sh
});
```

## The exit-code contract (handled for you)

When a task has both a `statusReporter` and a `statusContext`, the reporter needs the real exit
code of your work even though the step must use `onError: 'continue'` so the reporting step
still runs. Tektonic owns this plumbing:

- The framework sets `onError: 'continue'` on your steps and tells the language plugin to
  **capture** the exit code.
- The plugin wraps your body so it runs, records the **worst** exit code seen across the task's
  steps to `EXIT_CODE_PATH` (`/tekton/home/.exit-code`), and re-exits with its own code.
- The reporter's final step reads that file to decide success/failure.

You therefore **do not** hand-write `echo $? > /tekton/home/.exit-code` or set
`onError` — write the body as if it runs normally and `exit`/`error make`/`sys.exit` naturally.

> **Legacy caveat:** this automatic capture only applies to tagged/object/file scripts (and
> bare strings rendered via a default language). A raw string that begins with a shebang is
> passed through verbatim, so if you still use that form with a status reporter you must keep
> the manual `EC=$?; echo $EC > /tekton/home/.exit-code; exit $EC` plumbing. Prefer the script
> API to avoid it.

## Testing scripts

Because a script is a real file with a known interpreter, you can render it through its plugin
and execute it for real in a unit test. This is the pattern Tektonic uses for its own plugins
(`src/lib/script/runtime.test.ts`): render with `wrap`, run with the interpreter, assert both
the process exit code and the captured contract file.

```typescript
import { spawnSync } from 'child_process';
import { Nushell } from '@pfenerty/tektonic';

const wrapped = new Nushell().wrap(
  'error make {msg: "boom"}',
  { exitCodePath: '/tmp/ec', captureExitCode: true },
);
// write `wrapped` to a temp .nu file, run `nu file`, assert status === 1
```

To test your own job scripts, point a test at the same `.nu`/`.sh` file the task loads (e.g.
run `gofmt`-less fixture dirs through `fmt.nu` and assert it fails). Skip a case when its
interpreter is unavailable so the suite stays hermetic (`it.skipIf(!has('nu'))`).

### Lint harness

`npm run lint:scripts` walks every `.sh`/`.bash`/`.nu`/`.py` file under `src/` and runs the
per-language lint command (`shellcheck`, `nu-check`, `py_compile`). It skips gracefully when a
linter isn't installed and fails only on real syntax errors. The command chooser is exported
as `lintCommandForFile(filePath, { language? })` if you want to build your own harness over a
consumer repo's script files.

## API reference

| Export | Description |
|--------|-------------|
| `sh` / `bash` / `nu` / `py` | Tagged-template helpers returning a `Script` |
| `script({ language, body })` | Object-form helper |
| `scriptFromFile(path, { language? })` | Load a `Script` from a file, language inferred from extension |
| `Script` | A body paired with its `ScriptLanguage` |
| `Sh` / `Bash` / `Nushell` / `Python` | The built-in language plugin classes |
| `languageFor(name)` | Resolve a `LanguageName` to its plugin |
| `languageNameForFile(path, override?)` | Infer a language name from a file extension |
| `lintCommandForFile(path, { language? })` | The lint argv for a script file |
| `dedent(text)` | Strip common leading indentation (used internally by the tags) |
| `renderScript(input, ctx, defaultLanguage?)` | Resolve a `ScriptInput` to its final string (synth-time) |
| `EXIT_CODE_PATH` | The canonical contract path, `/tekton/home/.exit-code` |
| `ScriptInput` / `ScriptObject` / `LanguageName` / `ScriptLanguage` / `ScriptCtx` | Types |

To add a new language, implement `ScriptLanguage` and use it via `script`/the plugin directly —
see [architecture.md](architecture.md#extension-points).

import { Fragment, dedent } from './index';

/** Options for {@link embedSh}. */
export interface EmbedShOptions {
  /**
   * Values passed to the embedded body as positional parameters — `$1`, `$2`, … and `"$@"`.
   *
   * This is the *only* way data crosses the boundary: the body is a raw string, so the host
   * language never looks inside it and cannot interpolate into it. Each value is stringified
   * (a `Param` or `Result` renders its Tekton expression) and double-quoted, so Tekton still
   * substitutes it and the shell does not word-split the result.
   */
  args?: unknown[];
  /** Interpreter to run the body with. Defaults to `'sh'`. */
  shell?: string;
}

/**
 * The nushell raw-string fence that can hold `body` — `r#'…'#`, widening to `r##'…'##` and so
 * on if the body itself contains a closing sequence.
 */
function rawFence(body: string): string {
  let width = 1;
  for (const [, hashes] of body.matchAll(/'(#+)/g)) {
    width = Math.max(width, hashes.length + 1);
  }
  return '#'.repeat(width);
}

/**
 * Embeds a POSIX `sh` body inside a nushell script, as a {@link Fragment}.
 *
 * Some work is simply shell work — a `trap`, a polling loop against a cgroup file, a tool that
 * expects to be `exec`'d from `sh` — and writing it in nushell is a translation exercise with
 * its own bugs. Embedding it by hand means hand-rolling the quoting: the body goes in a raw
 * string (so nushell leaves it alone) and every value has to be smuggled through as a
 * positional argument, which callers wrote out longhand each time.
 *
 * The embedded body's `exit` codes are its own: they belong to the `sh` process, not the
 * nushell script, so they do not interact with the exit-code contract and the nushell plugin's
 * `exit` check ignores them (it strips raw strings before scanning).
 *
 * @example
 * ```ts
 * const watchdog = embedSh(
 *   `limit=$1
 *    while :; do
 *      used=$(cat /sys/fs/cgroup/memory.current)
 *      [ "$used" -gt "$limit" ] && exit 99
 *      sleep 5
 *    done`,
 *   { args: [memoryLimitBytes] },
 * );
 *
 * const script = nu`
 *   ${watchdog}
 *   log "watchdog exited"
 * `;
 * ```
 */
export function embedSh(body: string | Fragment, opts: EmbedShOptions = {}): Fragment {
  const shell = opts.shell ?? 'sh';
  const text = body instanceof Fragment ? body.body : dedent(body);
  const fence = rawFence(text);
  // `sh -c <script> <name> <args…>`: the argument after the script becomes $0, so the caller's
  // values start at $1 — the numbering the body is written against.
  const args = (opts.args ?? []).map(a => `"${String(a)}"`).join(' ');
  return new Fragment(`^${shell} -c r${fence}'${text}'${fence} ${shell}${args ? ` ${args}` : ''}`);
}

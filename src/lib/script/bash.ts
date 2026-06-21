import { Sh } from './sh';

/**
 * Bash scripting language plugin.
 *
 * Bash is a strict superset of POSIX sh for the constructs the wrapper uses, so
 * this reuses {@link Sh}'s `log` helper and worst-of exit-code capture verbatim,
 * differing only in the shebang (`#!/usr/bin/env bash`). Use this when the step
 * image is known to provide bash; prefer {@link Sh} for Alpine/Wolfi images.
 */
export class Bash extends Sh {
  readonly name = 'bash';
  readonly shebang = '#!/usr/bin/env bash';
}

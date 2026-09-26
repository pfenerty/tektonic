#!/usr/bin/env node
/**
 * Fails the build when a provider package reaches into tektonic's internals.
 *
 * The whole point of shipping the GCS backend and the GitHub reporter as separate packages
 * is that they consume the same surface a stranger would. A deep import (`.../dist/lib/...`)
 * or a relative path out of the package silently restores the in-tree privilege and the
 * seams stop being verified — so this is a build failure, not a lint warning.
 *
 * Allowed from a provider package: the core package root and its documented subpaths, plus
 * paths that stay inside the provider package itself.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages held to the rule, and the core package they may only reach through its exports. */
const CORE = '@tektonic-ci/core';
const PROVIDERS = ['packages/tektonic-cache-gcs', 'packages/tektonic-reporter-github'];
/** Subpaths `CORE` publishes in its `exports` map. Anything else is a deep import. */
const PUBLIC_SUBPATHS = new Set([CORE, `${CORE}/testing`]);

/**
 * Every shape a module specifier reaches a file in: `import x from 's'`, `export * from 's'`,
 * the side-effect form `import 's'`, and the call forms `import('s')` / `require('s')`.
 * The side-effect form is the one that carries no `from`, and is exactly how a violation
 * slips past a naive `from`-only pattern.
 */
const SPECIFIER =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function sourceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            if (entry === 'node_modules' || entry === 'dist') continue;
            out.push(...sourceFiles(path));
        } else if (/\.(m|c)?tsx?$/.test(entry)) {
            out.push(path);
        }
    }
    return out;
}

const violations = [];

for (const pkg of PROVIDERS) {
    const pkgDir = join(repoRoot, pkg);
    for (const file of sourceFiles(join(pkgDir, 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const [, specifier] of text.matchAll(SPECIFIER)) {
            const where = `${relative(repoRoot, file)}: '${specifier}'`;
            if (specifier.startsWith('.')) {
                const target = resolve(dirname(file), specifier);
                if (relative(pkgDir, target).startsWith('..')) {
                    violations.push(`${where} — relative path out of ${pkg}`);
                }
            } else if (specifier === CORE || specifier.startsWith(`${CORE}/`)) {
                if (!PUBLIC_SUBPATHS.has(specifier)) {
                    violations.push(
                        `${where} — deep import; ${CORE} publishes ${[...PUBLIC_SUBPATHS].join(', ')}`,
                    );
                }
            }
        }
    }
}

if (violations.length > 0) {
    console.error('Provider packages may only import tektonic through its published surface:\n');
    for (const v of violations) console.error(`  ${v}`);
    console.error(
        '\nIf a provider genuinely needs something internal, export it from the core package ' +
            'and document it as supported — that is the decision this check forces.',
    );
    process.exit(1);
}

console.log(`provider imports ok (${PROVIDERS.join(', ')})`);

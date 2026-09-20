/**
 * Returns the JSON paths at which two synthesized specs differ, e.g.
 * `['spec.steps[0].script', 'spec.params[1].name']`. Empty when they are identical.
 *
 * Used to explain a task-name collision: two same-named tasks are emitted as one Task
 * manifest, so if their specs differ, one pipeline would run YAML it never declared. The
 * paths make that concrete instead of leaving the reader to diff two manifests by eye.
 */
export function diffPaths(a: unknown, b: unknown, prefix = '', limit = 10): string[] {
  const found: string[] = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (found.length >= limit) return;
    if (left === right) return;
    const bothArrays = Array.isArray(left) && Array.isArray(right);
    const bothObjects =
      !bothArrays &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      left !== null &&
      right !== null;

    if (bothArrays) {
      const l = left as unknown[];
      const r = right as unknown[];
      if (l.length !== r.length) {
        found.push(`${path} (${l.length} vs ${r.length} entries)`);
        return;
      }
      l.forEach((item, i) => walk(item, r[i], `${path}[${i}]`));
      return;
    }
    if (bothObjects) {
      const keys = [...new Set([...Object.keys(left as object), ...Object.keys(right as object)])].sort();
      for (const key of keys) {
        const child = path ? `${path}.${key}` : key;
        walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], child);
      }
      return;
    }
    found.push(path || '(root)');
  };
  walk(a, b, prefix);
  return found;
}

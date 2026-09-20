/** Options for constructing a {@link Workspace}. */
export interface WorkspaceOptions {
  /** The workspace name as it appears in Tekton manifests. */
  name: string;
  /** Human-readable description included in the workspace spec. */
  description?: string;
  /** Whether the workspace is optional. Defaults to `false`. */
  optional?: boolean;
}

/**
 * A Tekton workspace declaration.
 *
 * Use the {@link path} and {@link bound} getters to embed workspace references
 * in step scripts via template literal interpolation:
 * ```ts
 * const ws = new Workspace({ name: 'source' });
 * // `workingDir: ws.path` produces `$(workspaces.source.path)`
 * ```
 */
export class Workspace {
  readonly name: string;
  readonly description?: string;
  readonly optional: boolean;

  constructor(opts: WorkspaceOptions) {
    this.name = opts.name;
    this.description = opts.description;
    this.optional = opts.optional ?? false;
  }

  /** Returns the Tekton interpolation expression for the workspace mount path. */
  get path(): string {
    return `$(workspaces.${this.name}.path)`;
  }

  /**
   * Returns a path inside the workspace, e.g. `ws.at('.go-mod')` →
   * `$(workspaces.source.path)/.go-mod`. Segments are joined with `/`, and leading and
   * trailing slashes on each segment are ignored, so `ws.at('/a/', '/b')` is `…/a/b`.
   *
   * Preferable to string concatenation for cache paths, `workingDir`s and script
   * interpolation: the workspace name stays in one place.
   */
  at(...segments: string[]): string {
    const parts = segments
      .flatMap(s => s.split('/'))
      .map(s => s.trim())
      .filter(s => s.length > 0 && s !== '.');
    return parts.length ? `${this.path}/${parts.join('/')}` : this.path;
  }

  /** Returns the Tekton interpolation expression that evaluates to `"true"` when the workspace is bound. */
  get bound(): string {
    return `$(workspaces.${this.name}.bound)`;
  }

  /** Serializes the workspace to its Tekton spec representation. */
  toSpec(): Record<string, unknown> {
    const spec: Record<string, unknown> = { name: this.name };
    if (this.description !== undefined) spec.description = this.description;
    if (this.optional) spec.optional = this.optional;
    return spec;
  }
}

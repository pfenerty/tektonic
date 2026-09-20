/** Options for constructing a {@link Param}. */
export interface ParamOptions {
  /** The parameter name as it appears in Tekton manifests. */
  name: string;
  /** Human-readable description included in the param spec. */
  description?: string;
  /** Tekton param type. Defaults to `'string'`. */
  type?: 'string' | 'array' | 'object';
  /** Default value used when the param is not supplied at runtime. */
  default?: string | string[];
  /**
   * Pipeline-level expression to use as the param value in a pipeline task spec,
   * instead of the default `$(params.<name>)`. Useful for Tekton built-in variables
   * like `$(tasks.status)` in finally tasks. Params with this set are excluded from
   * pipeline-level param inference since their value is not user-supplied.
   */
  pipelineExpression?: string;
}

/**
 * A Tekton pipeline/task parameter.
 *
 * Use template literal interpolation to embed param references in step scripts:
 * ```ts
 * const url = new Param({ name: 'url' });
 * // In a step script: `git clone ${url} .`
 * // Produces:          `git clone $(params.url) .`
 * ```
 */
export class Param {
  readonly name: string;
  readonly description?: string;
  readonly type: string;
  readonly default?: string | string[];
  readonly pipelineExpression?: string;

  constructor(opts: ParamOptions) {
    this.name = opts.name;
    this.description = opts.description;
    this.type = opts.type ?? 'string';
    this.default = opts.default;
    this.pipelineExpression = opts.pipelineExpression;
  }

  /** Returns the Tekton interpolation expression `$(params.<name>)`. */
  toString(): string {
    return `$(params.${this.name})`;
  }

  /** Serializes the param to its Tekton spec representation. */
  toSpec(): Record<string, unknown> {
    const spec: Record<string, unknown> = { name: this.name, type: this.type };
    if (this.description !== undefined) spec.description = this.description;
    if (this.default !== undefined) spec.default = this.default;
    return spec;
  }
}

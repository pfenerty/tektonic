/** Options for constructing a {@link Result}. */
export interface ResultOptions {
    /** The result name as it appears in Tekton manifests. */
    name: string;
    /** Human-readable description included in the result spec. */
    description?: string;
    /** Tekton result type. Defaults to `'string'`. */
    type?: "string" | "array" | "object";
}

/**
 * A Tekton Task result declaration.
 *
 * Use `result.path` in step scripts to write the result value, and the result
 * itself in template literals to reference it from downstream pipeline tasks:
 *
 * ```ts
 * const commit = new Result({ name: 'commit' });
 * const clone = new Task({
 *   name: 'git-clone',
 *   results: [commit],
 *   steps: [{ name: 'clone', image: 'alpine', script: `git rev-parse HEAD > ${commit.path}` }],
 * });
 * // After Task construction, commit is bound to 'git-clone':
 * // `${commit}` → '$(tasks.git-clone.results.commit)'
 * ```
 */
export class Result {
    readonly name: string;
    readonly description?: string;
    readonly type: string;
    private taskName?: string;

    constructor(opts: ResultOptions) {
        this.name = opts.name;
        this.description = opts.description;
        this.type = opts.type ?? "string";
    }

    /** @internal Called by {@link TaskDef} constructor to bind this result to a task. */
    _bindToTask(taskName: string): void {
        this.taskName = taskName;
    }

    /**
     * Tekton path expression where this result's value should be written inside a step.
     * Safe to call before the Result is attached to a Task.
     */
    get path(): string {
        return `$(results.${this.name}.path)`;
    }

    /**
     * Pipeline-level reference expression `$(tasks.<task>.results.<name>)`.
     * Throws if called before the Result is attached to a Task via a TaskDef constructor.
     */
    toString(): string {
        if (!this.taskName) {
            throw new Error(
                `Result '${this.name}' is not bound to a task — pass it in the Task 'results' option first`,
            );
        }
        return `$(tasks.${this.taskName}.results.${this.name})`;
    }

    /** Serializes the result to its Tekton spec representation. */
    toSpec(): Record<string, unknown> {
        const spec: Record<string, unknown> = { name: this.name, type: this.type };
        if (this.description !== undefined) spec.description = this.description;
        return spec;
    }
}

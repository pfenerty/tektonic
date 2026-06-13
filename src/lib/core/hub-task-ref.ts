import { Param } from "./param";
import { Workspace } from "./workspace";
import type { TaskLike } from "./task";

/** Options for constructing a {@link HubTaskRef}. */
export interface HubTaskRefOptions {
    /** Hub catalog name. Defaults to `'tekton'`. */
    catalog?: string;
    /** Task name in the catalog (e.g. `'git-clone'`). */
    taskName: string;
    /** Pinned task version (e.g. `'0.9'`). */
    version: string;
    /**
     * Local node name used in the pipeline spec.
     * Defaults to `taskName` when omitted.
     */
    name?: string;
    /** Params forwarded to the hub task. Must match the catalog task's declared params. */
    params?: Param[];
    /** Workspaces bound to the hub task. Must match the catalog task's declared workspaces. */
    workspaces?: Workspace[];
    /** Tasks that must complete before this one runs. */
    needs?: TaskLike[];
}

/**
 * A pipeline node backed by a remote ArtifactHub task.
 *
 * `HubTaskRef` implements `TaskLike` with `synthesizable: false`, so
 * `TektonProject` skips generating a local `kind: Task` resource for it.
 * The synthesized pipeline entry uses Tekton's hub resolver:
 *
 * ```yaml
 * taskRef:
 *   resolver: hub
 *   params:
 *   - { name: catalog,  value: tekton }
 *   - { name: name,     value: git-clone }
 *   - { name: version,  value: "0.9" }
 * ```
 *
 * @example
 * ```ts
 * const gitClone = new HubTaskRef({
 *   taskName: 'git-clone',
 *   version: '0.9',
 *   params: [url, revision],
 *   workspaces: [output],
 * });
 *
 * const test = new Task({
 *   name: 'test',
 *   needs: [gitClone],
 *   steps: [{ name: 'run', image: 'node:22-alpine', command: ['npm', 'test'] }],
 * });
 *
 * new Pipeline({ tasks: [test] });
 * ```
 */
export class HubTaskRef implements TaskLike {
    readonly name: string;
    readonly synthesizable = false as const;
    readonly params: Param[];
    readonly workspaces: Workspace[];
    readonly needs: TaskLike[];
    private readonly catalog: string;
    private readonly taskName: string;
    private readonly version: string;

    constructor(opts: HubTaskRefOptions) {
        this.taskName = opts.taskName;
        this.name = opts.name ?? opts.taskName;
        this.catalog = opts.catalog ?? "tekton";
        this.version = opts.version;
        this.params = opts.params ?? [];
        this.workspaces = opts.workspaces ?? [];
        this.needs = opts.needs ?? [];
    }

    /**
     * Generates the pipeline task spec for this hub-resolved task.
     * `namePrefix` is intentionally ignored — hub tasks are resolved from the
     * remote catalog and do not participate in local resource name prefixing.
     */
    _toPipelineTaskSpec(
        runAfterNames: string[],
        _namePrefix?: string,
    ): Record<string, unknown> {
        const spec: Record<string, unknown> = {
            name: this.name,
            taskRef: {
                resolver: "hub",
                params: [
                    { name: "catalog", value: this.catalog },
                    { name: "name", value: this.taskName },
                    { name: "version", value: this.version },
                ],
            },
        };
        if (this.params.length > 0) {
            spec.params = this.params.map((p) => ({
                name: p.name,
                value: p.pipelineExpression ?? `$(params.${p.name})`,
            }));
        }
        if (this.workspaces.length > 0) {
            spec.workspaces = this.workspaces.map((w) => ({
                name: w.name,
                workspace: w.name,
            }));
        }
        if (runAfterNames.length > 0) {
            spec.runAfter = runAfterNames;
        }
        return spec;
    }
}

/**
 * The categories a Tekton catalog entry may declare, as the hub's own `config.yaml`
 * lists them. Closed on purpose: the hub silently drops a category it does not know,
 * so a typo would cost a published version rather than a synth error.
 */
export type CatalogCategory =
    | "Automation"
    | "Build Tools"
    | "CLI"
    | "Cloud"
    | "Code Quality"
    | "Continuous Integration"
    | "Deployment"
    | "Developer Tools"
    | "Git"
    | "Image Build"
    | "Integration"
    | "Kubernetes"
    | "Messaging"
    | "Monitoring"
    | "Networking"
    | "Openshift"
    | "Publishing"
    | "Security"
    | "Storage"
    | "Testing";

/** Every {@link CatalogCategory}, for validation and error messages. */
export const CATALOG_CATEGORIES: CatalogCategory[] = [
    "Automation",
    "Build Tools",
    "CLI",
    "Cloud",
    "Code Quality",
    "Continuous Integration",
    "Deployment",
    "Developer Tools",
    "Git",
    "Image Build",
    "Integration",
    "Kubernetes",
    "Messaging",
    "Monitoring",
    "Networking",
    "Openshift",
    "Publishing",
    "Security",
    "Storage",
    "Testing",
];

/**
 * Platforms a catalog entry declares support for when it names none itself. `linux/amd64`
 * is what the hub assumes of an entry with no `tekton.dev/platforms` annotation.
 */
export const DEFAULT_CATALOG_PLATFORMS = ["linux/amd64"];

/**
 * Minimum Tekton Pipelines version a tektonic-published catalog entry declares by default.
 *
 * Tektonic emits `tekton.dev/v1`, which Pipelines has served for `Task` since v0.44.0 —
 * anything older resolves the entry to a version of the API it does not have.
 */
export const DEFAULT_MIN_PIPELINES_VERSION = "0.44.0";

/**
 * Catalog metadata for a {@link TaskDef}: everything a Tekton catalog entry needs that a
 * `kind: Task` manifest does not already carry.
 *
 * Setting it marks the task **publishable**. {@link HubTarget} emits exactly the tasks that
 * carry it, as `task/<name>/<version>/<name>.yaml` plus a generated `README.md`, and
 * validates the pair at synth time — the hub's own checks run only once a pull request is
 * open against the catalog repository, which is a slow way to learn that a param has no
 * description.
 *
 * @example
 * ```ts
 * new Task({
 *   name: 'git-clone',
 *   catalog: {
 *     version: '0.1',
 *     description: 'Clones a git repository onto a workspace.',
 *     categories: ['Git'],
 *     tags: ['git', 'clone'],
 *   },
 *   params: [url, revision],
 *   steps: [...],
 * });
 * ```
 */
export interface CatalogMetadata {
    /**
     * Entry version, as `<major>.<minor>` or `<major>.<minor>.<patch>` — no leading `v`.
     * It names the directory the entry is written to, and catalog entries are immutable
     * per version: publish a change as a new version rather than editing a published one.
     */
    version: string;
    /** Short human-readable name. Defaults to the task name. */
    displayName?: string;
    /** What the task does. Required — the hub lists entries by it. */
    description: string;
    /** Hub categories this entry belongs to. */
    categories?: CatalogCategory[];
    /** Free-form tags the hub indexes for search. */
    tags?: string[];
    /** Platforms the entry supports. Defaults to {@link DEFAULT_CATALOG_PLATFORMS}. */
    platforms?: string[];
    /**
     * Oldest Tekton Pipelines release the entry runs on. Defaults to
     * {@link DEFAULT_MIN_PIPELINES_VERSION}.
     */
    minPipelinesVersion?: string;
}

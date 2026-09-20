/**
 * Capability an image must provide for an injected step to run in it.
 *
 * Tektonic generates the script for every step it injects (git clone, cache
 * restore/save, status reporting, change detection) and only ever expects the image to
 * *provide* the interpreters and CLIs those scripts invoke — it ships no image of its own.
 * These names are that expectation, made checkable at synth time.
 */
export type ImageCapability = "sh" | "git" | "nushell" | "tar" | "zstd" | "gcloud";

/** An injected-step image together with the capabilities it declares. */
export interface InjectedStepImageSpec {
    /** Image reference, e.g. `'ghcr.io/acme/ci-base:1.2.3'`. */
    image: string;
    /**
     * Capabilities this image provides. Omit to declare every capability — an explicit
     * image is taken at its word, and synthesis never probes a registry.
     */
    provides?: ImageCapability[];
}

/**
 * Project-level image for the steps tektonic injects. A bare string is trusted for every
 * capability; the object form declares what the image actually provides, so a pipeline
 * that needs something it lacks fails at synth time instead of at pod-run time.
 */
export type InjectedStepImage = string | InjectedStepImageSpec;

/**
 * Library fallback when a project sets no `injectedStepImage`.
 *
 * Deliberately a neutral, public, widely mirrored image rather than one from any
 * particular author's registry: a stranger installing tektonic must not silently pull
 * from a repository their cluster has no pull secret for. It covers the plain paths
 * (git clone, change detection, uncompressed PVC caches) and nothing else — compressed
 * caches, GCS caches and the built-in status reporter need `nushell`/`zstd`/`gcloud` and
 * therefore name an image explicitly, via `injectedStepImage` or per component.
 *
 * `:latest` is mutable. Pin it — `injectedStepImage: 'docker.io/alpine/git:v2.49.1'` —
 * for reproducible runs, and see `defaultImagePullPolicy` for the kubelet's caching of
 * mutable tags.
 */
export const DEFAULT_INJECTED_STEP_IMAGE: InjectedStepImageSpec = {
    image: "docker.io/alpine/git:latest",
    provides: ["sh", "git"],
};

/** Every capability, in the order error messages list them. */
const ALL_CAPABILITIES: ImageCapability[] = ["sh", "git", "nushell", "tar", "zstd", "gcloud"];

/**
 * Marker an injected step puts in its `image` field to mean "whatever image this project
 * uses for injected steps". Never reaches a manifest: {@link TaskDef.synth} resolves every
 * one of them against the project's setting.
 */
const MARKER = "tektonic.internal/injected-step-image";

/**
 * The image reference an injected step uses when the caller named none: a marker resolved
 * at synth time against the project's `injectedStepImage`, requiring the given capabilities.
 *
 * Third-party cache backends, reporters and other injectors use this instead of hardcoding
 * an image, so their steps inherit the project's choice and their needs are checked:
 *
 * ```ts
 * restoreStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
 *   return { name: `restore-${spec.name}-cache`,
 *            image: spec.image ?? this.opts.image ?? injectedImageRef('nushell', 'zstd'),
 *            script: … };
 * }
 * ```
 *
 * With no arguments it requires only `sh`, which is what {@link BackendCtx.defaultImage} is.
 */
export function injectedImageRef(...requires: ImageCapability[]): string {
    const caps = requires.length > 0 ? requires : (["sh"] as ImageCapability[]);
    const unique = ALL_CAPABILITIES.filter(c => caps.includes(c));
    return `${MARKER}?requires=${unique.join(",")}`;
}

/**
 * The capabilities an {@link injectedImageRef} marker requires, or `undefined` when the
 * string is an ordinary image reference.
 */
export function injectedImageRequirements(image: string): ImageCapability[] | undefined {
    if (!image.startsWith(`${MARKER}?requires=`)) return undefined;
    const list = image.slice(`${MARKER}?requires=`.length);
    return list.length === 0 ? [] : (list.split(",") as ImageCapability[]);
}

/** Normalizes the project option (or its absence) to a spec. */
export function normalizeInjectedStepImage(
    image: InjectedStepImage | undefined,
): InjectedStepImageSpec {
    if (image === undefined) return DEFAULT_INJECTED_STEP_IMAGE;
    return typeof image === "string" ? { image } : image;
}

/** Where a step being resolved lives, for the error message. */
export interface InjectedImageSite {
    taskName: string;
    stepName: string;
}

/**
 * Resolves one step's `image`.
 *
 * Returns it unchanged unless it is an {@link injectedImageRef} marker, in which case the
 * project's injected-step image takes its place — throwing when that image does not
 * declare a capability the step needs, so a missing `nushell` surfaces as a synth error
 * naming the capability rather than a `command not found` inside a pod minutes later.
 */
export function resolveInjectedImage(
    image: string,
    project: InjectedStepImageSpec,
    site: InjectedImageSite,
): string {
    const required = injectedImageRequirements(image);
    if (required === undefined) return image;

    // No `provides` means "trust this image for everything": synthesis is offline and
    // deterministic, so an explicit image is never probed, only believed.
    if (project.provides !== undefined) {
        const missing = required.filter(c => !project.provides!.includes(c));
        if (missing.length > 0) {
            const isDefault = project.image === DEFAULT_INJECTED_STEP_IMAGE.image;
            throw new Error(
                `Task '${site.taskName}', step '${site.stepName}': this injected step needs an image providing ` +
                    `${missing.join(", ")}, but the project's injected-step image ` +
                    `(${project.image}${isDefault ? ", tektonic's neutral default" : ""}) declares only ` +
                    `${(project.provides ?? []).join(", ") || "nothing"}. ` +
                    `Set 'injectedStepImage' on the project to an image that provides ${required.join(", ")} ` +
                    `(pass DEFAULT_BASE_IMAGE to keep the image tektonic used to default to), ` +
                    `declare what yours provides with ` +
                    `{ image: '…', provides: [${required.map(c => `'${c}'`).join(", ")}] }, ` +
                    `or give this step its own image.`,
            );
        }
    }
    return project.image;
}

import { Result } from "./result";

/** Options for constructing a {@link ChainsImage}. */
export interface ChainsImageOptions {
    /**
     * Logical name for the image, used as the result-name prefix:
     * `<name>-IMAGE_URL` and `<name>-IMAGE_DIGEST`. Tekton Chains matches the
     * `IMAGE_URL` / `IMAGE_DIGEST` suffixes to record the image as a build
     * subject in provenance, so any distinct prefix works for multiple images.
     */
    name: string;
}

/**
 * A pair of Tekton results that mark a built container image as a Tekton Chains
 * build *subject*.
 *
 * Chains type-hinting recognizes results whose names end in `IMAGE_URL` and
 * `IMAGE_DIGEST` and records the corresponding image in build provenance.
 * `ChainsImage` bundles that pair and exposes the step paths to write into, so a
 * build task stays declarative:
 *
 * ```ts
 * const api = new ChainsImage({ name: "api" });
 *
 * new Task({
 *   name: "build-api",
 *   results: [...api.results],            // api-IMAGE_URL, api-IMAGE_DIGEST
 *   steps: [{
 *     name: "build",
 *     image: "moby/buildkit:rootless",
 *     script: sh`
 *       buildctl build ... --metadata-file /tmp/md.json
 *       jq -r '."containerimage.digest"' /tmp/md.json | tr -d '\n' > ${api.digestPath}
 *       printf '%s' "$IMAGE" > ${api.urlPath}`,
 *   }],
 * });
 * ```
 *
 * The digest value written at runtime must be in `alg:hex` form (e.g.
 * `sha256:586789aa…`) for Chains to accept it. The results are inert when Chains
 * is not installed.
 */
export class ChainsImage {
    /** The logical image name (result-name prefix). */
    readonly name: string;
    /** Result holding the fully-qualified image reference (e.g. `ghcr.io/org/app`). */
    readonly urlResult: Result;
    /** Result holding the image digest in `alg:hex` form (e.g. `sha256:…`). */
    readonly digestResult: Result;

    constructor(opts: ChainsImageOptions) {
        this.name = opts.name;
        this.urlResult = new Result({
            name: `${opts.name}-IMAGE_URL`,
            description: `Fully-qualified reference of the ${opts.name} image (Tekton Chains subject)`,
        });
        this.digestResult = new Result({
            name: `${opts.name}-IMAGE_DIGEST`,
            description: `Digest (alg:hex) of the ${opts.name} image (Tekton Chains subject)`,
        });
    }

    /** The result pair to spread into a Task's `results` option. */
    get results(): Result[] {
        return [this.urlResult, this.digestResult];
    }

    /** Step path to write the image reference to: `$(results.<name>-IMAGE_URL.path)`. */
    get urlPath(): string {
        return this.urlResult.path;
    }

    /** Step path to write the image digest (`alg:hex`) to: `$(results.<name>-IMAGE_DIGEST.path)`. */
    get digestPath(): string {
        return this.digestResult.path;
    }

    /**
     * Pipeline-level reference to the image URL, for a downstream task to consume.
     * Throws until the result pair is attached to a Task (via its `results` option).
     */
    get url(): string {
        return this.urlResult.toString();
    }

    /**
     * Pipeline-level reference to the image digest, for a downstream task to consume.
     * Throws until the result pair is attached to a Task (via its `results` option).
     */
    get digest(): string {
        return this.digestResult.toString();
    }
}

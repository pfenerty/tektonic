import type { TaskArtifact } from "./artifact";
import type { TaskStepSpec } from "./task";
import { injectedImageRef } from "./injected-image";
import { script } from "../script";

/**
 * Name of the step that emits TEP-0147 artifact provenance.
 *
 * Fixed rather than derived, because `$(step.artifacts.path)` resolves per step — one step
 * writes one provenance file, and every declared artifact of the task goes in it.
 */
export const ARTIFACT_PROVENANCE_STEP = "artifact-provenance" as const;

/**
 * Tekton's per-step provenance file, as the controller substitutes it: it becomes
 * `/tekton/steps/<step name>/artifacts/provenance.json` inside the container, and the
 * controller lifts whatever is written there into the TaskRun status.
 *
 * Written as the variable rather than the resolved path deliberately — the path is Tekton's
 * to change, the variable is the documented interface.
 */
const STEP_ARTIFACTS_PATH = "$(step.artifacts.path)";

/**
 * The step that records what a task read and wrote as TEP-0147 artifact provenance.
 *
 * **This moves no bytes.** TEP-0147 records are `{uri, digest}` pairs travelling the
 * TaskRun-status channel, and their purpose is feeding Tekton Chains: a consumed artifact
 * becomes a *material* of the build, a produced one a *byproduct* — or a **subject**, the
 * thing the attestation is about, when the declaration marked it `buildOutput`. Transport
 * is the {@link ArtifactStore}'s job and is entirely separate.
 *
 * Off unless asked for. The feature is alpha upstream and needs the cluster's
 * `enable-artifacts` feature flag, so emitting it by default would write a file no
 * controller reads and add a step to every artifact-using task for nothing.
 *
 * The digest is computed over what the producer actually wrote, not over what the store
 * uploaded: an archive's digest would describe tektonic's tar invocation rather than the
 * build's output. A directory is reduced to one digest over its files' digests, taken with
 * paths relative to the artifact root so the value does not depend on where the pod mounted
 * it.
 *
 * Unlike a cache save, a failure here fails the task. Provenance is a claim about a build,
 * and a claim that silently fails to appear is the failure mode that makes attestation
 * worthless — a red task is the cheaper outcome than a green one whose evidence is missing.
 *
 * @param produces  artifacts the task publishes, emitted as `outputs`
 * @param consumes  artifacts the task reads, emitted as `inputs`
 * @returns the step, or `undefined` when the task declares no artifacts at all
 */
export function artifactProvenanceStep(
    produces: readonly TaskArtifact[],
    consumes: readonly TaskArtifact[],
): TaskStepSpec | undefined {
    if (produces.length === 0 && consumes.length === 0) return undefined;
    const lines = [
        // Digest of a file, or of a directory reduced to its files' digests. `cd` into the
        // directory first so the inner sums are over relative paths: an absolute path would
        // put the pod's mount point inside the hash and make the same tree digest differently
        // in the producer and anywhere it is verified.
        `digest_of() {`,
        `  if [ -d "$1" ]; then`,
        `    ( cd "$1" && find . -type f | LC_ALL=C sort | xargs -r sha256sum ) | sha256sum | cut -d' ' -f1`,
        `  else`,
        `    sha256sum "$1" | cut -d' ' -f1`,
        `  fi`,
        `}`,
        ``,
        `inputs=''`,
        `outputs=''`,
        ``,
    ];
    for (const a of consumes) {
        lines.push(...entryLines("inputs", a, a.path, false));
    }
    for (const a of produces) {
        lines.push(...entryLines("outputs", a, a.sourcePath, a.buildOutput));
    }
    lines.push(
        `printf '{"inputs":[%s],"outputs":[%s]}' "$inputs" "$outputs" > '${STEP_ARTIFACTS_PATH}'`,
        `log "recorded TEP-0147 provenance for ${String(consumes.length)} input(s) and ${String(produces.length)} output(s)"`,
    );
    return {
        name: ARTIFACT_PROVENANCE_STEP,
        image: injectedImageRef(),
        script: script({ language: "sh", body: lines.join("\n") }),
    };
}

/** Shell that appends one TEP-0147 entry to the `inputs` or `outputs` accumulator. */
function entryLines(
    accumulator: "inputs" | "outputs",
    artifact: TaskArtifact,
    digestPath: string,
    buildOutput: boolean,
): string[] {
    const uri = artifactUri(artifact);
    return [
        `path='${digestPath}'`,
        `if [ ! -e "$path" ]; then`,
        `  log "artifact '${artifact.name}' declared by task '${artifact.producerName}' is not at $path, so no provenance can be recorded for it"`,
        `  exit 1`,
        `fi`,
        `d=$(digest_of "$path")`,
        // `buildOutput` is `omitempty` in Tekton's own Artifact type, so false is the absent
        // case and writing it out says nothing. Inputs never carry it at all: Chains reads it
        // only to pick the subjects of the attestation out of a task's outputs.
        `entry=$(printf '{"name":"%s",${buildOutput ? '"buildOutput":true,' : ""}"values":[{"uri":"%s","digest":{"sha256":"%s"}}]}' '${artifact.name}' '${uri}' "$d")`,
        `${accumulator}="\${${accumulator}}\${${accumulator}:+,}$entry"`,
        ``,
    ];
}

/**
 * Where TEP-0147 says the artifact can be retrieved from: the store's own answer when it has
 * one, else the consumer-visible path as a `file://` URL.
 *
 * A store that only moves files around a workspace has nothing more retrievable to offer, and
 * saying `file://` plainly beats inventing a URI scheme for a path that stops existing when
 * the PVC is reclaimed.
 */
export function artifactUri(artifact: TaskArtifact): string {
    const store = artifact.store;
    return store.uri ? store.uri(artifact) : `file://${artifact.path}`;
}

/** Tekton Pipelines v1 API version. */
export const TEKTON_API_V1 = "tekton.dev/v1";
/** Pipelines as Code (PAC) API version, used for the `Repository` custom resource. */
export const PAC_API = "pipelinesascode.tekton.dev/v1alpha1";

/**
 * Default pod-level security context applied to every PipelineRun pod.
 *
 * `fsGroup` causes Kubernetes to chown mounted volume roots to this GID and
 * add it to every container's supplemental groups — this fixes "owned by root"
 * errors on shared PVC workspaces without requiring a universal `runAsUser`.
 * These fields are **pod-level only** and must NOT be placed on a container/step.
 */
export const DEFAULT_POD_SECURITY_CONTEXT = {
    runAsNonRoot: true,
    runAsUser: 1001,
    runAsGroup: 1001,
    fsGroup: 1001,
    seccompProfile: { type: "RuntimeDefault" },
} as const;

/**
 * Default container-level security context applied to all task steps via stepTemplate.
 * Drops all capabilities. These fields are **container-level only** and must NOT
 * be placed on a pod template.
 */
export const DEFAULT_STEP_SECURITY_CONTEXT = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
} as const;

/**
 * Stricter container-level security context that also enforces `runAsNonRoot`.
 * Use via `stepTemplate: { securityContext: RESTRICTED_STEP_SECURITY_CONTEXT }`
 * on tasks where you want per-step non-root enforcement in addition to the pod default.
 */
export const RESTRICTED_STEP_SECURITY_CONTEXT = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: true,
} as const;

/**
 * An image known to provide everything tektonic's injected steps can ask for:
 * `/bin/sh` + `git` (git-clone, change detection), and `nushell` + `zstd` + `tar`
 * (compressed caches, status reporting via `http post`).
 *
 * **No longer a default.** Injected steps resolve their image through the project's
 * `injectedStepImage`, which falls back to {@link DEFAULT_INJECTED_STEP_IMAGE} — a
 * neutral public image, so installing tektonic never silently pulls from someone else's
 * registry. This constant stays exported as the one-line way back to the old behaviour:
 *
 * ```ts
 * new TektonicProject({ …, injectedStepImage: DEFAULT_BASE_IMAGE });
 * ```
 *
 * It is a **runtime interpreter expectation, not a module tektonic ships**: the library
 * generates each injected script's interpreter preamble at synth time via the
 * {@link ScriptLanguage} plugins, and the image is only expected to *provide* the
 * interpreters and CLIs those scripts invoke. Any image satisfying the subset your
 * pipeline actually uses will do.
 */
export const DEFAULT_BASE_IMAGE =
    "ghcr.io/pfenerty/apko-cicd/base:stable" as const;

/**
 * Default CPU/memory requests and limits applied to each task step.
 * Override per-step via the `computeResources` field on `TaskStepSpec`.
 */
/**
 * Default zstd compression level for GCS cache backends.
 * Higher than the PVC default (1) because GCS targets robust environments
 * where CPU is plentiful and reduced archive size speeds up transfers.
 */
export const DEFAULT_GCS_COMPRESSION_LEVEL = 3;

export const DEFAULT_STEP_RESOURCES = {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "1", memory: "512Mi" },
} as const;

/**
 * Home directory every pod gets unless the project sets its own `HOME`.
 *
 * A pod-level `runAsUser` (tektonic sets one by default) usually has no `/etc/passwd` entry,
 * so `$HOME` resolves to `/` — which Tekton's creds-init cannot write to, taking git and
 * registry credentials down with it. `/tekton/home` is the directory Tekton mounts writable
 * for exactly this.
 */
export const TEKTON_HOME = "/tekton/home";

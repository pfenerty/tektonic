/** Tekton Pipelines v1 API version. */
export const TEKTON_API_V1 = "tekton.dev/v1";
/** Tekton Triggers v1beta1 API version. */
export const TRIGGERS_API = "triggers.tekton.dev/v1beta1";
/** API version used for PipelineRun resources. */
export const PIPELINE_RUN_API = "tekton.dev/v1";

/** Default service account name for trigger infrastructure. */
export const DEFAULT_SERVICE_ACCOUNT = "tekton-triggers";
/** Default PVC storage size for pipeline workspace volumes. */
export const DEFAULT_WORKSPACE_STORAGE = "1Gi";

/** CEL expression that constructs the GitHub repository URL from webhook payload. */
export const GITHUB_REPO_URL =
    "https://github.com/$(body.repository.full_name)";

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
 * Default container image for injected steps (cache restore/save, status
 * reporting, git clone).
 *
 * This is a **runtime interpreter expectation, not a module tektonic ships**:
 * the library generates each injected script's interpreter preamble at synth
 * time via the {@link ScriptLanguage} plugins, and the image is only expected
 * to *provide* the interpreters and CLIs those scripts invoke. Concretely the
 * default image must offer `/bin/sh` + `git` (git-clone), `nushell` + `zstd` +
 * `tar` (compressed cache, status reporting via `http post`); the uncompressed
 * cache path needs only `/bin/sh`. Swap in any image that satisfies the subset
 * your pipeline actually uses.
 */
export const DEFAULT_BASE_IMAGE =
    "ghcr.io/pfenerty/apko-cicd/base:stable" as const;

/**
 * Container image for GCS cache restore/save steps. Provides the Google Cloud
 * SDK (gcloud storage) alongside nushell, zstd, and tar for
 * Workload Identity-authenticated GCS access without manual token management.
 */
export const DEFAULT_GCS_CACHE_IMAGE =
    "ghcr.io/pfenerty/apko-cicd/gcloud:563.0.0" as const;

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

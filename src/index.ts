// Core API
export { Param } from "./lib/core/param";
export type { ParamOptions } from "./lib/core/param";
export { Workspace } from "./lib/core/workspace";
export type { WorkspaceOptions } from "./lib/core/workspace";
export { Task, TaskDef } from "./lib/core/task";
export type { TaskLike, TaskOptions, TaskStepSpec, TaskCacheSpec, TaskSidecarSpec, TaskVolumeSpec } from "./lib/core/task";
export { Result } from "./lib/core/result";
export type { ResultOptions } from "./lib/core/result";
export { ChainsImage } from "./lib/core/chains-image";
export type { ChainsImageOptions } from "./lib/core/chains-image";
export { HubTaskRef } from "./lib/core/hub-task-ref";
export type { HubTaskRefOptions } from "./lib/core/hub-task-ref";
export type { CacheBackend, BackendCtx } from "./lib/core/cache-backend";
export { PvcBackend } from "./lib/cache/pvc-backend";
export { GcsBackend, gcs } from "./lib/cache/gcs-backend";
export type { GcsBackendOptions } from "./lib/cache/gcs-backend";
export { gated } from "./lib/core/pipeline-task";
export type { WhenExpression, MatrixSpec, PipelineTaskOverrides, PipelineTaskNode } from "./lib/core/pipeline-task";
export {
    Condition,
    equals,
    notEquals,
    isIn,
    notIn,
    matches,
    and,
    or,
    not,
    normalizeWhen,
    onBranch,
    onBranches,
    onBranchMatching,
    GIT_BRANCH_REF,
} from "./lib/core/condition";
export type { Expressable, WhenClause, CelWhenExpression } from "./lib/core/condition";
export { onChanges } from "./lib/core/changes";
export type { OnChangesOptions } from "./lib/core/changes";
export { Pipeline } from "./lib/core/pipeline";
export type { PipelineOptions } from "./lib/core/pipeline";
export { globToRegex } from "./lib/core/pac-trigger";
export type { PipelineTrigger, TriggerRule } from "./lib/core/pac-trigger";
export { GitPipeline } from "./lib/core/git-pipeline";
export type { GitPipelineOptions } from "./lib/core/git-pipeline";
export { TektonicProject } from "./lib/core/tektonic-project";
export type {
    TektonicProjectOptions,
    CacheSpec,
    RepositoryConfig,
    RepositoryGitProvider,
} from "./lib/core/tektonic-project";
export { TRIGGER_EVENTS } from "./lib/core/trigger-events";
export type { StatusReporter } from "./lib/core/status-reporter";

// Scripting
export { sh, bash, nu, py, script, Script, languageFor, dedent, renderScript, Sh, Bash, Nushell, Python, EXIT_CODE_PATH } from "./lib/script";
export { scriptFromFile, lintCommandForFile, languageNameForFile } from "./lib/script/from-file";
export type { ScriptLanguage, ScriptCtx, ScriptInput, ScriptObject, LanguageName } from "./lib/script";

// Reporters
export { GitHubStatusReporter } from "./lib/reporters/github-status-reporter";
export type { GitHubStatusReporterOptions } from "./lib/reporters/github-status-reporter";

// Re-exported from cdk8s / constructs so downstream projects depend only on tektonic
export { App, Chart, ApiObject } from "cdk8s";
export type { AppProps, ChartProps } from "cdk8s";
export { Construct } from "constructs";

// Constants
export {
    TEKTON_API_V1,
    PAC_API,
    DEFAULT_POD_SECURITY_CONTEXT,
    DEFAULT_STEP_SECURITY_CONTEXT,
    RESTRICTED_STEP_SECURITY_CONTEXT,
    DEFAULT_STEP_RESOURCES,
    DEFAULT_BASE_IMAGE,
    DEFAULT_GCS_COMPRESSION_LEVEL,
} from "./lib/constants";

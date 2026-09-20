import { Param } from '../../core/param';

/**
 * The pipeline params [Pipelines as Code](https://pipelinesascode.tekton.dev/) fills in for
 * every run, as typed handles.
 *
 * {@link TektonicProject} declares and binds these on every emitted PipelineRun, so a task can
 * take one straight from here instead of declaring a matching `Param` by hand and writing the
 * `$(params.…)` string into its script — where a typo is a template that silently never
 * substitutes.
 *
 * @example
 * ```ts
 * import { PAC_PARAMS, nu, Task } from '@pfenerty/tektonic';
 *
 * new Task({
 *   name: 'notify',
 *   params: [PAC_PARAMS.revision, PAC_PARAMS.repoFullName],
 *   steps: [{
 *     name: 'notify',
 *     image,
 *     // Param.toString() renders the Tekton expression, so interpolation is typed.
 *     script: nu`log $"building ${PAC_PARAMS.repoFullName} at ${PAC_PARAMS.revision}"`,
 *   }],
 * });
 * ```
 */
// Descriptions deliberately spell the PAC variable names out rather than writing `{{ … }}`:
// PAC substitutes template variables anywhere in the emitted PipelineRun, descriptions
// included, so a doc string would be rewritten at run time.
export const PAC_PARAMS = {
  /** Repository clone URL (`{{ repo_url }}`). */
  url: new Param({ name: 'url', type: 'string', description: 'Repository URL, bound by PAC from repo_url' }),
  /** Commit SHA the run is for (`{{ revision }}`). */
  revision: new Param({ name: 'revision', type: 'string', description: 'Commit SHA, bound by PAC from revision' }),
  /** Repository name without owner (`{{ repo_name }}`). */
  projectName: new Param({
    name: 'project-name',
    type: 'string',
    description: 'Repository name, bound by PAC from repo_name',
  }),
  /** `owner/repo` (`{{ repo_owner }}/{{ repo_name }}`). */
  repoFullName: new Param({
    name: 'repo-full-name',
    type: 'string',
    description: 'Repository owner/name, bound by PAC from repo_owner and repo_name',
  }),
  /**
   * Branch the event concerns (`{{ source_branch }}`) — the pushed branch for a push, the head
   * branch for a pull request, and the tag ref for a tag push.
   */
  sourceBranch: new Param({
    name: 'source-branch',
    type: 'string',
    description: 'Branch or tag ref of the event, bound by PAC from source_branch',
  }),
} as const;

/** The PAC template expression each well-known param is bound to on the emitted PipelineRun. */
export const PAC_PARAM_BINDINGS: Record<string, string> = {
  [PAC_PARAMS.url.name]: '{{ repo_url }}',
  [PAC_PARAMS.revision.name]: '{{ revision }}',
  [PAC_PARAMS.projectName.name]: '{{ repo_name }}',
  [PAC_PARAMS.repoFullName.name]: '{{ repo_owner }}/{{ repo_name }}',
  [PAC_PARAMS.sourceBranch.name]: '{{ source_branch }}',
};

/**
 * Params {@link TektonicProject} adds to every pipeline whether or not a task asked for one, so
 * the PAC bindings above always have somewhere to land. `url` and `revision` are omitted: they
 * come from the tasks that use them (`GitPipeline`'s git-clone declares both).
 */
export const PAC_INJECTED_PARAMS: Param[] = [
  PAC_PARAMS.projectName,
  PAC_PARAMS.repoFullName,
  PAC_PARAMS.sourceBranch,
];

/**
 * Environment variables carrying the PAC event context into every step, injected when
 * {@link TektonicProjectOptions.pacEventContext} is set.
 *
 * The values are PAC template variables, substituted before the PipelineRun reaches
 * Kubernetes — so a step reads an ordinary env var and needs no pipeline param plumbing.
 * Handy where the *event* rather than the code decides what to do: a security scan that runs
 * diff-scoped on a pull request and full on a push, say.
 *
 * Only variables PAC provides for every event are included; anything event-specific (a pull
 * request number) stays a deliberate `podTemplateEnv` entry, since PAC leaves an unavailable
 * variable in place as literal text.
 */
export const PAC_EVENT_ENV: Record<string, string> = {
  PAC_EVENT_TYPE: '{{ event_type }}',
  PAC_TARGET_BRANCH: '{{ target_branch }}',
  PAC_SOURCE_BRANCH: '{{ source_branch }}',
  PAC_REVISION: '{{ revision }}',
  PAC_REPO_URL: '{{ repo_url }}',
  PAC_REPO_OWNER: '{{ repo_owner }}',
  PAC_REPO_NAME: '{{ repo_name }}',
};

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitPipeline } from '../../core/git-pipeline';
import { Task } from '../../core/task';
import { TektonicProject } from '../../core/tektonic-project';
import { TRIGGER_EVENTS } from '../../core/trigger-events';

const capturedCharts: any[] = [];

vi.mock('cdk8s', async () => {
  const actual = await vi.importActual<typeof import('cdk8s')>('cdk8s');
  return {
    ...actual,
    App: class MockApp extends actual.App {
      synth() { /* no-op — suppress file writes in tests */ }
    },
    Chart: class CaptureChart extends actual.Chart {
      constructor(scope: any, id: string, props?: any) {
        super(scope, id, props);
        capturedCharts.push(this);
      }
    },
  };
});

// What a project emits through its default target: PAC-annotated PipelineRun templates with
// every well-known param bound to its `{{ }}` variable, and an optional Repository CR.
describe('PacTarget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capturedCharts.length = 0;
  });

  const buildTask = new Task({
    name: 'build',
    steps: [{ name: 'build', image: 'golang:1.24' }],
  });

  it('PipelineRun params bind source-branch to {{ source_branch }}', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [buildTask],
    });
    new TektonicProject({ namespace: 'ci', pipelines: [pipeline] });

    const allObjects = capturedCharts.flatMap((c: any) => c.toJson());
    const pipelineRun = allObjects.find((o: any) => o.kind === 'PipelineRun');
    const param = pipelineRun?.spec?.params?.find((p: any) => p.name === 'source-branch');
    expect(param?.value).toBe('{{ source_branch }}');
  });

  describe('trigger annotations on the PipelineRun', () => {
    const PAC = 'pipelinesascode.tekton.dev';
    const annotationsFor = (trigger: any) => {
      const pipeline = new GitPipeline({ name: 'ci', trigger, tasks: [buildTask] });
      new TektonicProject({ namespace: 'ci', pipelines: [pipeline] });
      const pr = capturedCharts.flatMap((c: any) => c.toJson()).find((o: any) => o.kind === 'PipelineRun');
      return pr.metadata.annotations as Record<string, string>;
    };

    it('single rule → discrete on-event / on-target-branch / on-path-changed', () => {
      const a = annotationsFor({
        rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST, branch: 'main', pathsChanged: ['src/**'] }],
        comment: '^/ci',
        cancelInProgress: true,
      });
      expect(a[`${PAC}/on-event`]).toBe('[pull_request]');
      expect(a[`${PAC}/on-target-branch`]).toBe('[main]');
      expect(a[`${PAC}/on-path-changed`]).toBe('[src/**]');
      expect(a[`${PAC}/on-comment`]).toBe('^/ci');
      expect(a[`${PAC}/cancel-in-progress`]).toBe('true');
    });

    it('compound rules → single on-cel-expression, no on-event', () => {
      const a = annotationsFor({
        rules: [
          { on: [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST], branch: 'main' },
          { on: TRIGGER_EVENTS.PULL_REQUEST, sourceBranch: 'feature/*', pathsChanged: ['src/**'] },
        ],
      });
      expect(a[`${PAC}/on-cel-expression`]).toContain(' || ');
      expect(a[`${PAC}/on-event`]).toBeUndefined();
      expect(a[`${PAC}/on-target-branch`]).toBeUndefined();
    });
  });

  describe('Repository CR', () => {
    const findRepo = () =>
      capturedCharts.flatMap((c: any) => c.toJson()).find((o: any) => o.kind === 'Repository');

    it('is not emitted when repository is omitted', () => {
      const pipeline = new GitPipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [buildTask] });
      new TektonicProject({ namespace: 'ci', pipelines: [pipeline] });
      expect(findRepo()).toBeUndefined();
    });

    it('emits a minimal Repository (GitHub-App style: url only)', () => {
      const pipeline = new GitPipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [buildTask] });
      new TektonicProject({
        name: 'app',
        namespace: 'ci',
        pipelines: [pipeline],
        repository: { url: 'https://github.com/pfenerty/app' },
      });
      const repo = findRepo();
      expect(repo.apiVersion).toBe('pipelinesascode.tekton.dev/v1alpha1');
      expect(repo.metadata.namespace).toBe('ci');
      expect(repo.spec.url).toBe('https://github.com/pfenerty/app');
      expect(repo.spec.git_provider).toBeUndefined();
    });

    it('emits a git_provider block with secret refs when configured', () => {
      const pipeline = new GitPipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [buildTask] });
      new TektonicProject({
        namespace: 'ci',
        pipelines: [pipeline],
        repository: {
          url: 'https://gitlab.com/acme/app',
          gitProvider: { type: 'gitlab', secretName: 'gl-token', webhookSecretName: 'gl-webhook' },
        },
      });
      const repo = findRepo();
      expect(repo.spec.git_provider.type).toBe('gitlab');
      expect(repo.spec.git_provider.secret).toEqual({ name: 'gl-token', key: 'token' });
      expect(repo.spec.git_provider.webhook_secret).toEqual({ name: 'gl-webhook', key: 'webhook.secret' });
    });
  });
});

describe('pod template env', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capturedCharts.length = 0;
  });

  const runOf = (opts: Record<string, unknown> = {}) => {
    const task = new Task({ name: 'work', steps: [{ name: 's', image: 'alpine' }] });
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [task],
    });
    new TektonicProject({ namespace: 'ci', pipelines: [pipeline], ...opts });
    const run = capturedCharts
      .flatMap(c => c.toJson())
      .find((m: any) => m?.kind === 'PipelineRun');
    return run.spec.taskRunTemplate.podTemplate.env as { name: string; value?: string }[];
  };

  // A pod-level runAsUser with no /etc/passwd entry leaves $HOME as '/', which creds-init
  // cannot write to — git and registry credentials go with it.
  it('sets HOME to /tekton/home by default', () => {
    expect(runOf()).toContainEqual({ name: 'HOME', value: '/tekton/home' });
  });

  it('lets an explicit HOME win', () => {
    const env = runOf({ podTemplateEnv: [{ name: 'HOME', value: '/root' }] });
    expect(env.filter(e => e.name === 'HOME')).toEqual([{ name: 'HOME', value: '/root' }]);
  });

  it('injects the PAC event context on request', () => {
    const env = runOf({ pacEventContext: true });
    expect(env).toContainEqual({ name: 'PAC_EVENT_TYPE', value: '{{ event_type }}' });
    expect(env).toContainEqual({ name: 'PAC_TARGET_BRANCH', value: '{{ target_branch }}' });
    expect(env).toContainEqual({ name: 'PAC_REPO_NAME', value: '{{ repo_name }}' });
  });

  it('omits the PAC event context by default', () => {
    expect(runOf().some(e => e.name.startsWith('PAC_'))).toBe(false);
  });

  it('lets podTemplateEnv override an injected PAC variable', () => {
    const env = runOf({
      pacEventContext: true,
      podTemplateEnv: [{ name: 'PAC_EVENT_TYPE', value: 'override' }],
    });
    expect(env.filter(e => e.name === 'PAC_EVENT_TYPE')).toEqual([
      { name: 'PAC_EVENT_TYPE', value: 'override' },
    ]);
  });
});

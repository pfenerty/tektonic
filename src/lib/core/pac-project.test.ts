import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitPipeline } from './git-pipeline';
import { Pipeline } from './pipeline';
import { Task } from './task';
import { Workspace } from './workspace';
import { PACProject } from './pac-project';
import { TRIGGER_EVENTS } from './trigger-events';

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

describe('PACProject', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capturedCharts.length = 0;
  });

  const buildTask = new Task({
    name: 'build',
    steps: [{ name: 'build', image: 'golang:1.24' }],
  });

  const testTask = new Task({
    name: 'test',
    needs: [buildTask],
    steps: [{ name: 'test', image: 'golang:1.24' }],
  });

  it('constructs without error for a push pipeline', () => {
    const pipeline = new GitPipeline({
      name: 'my-push',
      triggers: [TRIGGER_EVENTS.PUSH],
      tasks: [buildTask, testTask],
    });
    expect(() =>
      new PACProject({ namespace: 'ci', pipelines: [pipeline] }),
    ).not.toThrow();
  });

  it('constructs without error for push and PR pipelines', () => {
    const push = new GitPipeline({
      name: 'push',
      triggers: [TRIGGER_EVENTS.PUSH],
      tasks: [buildTask],
    });
    const pr = new GitPipeline({
      name: 'pull-request',
      triggers: [TRIGGER_EVENTS.PULL_REQUEST],
      tasks: [buildTask, testTask],
    });
    expect(() =>
      new PACProject({ namespace: 'ci', pipelines: [push, pr] }),
    ).not.toThrow();
  });

  it('constructs with name prefix', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      triggers: [TRIGGER_EVENTS.PUSH],
      tasks: [buildTask],
    });
    expect(() =>
      new PACProject({ name: 'ocidex', namespace: 'ocidex-ci', pipelines: [pipeline] }),
    ).not.toThrow();
  });

  it('constructs with cache workspaces', () => {
    const goCache = new Workspace({ name: 'go-cache' });
    const pipeline = new GitPipeline({
      name: 'push',
      triggers: [TRIGGER_EVENTS.PUSH],
      tasks: [buildTask],
    });
    expect(() =>
      new PACProject({
        name: 'ocidex',
        namespace: 'ocidex-ci',
        pipelines: [pipeline],
        caches: [{ workspace: goCache, storageSize: '5Gi', storageClassName: 'local-path' }],
      }),
    ).not.toThrow();
  });

  it('skips pipelines with no triggers', () => {
    const noTrigger = new Pipeline({ name: 'manual', tasks: [buildTask] });
    expect(() =>
      new PACProject({ namespace: 'ci', pipelines: [noTrigger] }),
    ).not.toThrow();
  });

  it('constructs with tag trigger', () => {
    const tag = new GitPipeline({
      name: 'release',
      triggers: [TRIGGER_EVENTS.TAG],
      tasks: [buildTask],
    });
    expect(() =>
      new PACProject({ namespace: 'ci', pipelines: [tag] }),
    ).not.toThrow();
  });

  it('constructs with custom onTargetBranch', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      triggers: [TRIGGER_EVENTS.PUSH],
      onTargetBranch: 'main',
      tasks: [buildTask],
    });
    expect(() =>
      new PACProject({ namespace: 'ci', pipelines: [pipeline] }),
    ).not.toThrow();
  });

  it('constructs with custom pod security context', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      triggers: [TRIGGER_EVENTS.PUSH],
      tasks: [buildTask],
    });
    expect(() =>
      new PACProject({
        namespace: 'ci',
        pipelines: [pipeline],
        defaultPodSecurityContext: { runAsUser: 1024, runAsGroup: 1024, fsGroup: 1024 },
      }),
    ).not.toThrow();
  });

  it('constructs with repoRelativePath override', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      triggers: [TRIGGER_EVENTS.PUSH],
      tasks: [buildTask],
    });
    expect(() =>
      new PACProject({
        namespace: 'ci',
        pipelines: [pipeline],
        outdir: '../../.tekton',
        repoRelativePath: '.tekton',
      }),
    ).not.toThrow();
  });

  it('constructs with glob onTargetBranch for release branch trigger', () => {
    const pipeline = new GitPipeline({
      name: 'release',
      triggers: [TRIGGER_EVENTS.PUSH],
      onTargetBranch: 'release/v*',
      tasks: [buildTask],
    });
    expect(() =>
      new PACProject({ namespace: 'ci', pipelines: [pipeline] }),
    ).not.toThrow();
  });

  it('PipelineRun params bind source-branch to {{ source_branch }}', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      triggers: [TRIGGER_EVENTS.PUSH],
      tasks: [buildTask],
    });
    new PACProject({ namespace: 'ci', pipelines: [pipeline] });

    const allObjects = capturedCharts.flatMap((c: any) => c.toJson());
    const pipelineRun = allObjects.find((o: any) => o.kind === 'PipelineRun');
    const param = pipelineRun?.spec?.params?.find((p: any) => p.name === 'source-branch');
    expect(param?.value).toBe('{{ source_branch }}');
  });

  it('merges pipelineRunAnnotations into the PipelineRun metadata alongside PAC annotations', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      triggers: [TRIGGER_EVENTS.PUSH],
      tasks: [buildTask],
    });
    new PACProject({
      namespace: 'ci',
      pipelines: [pipeline],
      pipelineRunAnnotations: { 'chains.tekton.dev/transparency-upload': 'true' },
    });

    const allObjects = capturedCharts.flatMap((c: any) => c.toJson());
    const pipelineRun = allObjects.find((o: any) => o.kind === 'PipelineRun');
    expect(pipelineRun.metadata.annotations['chains.tekton.dev/transparency-upload']).toBe('true');
    // PAC annotations are preserved.
    expect(pipelineRun.metadata.annotations['pipelinesascode.tekton.dev/on-event']).toBeDefined();
  });

  it('emits spec.timeouts.pipeline when the pipeline sets a timeout', () => {
    const pipeline = new GitPipeline({
      name: 'push',
      triggers: [TRIGGER_EVENTS.PUSH],
      timeout: '2h',
      tasks: [buildTask],
    });
    new PACProject({ namespace: 'ci', pipelines: [pipeline] });
    const pipelineRun = capturedCharts.flatMap((c: any) => c.toJson()).find((o: any) => o.kind === 'PipelineRun');
    expect(pipelineRun.spec.timeouts).toEqual({ pipeline: '2h' });
  });

  it('omits spec.timeouts when no timeout is set', () => {
    const pipeline = new GitPipeline({ name: 'push', triggers: [TRIGGER_EVENTS.PUSH], tasks: [buildTask] });
    new PACProject({ namespace: 'ci', pipelines: [pipeline] });
    const pipelineRun = capturedCharts.flatMap((c: any) => c.toJson()).find((o: any) => o.kind === 'PipelineRun');
    expect(pipelineRun.spec.timeouts).toBeUndefined();
  });
});

describe('Pipeline.onTargetBranch', () => {
  it('defaults to "*"', () => {
    const p = new Pipeline({ name: 'p', tasks: [new Task({ name: 't', steps: [{ name: 's', image: 'alpine' }] })] });
    expect(p.onTargetBranch).toBe('*');
  });

  it('reflects the provided value', () => {
    const p = new Pipeline({
      name: 'p',
      tasks: [new Task({ name: 't', steps: [{ name: 's', image: 'alpine' }] })],
      onTargetBranch: 'main',
    });
    expect(p.onTargetBranch).toBe('main');
  });
});

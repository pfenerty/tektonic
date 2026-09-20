import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitPipeline } from './git-pipeline';
import { Pipeline } from './pipeline';
import { Task } from './task';
import { TektonicProject } from './tektonic-project';
import { TRIGGER_EVENTS } from './trigger-events';
import { Param } from './param';
import { Workspace } from './workspace';
import type { EmittedFile, SynthModel, SynthTarget } from './synth-target';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tektonic-synth-target-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A target that records the model it was handed and writes nothing. */
class RecordingTarget implements SynthTarget {
  readonly name = 'recording';
  model?: SynthModel;
  outdir?: string;
  constructor(readonly injectedParams?: Param[], readonly injectedEnv?: { name: string; value: string }[]) {}
  emit(model: SynthModel, outdir: string): EmittedFile[] {
    this.model = model;
    this.outdir = outdir;
    return [];
  }
}

const buildTask = () => new Task({ name: 'build', steps: [{ name: 'build', image: 'golang:1.24' }] });

const projectWith = (target: SynthTarget, opts: Record<string, unknown> = {}): TektonicProject =>
  new TektonicProject({
    namespace: 'ci',
    outdir: path.join(tmp, '.tekton'),
    pipelines: [
      new GitPipeline({
        name: 'push',
        trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
        tasks: [buildTask()],
      }),
    ],
    targets: [target],
    ...opts,
  });

describe('SynthTarget', () => {
  it('hands a custom target the model and the outdir', () => {
    const target = new RecordingTarget();
    projectWith(target);

    expect(target.outdir).toBe(path.join(tmp, '.tekton'));
    expect(target.model?.namespace).toBe('ci');
    expect(target.model?.pipelines.map(p => p.name)).toEqual(['push']);
    expect(target.model?.tasks.map(t => t.name).sort()).toEqual(['build', 'git-clone']);
  });

  // The whole point of the seam: a target that is not PAC must not be handed PAC's
  // annotations, its `{{ }}` template variables or its injected params.
  it('builds a model with no PAC concepts in it', () => {
    const target = new RecordingTarget();
    projectWith(target);

    const serialized = JSON.stringify(target.model);
    expect(serialized).not.toContain('pipelinesascode');
    expect(serialized).not.toContain('PAC_');
    expect(serialized).not.toContain('{{');
    const paramNames = (target.model!.pipelines[0].spec.params as { name: string }[]).map(p => p.name);
    expect(paramNames).not.toContain('repo-full-name');
    expect(paramNames).not.toContain('source-branch');
  });

  it('declares every target-injected param on every pipeline spec', () => {
    const target = new RecordingTarget([new Param({ name: 'build-id', type: 'string' })]);
    projectWith(target);

    const paramNames = (target.model!.pipelines[0].spec.params as { name: string }[]).map(p => p.name);
    expect(paramNames).toContain('build-id');
  });

  it('merges target-injected env, with the project’s own entries winning', () => {
    const target = new RecordingTarget(undefined, [
      { name: 'RUNNER', value: 'from-target' },
      { name: 'HOME', value: '/from-target' },
    ]);
    projectWith(target, { podTemplateEnv: [{ name: 'HOME', value: '/from-project' }] });

    expect(target.model!.defaults.podTemplateEnv).toEqual([
      { name: 'HOME', value: '/from-project' },
      { name: 'RUNNER', value: 'from-target' },
    ]);
  });

  it('carries the model’s run defaults and workspace bindings', () => {
    const cacheWs = new Workspace({ name: 'go-cache' });
    const cached = new Task({
      name: 'cached',
      workspaces: [cacheWs],
      steps: [{ name: 's', image: 'alpine' }],
    });
    const target = new RecordingTarget();
    new TektonicProject({
      namespace: 'ci',
      name: 'demo',
      outdir: path.join(tmp, '.tekton'),
      pipelines: [new Pipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [cached] })],
      caches: [{ workspace: cacheWs, storageSize: '5Gi' }],
      serviceAccountName: 'builder',
      targets: [target],
    });

    expect(target.model!.name).toBe('demo');
    expect(target.model!.defaults.serviceAccountName).toBe('builder');
    expect(target.model!.pipelines[0].resourceName).toBe('demo-push');
    expect(target.model!.pipelines[0].workspaceBindings).toEqual([
      { name: 'go-cache', persistentVolumeClaim: { claimName: 'demo-go-cache' } },
    ]);
  });

  it('keeps untriggered pipelines in the model for targets that want them', () => {
    const target = new RecordingTarget();
    new TektonicProject({
      namespace: 'ci',
      outdir: path.join(tmp, '.tekton'),
      pipelines: [new Pipeline({ name: 'manual', tasks: [buildTask()] })],
      targets: [target],
    });

    const manual = target.model!.pipelines[0];
    expect(manual.name).toBe('manual');
    expect(manual.trigger).toBeUndefined();
    expect(manual.events).toEqual([]);
  });

  it('runs every target given, in order', () => {
    const first = new RecordingTarget();
    const second = new RecordingTarget();
    const project = new TektonicProject({
      namespace: 'ci',
      outdir: path.join(tmp, '.tekton'),
      pipelines: [new Pipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [buildTask()] })],
      targets: [first, second],
    });

    expect(project.targets).toEqual([first, second]);
    expect(first.model).toBe(second.model);
  });

  // A `repository` that quietly never gets written is the kind of thing you find out about
  // from the cluster.
  it('warns when a PAC-only option is set but no PAC target is emitting', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    projectWith(new RecordingTarget(), { repository: { url: 'https://github.com/acme/app' } });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('repository'));
  });

  it('does not warn when no PAC-only option is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    projectWith(new RecordingTarget());

    expect(warn).not.toHaveBeenCalled();
  });
});

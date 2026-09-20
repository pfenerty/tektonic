import { describe, it, expect } from 'vitest';
import { pipelineManifest } from '../targets/tekton/tekton-target';
import { Pipeline } from './pipeline';
import { Task } from './task';
import { Result } from './result';
import { equals } from './condition';
import { GitPipeline } from './git-pipeline';
import { gated, unwrapGated } from './pipeline-task';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

describe('gated()', () => {
  const clone = new Task({ name: 'clone', steps: [{ name: 'clone', image: 'git' }] });
  const build = new Task({ name: 'build', needs: [clone], steps: [{ name: 'build', image: 'node:22' }] });

  const whenExpr = [{ input: '$(params.event-type)', operator: 'in' as const, values: ['push'] }];

  it('emits when clause in pipeline task spec', () => {
    const gatedBuild = gated(build, { when: whenExpr });
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gatedBuild] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.when).toEqual(whenExpr);
  });

  it('plain tasks have no when clause', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, build] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.when).toBeUndefined();
  });

  it('delegates task properties to the wrapped task', () => {
    const gatedBuild = gated(build, { when: whenExpr });
    expect(gatedBuild.name).toBe('build');
    expect(gatedBuild.needs).toContain(clone);
    expect(gatedBuild.params).toEqual(build.params);
    expect(gatedBuild.workspaces).toEqual(build.workspaces);
    expect(gatedBuild._overrides).toEqual({ when: whenExpr });
  });

  it('preserves runAfter ordering for wrapped task', () => {
    const gatedBuild = gated(build, { when: whenExpr });
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gatedBuild] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.runAfter).toContain('clone');
  });

  it('omits when from spec when overrides.when is empty', () => {
    const gatedBuild = gated(build, { when: [] });
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gatedBuild] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.when).toBeUndefined();
  });

  it('emits retries in pipeline task spec', () => {
    const gatedBuild = gated(build, { retries: 3 });
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gatedBuild] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.retries).toBe(3);
  });

  it('emits timeout in pipeline task spec', () => {
    const gatedBuild = gated(build, { timeout: '30m' });
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gatedBuild] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.timeout).toBe('30m');
  });

  it('plain tasks have no retries or timeout', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, build] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.retries).toBeUndefined();
    expect(buildEntry?.timeout).toBeUndefined();
  });

  it('can combine when, retries, and timeout in one override', () => {
    const gatedBuild = gated(build, {
      when: whenExpr,
      retries: 2,
      timeout: '1h',
    });
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gatedBuild] });
    const manifest = pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.when).toEqual(whenExpr);
    expect(buildEntry?.retries).toBe(2);
    expect(buildEntry?.timeout).toBe('1h');
  });
});

describe('gated() identity', () => {
  // The shape that broke before: a task other tasks depend on (goTest ← goIntegration)
  // is gated in one pipeline and ungated in another.
  const mkGraph = () => {
    const clone = new Task({ name: 'clone', steps: [{ name: 'clone', image: 'git' }] });
    const test = new Task({ name: 'test', needs: [clone], steps: [{ name: 'test', image: 'go' }] });
    const integration = new Task({ name: 'integration', needs: [test], steps: [{ name: 'it', image: 'go' }] });
    return { clone, test, integration };
  };

  const specOf = (pipeline: Pipeline) =>
    (pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj).spec;

  const goWhen = [{ input: '$(params.changed)', operator: 'in' as const, values: ['go'] }];

  it('emits one entry for a depended-on task that is gated', () => {
    const { clone, test, integration } = mkGraph();
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gated(test, { when: goWhen }), integration] });
    const entries = (specOf(pipeline).tasks as AnyObj[]).filter(t => t.name === 'test');
    expect(entries).toHaveLength(1);
    expect(entries[0].when).toEqual(goWhen);
  });

  it('keeps runAfter edges into and out of a gated non-leaf task', () => {
    const { clone, test, integration } = mkGraph();
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gated(test, { when: goWhen }), integration] });
    const tasks = specOf(pipeline).tasks as AnyObj[];
    expect(tasks.find(t => t.name === 'test')?.runAfter).toEqual(['clone']);
    expect(tasks.find(t => t.name === 'integration')?.runAfter).toEqual(['test']);
  });

  it('discovers a gated task reached only through another task needs', () => {
    const { clone, test, integration } = mkGraph();
    // `test` is not listed at the top level — it is reached via integration.needs — but the
    // marker in `tasks` still contributes its overrides.
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, integration, gated(test, { retries: 2 })] });
    const entries = (specOf(pipeline).tasks as AnyObj[]).filter(t => t.name === 'test');
    expect(entries).toHaveLength(1);
    expect(entries[0].retries).toBe(2);
  });

  it('gates the same task in one pipeline and not in another', () => {
    const { clone, test, integration } = mkGraph();
    const gatedPipeline = new Pipeline({ name: 'pr', tasks: [clone, gated(test, { when: goWhen }), integration] });
    const plainPipeline = new Pipeline({ name: 'push', tasks: [clone, test, integration] });
    const gatedEntry = (specOf(gatedPipeline).tasks as AnyObj[]).find(t => t.name === 'test');
    const plainEntry = (specOf(plainPipeline).tasks as AnyObj[]).find(t => t.name === 'test');
    expect(gatedEntry?.when).toEqual(goWhen);
    expect(plainEntry?.when).toBeUndefined();
  });

  it('rejects the same task gated twice with different overrides', () => {
    const { clone, test } = mkGraph();
    expect(
      () => new Pipeline({ name: 'ci', tasks: [clone, gated(test, { retries: 1 }), gated(test, { retries: 2 })] }),
    ).toThrow(/gated more than once/);
  });

  it('unwrapGated returns the wrapped task', () => {
    const { test } = mkGraph();
    const marker = gated(test, { retries: 1 });
    expect(unwrapGated(marker)).toBe(test);
    expect(unwrapGated(test)).toBe(test);
  });
});

describe('gated() condition sources', () => {
  const detected = () => {
    const changed = new Result({ name: 'changed' });
    const detect = new Task({
      name: 'detect-changes',
      results: [changed],
      steps: [{ name: 'detect', image: 'git' }],
    });
    return { detect, cond: equals(changed, 'true') };
  };

  it('pulls the producing task of an override condition into the pipeline', () => {
    const { detect, cond } = detected();
    const build = new Task({ name: 'build', steps: [{ name: 'build', image: 'node' }] });
    const pipeline = new Pipeline({ name: 'ci', tasks: [gated(build, { when: cond })] });
    expect(pipeline.allTasks).toContain(detect);

    const tasks = (pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj).spec.tasks as AnyObj[];
    expect(tasks.map(t => t.name)).toContain('detect-changes');
    expect(tasks.find(t => t.name === 'build')?.runAfter).toEqual(['detect-changes']);
  });

  it('does not duplicate an edge already declared in needs', () => {
    const { detect, cond } = detected();
    const build = new Task({ name: 'build', needs: [detect], steps: [{ name: 'build', image: 'node' }] });
    const pipeline = new Pipeline({ name: 'ci', tasks: [gated(build, { when: cond })] });
    const tasks = (pipelineManifest(pipeline, { namespace: 'ns' }) as AnyObj).spec.tasks as AnyObj[];
    expect(tasks.find(t => t.name === 'build')?.runAfter).toEqual(['detect-changes']);
  });

  it('GitPipeline injects the shared workspace into a condition-sourced detection task', () => {
    const { detect, cond } = detected();
    const build = new Task({ name: 'build', steps: [{ name: 'build', image: 'node' }] });
    const pipeline = new GitPipeline({ name: 'ci', tasks: [gated(build, { when: cond })] });
    expect(detect.workspaces.map(w => w.name)).toContain(pipeline.workspace.name);
  });
});

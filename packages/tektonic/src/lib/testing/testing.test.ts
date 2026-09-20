import { describe, it, expect } from 'vitest';
import { synthPipeline, synthTask, synthTasks } from './index';
import { Task } from '../core/task';
import { Result } from '../core/result';
import { Workspace } from '../core/workspace';
import { GitPipeline } from '../core/git-pipeline';
import { Pipeline } from '../core/pipeline';
import { gated } from '../core/pipeline-task';
import { equals } from '../core/condition';
import { TRIGGER_EVENTS } from '../core/trigger-events';
import { TestStatusReporter } from '../../__fixtures__/reporter';
import { sh } from '../script';

/** The shape the helpers exist for: a frontend-only PR must skip the Go tasks. */
const changeGatedPipeline = () => {
  const changed = new Result({ name: 'changed' });
  const detect = new Task({
    name: 'detect-go-changes',
    results: [changed],
    steps: [{ name: 'detect', image: 'git', script: sh`git diff --name-only` }],
  });
  const goTest = new Task({
    name: 'go-test',
    when: equals(changed, 'true'),
    steps: [{ name: 'test', image: 'go', script: sh`go test ./...` }],
  });
  const frontendTest = new Task({
    name: 'frontend-test',
    steps: [{ name: 'test', image: 'node', script: sh`npm test` }],
  });
  const pipeline = new GitPipeline({
    name: 'pr',
    trigger: { rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST }] },
    tasks: [goTest, frontendTest],
  });
  return { pipeline, detect, goTest, frontendTest };
};

describe('synthPipeline', () => {
  it('asserts gating without writing YAML or touching a cluster', () => {
    const { pipeline } = changeGatedPipeline();
    const pr = synthPipeline(pipeline);

    expect(pr.has('go-test')).toBe(true);
    expect(pr.isGated('go-test')).toBe(true);
    expect(pr.when('go-test')).toEqual([
      { input: '$(tasks.detect-go-changes.results.changed)', operator: 'in', values: ['true'] },
    ]);
    expect(pr.runAfter('go-test')).toContain('detect-go-changes');

    // The frontend task is not gated, so a Go-only change still runs it.
    expect(pr.isGated('frontend-test')).toBe(false);
  });

  it('exposes task order, params and workspaces', () => {
    const { pipeline } = changeGatedPipeline();
    const pr = synthPipeline(pipeline);
    expect(pr.taskNames).toContain('git-clone');
    // git-clone comes first: everything root-level runs after it.
    expect(pr.runAfter('frontend-test')).toEqual(['git-clone']);
    expect(pr.params('git-clone')).toMatchObject({ url: '$(params.url)', revision: '$(params.revision)' });
    expect(pr.workspaceNames).toContain('workspace');
    expect(pr.paramNames).toEqual(expect.arrayContaining(['url', 'revision']));
  });

  it('reflects gated() overrides', () => {
    const clone = new Task({ name: 'clone', steps: [{ name: 's', image: 'git' }] });
    const build = new Task({ name: 'build', needs: [clone], steps: [{ name: 's', image: 'node' }] });
    const pipeline = new Pipeline({
      name: 'ci',
      tasks: [clone, gated(build, { retries: 2, timeout: '20m' })],
    });
    const view = synthPipeline(pipeline);
    expect(view.task('build').retries).toBe(2);
    expect(view.task('build').timeout).toBe('20m');
  });

  it('lists finally tasks, including the ones the framework adds', () => {
    const reporter = new TestStatusReporter();
    const task = new Task({
      name: 'deploy',
      statusReporter: reporter,
      steps: [{ name: 's', image: 'alpine' }],
    });
    const view = synthPipeline(new Pipeline({ name: 'ci', tasks: [task] }));
    expect(view.finallyNames).toContain('reconcile-status-ci');
    expect(view.has('reconcile-status-ci')).toBe(true);
  });

  it('names the available tasks when one is missing', () => {
    const { pipeline } = changeGatedPipeline();
    expect(() => synthPipeline(pipeline).task('nope')).toThrow(/no task 'nope'.*go-test/s);
  });

  it('applies a project name prefix to task refs', () => {
    const { pipeline } = changeGatedPipeline();
    const view = synthPipeline(pipeline, { namePrefix: 'demo' });
    expect(view.task('go-test').raw.taskRef).toEqual({ kind: 'Task', name: 'demo-go-test' });
  });
});

describe('synthTask', () => {
  it('returns the manifest with framework-injected steps in place', () => {
    const cacheWs = new Workspace({ name: 'cache' });
    const task = new Task({
      name: 'build',
      statusReporter: new TestStatusReporter(),
      caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'], workspace: cacheWs }],
      steps: [{ name: 'build', image: 'node', script: sh`npm run build` }],
    });
    // The reporter's step resolves to the project's injected-step image, which must declare
    // the `nushell` its `http post` needs.
    const view = synthTask(task, { namespace: 'ci', injectedStepImage: 'ghcr.io/example/ci-base:test' });
    expect(view.name).toBe('build');
    expect(view.stepNames).toEqual(['restore-npm-cache', 'build', 'save-npm-cache', 'report-status']);
    expect(view.paramNames).toEqual(expect.arrayContaining(['repo-full-name', 'revision']));
    // The exit-code contract is applied to the user step, not hand-written by the author.
    expect(view.script('build')).toContain('/tekton/home/.exit-code');
  });

  it('names the available steps when one is missing', () => {
    const task = new Task({ name: 'build', steps: [{ name: 'build', image: 'node' }] });
    expect(() => synthTask(task).step('nope')).toThrow(/no step 'nope'.*build/s);
  });
});

describe('synthTasks', () => {
  it('synthesizes every task the pipeline emits, keyed by name', () => {
    const { pipeline } = changeGatedPipeline();
    const tasks = synthTasks(pipeline);
    expect(Object.keys(tasks).sort()).toEqual(
      ['detect-go-changes', 'frontend-test', 'git-clone', 'go-test'].sort(),
    );
    expect(tasks['git-clone'].stepNames).toEqual(['clone']);
  });
});

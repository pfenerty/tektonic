import { describe, it, expect } from 'vitest';
import { taskPreset } from './task-preset';
import { Task } from './task';
import { Param } from './param';
import { Workspace } from './workspace';
import { TestStatusReporter } from '../../__fixtures__/reporter';
import { synthTask } from '../testing';
import { sh } from '../script';

const workspace = new Workspace({ name: 'workspace' });
const reporter = new TestStatusReporter();

const ciTask = taskPreset({
  statusReporter: reporter,
  workspaces: [workspace],
  params: [new Param({ name: 'revision' })],
  stepTemplate: { workingDir: workspace.path },
  step: {
    computeResources: { requests: { cpu: '250m', memory: '512Mi' } },
    env: [{ name: 'CI', value: 'true' }],
  },
});

describe('taskPreset', () => {
  it('stamps task-level defaults onto every task', () => {
    const task = ciTask({ name: 'test', steps: [{ name: 'test', image: 'go', script: sh`go test ./...` }] });
    expect(task.statusReporter).toBe(reporter);
    expect(task.workspaces.map(w => w.name)).toContain('workspace');
    expect(task.params.map(p => p.name)).toContain('revision');
  });

  it('stamps step defaults, letting the step win per field', () => {
    const task = ciTask({
      name: 'test',
      steps: [
        { name: 'a', image: 'go' },
        { name: 'b', image: 'go', computeResources: { requests: { cpu: '1' } } },
      ],
    });
    expect(task.steps[0].computeResources).toEqual({ requests: { cpu: '250m', memory: '512Mi' } });
    expect(task.steps[1].computeResources).toEqual({ requests: { cpu: '1' } });
  });

  it('merges env by name, the step winning', () => {
    const task = ciTask({
      name: 'test',
      steps: [{ name: 'a', image: 'go', env: [{ name: 'CI', value: 'no' }, { name: 'EXTRA', value: '1' }] }],
    });
    expect(task.steps[0].env).toEqual([
      { name: 'CI', value: 'no' },
      { name: 'EXTRA', value: '1' },
    ]);
  });

  it('lets the call override a task-level default', () => {
    const other = new TestStatusReporter({ failOnError: false });
    const task = ciTask({ name: 'scan', statusReporter: other, steps: [{ name: 's', image: 'go' }] });
    expect(task.statusReporter).toBe(other);
  });

  it('merges stepTemplate per key', () => {
    const task = ciTask({
      name: 'test',
      stepTemplate: { workingDir: '/custom' },
      steps: [{ name: 's', image: 'go' }],
    });
    expect(task.stepTemplate).toEqual({ workingDir: '/custom' });
  });

  it('concatenates needs and dedupes named collections', () => {
    const upstream = ciTask({ name: 'build', steps: [{ name: 's', image: 'go' }] });
    const task = ciTask({
      name: 'test',
      needs: [upstream],
      workspaces: [workspace],
      steps: [{ name: 's', image: 'go' }],
    });
    expect(task.needs).toEqual([upstream]);
    expect(task.workspaces.filter(w => w.name === 'workspace')).toHaveLength(1);
  });

  it('produces a task that synthesizes like any other', () => {
    const task = ciTask({ name: 'test', steps: [{ name: 'test', image: 'go', script: sh`go test ./...` }] });
    const view = synthTask(task, { namespace: 'ci', injectedStepImage: 'ghcr.io/example/ci-base:test' });
    expect(view.stepNames).toEqual(['test', 'report-status']);
    expect(view.script('test')).toContain('go test ./...');
  });
});

describe('taskPreset and artifacts', () => {
  it('carries a project-wide artifact store and workspace onto the tasks it builds', () => {
    const shared = new Workspace({ name: 'shared' });
    const ciTask = taskPreset({ workspaces: [shared], artifactWorkspace: shared });
    const build = ciTask({
      name: 'build',
      steps: [{ name: 'compile', image: 'alpine', script: sh`true` }],
      produces: { dist: 'out/app.tar' },
    });
    // The typed handle survives the preset: `dist` is a name, not a string lookup.
    expect(build.artifacts.dist.workspace).toBe(shared);
    expect(build.artifacts.dist.producer).toBe(build);
  });

  it('concatenates the preset’s consumes with the call’s', () => {
    const shared = new Workspace({ name: 'shared' });
    const producer = new Task({
      name: 'build',
      workspaces: [shared],
      steps: [{ name: 'compile', image: 'alpine', script: sh`true` }],
      produces: { dist: 'out/app.tar' },
    });
    const ciTask = taskPreset({ workspaces: [shared], consumes: [producer.artifacts.dist] });
    const test = ciTask({
      name: 'test',
      needs: [producer],
      steps: [{ name: 'run', image: 'alpine', script: sh`true` }],
    });
    expect(test.consumes).toEqual([producer.artifacts.dist]);
  });
});

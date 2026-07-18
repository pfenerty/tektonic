import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { Pipeline } from './pipeline';
import { Task } from './task';
import { Param } from './param';
import { Result } from './result';
import { Workspace } from './workspace';
import { TRIGGER_EVENTS } from './trigger-events';
import { GitHubStatusReporter } from '../reporters/github-status-reporter';

describe('Pipeline', () => {
  const workspace = new Workspace({ name: 'workspace' });
  const urlParam = new Param({ name: 'url' });
  const revParam = new Param({ name: 'revision' });
  const pathParam = new Param({ name: 'build-path', default: './' });

  const clone = new Task({
    name: 'clone',
    params: [urlParam, revParam],
    workspaces: [workspace],
    steps: [{ name: 'clone', image: 'git' }],
  });

  const test = new Task({
    name: 'test',
    params: [pathParam],
    workspaces: [workspace],
    needs: [clone],
    steps: [{ name: 'test', image: 'node' }],
  });

  const build = new Task({
    name: 'build',
    params: [pathParam],
    workspaces: [workspace],
    needs: [clone],
    steps: [{ name: 'build', image: 'node' }],
  });

  it('auto-discovers tasks from needs graph', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test] });
    expect(pipeline.allTasks).toContain(clone);
    expect(pipeline.allTasks).toContain(test);
    expect(pipeline.allTasks).toHaveLength(2);
  });

  it('deduplicates inferred params by name', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test, build] });
    const params = pipeline.inferParams();
    const names = params.map((p: any) => p.name);
    expect(names.filter((n: string) => n === 'build-path')).toHaveLength(1);
    expect(names).toContain('url');
    expect(names).toContain('revision');
    expect(names).toContain('build-path');
  });

  it('deduplicates inferred workspaces by name', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test, build] });
    const workspaces = pipeline.inferWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect((workspaces[0] as any).name).toBe('workspace');
  });

  it('merges extra params with task-inferred params', () => {
    const extra = new Param({ name: 'extra' });
    const pipeline = new Pipeline({ name: 'ci', tasks: [test], params: [extra] });
    const params = pipeline.inferParams();
    const names = params.map((p: any) => p.name);
    expect(names).toContain('extra');
    expect(names).toContain('url');
  });

  it('names from single trigger', () => {
    const pipeline = new Pipeline({ triggers: [TRIGGER_EVENTS.PUSH], tasks: [test] });
    expect(pipeline.name).toBe('push-pipeline');
  });

  it('throws on duplicate task names', () => {
    const dup = new Task({ name: 'clone', steps: [{ name: 's', image: 'alpine' }] });
    expect(() => {
      const p = new Pipeline({ name: 'bad', tasks: [clone, dup] });
      const app = new App();
      const chart = new Chart(app, 'test');
      p._build(chart, 'pipeline', 'ns');
    }).toThrow(/duplicate task name/);
  });

  it('throws on cycle', () => {
    const a = new Task({ name: 'a', steps: [{ name: 's', image: 'alpine' }] });
    const b = new Task({ name: 'b', needs: [a], steps: [{ name: 's', image: 'alpine' }] });
    // Manually create a cycle by mutating (normally impossible via constructor)
    (a as any).needs = [b];
    expect(() => {
      const p = new Pipeline({ name: 'cycle', tasks: [a, b] });
      const app = new App();
      const chart = new Chart(app, 'test');
      p._build(chart, 'pipeline', 'ns');
    }).toThrow(/cycle/);
  });

  it('_build() produces valid Pipeline resource', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test, build] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'my-ns');
    const manifest = chart.toJson()[0];
    expect(manifest.apiVersion).toBe('tekton.dev/v1');
    expect(manifest.kind).toBe('Pipeline');
    expect(manifest.metadata.name).toBe('ci');
    expect(manifest.metadata.namespace).toBe('my-ns');

    // Tasks should include clone (auto-discovered), test, build
    const taskNames = manifest.spec.tasks.map((t: any) => t.name);
    expect(taskNames).toContain('clone');
    expect(taskNames).toContain('test');
    expect(taskNames).toContain('build');

    // test and build should runAfter clone
    const testTask = manifest.spec.tasks.find((t: any) => t.name === 'test');
    expect(testTask.runAfter).toEqual(['clone']);
    const buildTask = manifest.spec.tasks.find((t: any) => t.name === 'build');
    expect(buildTask.runAfter).toEqual(['clone']);

    // clone should have no runAfter
    const cloneTask = manifest.spec.tasks.find((t: any) => t.name === 'clone');
    expect(cloneTask.runAfter).toBeUndefined();
  });

  it('_build() applies namePrefix', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns', [], 'myapp');
    const manifest = chart.toJson()[0];
    expect(manifest.metadata.name).toBe('myapp-ci');
    // taskRefs should also be prefixed
    const cloneTask = manifest.spec.tasks.find((t: any) => t.name === 'clone');
    expect(cloneTask.taskRef.name).toBe('myapp-clone');
  });

  it('includes finally tasks in inferParams and inferWorkspaces', () => {
    const statusParam = new Param({ name: 'status-param' });
    const statusWorkspace = new Workspace({ name: 'status-ws' });
    const statusTask = new Task({
      name: 'status',
      params: [statusParam],
      workspaces: [statusWorkspace],
      steps: [{ name: 'report', image: 'alpine' }],
    });
    const pipeline = new Pipeline({
      name: 'ci',
      tasks: [test],
      finallyTasks: [statusTask],
    });
    const paramNames = pipeline.inferParams().map((p: any) => p.name);
    expect(paramNames).toContain('status-param');
    expect(paramNames).toContain('url'); // from regular tasks
    const wsNames = pipeline.inferWorkspaces().map((w: any) => w.name);
    expect(wsNames).toContain('status-ws');
    expect(wsNames).toContain('workspace');
  });

  it('_build() produces finally block in Pipeline spec', () => {
    const finalTask = new Task({
      name: 'final',
      steps: [{ name: 'done', image: 'alpine' }],
    });
    const pipeline = new Pipeline({
      name: 'ci',
      tasks: [test],
      finallyTasks: [finalTask],
    });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0];
    expect(manifest.spec.finally).toHaveLength(1);
    expect(manifest.spec.finally[0].name).toBe('final');
    // finally tasks should not have runAfter
    expect(manifest.spec.finally[0].runAfter).toBeUndefined();
  });

  it('tasks without statusReporter do not get runAfter set-status-pending', () => {
    const reporter = new GitHubStatusReporter();
    const reportingTask = new Task({
      name: 'test',
      statusReporter: reporter,
      steps: [{ name: 's', image: 'alpine', onError: 'continue' }],
    });
    const plainTask = new Task({
      name: 'lint',
      steps: [{ name: 's', image: 'alpine' }],
    });
    const pipeline = new Pipeline({ name: 'ci', tasks: [reportingTask, plainTask] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0];
    const lintSpec = manifest.spec.tasks.find((t: any) => t.name === 'lint');
    // lint has no statusReporter — must not depend on set-status-pending
    expect(lintSpec.runAfter).toBeUndefined();
    // reporting task should depend on the pipeline-scoped pending task
    const testSpec = manifest.spec.tasks.find((t: any) => t.name === 'test');
    expect(testSpec.runAfter).toContain('set-status-pending-ci');
  });

  it('pending task name is scoped per pipeline so multi-pipeline projects do not collide', () => {
    const reporter = new GitHubStatusReporter();
    const mk = (name: string) =>
      new Task({ name, statusReporter: reporter, steps: [{ name: 's', image: 'alpine', onError: 'continue' }] });
    // Distinct task instances per pipeline (shared instances can't span pipelines via needs).
    const push = new Pipeline({ name: 'push', tasks: [mk('build'), mk('publish')] });
    const pr = new Pipeline({ name: 'pull-request', tasks: [mk('build')] });
    const nameOf = (p: Pipeline) => {
      const app = new App();
      const chart = new Chart(app, p.name);
      p._build(chart, 'pipeline', 'ns');
      return chart.toJson()[0].spec.tasks.map((t: any) => t.name).find((n: string) => n.startsWith('set-status-pending'));
    };
    expect(nameOf(push)).toBe('set-status-pending-push');
    expect(nameOf(pr)).toBe('set-status-pending-pull-request');
    expect(nameOf(push)).not.toBe(nameOf(pr));
  });

  it('_build() omits finally when no finally tasks', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0];
    expect(manifest.spec.finally).toBeUndefined();
  });

  it('_build() includes extra params', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [test] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns', [{ name: 'project-name', type: 'string' }]);
    const manifest = chart.toJson()[0];
    const paramNames = manifest.spec.params.map((p: any) => p.name);
    expect(paramNames).toContain('project-name');
    expect(paramNames).toContain('url');
  });

  describe('fan-out', () => {
    const buildFanoutPipeline = () => {
      const targets = new Result({ name: 'targets', type: 'array' });
      const detect = new Task({
        name: 'detect',
        results: [targets],
        steps: [{ name: 'd', image: 'alpine' }],
      });
      const service = new Param({ name: 'service' });
      const deploy = new Task({
        name: 'deploy',
        params: [service],
        fanOut: { over: targets, as: service },
        steps: [{ name: 's', image: 'alpine' }],
      });
      return { targets, detect, service, deploy };
    };

    it('excludes the fan-out param from pipeline-level inference', () => {
      const { deploy } = buildFanoutPipeline();
      const pipeline = new Pipeline({ name: 'ci', tasks: [deploy] });
      expect(pipeline.inferParams().map((p: any) => p.name)).not.toContain('service');
    });

    it('auto-discovers the producing task and emits matrix + runAfter', () => {
      const { deploy } = buildFanoutPipeline();
      const pipeline = new Pipeline({ name: 'ci', tasks: [deploy] });
      const app = new App();
      const chart = new Chart(app, 'test');
      pipeline._build(chart, 'pipeline', 'ns');
      const manifest = chart.toJson()[0] as any;

      const deployEntry = manifest.spec.tasks.find((t: any) => t.name === 'deploy');
      expect(deployEntry.matrix).toEqual({
        params: [{ name: 'service', value: '$(tasks.detect.results.targets[*])' }],
      });
      expect(deployEntry.runAfter).toContain('detect');
      // producing task auto-discovered though only reachable via the fan-out edge
      expect(manifest.spec.tasks.map((t: any) => t.name)).toContain('detect');
    });

    it('keeps the matrixed param on the produced Task manifest (synth vs. inference)', () => {
      const { deploy } = buildFanoutPipeline();
      const app = new App();
      const chart = new Chart(app, 't');
      deploy.synth(chart, 'ns');
      const taskManifest = chart.toJson()[0] as any;
      expect(taskManifest.spec.params.map((p: any) => p.name)).toContain('service');
    });
  });
});

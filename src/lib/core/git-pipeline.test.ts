import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { GitPipeline } from './git-pipeline';
import { Task, TaskLike } from './task';
import { Param } from './param';
import { Workspace } from './workspace';
import { TRIGGER_EVENTS } from './trigger-events';

describe('GitPipeline', () => {
  const buildPathParam = new Param({ name: 'build-path', default: './' });

  const makeTask = (name: string, needs: Task[] = []) =>
    new Task({ name, needs, steps: [{ name: 'run', image: 'alpine' }] });

  it('auto-creates a git-clone task', () => {
    const pipeline = new GitPipeline({ name: 'ci', tasks: [makeTask('test')] });
    expect(pipeline.cloneTask.name).toBe('git-clone');
    expect(pipeline.allTasks).toContainEqual(pipeline.cloneTask);
  });

  it('auto-creates a workspace named "workspace" when none provided', () => {
    const pipeline = new GitPipeline({ name: 'ci', tasks: [makeTask('test')] });
    expect(pipeline.workspace.name).toBe('workspace');
  });

  it('uses a provided workspace', () => {
    const ws = new Workspace({ name: 'source' });
    const pipeline = new GitPipeline({ name: 'ci', workspace: ws, tasks: [makeTask('test')] });
    expect(pipeline.workspace).toBe(ws);
    expect(pipeline.cloneTask.workspaces).toContain(ws);
  });

  it('injects workspace into all tasks', () => {
    const ws = new Workspace({ name: 'workspace' });
    const test = makeTask('test');
    const build = makeTask('build', [test]);
    new GitPipeline({ name: 'ci', workspace: ws, tasks: [build] });
    expect(test.workspaces).toContain(ws);
    expect(build.workspaces).toContain(ws);
  });

  it('does not duplicate workspace when task already declares it', () => {
    const ws = new Workspace({ name: 'workspace' });
    const test = new Task({ name: 'test', workspaces: [ws], steps: [{ name: 's', image: 'alpine' }] });
    new GitPipeline({ name: 'ci', workspace: ws, tasks: [test] });
    expect(test.workspaces.filter(w => w.name === 'workspace')).toHaveLength(1);
  });

  it('workspace injection is idempotent across multiple GitPipelines', () => {
    const ws = new Workspace({ name: 'workspace' });
    const test = makeTask('test');
    new GitPipeline({ name: 'push', workspace: ws, tasks: [test] });
    new GitPipeline({ name: 'pr', workspace: ws, tasks: [test] });
    expect(test.workspaces.filter(w => w.name === 'workspace')).toHaveLength(1);
  });

  it('does not mutate task.needs', () => {
    const ws = new Workspace({ name: 'workspace' });
    const test = makeTask('test');
    expect(test.needs).toHaveLength(0);
    new GitPipeline({ name: 'ci', workspace: ws, tasks: [test] });
    expect(test.needs).toHaveLength(0);
  });

  it('_build() adds runAfter git-clone for root tasks', () => {
    const ws = new Workspace({ name: 'workspace' });
    const test = makeTask('test');
    const pipeline = new GitPipeline({ name: 'ci', workspace: ws, tasks: [test] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0];
    const testSpec = manifest.spec.tasks.find((t: any) => t.name === 'test');
    expect(testSpec.runAfter).toEqual(['git-clone']);
  });

  it('_build() does not add runAfter git-clone to clone task itself', () => {
    const ws = new Workspace({ name: 'workspace' });
    const pipeline = new GitPipeline({ name: 'ci', workspace: ws, tasks: [makeTask('test')] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0];
    const cloneSpec = manifest.spec.tasks.find((t: any) => t.name === 'git-clone');
    expect(cloneSpec.runAfter).toBeUndefined();
  });

  it('_build() preserves explicit task.needs for non-root tasks', () => {
    const ws = new Workspace({ name: 'workspace' });
    const test = makeTask('test');
    const build = makeTask('build', [test]);
    const pipeline = new GitPipeline({ name: 'ci', workspace: ws, tasks: [build] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0];
    const buildSpec = manifest.spec.tasks.find((t: any) => t.name === 'build');
    // build should runAfter test only; git-clone is transitively required through test
    expect(buildSpec.runAfter).toEqual(['test']);
    const testSpec = manifest.spec.tasks.find((t: any) => t.name === 'test');
    expect(testSpec.runAfter).toEqual(['git-clone']);
  });

  it('infers url and revision params from the clone task', () => {
    const ws = new Workspace({ name: 'workspace' });
    const pipeline = new GitPipeline({ name: 'ci', workspace: ws, tasks: [makeTask('test')] });
    const paramNames = pipeline.inferParams().map((p: any) => p.name);
    expect(paramNames).toContain('url');
    expect(paramNames).toContain('revision');
  });

  it('uses a custom clone image', () => {
    const pipeline = new GitPipeline({
      name: 'ci',
      cloneImage: 'alpine/git:latest',
      tasks: [makeTask('test')],
    });
    expect(pipeline.cloneTask.steps[0].image).toBe('alpine/git:latest');
  });

  it('includes workspace in inferred pipeline workspaces', () => {
    const ws = new Workspace({ name: 'workspace' });
    const pipeline = new GitPipeline({ name: 'ci', workspace: ws, tasks: [makeTask('test')] });
    const wsNames = pipeline.inferWorkspaces().map((w: any) => w.name);
    expect(wsNames).toContain('workspace');
  });

  it('clone step has workingDir set to workspace path', () => {
    const ws = new Workspace({ name: 'workspace' });
    const pipeline = new GitPipeline({ name: 'ci', workspace: ws, tasks: [makeTask('test')] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline.cloneTask.synth(chart, 'ns');
    const manifest = chart.toJson().find((m: any) => m.kind === 'Task' && m.metadata.name === 'git-clone');
    expect(manifest.spec.steps[0].workingDir).toBe('$(workspaces.workspace.path)');
  });

  it('injects workspace path into task stepTemplate as default workingDir', () => {
    const ws = new Workspace({ name: 'workspace' });
    const test = makeTask('test');
    new GitPipeline({ name: 'ci', workspace: ws, tasks: [test] });
    const app = new App();
    const chart = new Chart(app, 'test');
    test.synth(chart, 'ns');
    const manifest = chart.toJson().find((m: any) => m.kind === 'Task' && m.metadata.name === 'test');
    expect(manifest.spec.stepTemplate.workingDir).toBe('$(workspaces.workspace.path)');
  });

  it('does not overwrite a task stepTemplate workingDir already set', () => {
    const ws = new Workspace({ name: 'workspace' });
    const test = new Task({
      name: 'test',
      stepTemplate: { workingDir: '/custom/path' },
      steps: [{ name: 's', image: 'alpine' }],
    });
    new GitPipeline({ name: 'ci', workspace: ws, tasks: [test] });
    expect((test as any).stepTemplate.workingDir).toBe('/custom/path');
  });

  it('cloneTask declares 8 results', () => {
    const pipeline = new GitPipeline({ name: 'ci', tasks: [makeTask('test')] });
    expect(pipeline.cloneTask.results).toHaveLength(8);
    const names = pipeline.cloneTask.results.map(r => r.name);
    expect(names).toContain('commit');
    expect(names).toContain('short-sha');
    expect(names).toContain('branch');
    expect(names).toContain('commit-message');
    expect(names).toContain('author-name');
    expect(names).toContain('author-email');
    expect(names).toContain('timestamp');
    expect(names).toContain('remote-url');
  });

  it('cloneTask results are bound — toString() produces pipeline reference', () => {
    const pipeline = new GitPipeline({ name: 'ci', tasks: [makeTask('test')] });
    const commit = pipeline.cloneTask.results.find(r => r.name === 'commit')!;
    expect(commit.toString()).toBe('$(tasks.git-clone.results.commit)');
    const shortSha = pipeline.cloneTask.results.find(r => r.name === 'short-sha')!;
    expect(shortSha.toString()).toBe('$(tasks.git-clone.results.short-sha)');
  });

  it('synthesized git-clone Task spec includes results array', () => {
    const ws = new Workspace({ name: 'workspace' });
    const pipeline = new GitPipeline({ name: 'ci', workspace: ws, tasks: [makeTask('test')] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline.cloneTask.synth(chart, 'ns');
    const manifest = chart.toJson().find((m: any) => m.kind === 'Task' && m.metadata.name === 'git-clone');
    expect(manifest.spec.results).toHaveLength(8);
    expect(manifest.spec.results.find((r: any) => r.name === 'commit')).toBeDefined();
  });

  it('clone step script writes to result paths instead of git-metadata.json', () => {
    const pipeline = new GitPipeline({ name: 'ci', tasks: [makeTask('test')] });
    const script = pipeline.cloneTask.steps[0].script!;
    expect(script).toContain('$(results.commit.path)');
    expect(script).toContain('$(results.short-sha.path)');
    expect(script).not.toContain('git-metadata.json');
  });

  it('does not throw or mutate a non-synthesizable TaskLike', () => {
    const stub: TaskLike = {
      name: 'hub-task',
      synthesizable: false,
      needs: [],
      params: [],
      workspaces: [],
      _toPipelineTaskSpec: (runAfter, prefix) => ({
        name: 'hub-task',
        taskRef: { kind: 'Task', name: prefix ? `${prefix}-hub-task` : 'hub-task' },
        ...(runAfter.length > 0 ? { runAfter } : {}),
      }),
    };
    expect(() => new GitPipeline({ name: 'ci', tasks: [stub] })).not.toThrow();
    expect(stub.workspaces).toHaveLength(0);
  });

  it('tasks from multiple GitPipelines sharing the same instance are isolated in runAfter', () => {
    const ws = new Workspace({ name: 'workspace' });
    const shared = makeTask('shared');
    const pushPipeline = new GitPipeline({ name: 'push', workspace: ws, tasks: [shared] });
    const prPipeline = new GitPipeline({ name: 'pr', workspace: ws, tasks: [shared] });

    // Push pipeline build
    const pushApp = new App();
    const pushChart = new Chart(pushApp, 'push');
    pushPipeline._build(pushChart, 'pipeline', 'ns');
    const pushManifest = pushChart.toJson()[0];
    const pushShared = pushManifest.spec.tasks.find((t: any) => t.name === 'shared');
    expect(pushShared.runAfter).toEqual(['git-clone']);

    // PR pipeline build
    const prApp = new App();
    const prChart = new Chart(prApp, 'pr');
    prPipeline._build(prChart, 'pipeline', 'ns');
    const prManifest = prChart.toJson()[0];
    const prShared = prManifest.spec.tasks.find((t: any) => t.name === 'shared');
    expect(prShared.runAfter).toEqual(['git-clone']);
  });
});

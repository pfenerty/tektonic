import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { onChanges } from './changes';
import { Task } from './task';
import { Pipeline } from './pipeline';
import { Workspace } from './workspace';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

describe('onChanges', () => {
  it('compiles to an equals guard on the detection task result', () => {
    const cond = onChanges(['src/**']);
    expect(cond.compile()).toEqual([
      { input: '$(tasks.detect-changes.results.changed)', operator: 'in', values: ['true'] },
    ]);
  });

  it('exposes the detection task as a source for auto-wiring', () => {
    const cond = onChanges(['src/**']);
    expect(cond.sources()).toHaveLength(1);
    expect(cond.sources()[0].name).toBe('detect-changes');
  });

  it('a task gating on it auto-gains the detection task in needs', () => {
    const deploy = new Task({
      name: 'deploy',
      when: onChanges(['src/**', 'package.json']),
      steps: [{ name: 'd', image: 'alpine' }],
    });
    expect(deploy.needs.map(t => t.name)).toContain('detect-changes');
  });

  it('throws on empty paths', () => {
    expect(() => onChanges([])).toThrow(/at least one path/);
  });

  it('honors a custom detection task name', () => {
    const cond = onChanges({ paths: ['docs/**'], name: 'detect-docs' });
    expect(cond.sources()[0].name).toBe('detect-docs');
    expect(cond.compile()).toEqual([
      { input: '$(tasks.detect-docs.results.changed)', operator: 'in', values: ['true'] },
    ]);
  });

  it('synthesizes a detection task declaring diff-base and the changed result, with pathspecs and no shell $()', () => {
    const workspace = new Workspace({ name: 'workspace' });
    const deploy = new Task({
      name: 'deploy',
      workspaces: [workspace],
      when: onChanges({ paths: ['src/**', 'package.json'], workspace }),
      steps: [{ name: 'd', image: 'alpine', workingDir: workspace.path }],
    });
    const pipeline = new Pipeline({ name: 'ci', tasks: [deploy] });
    const app = new App();
    const chart = new Chart(app, 'test');
    // synth the detection task manifest
    const detect = deploy.needs.find(t => t.name === 'detect-changes') as Task;
    detect.synth(chart, 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    // No diff-base param — the base is a trunk branch baked into the script.
    expect(manifest.spec.params).toBeUndefined();
    expect(manifest.spec.results.map((r: AnyObj) => r.name)).toContain('changed');
    const script: string = manifest.spec.steps[0].script;
    expect(script).toContain(":(glob)src/**");
    expect(script).toContain(":(glob)package.json");
    // trunk default + three-dot merge-base diff
    expect(script).toContain('origin "main"');
    expect(script).toContain('FETCH_HEAD...HEAD');
    // the git diff must not be wrapped in shell command substitution — that `$(...)`
    // would collide with Tekton interpolation; a temp file is used instead.
    expect(script).not.toContain('$(git');
    expect(script).toContain('/tmp/tektonic-changed.txt');
  });

  it('supports a custom trunk base branch', () => {
    const cond = onChanges({ paths: ['docs/**'], base: 'develop' });
    const detect = cond.sources()[0] as Task;
    const app = new App();
    const chart = new Chart(app, 'test');
    detect.synth(chart, 'ns');
    const script: string = (chart.toJson()[0] as AnyObj).spec.steps[0].script;
    expect(script).toContain('origin "develop"');
  });

  it('detection task surfaces in a pipeline with no extra pipeline params', () => {
    const deploy = new Task({
      name: 'deploy',
      when: onChanges(['src/**']),
      steps: [{ name: 'd', image: 'alpine' }],
    });
    const pipeline = new Pipeline({ name: 'ci', tasks: [deploy] });
    expect(pipeline.allTasks.map(t => t.name)).toContain('detect-changes');
    // no diff-base (or any) param is introduced by change detection
    expect(pipeline.inferParams().map((p: AnyObj) => p.name)).not.toContain('diff-base');
  });
});

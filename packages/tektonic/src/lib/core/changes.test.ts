import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { onChanges } from './changes';
import { or, onBranch } from './condition';
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

describe('or() of change rules', () => {
  const detectionTasks = (pipeline: Pipeline) =>
    pipeline.allTasks.map(t => t.name).filter(n => n.startsWith('detect-'));

  // CEL guards need the enable-cel-in-whenexpression feature flag, which is off by default —
  // so gating on two path sets used to mean hand-maintaining a third union detection task.
  it('folds into one detection task with a classic guard', () => {
    const go = onChanges({ paths: ['api/**'], name: 'detect-go-changes' });
    const node = onChanges({ paths: ['web/**'], name: 'detect-node-changes' });
    const union = or(go, node);

    const clauses = union.compile();
    expect(clauses).toHaveLength(1);
    expect(clauses[0]).not.toHaveProperty('cel');
    expect(clauses[0]).toMatchObject({ operator: 'in', values: ['true'] });
    expect((clauses[0] as { input: string }).input).toBe(
      '$(tasks.detect-go-node-changes.results.changed)',
    );
  });

  it('unions the pathspecs of every operand', () => {
    const union = or(
      onChanges({ paths: ['api/**', 'go.mod'], name: 'detect-go-changes' }),
      onChanges({ paths: ['web/**', 'api/**'], name: 'detect-node-changes' }),
    );
    const task = union.sources()[0] as Task;
    const app = new App();
    const chart = new Chart(app, 'test');
    task.synth(chart, 'ns');
    const script = (chart.toJson()[0] as AnyObj).spec.steps[0].script as string;
    expect(script).toContain(`':(glob)api/**'`);
    expect(script).toContain(`':(glob)go.mod'`);
    expect(script).toContain(`':(glob)web/**'`);
    // Duplicated paths appear once.
    expect(script.match(/:\(glob\)api\/\*\*/g)).toHaveLength(1);
  });

  it('wires only the union task into the gated task', () => {
    const union = or(
      onChanges({ paths: ['api/**'], name: 'detect-go-changes' }),
      onChanges({ paths: ['web/**'], name: 'detect-node-changes' }),
    );
    const scan = new Task({ name: 'semgrep', when: union, steps: [{ name: 's', image: 'semgrep' }] });
    const pipeline = new Pipeline({ name: 'ci', tasks: [scan] });
    expect(detectionTasks(pipeline)).toEqual(['detect-go-node-changes']);
  });

  it('falls back to CEL when the operands disagree on the base branch', () => {
    const union = or(
      onChanges({ paths: ['api/**'], base: 'main' }),
      onChanges({ paths: ['web/**'], base: 'develop' }),
    );
    expect(union.compile()[0]).toHaveProperty('cel');
  });

  it('falls back to CEL for a mixed or()', () => {
    const union = or(onBranch('main'), onChanges(['api/**']));
    expect(union.compile()[0]).toHaveProperty('cel');
  });

  it('returns a single operand unchanged, with no CEL', () => {
    const single = onChanges(['api/**']);
    expect(or(single)).toBe(single);
  });

  it('keeps the union task name within the Kubernetes limit', () => {
    const long = (i: number) => onChanges({ paths: [`p${i}/**`], name: `detect-${'x'.repeat(20)}${i}-changes` });
    const union = or(long(1), long(2), long(3), long(4));
    const name = (union.sources()[0] as Task).name;
    expect(name.length).toBeLessThanOrEqual(63);
  });
});

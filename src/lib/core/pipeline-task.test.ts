import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { Pipeline } from './pipeline';
import { Task } from './task';
import { gated } from './pipeline-task';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

describe('gated()', () => {
  const clone = new Task({ name: 'clone', steps: [{ name: 'clone', image: 'git' }] });
  const build = new Task({ name: 'build', needs: [clone], steps: [{ name: 'build', image: 'node:22' }] });

  const whenExpr = [{ input: '$(params.event-type)', operator: 'in' as const, values: ['push'] }];

  it('emits when clause in pipeline task spec', () => {
    const gatedBuild = gated(build, { when: whenExpr });
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gatedBuild] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.when).toEqual(whenExpr);
  });

  it('plain tasks have no when clause', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, build] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

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
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.runAfter).toContain('clone');
  });

  it('omits when from spec when overrides.when is empty', () => {
    const gatedBuild = gated(build, { when: [] });
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gatedBuild] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.when).toBeUndefined();
  });

  it('emits retries in pipeline task spec', () => {
    const gatedBuild = gated(build, { retries: 3 });
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gatedBuild] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.retries).toBe(3);
  });

  it('emits timeout in pipeline task spec', () => {
    const gatedBuild = gated(build, { timeout: '30m' });
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, gatedBuild] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.timeout).toBe('30m');
  });

  it('plain tasks have no retries or timeout', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [clone, build] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

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
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    const buildEntry = (manifest.spec.tasks as AnyObj[]).find(t => t.name === 'build');
    expect(buildEntry?.when).toEqual(whenExpr);
    expect(buildEntry?.retries).toBe(2);
    expect(buildEntry?.timeout).toBe('1h');
  });
});

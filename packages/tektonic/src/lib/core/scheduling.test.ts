import { describe, it, expect } from 'vitest';
import { serial, withConcurrency } from './scheduling';
import { Task } from './task';
import { Pipeline } from './pipeline';
import { gated, GatedTask, unwrapGated } from './pipeline-task';
import { synthPipeline } from '../testing';

const mkTasks = (n: number, needs: Task[] = []) =>
  Array.from({ length: n }, (_, i) => new Task({ name: `build-${i}`, needs, steps: [{ name: 's', image: 'buildkit' }] }));

describe('serial', () => {
  it('chains each task behind the previous one', () => {
    const tasks = mkTasks(3);
    const view = synthPipeline(new Pipeline({ name: 'ci', tasks: serial(tasks) }));
    expect(view.runAfter('build-0')).toEqual([]);
    expect(view.runAfter('build-1')).toEqual(['build-0']);
    expect(view.runAfter('build-2')).toEqual(['build-1']);
  });

  it('keeps the needs each task already declares', () => {
    const test = new Task({ name: 'test', steps: [{ name: 's', image: 'go' }] });
    const builds = mkTasks(2, [test]);
    const view = synthPipeline(new Pipeline({ name: 'ci', tasks: [test, ...serial(builds)] }));
    expect(view.runAfter('build-0')).toEqual(['test']);
    expect(view.runAfter('build-1')).toEqual(['test', 'build-0']);
  });

  // The chain is a per-pipeline overlay, so the same instances can run parallel elsewhere.
  it('does not mutate the tasks it chains', () => {
    const tasks = mkTasks(3);
    const chained = serial(tasks);
    expect(tasks.every(t => t.needs.length === 0)).toBe(true);
    const parallel = synthPipeline(new Pipeline({ name: 'other', tasks }));
    expect(parallel.runAfter('build-2')).toEqual([]);
    expect(chained.map(unwrapGated)).toEqual(tasks);
  });

  it('returns a single task unchanged', () => {
    const tasks = mkTasks(1);
    expect(serial(tasks)).toEqual(tasks);
  });
});

describe('withConcurrency', () => {
  it('keeps max lanes running', () => {
    const tasks = mkTasks(5);
    const view = synthPipeline(new Pipeline({ name: 'ci', tasks: withConcurrency(tasks, 2) }));
    expect(view.runAfter('build-0')).toEqual([]);
    expect(view.runAfter('build-1')).toEqual([]);
    expect(view.runAfter('build-2')).toEqual(['build-0']);
    expect(view.runAfter('build-3')).toEqual(['build-1']);
    expect(view.runAfter('build-4')).toEqual(['build-2']);
  });

  it('leaves a list no longer than the limit untouched', () => {
    const tasks = mkTasks(2);
    expect(withConcurrency(tasks, 3)).toEqual(tasks);
    expect(withConcurrency(tasks, 3).some(t => t instanceof GatedTask)).toBe(false);
  });

  it('preserves gated() overrides on a chained task', () => {
    const [a, b] = mkTasks(2);
    const chained = withConcurrency([a, gated(b, { retries: 2 })], 1);
    const view = synthPipeline(new Pipeline({ name: 'ci', tasks: chained }));
    expect(view.task('build-1').retries).toBe(2);
    expect(view.runAfter('build-1')).toEqual(['build-0']);
  });

  it('rejects a non-positive limit', () => {
    expect(() => withConcurrency(mkTasks(2), 0)).toThrow(/positive integer/);
    expect(() => withConcurrency(mkTasks(2), 1.5)).toThrow(/positive integer/);
  });
});

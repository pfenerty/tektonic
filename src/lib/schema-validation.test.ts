/**
 * Schema conformance tests.
 *
 * Validates that synthesized Task and Pipeline manifests contain only fields
 * declared in the official Tekton v1 Swagger schema. This catches cases where
 * an invalid field name (e.g. `resources` instead of `computeResources`) is
 * used on a step — the same class of error that caused the dry-run failure:
 *
 *   .spec.steps[0].resources: field not declared in schema
 *
 * The schema fixture is pinned from the Tekton Pipeline main branch and should
 * be refreshed when upgrading the target Tekton version.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { App, Chart } from 'cdk8s';
import { Task } from './core/task';
import { Pipeline } from './core/pipeline';
import { gated } from './core/pipeline-task';
import { HubTaskRef } from './core/hub-task-ref';
import { Result } from './core/result';
import { Param } from './core/param';
import { Workspace } from './core/workspace';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

let swagger: AnyObj;

beforeAll(() => {
  swagger = JSON.parse(
    readFileSync(join(__dirname, '../__fixtures__/tekton-v1-swagger.json'), 'utf-8'),
  );
});

/** Returns the set of property names declared for a Tekton swagger definition. */
function schemaFields(defName: string): Set<string> {
  const def = swagger.definitions[defName];
  if (!def?.properties) {
    throw new Error(`No properties found for swagger definition: ${defName}`);
  }
  return new Set(Object.keys(def.properties as AnyObj));
}

/**
 * Asserts that every key in `obj` is declared in the swagger definition for
 * `defName`. Fails with a descriptive message listing unknown field names.
 */
function assertNoUnknownFields(obj: AnyObj, defName: string, path: string): void {
  const allowed = schemaFields(defName);
  const unknown = Object.keys(obj).filter(k => !allowed.has(k));
  expect(
    unknown,
    `${path} has field(s) not declared in Tekton v1 schema "${defName}": [${unknown.join(', ')}]`,
  ).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ws = new Workspace({ name: 'src' });
const urlParam = new Param({ name: 'url' });
const revParam = new Param({ name: 'revision' });

// ---------------------------------------------------------------------------
// Task schema tests
// ---------------------------------------------------------------------------

describe('Tekton v1 schema conformance — Task', () => {
  it('step fields on a bare Task conform to v1.Step schema', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    new Task({ name: 'bare', steps: [{ name: 's', image: 'alpine' }] }).synth(chart, 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    for (const step of manifest.spec.steps as AnyObj[]) {
      assertNoUnknownFields(step, 'v1.Step', 'spec.steps[]');
    }
  });

  it('stepTemplate fields conform to v1.StepTemplate schema', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    new Task({ name: 'bare', steps: [{ name: 's', image: 'alpine' }] }).synth(chart, 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    assertNoUnknownFields(manifest.spec.stepTemplate as AnyObj, 'v1.StepTemplate', 'spec.stepTemplate');
  });

  it('TaskSpec fields conform to v1.TaskSpec schema', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    new Task({
      name: 't',
      params: [urlParam, revParam],
      workspaces: [ws],
      steps: [{ name: 's', image: 'alpine' }],
    }).synth(chart, 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    assertNoUnknownFields(manifest.spec as AnyObj, 'v1.TaskSpec', 'spec');
  });

  it('step with per-step computeResources conforms to v1.Step schema', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    new Task({
      name: 'heavy',
      steps: [{
        name: 's',
        image: 'alpine',
        computeResources: { limits: { cpu: '4', memory: '4Gi' } },
      }],
    }).synth(chart, 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    for (const step of manifest.spec.steps as AnyObj[]) {
      assertNoUnknownFields(step, 'v1.Step', 'spec.steps[]');
    }
  });

  it('TaskSpec with results conforms to v1.TaskSpec and v1.TaskResult schema', () => {
    const commit = new Result({ name: 'commit', description: 'Full commit SHA' });
    const branch = new Result({ name: 'branch' });
    const app = new App();
    const chart = new Chart(app, 'test');
    new Task({
      name: 'clone',
      results: [commit, branch],
      steps: [{ name: 's', image: 'alpine' }],
    }).synth(chart, 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    assertNoUnknownFields(manifest.spec as AnyObj, 'v1.TaskSpec', 'spec');
    for (const result of manifest.spec.results as AnyObj[]) {
      assertNoUnknownFields(result, 'v1.TaskResult', 'spec.results[]');
    }
  });

  it('Task with multiple steps all conform to v1.Step schema', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    new Task({
      name: 'multi',
      steps: [
        { name: 'fetch', image: 'alpine', script: 'echo hi', workingDir: '/workspace' },
        { name: 'build', image: 'node:22', command: ['npm', 'run', 'build'] },
        { name: 'test', image: 'node:22', args: ['run', 'test'], onError: 'continue' },
      ],
    }).synth(chart, 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    for (const step of manifest.spec.steps as AnyObj[]) {
      assertNoUnknownFields(step, 'v1.Step', 'spec.steps[]');
    }
  });
});

// ---------------------------------------------------------------------------
// Pipeline schema tests
// ---------------------------------------------------------------------------

describe('Tekton v1 schema conformance — Pipeline', () => {
  const clone = new Task({
    name: 'clone',
    params: [urlParam, revParam],
    workspaces: [ws],
    steps: [{ name: 'clone', image: 'git' }],
  });
  const build = new Task({
    name: 'build',
    workspaces: [ws],
    needs: [clone],
    steps: [{ name: 'build', image: 'node:22' }],
  });

  it('PipelineSpec fields conform to v1.PipelineSpec schema', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [build] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    assertNoUnknownFields(manifest.spec as AnyObj, 'v1.PipelineSpec', 'spec');
  });

  it('pipeline task entries conform to v1.PipelineTask schema', () => {
    const pipeline = new Pipeline({ name: 'ci', tasks: [build] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    for (const task of manifest.spec.tasks as AnyObj[]) {
      assertNoUnknownFields(task, 'v1.PipelineTask', 'spec.tasks[]');
    }
  });

  it('pipeline task with resolver-based taskRef conforms to v1.PipelineTask schema', () => {
    const hubClone = new HubTaskRef({
      taskName: 'git-clone',
      version: '0.9',
      params: [urlParam, revParam],
      workspaces: [ws],
    });
    const build = new Task({
      name: 'build',
      workspaces: [ws],
      needs: [hubClone],
      steps: [{ name: 'build', image: 'node:22' }],
    });
    const pipeline = new Pipeline({ name: 'ci', tasks: [build] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    for (const task of manifest.spec.tasks as AnyObj[]) {
      assertNoUnknownFields(task, 'v1.PipelineTask', 'spec.tasks[]');
    }
  });

  it('pipeline task with when clause conforms to v1.PipelineTask schema', () => {
    const gatedBuild = gated(build, {
      when: [{ input: '$(params.type)', operator: 'in', values: ['push'] }],
    });
    const pipeline = new Pipeline({ name: 'ci', tasks: [gatedBuild] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    for (const task of manifest.spec.tasks as AnyObj[]) {
      assertNoUnknownFields(task, 'v1.PipelineTask', 'spec.tasks[]');
    }
  });

  it('Pipeline with finally tasks conforms to v1.PipelineSpec and v1.PipelineTask schema', () => {
    const report = new Task({ name: 'report', steps: [{ name: 'done', image: 'alpine' }] });
    const pipeline = new Pipeline({ name: 'ci', tasks: [build], finallyTasks: [report] });
    const app = new App();
    const chart = new Chart(app, 'test');
    pipeline._build(chart, 'pipeline', 'ns');
    const manifest = chart.toJson()[0] as AnyObj;

    assertNoUnknownFields(manifest.spec as AnyObj, 'v1.PipelineSpec', 'spec');
    for (const task of manifest.spec.finally as AnyObj[]) {
      assertNoUnknownFields(task, 'v1.PipelineTask', 'spec.finally[]');
    }
  });
});

import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { PAC_PARAMS, PAC_PARAM_BINDINGS, PAC_INJECTED_PARAMS } from './params';
import { Task } from '../../core/task';
import { GitPipeline } from '../../core/git-pipeline';
import { TRIGGER_EVENTS } from '../../core/trigger-events';
import { Workspace } from '../../core/workspace';
import { nu } from '../../script';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

describe('PAC_PARAMS', () => {
  it('renders the Tekton expression when interpolated', () => {
    expect(`${PAC_PARAMS.revision}`).toBe('$(params.revision)');
    expect(`${PAC_PARAMS.repoFullName}`).toBe('$(params.repo-full-name)');
    expect(`${PAC_PARAMS.sourceBranch}`).toBe('$(params.source-branch)');
  });

  it('binds every well-known param to a PAC template variable', () => {
    for (const param of Object.values(PAC_PARAMS)) {
      expect(PAC_PARAM_BINDINGS[param.name]).toMatch(/\{\{.+\}\}/);
    }
  });

  it('declares the handle on a task that uses it', () => {
    const task = new Task({
      name: 'notify',
      params: [PAC_PARAMS.repoFullName],
      steps: [{ name: 's', image: 'alpine', script: nu`log "${PAC_PARAMS.repoFullName}"` }],
    });
    const app = new App();
    const chart = new Chart(app, 'test');
    task.synth(chart, 'ns');
    const spec = (chart.toJson()[0] as AnyObj).spec;
    expect(spec.params.map((p: AnyObj) => p.name)).toContain('repo-full-name');
    expect(spec.steps[0].script).toContain('$(params.repo-full-name)');
  });

  // The project injects these whether or not a task asked, so the PAC bindings always land.
  it('is declared on every emitted pipeline, asked for or not', () => {
    const task = new Task({ name: 'work', steps: [{ name: 's', image: 'alpine' }] });
    const pipeline = new GitPipeline({
      name: 'push',
      trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
      tasks: [task],
    });
    const spec = pipeline._buildSpec(PAC_INJECTED_PARAMS.map(p => p.toSpec()));
    expect((spec.params as AnyObj[]).map(p => p.name)).toEqual(
      expect.arrayContaining(['project-name', 'repo-full-name', 'source-branch']),
    );
  });
});

describe('Workspace.at', () => {
  it('joins segments under the workspace path', () => {
    const ws = new Workspace({ name: 'source' });
    expect(ws.at('.go-mod')).toBe('$(workspaces.source.path)/.go-mod');
    expect(ws.at('a', 'b')).toBe('$(workspaces.source.path)/a/b');
    expect(ws.at('/a/', '/b')).toBe('$(workspaces.source.path)/a/b');
    expect(ws.at('a/b')).toBe('$(workspaces.source.path)/a/b');
    expect(ws.at()).toBe('$(workspaces.source.path)');
    expect(ws.at('.')).toBe('$(workspaces.source.path)');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Pipeline } from '../../core/pipeline';
import { Task } from '../../core/task';
import { TektonicProject } from '../../core/tektonic-project';
import { TRIGGER_EVENTS } from '../../core/trigger-events';
import { TektonTarget, pipelineManifest } from './tekton-target';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tektonic-tekton-target-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const build = () => new Task({ name: 'build', steps: [{ name: 'build', image: 'golang:1.24' }] });
const test = (needs: Task) =>
  new Task({ name: 'test', needs: [needs], steps: [{ name: 'test', image: 'golang:1.24' }] });

const read = (rel: string): string => fs.readFileSync(path.join(tmp, '.tekton', rel), 'utf8');

describe('TektonTarget', () => {
  const project = (opts: Record<string, unknown> = {}) => {
    const b = build();
    return new TektonicProject({
      namespace: 'ci',
      outdir: path.join(tmp, '.tekton'),
      pipelines: [
        new Pipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [b, test(b)] }),
        new Pipeline({ name: 'manual', tasks: [build()] }),
      ],
      targets: [new TektonTarget()],
      ...opts,
    });
  };

  it('emits a standalone Pipeline per pipeline and a Task per unique task', () => {
    project();

    expect(read('push.k8s.yaml')).toContain('kind: Pipeline');
    expect(read('tasks/build.k8s.yaml')).toContain('kind: Task');
    expect(read('tasks/test.k8s.yaml')).toContain('kind: Task');
  });

  // Nothing fires an untriggered pipeline under PAC, so the PAC target skips it — but a
  // `Pipeline` resource is worth applying whether or not an event ever starts it.
  it('emits untriggered pipelines too', () => {
    project();
    expect(read('manual.k8s.yaml')).toContain('name: manual');
  });

  it('emits no PAC annotations, bindings or Repository CR', () => {
    project();
    const pipeline = read('push.k8s.yaml');
    expect(pipeline).not.toContain('pipelinesascode');
    expect(pipeline).not.toContain('{{');
    expect(fs.existsSync(path.join(tmp, '.tekton', 'app-repository.k8s.yaml'))).toBe(false);
  });

  it('reports the files it wrote', () => {
    const model = project().model;
    const files = new TektonTarget().emit(model, path.join(tmp, 'other'));

    expect(files.map(f => f.path)).toEqual([
      'tasks/build.k8s.yaml',
      'tasks/test.k8s.yaml',
      'push.k8s.yaml',
      'manual.k8s.yaml',
    ]);
  });

  it('honours custom pipeline and task subdirectories', () => {
    project({ targets: [new TektonTarget({ pipelineDir: 'pipelines', taskDir: 'tekton-tasks' })] });

    expect(read('pipelines/push.k8s.yaml')).toContain('kind: Pipeline');
    expect(read('tekton-tasks/build.k8s.yaml')).toContain('kind: Task');
  });

  it('applies the project name prefix to emitted resource names', () => {
    project({ name: 'demo' });

    expect(read('demo-push.k8s.yaml')).toContain('name: demo-push');
    expect(read('tasks/build.k8s.yaml')).toContain('name: demo-build');
  });
});

describe('pipelineManifest', () => {
  it('renders one pipeline as a standalone resource', () => {
    const b = build();
    const manifest = pipelineManifest(new Pipeline({ name: 'ci', tasks: [b, test(b)] }), {
      namespace: 'ns',
    }) as any;

    expect(manifest.apiVersion).toBe('tekton.dev/v1');
    expect(manifest.kind).toBe('Pipeline');
    expect(manifest.metadata).toEqual({ name: 'ci', namespace: 'ns' });
    expect(manifest.spec.tasks.map((t: any) => t.name)).toEqual(['build', 'test']);
  });

  it('applies a name prefix and extra params', () => {
    const manifest = pipelineManifest(new Pipeline({ name: 'ci', tasks: [build()] }), {
      namespace: 'ns',
      namePrefix: 'demo',
      extraParams: [{ name: 'build-id', type: 'string' }],
    }) as any;

    expect(manifest.metadata.name).toBe('demo-ci');
    expect(manifest.spec.params.map((p: any) => p.name)).toContain('build-id');
  });
});

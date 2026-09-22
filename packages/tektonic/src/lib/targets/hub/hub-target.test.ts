import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitPipeline } from '../../core/git-pipeline';
import { HubTaskRef } from '../../core/hub-task-ref';
import { Param } from '../../core/param';
import { Pipeline } from '../../core/pipeline';
import { Result } from '../../core/result';
import { Task } from '../../core/task';
import { TektonicProject } from '../../core/tektonic-project';
import { TRIGGER_EVENTS } from '../../core/trigger-events';
import { Workspace } from '../../core/workspace';
import type { CatalogMetadata } from '../../core/catalog';
import { PacTarget } from '../pac/pac-target';
import { HubTarget, registryOf } from './hub-target';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tektonic-hub-target-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const outdir = (): string => path.join(tmp, 'catalog');
const read = (rel: string): string => fs.readFileSync(path.join(outdir(), rel), 'utf8');
const exists = (rel: string): boolean => fs.existsSync(path.join(outdir(), rel));

const catalog: CatalogMetadata = {
  version: '0.1',
  description: 'Says hello, loudly.',
  displayName: 'Greeter',
  categories: ['Developer Tools'],
  tags: ['hello', 'demo'],
};

const greetParam = new Param({ name: 'who', description: 'Name to greet', default: 'world' });

const greeter = (over: Partial<CatalogMetadata> = {}, params: Param[] = [greetParam]) =>
  new Task({
    name: 'greet',
    catalog: { ...catalog, ...over },
    params,
    results: [new Result({ name: 'greeting', description: 'What was said' })],
    steps: [{ name: 'greet', image: 'docker.io/alpine:3.20', script: 'echo hi' }],
  });

const project = (tasks: Task[], targets = [new HubTarget()], opts: Record<string, unknown> = {}) =>
  new TektonicProject({
    namespace: 'ci',
    outdir: outdir(),
    pipelines: [new Pipeline({ name: 'push', trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks })],
    targets,
    ...opts,
  });

describe('HubTarget', () => {
  it('writes task/<name>/<version>/<name>.yaml plus a README', () => {
    project([greeter()]);

    expect(exists('task/greet/0.1/greet.yaml')).toBe(true);
    expect(exists('task/greet/0.1/README.md')).toBe(true);
  });

  it('emits a standalone Task: no namespace, no project prefix, no PAC annotations', () => {
    project([greeter()], [new PacTarget(), new HubTarget()], { name: 'demo' });

    const entry = read('task/greet/0.1/greet.yaml');
    expect(entry).toContain('kind: Task');
    expect(entry).toContain('name: greet');
    expect(entry).not.toContain('namespace:');
    expect(entry).not.toContain('demo-greet');
    expect(entry).not.toContain('pipelinesascode');
  });

  it('carries the catalog metadata as annotations, a label and spec.description', () => {
    project([greeter()]);

    const entry = read('task/greet/0.1/greet.yaml');
    expect(entry).toContain('app.kubernetes.io/version: "0.1"');
    expect(entry).toContain('tekton.dev/displayName: Greeter');
    expect(entry).toContain('tekton.dev/categories: Developer Tools');
    expect(entry).toContain('tekton.dev/tags: hello,demo');
    expect(entry).toContain('tekton.dev/platforms: linux/amd64');
    expect(entry).toContain('tekton.dev/pipelines.minVersion: 0.44.0');
    expect(entry).toContain('description: Says hello, loudly.');
  });

  it('keeps the task’s own annotations while dropping PAC ones', () => {
    const task = new Task({
      name: 'greet',
      catalog,
      params: [greetParam],
      annotations: {
        'chains.tekton.dev/transparency-upload': 'true',
        'pipelinesascode.tekton.dev/task': '[.tekton/tasks/greet.k8s.yaml]',
      },
      steps: [{ name: 'greet', image: 'docker.io/alpine:3.20', script: 'echo hi' }],
    });
    project([task]);

    const entry = read('task/greet/0.1/greet.yaml');
    expect(entry).toContain('chains.tekton.dev/transparency-upload');
    expect(entry).not.toContain('pipelinesascode');
  });

  it('publishes only the tasks that declare catalog metadata', () => {
    const plain = new Task({ name: 'build', steps: [{ name: 'build', image: 'docker.io/alpine:3.20' }] });
    project([greeter(), plain]);

    expect(exists('task/greet/0.1/greet.yaml')).toBe(true);
    expect(exists('task/build')).toBe(false);
  });

  it('warns rather than writing nothing silently when no task is publishable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    project([new Task({ name: 'build', steps: [{ name: 'build', image: 'docker.io/alpine:3.20' }] })]);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no task in this project declares"));
    expect(exists('task')).toBe(false);
  });

  it('honours taskDir and readme: false', () => {
    project([greeter()], [new HubTarget({ taskDir: 'tasks', readme: false })]);

    expect(exists('tasks/greet/0.1/greet.yaml')).toBe(true);
    expect(exists('tasks/greet/0.1/README.md')).toBe(false);
  });

  describe('synth-time validation', () => {
    const fails = (task: Task, fragment: string, targets = [new HubTarget()]) =>
      expect(() => project([task], targets)).toThrow(fragment);

    it('rejects a param with no description', () => {
      fails(greeter({}, [new Param({ name: 'who' })]), "param 'who' has no description");
    });

    it('rejects a result with no description', () => {
      const task = new Task({
        name: 'greet',
        catalog,
        params: [greetParam],
        results: [new Result({ name: 'greeting' })],
        steps: [{ name: 'greet', image: 'docker.io/alpine:3.20' }],
      });
      fails(task, "result 'greeting' has no description");
    });

    it('rejects an image a consumer cannot pull anonymously', () => {
      const task = new Task({
        name: 'greet',
        catalog,
        params: [greetParam],
        steps: [{ name: 'greet', image: 'registry.internal.example.com/ci/base:1' }],
      });
      fails(task, 'registry.internal.example.com');
    });

    it('accepts a private registry the target was told to allow', () => {
      const task = new Task({
        name: 'greet',
        catalog,
        params: [greetParam],
        steps: [{ name: 'greet', image: 'registry.internal.example.com/ci/base:1' }],
      });
      project([task], [new HubTarget({ allowedRegistries: ['registry.internal.example.com'] })]);
      expect(exists('task/greet/0.1/greet.yaml')).toBe(true);
    });

    it('accepts a param-driven image, which is the consumer’s choice', () => {
      const image = new Param({ name: 'image', description: 'Image to run in' });
      const task = new Task({
        name: 'greet',
        catalog,
        params: [image],
        steps: [{ name: 'greet', image: `${image}` }],
      });
      project([task]);
      expect(exists('task/greet/0.1/greet.yaml')).toBe(true);
    });

    it('rejects an unknown category and a malformed version', () => {
      fails(greeter({ categories: ['Bagels' as never] }), "category 'Bagels'");
      fails(greeter({ version: 'v0.1' }), "version 'v0.1' is not a catalog version");
      fails(greeter({ minPipelinesVersion: 'latest' }), "minPipelinesVersion 'latest'");
      fails(greeter({ description: '  ' }), 'description is empty');
    });

    it('reports every problem with an entry at once', () => {
      const task = new Task({
        name: 'greet',
        catalog: { ...catalog, version: 'v1' },
        params: [new Param({ name: 'who' })],
        steps: [{ name: 'greet', image: 'docker.io/alpine:3.20' }],
      });
      let message = '';
      try {
        project([task]);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("version 'v1'");
      expect(message).toContain("param 'who'");
    });
  });

  // The validation gate from tektonic-46j.7: tektonic's own git-clone task, published as a
  // catalog entry and consumed back through the read side.
  describe('round trip with HubTaskRef', () => {
    const publishGitClone = (): string => {
      const pipeline = new GitPipeline({
        name: 'push',
        trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
        cloneCatalog: {
          version: '0.1',
          description: 'Clones a git repository onto a workspace and reports its metadata.',
          categories: ['Git'],
          tags: ['git', 'clone'],
        },
        tasks: [new Task({ name: 'test', steps: [{ name: 'test', image: 'docker.io/node:24-alpine' }] })],
      });
      new TektonicProject({ namespace: 'ci', outdir: outdir(), pipelines: [pipeline], targets: [new HubTarget()] });
      return read('task/git-clone/0.1/git-clone.yaml');
    };

    it('publishes git-clone as a catalog entry a scratch project can reference', () => {
      const entry = publishGitClone();
      expect(entry).toContain('name: git-clone');
      expect(entry).toContain('description: Clones a git repository onto a workspace');
      // Public by construction: the injected clone step resolves to tektonic's neutral default.
      expect(entry).toContain('docker.io/alpine/git');

      // The consumer side, in a project that shares nothing with the publisher but the names.
      const ref = new HubTaskRef({
        taskName: 'git-clone',
        version: '0.1',
        params: [
          new Param({ name: 'url', description: 'Repository URL to clone from' }),
          new Param({ name: 'revision', description: 'Branch, tag or revision to check out' }),
        ],
        workspaces: [new Workspace({ name: 'workspace' })],
      });
      const spec = ref._toPipelineTaskSpec([]);
      expect(spec.taskRef).toEqual({
        resolver: 'hub',
        params: [
          { name: 'catalog', value: 'tekton' },
          { name: 'name', value: 'git-clone' },
          { name: 'version', value: '0.1' },
        ],
      });

      // Every param and workspace the consumer binds is one the published entry declares.
      for (const name of ['url', 'revision']) expect(entry).toContain(`name: ${name}`);
      expect(entry).toContain('name: workspace');
    });

    it('generates a README from the published task’s own params, results and workspaces', () => {
      publishGitClone();
      const readme = read('task/git-clone/0.1/README.md');

      expect(readme).toContain('# git-clone');
      expect(readme).toContain('Clones a git repository onto a workspace');
      expect(readme).toContain('| `url` | `string` | Repository URL to clone from | — |');
      expect(readme).toContain('| `commit` | `string` | Full commit SHA |');
      expect(readme).toContain('| `workspace` | no | — |');
      expect(readme).toContain("new HubTaskRef({ catalog: 'tekton', taskName: 'git-clone', version: '0.1' })");
    });
  });
});

describe('registryOf', () => {
  it('reads the registry off a reference the way the OCI grammar does', () => {
    expect(registryOf('alpine:3')).toBe('docker.io');
    expect(registryOf('library/alpine:3')).toBe('docker.io');
    expect(registryOf('docker.io/alpine/git:latest')).toBe('docker.io');
    expect(registryOf('ghcr.io/acme/base:1')).toBe('ghcr.io');
    expect(registryOf('localhost:5000/base:1')).toBe('localhost:5000');
  });
});

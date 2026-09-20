import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { Task } from './task';
import { Workspace } from './workspace';
import type { BackendCtx, CacheBackend } from './cache-backend';
import type { TaskCacheSpec, TaskStepSpec } from './task';
import { gcs, DEFAULT_GCS_CACHE_IMAGE } from '../cache/gcs-backend';
import { DEFAULT_BASE_IMAGE } from '../constants';

/**
 * The worked example from docs/cache-backends.md, kept here so the documented
 * contract has to keep compiling. `image` is the backend's own default, which is
 * the seam that keeps provider images out of {@link BackendCtx}.
 */
const DEFAULT_S3_CACHE_IMAGE = 'ghcr.io/example/aws-cli:stable';

class S3Backend implements CacheBackend {
  readonly type = 's3';
  readonly needsPvcWorkspace = false;
  /** Every ctx this backend was handed, for assertions about the contract. */
  readonly seen: BackendCtx[] = [];

  constructor(private readonly opts: { bucket: string; image?: string }) {}

  restoreStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
    this.seen.push(ctx);
    return {
      name: `restore-${spec.name}-cache`,
      image: this._image(spec, ctx),
      script: `#!/bin/sh\necho "[s3] restore ${spec.name} from ${this.opts.bucket} for ${ctx.taskName}"`,
    };
  }

  saveStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
    this.seen.push(ctx);
    return {
      name: `save-${spec.name}-cache`,
      image: this._image(spec, ctx),
      script: `#!/bin/sh\necho "[s3] save ${spec.name} to ${this.opts.bucket} for ${ctx.taskName}"`,
      onError: 'continue',
    };
  }

  private _image(spec: TaskCacheSpec, ctx: BackendCtx): string {
    // A backend with no default of its own would end this chain at `ctx.defaultImage`.
    void ctx;
    return spec.image ?? this.opts.image ?? DEFAULT_S3_CACHE_IMAGE;
  }
}

/** A backend with no image default of its own, so it falls through to the ctx. */
class BareBackend implements CacheBackend {
  readonly type = 'bare';
  readonly needsPvcWorkspace = false;

  restoreStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
    return { name: `restore-${spec.name}-cache`, image: spec.image ?? ctx.defaultImage, script: '#!/bin/sh\ntrue' };
  }

  saveStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
    return { name: `save-${spec.name}-cache`, image: spec.image ?? ctx.defaultImage, script: '#!/bin/sh\ntrue', onError: 'continue' };
  }
}

const steps = (t: Task): any[] => {
  const chart = new Chart(new App(), 'test');
  t.synth(chart, 'ns');
  return (chart.toJson()[0] as any).spec.steps;
};

const cacheSpec = (backend: CacheBackend, extra: Partial<TaskCacheSpec> = {}): TaskCacheSpec => ({
  name: 'npm',
  key: ['package-lock.json'],
  paths: ['node_modules'],
  backend,
  ...extra,
});

const taskWith = (backend: CacheBackend, extra: Partial<TaskCacheSpec> = {}, name = 'build'): Task =>
  new Task({ name, steps: [{ name: 's', image: 'alpine' }], caches: [cacheSpec(backend, extra)] });

describe('BackendCtx', () => {
  it('carries nothing provider-specific — only the task name and a fallback image', () => {
    const backend = new S3Backend({ bucket: 'ci-cache' });
    steps(taskWith(backend));

    expect(backend.seen.length).toBeGreaterThan(0);
    for (const ctx of backend.seen) {
      expect(Object.keys(ctx).sort()).toEqual(['defaultImage', 'taskName']);
      expect(JSON.stringify(ctx)).not.toMatch(/gcs|gcloud|s3/i);
    }
  });

  it('names the task the cache belongs to', () => {
    const backend = new S3Backend({ bucket: 'ci-cache' });
    steps(taskWith(backend, {}, 'compile'));
    expect(backend.seen.map((c) => c.taskName)).toEqual(['compile', 'compile']);
  });

  it('names the source task for a finally save pod, not the generated one', () => {
    const backend = new S3Backend({ bucket: 'ci-cache' });
    const t = taskWith(backend, { saveStrategy: 'finally' }, 'compile');
    const finallyTasks = t.getCacheFinallyTasks();
    expect(finallyTasks).toHaveLength(1);
    expect(finallyTasks[0].name).toBe('save-npm-cache-compile');
    expect(backend.seen.map((c) => c.taskName)).toEqual(['compile']);
  });
});

describe('cache step image resolution', () => {
  it('prefers spec.image over the backend default', () => {
    const rendered = steps(taskWith(new S3Backend({ bucket: 'b', image: 'backend-image' }), { image: 'spec-image' }));
    expect(rendered.find((s) => s.name === 'restore-npm-cache').image).toBe('spec-image');
    expect(rendered.find((s) => s.name === 'save-npm-cache').image).toBe('spec-image');
  });

  it('prefers the backend default over ctx.defaultImage', () => {
    const rendered = steps(taskWith(new S3Backend({ bucket: 'b' })));
    expect(rendered.find((s) => s.name === 'restore-npm-cache').image).toBe(DEFAULT_S3_CACHE_IMAGE);
  });

  it('falls back to ctx.defaultImage when neither names an image', () => {
    const rendered = steps(taskWith(new BareBackend()));
    expect(rendered.find((s) => s.name === 'restore-npm-cache').image).toBe(DEFAULT_BASE_IMAGE);
    expect(rendered.find((s) => s.name === 'save-npm-cache').image).toBe(DEFAULT_BASE_IMAGE);
  });
});

describe('GcsBackend image default', () => {
  it('owns DEFAULT_GCS_CACHE_IMAGE rather than reading it off the ctx', () => {
    const rendered = steps(taskWith(gcs({ bucket: 'my-ci-cache' }), { compress: true }));
    expect(rendered.find((s) => s.name === 'restore-npm-cache').image).toBe(DEFAULT_GCS_CACHE_IMAGE);
    expect(rendered.find((s) => s.name === 'save-npm-cache').image).toBe(DEFAULT_GCS_CACHE_IMAGE);
  });

  it('is overridable per backend instance', () => {
    const backend = gcs({ bucket: 'my-ci-cache', image: 'ghcr.io/example/gcloud:pinned' });
    expect(backend.image).toBe('ghcr.io/example/gcloud:pinned');
    const rendered = steps(taskWith(backend, { compress: true }));
    expect(rendered.find((s) => s.name === 'restore-npm-cache').image).toBe('ghcr.io/example/gcloud:pinned');
  });

  it('still yields to spec.image', () => {
    const backend = gcs({ bucket: 'my-ci-cache', image: 'ghcr.io/example/gcloud:pinned' });
    const rendered = steps(taskWith(backend, { compress: true, image: 'spec-image' }));
    expect(rendered.find((s) => s.name === 'restore-npm-cache').image).toBe('spec-image');
  });
});

describe('a backend that needs a PVC workspace', () => {
  it('is unaffected by the ctx reshape — the workspace still auto-registers', () => {
    const ws = new Workspace({ name: 'npm-cache' });
    const t = new Task({
      name: 'build',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'], workspace: ws }],
    });
    expect(t.workspaces.map((w) => w.name)).toContain('npm-cache');
  });
});

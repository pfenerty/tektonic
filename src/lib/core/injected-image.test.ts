import { describe, it, expect } from 'vitest';
import { Task } from './task';
import { Workspace } from './workspace';
import { Pipeline } from './pipeline';
import { GitPipeline } from './git-pipeline';
import { onChanges } from './changes';
import { gcs, DEFAULT_GCS_CACHE_IMAGE } from '../cache/gcs-backend';
import { GitHubStatusReporter } from '../reporters/github-status-reporter';
import { DEFAULT_BASE_IMAGE } from '../constants';
import { synthTask, synthTasks } from '../testing';
import {
  DEFAULT_INJECTED_STEP_IMAGE,
  injectedImageRef,
  injectedImageRequirements,
} from './injected-image';

/** A project image trusted for every capability, as a bare string is. */
const PROJECT_IMAGE = 'ghcr.io/example/ci-base:test';

const workspace = new Workspace({ name: 'workspace' });
const cacheWs = new Workspace({ name: 'cache' });

const npmCache = (extra: Record<string, unknown> = {}) => ({
  name: 'npm',
  key: ['package-lock.json'],
  paths: ['node_modules'],
  workspace: cacheWs,
  ...extra,
});

describe('injectedImageRef', () => {
  it('round-trips the capabilities it declares', () => {
    expect(injectedImageRequirements(injectedImageRef('nushell', 'zstd'))).toEqual(['nushell', 'zstd']);
  });

  it('requires only sh when given nothing', () => {
    expect(injectedImageRequirements(injectedImageRef())).toEqual(['sh']);
  });

  it('is not confused with an ordinary image reference', () => {
    expect(injectedImageRequirements('alpine:3.22')).toBeUndefined();
    expect(injectedImageRequirements(DEFAULT_BASE_IMAGE)).toBeUndefined();
  });

  it('orders capabilities canonically, so two equal requirements render identically', () => {
    expect(injectedImageRef('zstd', 'nushell')).toBe(injectedImageRef('nushell', 'zstd'));
  });
});

describe('the library fallback', () => {
  it('pulls from no particular author’s registry', () => {
    expect(DEFAULT_INJECTED_STEP_IMAGE.image).not.toContain('ghcr.io/pfenerty');
  });

  it('is what an injected step resolves to when the project names no image', () => {
    const view = synthTask(new Task({ name: 'c', steps: [{ name: 's', image: 'alpine' }], caches: [npmCache()] }));
    expect(view.step('restore-npm-cache').image).toBe(DEFAULT_INJECTED_STEP_IMAGE.image);
  });

  it('reaches the git-clone step of a GitPipeline', () => {
    const pipeline = new GitPipeline({
      name: 'ci',
      tasks: [new Task({ name: 'build', steps: [{ name: 's', image: 'alpine' }] })],
    });
    const clone = synthTasks(pipeline)['git-clone'];
    expect(clone.step('clone').image).toBe(DEFAULT_INJECTED_STEP_IMAGE.image);
  });

  it('reaches an onChanges detection task', () => {
    const detect = onChanges({ paths: ['src/**'], workspace }).sources()[0] as Task;
    expect(synthTask(detect).step('detect').image).toBe(DEFAULT_INJECTED_STEP_IMAGE.image);
  });

  it('leaves no marker behind in the manifest', () => {
    const view = synthTask(new Task({ name: 'c', steps: [{ name: 's', image: 'alpine' }], caches: [npmCache()] }));
    expect(JSON.stringify(view.manifest)).not.toContain('tektonic.internal');
  });
});

describe('resolution order', () => {
  it("project injectedStepImage beats the library fallback", () => {
    const view = synthTask(
      new Task({ name: 'c', steps: [{ name: 's', image: 'alpine' }], caches: [npmCache()] }),
      { injectedStepImage: PROJECT_IMAGE },
    );
    expect(view.step('restore-npm-cache').image).toBe(PROJECT_IMAGE);
  });

  it('a component default beats the project image', () => {
    const reporter = new GitHubStatusReporter({ image: 'ghcr.io/example/reporter:1' });
    const view = synthTask(
      new Task({ name: 'c', statusReporter: reporter, statusContext: 'ci/c', steps: [{ name: 's', image: 'alpine' }] }),
      { injectedStepImage: PROJECT_IMAGE },
    );
    expect(view.step('report-status').image).toBe('ghcr.io/example/reporter:1');
  });

  it('a per-step image beats both', () => {
    const view = synthTask(
      new Task({
        name: 'c',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [npmCache({ image: 'ghcr.io/example/cache:1' })],
      }),
      { injectedStepImage: PROJECT_IMAGE },
    );
    expect(view.step('restore-npm-cache').image).toBe('ghcr.io/example/cache:1');
  });

  it('GitPipeline.cloneImage beats the project image', () => {
    const pipeline = new GitPipeline({
      name: 'ci',
      cloneImage: 'ghcr.io/example/git:1',
      tasks: [new Task({ name: 'build', steps: [{ name: 's', image: 'alpine' }] })],
    });
    const clone = synthTasks(pipeline, { injectedStepImage: PROJECT_IMAGE })['git-clone'];
    expect(clone.step('clone').image).toBe('ghcr.io/example/git:1');
  });

  it('a user step is never touched', () => {
    const view = synthTask(
      new Task({ name: 'c', steps: [{ name: 's', image: 'alpine:3.22' }] }),
      { injectedStepImage: PROJECT_IMAGE },
    );
    expect(view.step('s').image).toBe('alpine:3.22');
  });
});

describe('capability checking', () => {
  const compressed = new Task({
    name: 'c',
    steps: [{ name: 's', image: 'alpine' }],
    caches: [npmCache({ compress: true })],
  });

  it('fails at synth time, naming the capability, rather than at pod-run time', () => {
    expect(() => synthTask(compressed)).toThrow(
      /step 'restore-npm-cache': this injected step needs an image providing nushell, tar, zstd/,
    );
  });

  it('names the way back: DEFAULT_BASE_IMAGE is one image that has them', () => {
    expect(() => synthTask(compressed)).toThrow(/DEFAULT_BASE_IMAGE/);
    expect(() => synthTask(compressed, { injectedStepImage: DEFAULT_BASE_IMAGE })).not.toThrow();
  });

  it('takes a bare string at its word — synthesis never probes a registry', () => {
    expect(() => synthTask(compressed, { injectedStepImage: PROJECT_IMAGE })).not.toThrow();
  });

  it('checks a declared image against what the step asked for', () => {
    expect(() =>
      synthTask(compressed, { injectedStepImage: { image: PROJECT_IMAGE, provides: ['sh', 'git'] } }),
    ).toThrow(/providing nushell, tar, zstd/);
    expect(() =>
      synthTask(compressed, {
        injectedStepImage: { image: PROJECT_IMAGE, provides: ['sh', 'nushell', 'tar', 'zstd'] },
      }),
    ).not.toThrow();
  });

  it('lets an uncompressed cache through on the sh-only fallback', () => {
    expect(() =>
      synthTask(new Task({ name: 'c', steps: [{ name: 's', image: 'alpine' }], caches: [npmCache()] })),
    ).not.toThrow();
  });

  it('holds the built-in status reporter to nushell', () => {
    const reporting = new Task({
      name: 'c',
      statusReporter: new GitHubStatusReporter(),
      statusContext: 'ci/c',
      steps: [{ name: 's', image: 'alpine' }],
    });
    expect(() => synthTask(reporting)).toThrow(/needs an image providing nushell/);
    expect(() => synthTask(reporting, { injectedStepImage: DEFAULT_BASE_IMAGE })).not.toThrow();
  });

  it('holds a GCS cache to gcloud, and DEFAULT_GCS_CACHE_IMAGE satisfies it', () => {
    const task = new Task({
      name: 'c',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [npmCache({ compress: true, backend: gcs({ bucket: 'b' }) })],
    });
    expect(() => synthTask(task, { injectedStepImage: { image: PROJECT_IMAGE, provides: ['nushell', 'tar', 'zstd'] } }))
      .toThrow(/providing gcloud/);
    expect(() =>
      synthTask(
        new Task({
          name: 'c2',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [npmCache({ compress: true, backend: gcs({ bucket: 'b', image: DEFAULT_GCS_CACHE_IMAGE }) })],
        }),
      ),
    ).not.toThrow();
  });

  it('checks a cache saved in a finally task too', () => {
    const task = new Task({
      name: 'c',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [npmCache({ compress: true, saveStrategy: 'finally' as const })],
    });
    const [finallyTask] = task.getCacheFinallyTasks();
    expect(() => synthTask(finallyTask)).toThrow(/providing nushell, tar, zstd/);
    expect(() => synthTask(finallyTask, { injectedStepImage: PROJECT_IMAGE })).not.toThrow();
  });
});

describe('a plain Pipeline of user tasks', () => {
  it('needs no injected-step image at all', () => {
    const pipeline = new Pipeline({
      name: 'ci',
      tasks: [new Task({ name: 'build', steps: [{ name: 's', image: 'alpine' }] })],
    });
    expect(() => synthTasks(pipeline)).not.toThrow();
  });
});

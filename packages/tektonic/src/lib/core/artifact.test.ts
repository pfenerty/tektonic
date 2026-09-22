import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TaskArtifact,
  WorkspaceArtifactStore,
  artifactStoreCtx,
  ARTIFACT_DIR,
  type ArtifactStore,
  type ArtifactStoreCtx,
} from './artifact';
import { Task } from './task';
import type { TaskStepSpec } from './task';
import { Workspace } from './workspace';
import { Pipeline } from './pipeline';
import { defineAction } from './action';
import { injectedImageRequirements } from './injected-image';
import { TestStatusReporter } from '../../__fixtures__/reporter';
import { synthTask } from '../testing';
import { sh } from '../script';

const ws = () => new Workspace({ name: 'source' });

const step = (name: string, script = sh`true`): TaskStepSpec => ({
  name,
  image: 'alpine',
  script,
});

const compile = defineAction<void, 'bundle'>({
  name: 'compile',
  image: 'ghcr.io/example/node:24',
  outputs: { bundle: 'app.tar' },
  steps: ({ name, outputs }) => [{ name, script: sh`tar cf ${outputs.bundle} dist` }],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TaskArtifact', () => {
  it('is reached through its producing task and stringifies to the consumer path', () => {
    const source = ws();
    const build = new Task({
      name: 'build',
      workspaces: [source],
      steps: [step('compile')],
      produces: { dist: 'target/app.tar' },
    });

    const dist = build.artifacts.dist;
    expect(dist).toBeInstanceOf(TaskArtifact);
    expect(dist.name).toBe('dist');
    expect(dist.producer).toBe(build);
    expect(dist.producerName).toBe('build');
    expect(dist.path).toBe(source.at(ARTIFACT_DIR, 'build', 'dist', 'app.tar'));
    // The whole point of the handle: a step body interpolates it and never names the layout.
    expect(`${dist}`).toBe(dist.path);
    expect(dist.path).not.toBe(dist.sourcePath);
  });

  it('keys the storage path by producing task, so a subtree has exactly one writer', () => {
    const source = ws();
    const a = new Task({ name: 'a', workspaces: [source], steps: [step('s')], produces: { report: 'out/r.xml' } });
    const b = new Task({ name: 'b', workspaces: [source], steps: [step('s')], produces: { report: 'out/r.xml' } });
    expect(a.artifacts.report.path).toBe(source.at(ARTIFACT_DIR, 'a', 'report', 'r.xml'));
    expect(b.artifacts.report.path).toBe(source.at(ARTIFACT_DIR, 'b', 'report', 'r.xml'));
    expect(a.artifacts.report.path).not.toBe(b.artifacts.report.path);
  });

  it('promotes an action output through toArtifact(), keeping the file name', () => {
    const source = ws();
    const build = compile();
    const task = new Task({
      name: 'build',
      workspaces: [source],
      steps: [build],
      produces: { dist: build.outputs.bundle.toArtifact() },
    });

    const dist = task.artifacts.dist;
    expect(dist.sourcePath).toBe(build.outputs.bundle.path);
    expect(dist.fileName).toBe('app.tar');
    expect(dist.action).toBe('compile');
    // The copy runs in the image that wrote the file — the one the pod already pulled.
    expect(dist.publishImage).toBe('ghcr.io/example/node:24');
    expect(dist.path).toBe(source.at(ARTIFACT_DIR, 'build', 'dist', 'app.tar'));
  });

  it('rejects promoting an output of an action the task does not compose', () => {
    const stray = compile({}, { name: 'elsewhere' });
    expect(
      () =>
        new Task({
          name: 'build',
          workspaces: [ws()],
          steps: [step('s')],
          produces: { dist: stray.outputs.bundle.toArtifact() },
        }),
    ).toThrow(/action 'elsewhere', which this task does not compose/);
  });

  it('rejects an artifact name that is not a DNS label, since step names derive from it', () => {
    expect(
      () =>
        new Task({
          name: 'build',
          workspaces: [ws()],
          steps: [step('s')],
          produces: { 'Dist Bundle': 'out/x' },
        }),
    ).toThrow(/not a DNS label/);
  });
});

describe('resolving the artifact workspace', () => {
  it('defaults to the task’s only workspace', () => {
    const source = ws();
    const build = new Task({
      name: 'build',
      workspaces: [source],
      steps: [step('s')],
      produces: { dist: 'out/app.tar' },
    });
    expect(build.artifacts.dist.workspace).toBe(source);
  });

  it('refuses to guess when the task declares more than one', () => {
    expect(
      () =>
        new Task({
          name: 'build',
          workspaces: [ws(), new Workspace({ name: 'cache' })],
          steps: [step('s')],
          produces: { dist: 'out/app.tar' },
        }),
    ).toThrow(/'produces' is ambiguous .*\(source, cache\).*artifactWorkspace/s);
  });

  it('takes an explicit artifactWorkspace', () => {
    const source = ws();
    const shared = new Workspace({ name: 'shared' });
    const build = new Task({
      name: 'build',
      workspaces: [source, shared],
      steps: [step('s')],
      artifactWorkspace: shared,
      produces: { dist: 'out/app.tar' },
    });
    expect(build.artifacts.dist.workspace).toBe(shared);
    expect(build.artifacts.dist.path).toBe(shared.at(ARTIFACT_DIR, 'build', 'dist', 'app.tar'));
  });

  it('says what is missing when the task has no workspace at all', () => {
    expect(
      () => new Task({ name: 'build', steps: [step('s')], produces: { dist: 'out/app.tar' } }),
    ).toThrow(/needs a workspace to publish onto/);
  });
});

describe('a consuming task', () => {
  it('auto-mounts the workspace the artifact lives on', () => {
    const source = ws();
    const build = new Task({
      name: 'build',
      workspaces: [source],
      steps: [step('compile')],
      produces: { dist: 'out/app.tar' },
    });
    const test = new Task({
      name: 'test',
      needs: [build],
      consumes: [build.artifacts.dist],
      steps: [step('run', sh`tar xf ${build.artifacts.dist}`)],
    });
    expect(test.workspaces.map(w => w.name)).toEqual(['source']);
  });

  it('interpolates the artifact into a step body as the consumer path', () => {
    const source = ws();
    const build = new Task({
      name: 'build',
      workspaces: [source],
      steps: [step('compile')],
      produces: { dist: 'out/app.tar' },
    });
    const test = new Task({
      name: 'test',
      needs: [build],
      consumes: [build.artifacts.dist],
      steps: [step('run', sh`tar xf ${build.artifacts.dist}`)],
    });
    const script = synthTask(test).script('run');
    expect(script).toContain(`tar xf ${source.at(ARTIFACT_DIR, 'build', 'dist', 'app.tar')}`);
    expect(script).not.toContain('out/app.tar');
  });
});

describe('injected publish and fetch steps', () => {
  const pair = () => {
    const source = ws();
    const build = new Task({
      name: 'build',
      workspaces: [source],
      steps: [step('compile')],
      produces: { dist: 'out/app.tar' },
    });
    const test = new Task({
      name: 'test',
      needs: [build],
      consumes: [build.artifacts.dist],
      steps: [step('run')],
    });
    return { source, build, test };
  };

  it('publishes after the producer’s own steps', () => {
    const { build } = pair();
    expect(synthTask(build).stepNames).toEqual(['compile', 'publish-dist-artifact']);
  });

  it('fetches before the consumer’s own steps', () => {
    const { test } = pair();
    expect(synthTask(test).stepNames).toEqual(['fetch-build-dist-artifact', 'run']);
  });

  it('copies the declared path into the artifact subtree', () => {
    const { source, build } = pair();
    const script = synthTask(build).script('publish-dist-artifact');
    expect(script).toContain("src='out/app.tar'");
    expect(script).toContain(`dest='${source.at(ARTIFACT_DIR, 'build', 'dist', 'app.tar')}'`);
    expect(script).toContain('cp -R "$src" "$dest"');
    // A producer that declared an artifact and wrote nothing is a failure, not a no-op.
    expect(script).toContain("task 'build' declares artifact 'dist' but wrote nothing");
  });

  it('turns a producer that published nothing into a named failure in the consumer', () => {
    const { test } = pair();
    const script = synthTask(test).script('fetch-build-dist-artifact');
    expect(script).toContain(
      "task 'test' consumes artifact 'dist' from task 'build', but nothing was published",
    );
  });

  it('resolves both step images through the project’s injected-step image', () => {
    const { build, test } = pair();
    const image = { image: 'ghcr.io/acme/ci:1', provides: ['sh' as const] };
    expect(synthTask(build, { injectedStepImage: image }).step('publish-dist-artifact').image).toBe(
      'ghcr.io/acme/ci:1',
    );
    expect(
      synthTask(test, { injectedStepImage: image }).step('fetch-build-dist-artifact').image,
    ).toBe('ghcr.io/acme/ci:1');
  });

  it('asks the injected image only for sh — the copy is portable', () => {
    const { build } = pair();
    const store = new WorkspaceArtifactStore();
    const ctx = artifactStoreCtx('build');
    expect(injectedImageRequirements(store.publishStep(build.artifacts.dist, ctx).image)).toEqual([
      'sh',
    ]);
    expect(injectedImageRequirements(store.fetchStep(build.artifacts.dist, ctx).image)).toEqual([
      'sh',
    ]);
  });

  it('publishes an action output from the image that wrote it', () => {
    const action = compile();
    const build = new Task({
      name: 'build',
      workspaces: [ws()],
      steps: [action],
      produces: { dist: action.outputs.bundle.toArtifact() },
    });
    const view = synthTask(build);
    expect(view.step('publish-dist-artifact').image).toBe('ghcr.io/example/node:24');
    expect(view.script('publish-dist-artifact')).toContain(`src='${action.outputs.bundle.path}'`);
  });

  it('refuses to inject a step whose name collides with one of the task’s own', () => {
    const build = new Task({
      name: 'build',
      workspaces: [ws()],
      steps: [step('publish-dist-artifact')],
      produces: { dist: 'out/app.tar' },
    });
    expect(() => synthTask(build)).toThrow(/collides with a step of the same name/);
  });

  it('takes the exit-code contract in a reporting task, unlike a cache save', () => {
    const source = ws();
    const build = new Task({
      name: 'build',
      workspaces: [source],
      steps: [step('compile')],
      produces: { dist: 'out/app.tar' },
      statusContext: 'ci/build',
      statusReporter: new TestStatusReporter(),
    });
    // The reporter's step needs nushell, so synthesize with a project image declaring it.
    const view = synthTask(build, { injectedStepImage: 'ghcr.io/example/ci-base:test' });
    expect(view.stepNames).toEqual(['compile', 'publish-dist-artifact', 'report-status']);
    const publish = view.step('publish-dist-artifact');
    // Continues so the reporter still runs, and captures its code so the report is honest.
    expect(publish.onError).toBe('continue');
    expect(view.script('publish-dist-artifact')).toContain('__tek_rc');
    // A failed publish must reach the reported status; a failed cache save must not.
    expect(view.script('report-status')).toContain('publish-dist-artifact');
  });

  it('fails the pod directly when the task reports no status', () => {
    const { build } = pair();
    expect(synthTask(build).step('publish-dist-artifact').onError).toBeUndefined();
  });
});

describe('pipeline-level validation', () => {
  const build = () => {
    const source = ws();
    return new Task({
      name: 'build',
      workspaces: [source],
      steps: [step('compile')],
      produces: { dist: 'out/app.tar' },
    });
  };

  it('accepts a consumer ordered after its producer', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const producer = build();
    const test = new Task({
      name: 'test',
      needs: [producer],
      consumes: [producer.artifacts.dist],
      steps: [step('run')],
    });
    expect(() => new Pipeline({ name: 'ci', tasks: [test] })).not.toThrow();
  });

  it('fails when nothing in the pipeline produces the artifact, naming it and the consumer', () => {
    const producer = build();
    const test = new Task({
      name: 'test',
      consumes: [producer.artifacts.dist],
      steps: [step('run')],
    });
    expect(() => new Pipeline({ name: 'ci', tasks: [test] })).toThrow(
      /task 'test' consumes artifact 'dist' from task 'build', which is not in this pipeline/,
    );
  });

  it('fails when the producer is present but not ordered first, and says so', () => {
    const producer = build();
    const test = new Task({
      name: 'test',
      consumes: [producer.artifacts.dist],
      steps: [step('run')],
    });
    let message = '';
    try {
      new Pipeline({ name: 'ci', tasks: [producer, test] });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/is not ordered before it/);
    expect(message).toMatch(/add 'build' to 'test'\.needs/);
    // The distinction is the product: this is not the "no producer" case wearing a hat.
    expect(message).toMatch(/only the ordering is missing/);
    expect(message).not.toMatch(/not in this pipeline/);
  });

  it('accepts a transitive ordering, not just a direct need', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const producer = build();
    const middle = new Task({ name: 'middle', needs: [producer], steps: [step('s')] });
    const test = new Task({
      name: 'test',
      needs: [middle],
      consumes: [producer.artifacts.dist],
      steps: [step('run')],
    });
    expect(() => new Pipeline({ name: 'ci', tasks: [test] })).not.toThrow();
  });

  it('rejects a task consuming its own artifact', () => {
    const producer = build();
    // A task cannot reach its own handle at construction, so this only happens by reaching
    // into `consumes` afterwards — which is exactly the case worth a message of its own,
    // since the ordering check would otherwise report it as "not ordered before itself".
    producer.consumes.push(producer.artifacts.dist);
    expect(() => new Pipeline({ name: 'ci', tasks: [producer] })).toThrow(
      /consumes its own artifact 'dist'/,
    );
  });

  it('warns, and synthesizes, when an artifact is declared but never consumed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const producer = build();
    expect(() => new Pipeline({ name: 'ci', tasks: [producer] })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("artifact 'dist' is declared but no task in this pipeline consumes it"),
    );
  });

  it('does not warn once something consumes it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const producer = build();
    const test = new Task({
      name: 'test',
      needs: [producer],
      consumes: [producer.artifacts.dist],
      steps: [step('run')],
    });
    new Pipeline({ name: 'ci', tasks: [test] });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("artifact 'dist' is declared"));
  });
});

describe('the ArtifactStore seam', () => {
  /**
   * A store that keeps nothing on a workspace — the shape tektonic-46j.15 will fill in for
   * real. Written as a plain implementation of the public interface rather than a mock: if
   * implementing it from out of tree needs something core does not export, it shows up here.
   */
  class BucketStore implements ArtifactStore {
    readonly type = 'bucket' as const;
    readonly needsWorkspace = false as const;
    constructor(private readonly bucket: string) {}
    path(a: TaskArtifact): string {
      return `/tektonic/artifacts/${a.producerName}/${a.name}/${a.fileName}`;
    }
    publishStep(a: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec {
      return {
        name: `publish-${a.name}-artifact`,
        image: ctx.defaultImage,
        script: sh`upload '${a.sourcePath}' '${this.key(a)}'`,
      };
    }
    fetchStep(a: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec {
      return {
        name: `fetch-${a.producerName}-${a.name}-artifact`,
        image: ctx.defaultImage,
        script: sh`download '${this.key(a)}' '${this.path(a)}'`,
      };
    }
    private key(a: TaskArtifact): string {
      return `${this.bucket}/${a.producerName}/${a.name}`;
    }
  }

  it('swaps the transport without touching the declaration or the handle types', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new BucketStore('s3://ci-artifacts');
    const producer = new Task({
      name: 'build',
      steps: [step('compile')],
      artifactStore: store,
      produces: { dist: 'out/app.tar' },
    });
    const test = new Task({
      name: 'test',
      needs: [producer],
      consumes: [producer.artifacts.dist],
      steps: [step('run', sh`tar xf ${producer.artifacts.dist}`)],
    });

    // No workspace anywhere: the store said it needs none, so nothing was resolved or mounted.
    expect(producer.workspaces).toEqual([]);
    expect(test.workspaces).toEqual([]);
    // The handle still stringifies to whatever the store says the consumer reads.
    expect(producer.artifacts.dist.path).toBe('/tektonic/artifacts/build/dist/app.tar');
    expect(synthTask(test).script('run')).toContain('tar xf /tektonic/artifacts/build/dist/app.tar');
    // The store's steps land in the same positions the built-in one's do.
    expect(synthTask(producer).stepNames).toEqual(['compile', 'publish-dist-artifact']);
    expect(synthTask(test).stepNames).toEqual(['fetch-build-dist-artifact', 'run']);
    expect(synthTask(producer).script('publish-dist-artifact')).toContain(
      "upload 'out/app.tar' 's3://ci-artifacts/build/dist'",
    );
    // And the synth-time checks are the store's business not at all.
    expect(() => new Pipeline({ name: 'ci', tasks: [test] })).not.toThrow();
  });

  it('injects no fetch step when the store needs none', () => {
    class PresentStore extends BucketStore {
      fetchStep(): undefined {
        return undefined;
      }
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const producer = new Task({
      name: 'build',
      steps: [step('compile')],
      artifactStore: new PresentStore('s3://x'),
      produces: { dist: 'out/app.tar' },
    });
    const test = new Task({
      name: 'test',
      needs: [producer],
      consumes: [producer.artifacts.dist],
      steps: [step('run')],
    });
    expect(synthTask(test).stepNames).toEqual(['run']);
  });
});

describe('producing and consuming in the same task', () => {
  it('publishes onto its own declared workspace, not a consumed artifact’s', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const upstream = new Workspace({ name: 'upstream' });
    const own = new Workspace({ name: 'own' });
    const build = new Task({
      name: 'build',
      workspaces: [upstream],
      steps: [step('compile')],
      produces: { dist: 'out/app.tar' },
    });
    // `test` declares one workspace and consumes from another. Auto-mounting the consumed
    // one must not turn its own `produces` into the ambiguous-workspace error.
    const test = new Task({
      name: 'test',
      workspaces: [own],
      needs: [build],
      consumes: [build.artifacts.dist],
      steps: [step('run')],
      produces: { coverage: 'out/coverage.xml' },
    });
    expect(test.artifacts.coverage.workspace).toBe(own);
    expect(test.workspaces.map(w => w.name)).toEqual(['own', 'upstream']);
    expect(synthTask(test).stepNames).toEqual([
      'fetch-build-dist-artifact',
      'run',
      'publish-coverage-artifact',
    ]);
  });
});

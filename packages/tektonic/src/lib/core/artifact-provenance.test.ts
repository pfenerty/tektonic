import { describe, it, expect, vi, afterEach } from 'vitest';
import { ARTIFACT_PROVENANCE_STEP, artifactUri } from './artifact-provenance';
import { WorkspaceArtifactStore, type ArtifactStore, type ArtifactStoreCtx, type TaskArtifact } from './artifact';
import { Task } from './task';
import type { TaskStepSpec } from './task';
import { Workspace } from './workspace';
import { defineAction } from './action';
import { synthTask } from '../testing';
import { sh } from '../script';

const ws = () => new Workspace({ name: 'source' });

const step = (name: string, script = sh`true`): TaskStepSpec => ({ name, image: 'alpine', script });

const compile = defineAction<void, 'bundle'>({
  name: 'compile',
  image: 'ghcr.io/example/node:24',
  outputs: { bundle: 'app.tar' },
  steps: ({ name, outputs }) => [{ name, script: sh`tar cf ${outputs.bundle} dist` }],
});

/** A store that publishes somewhere retrievable, so `uri()` has something to say. */
class BucketStore implements ArtifactStore {
  readonly type = 'bucket' as const;
  readonly needsWorkspace = false as const;
  path(a: TaskArtifact): string {
    return `/tektonic/artifacts/${a.producerName}/${a.name}/${a.fileName}`;
  }
  uri(a: TaskArtifact): string {
    return `s3://ci-artifacts/${a.producerName}/${a.name}`;
  }
  publishStep(a: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec {
    return { name: `publish-${a.name}-artifact`, image: ctx.defaultImage, script: sh`upload` };
  }
  fetchStep(a: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec {
    return { name: `fetch-${a.producerName}-${a.name}-artifact`, image: ctx.defaultImage, script: sh`download` };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TEP-0147 artifact provenance', () => {
  it('emits nothing unless it is turned on', () => {
    const build = new Task({
      name: 'build',
      workspaces: [ws()],
      steps: [step('compile')],
      produces: { dist: 'target/app.tar' },
    });

    expect(synthTask(build).stepNames).toEqual(['compile', 'publish-dist-artifact']);
    // The alpha feature flag is the cluster's business, so nothing is emitted on spec.
    expect(synthTask(build, { artifactProvenance: true }).stepNames).toEqual([
      'compile',
      'publish-dist-artifact',
      ARTIFACT_PROVENANCE_STEP,
    ]);
  });

  it('runs last, after the bytes it digests have been written and fetched', () => {
    const source = ws();
    const build = new Task({
      name: 'build',
      workspaces: [source],
      steps: [step('compile')],
      produces: { dist: 'target/app.tar' },
    });
    const test = new Task({
      name: 'test',
      needs: [build],
      workspaces: [source],
      consumes: [build.artifacts.dist],
      steps: [step('run')],
      artifactProvenance: true,
    });

    expect(synthTask(test).stepNames).toEqual([
      'fetch-build-dist-artifact',
      'run',
      ARTIFACT_PROVENANCE_STEP,
    ]);
  });

  it('records what the task consumed as inputs and what it produced as outputs', () => {
    const source = ws();
    const build = new Task({
      name: 'build',
      workspaces: [source],
      steps: [step('compile')],
      produces: { dist: 'target/app.tar' },
    });
    const pack = new Task({
      name: 'pack',
      needs: [build],
      workspaces: [source],
      consumes: [build.artifacts.dist],
      steps: [step('run')],
      produces: { bundle: 'out/bundle.tgz' },
      artifactProvenance: true,
    });

    const script = synthTask(pack).script(ARTIFACT_PROVENANCE_STEP);
    // The consumed artifact is digested where the fetch step left it; the produced one where
    // this task's own step wrote it, not where the store put a copy.
    expect(script).toContain(`path='${build.artifacts.dist.path}'`);
    expect(script).toContain(`path='out/bundle.tgz'`);
    expect(script).toContain('inputs="${inputs}${inputs:+,}$entry"');
    expect(script).toContain('outputs="${outputs}${outputs:+,}$entry"');
    expect(script).toContain(`printf '{"inputs":[%s],"outputs":[%s]}' "$inputs" "$outputs"`);
    // Written through Tekton's variable, which resolves per step — not a hardcoded path.
    expect(script).toContain("> '$(step.artifacts.path)'");
  });

  it('marks only the artifacts the declaration called build outputs', () => {
    const release = new Task({
      name: 'release',
      workspaces: [ws()],
      steps: [step('build')],
      produces: {
        image: { from: 'out/image.tar', buildOutput: true },
        coverage: 'out/coverage.xml',
      },
      artifactProvenance: true,
    });

    expect(release.artifacts.image.buildOutput).toBe(true);
    expect(release.artifacts.coverage.buildOutput).toBe(false);
    const script = synthTask(release).script(ARTIFACT_PROVENANCE_STEP);
    expect(script).toContain('{"name":"%s","buildOutput":true,"values":[{"uri":"%s","digest":{"sha256":"%s"}}]}\' \'image\'');
    // Absent, not false: `buildOutput` is omitempty upstream, so writing it out says nothing.
    expect(script).toContain('{"name":"%s","values":[{"uri":"%s","digest":{"sha256":"%s"}}]}\' \'coverage\'');
  });

  it('takes the retrievable URI from the store, and falls back to the path when it has none', () => {
    const source = ws();
    const onWorkspace = new Task({
      name: 'build',
      workspaces: [source],
      steps: [step('compile')],
      produces: { dist: 'target/app.tar' },
    });
    const inBucket = new Task({
      name: 'build',
      steps: [step('compile')],
      artifactStore: new BucketStore(),
      produces: { dist: 'target/app.tar' },
    });

    expect(onWorkspace.artifacts.dist.store).toBeInstanceOf(WorkspaceArtifactStore);
    expect(artifactUri(onWorkspace.artifacts.dist)).toBe(`file://${onWorkspace.artifacts.dist.path}`);
    expect(artifactUri(inBucket.artifacts.dist)).toBe('s3://ci-artifacts/build/dist');
  });

  it('reads the object form for a promoted action output too', () => {
    const build = new Task({
      name: 'build',
      workspaces: [ws()],
      steps: [compile()],
      produces: { dist: { from: compile().outputs.bundle.toArtifact(), buildOutput: true } },
      artifactProvenance: true,
    });

    const dist = build.artifacts.dist;
    expect(dist.buildOutput).toBe(true);
    expect(dist.fileName).toBe('app.tar');
    expect(dist.action).toBe('compile');
    // And the promoted-output check still fires through the wrapper.
    expect(
      () =>
        new Task({
          name: 'build',
          workspaces: [ws()],
          steps: [step('other')],
          produces: { dist: { from: compile().outputs.bundle.toArtifact() } },
        }),
    ).toThrow(/which this task does not compose/);
  });

  it('is a plain step in a task that reports status, so a failed digest is not reported green', () => {
    const build = new Task({
      name: 'build',
      workspaces: [ws()],
      steps: [step('compile')],
      produces: { dist: 'target/app.tar' },
      artifactProvenance: true,
    });

    const view = synthTask(build);
    const provenance = view.step(ARTIFACT_PROVENANCE_STEP);
    expect(provenance.onError).toBeUndefined();
  });

  it('lets a task override the project-wide setting in both directions', () => {
    const opted = new Task({
      name: 'build',
      workspaces: [ws()],
      steps: [step('compile')],
      produces: { dist: 'target/app.tar' },
      artifactProvenance: false,
    });

    expect(synthTask(opted, { artifactProvenance: true }).stepNames).not.toContain(
      ARTIFACT_PROVENANCE_STEP,
    );
  });

  it('adds no step to a task that declares no artifacts', () => {
    const plain = new Task({ name: 'lint', steps: [step('run')], artifactProvenance: true });
    expect(synthTask(plain).stepNames).toEqual(['run']);
  });
});

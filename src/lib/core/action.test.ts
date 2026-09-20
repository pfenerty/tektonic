import { describe, it, expect } from 'vitest';
import { defineAction, Action, ActionOutput, ACTION_OUTPUT_DIR, ACTION_VOLUME_NAME } from './action';
import { Task } from './task';
import { Param } from './param';
import { Workspace } from './workspace';
import { Result } from './result';
import { taskPreset } from './task-preset';
import { GitHubStatusReporter } from '../reporters/github-status-reporter';
import { synthTask } from '../testing';
import { sh, rawScript, EXIT_CODE_PATH } from '../script';

const syft = defineAction<{ image: string }, 'sbom'>({
  name: 'syft-sbom',
  version: '1.0.0',
  image: 'ghcr.io/example/syft:1.42.3',
  outputs: { sbom: 'sbom.json' },
  steps: ({ inputs, outputs }) => [
    { name: 'scan', script: sh`syft "${inputs.image}" -o cyclonedx-json=${outputs.sbom}` },
  ],
});

describe('defineAction', () => {
  it('builds typed output handles that stringify to a pod-shared path', () => {
    const sbom = syft({ image: 'app:1.0' });
    expect(sbom.outputs.sbom.path).toBe(`${ACTION_OUTPUT_DIR}/syft-sbom-sbom.json`);
    expect(`${sbom.outputs.sbom}`).toBe(sbom.outputs.sbom.path);
    expect(sbom.outputs.sbom.action).toBe('syft-sbom');
    expect(sbom.outputs.sbom.name).toBe('sbom');
  });

  it('carries the definition name and version onto the instance', () => {
    const sbom = syft({ image: 'app:1.0' }, { name: 'app-sbom' });
    expect(sbom.name).toBe('app-sbom');
    expect(sbom.actionName).toBe('syft-sbom');
    expect(sbom.version).toBe('1.0.0');
    // The output path follows the instance, so two instances never collide.
    expect(sbom.outputs.sbom.path).toBe(`${ACTION_OUTPUT_DIR}/app-sbom-sbom.json`);
  });

  it('prefixes step names with the instance name and fills in the image', () => {
    const sbom = syft({ image: 'app:1.0' }, { name: 'app-sbom' });
    expect(sbom.steps.map(s => s.name)).toEqual(['app-sbom-scan']);
    expect(sbom.steps[0].image).toBe('ghcr.io/example/syft:1.42.3');
  });

  it('does not double a step named after the instance', () => {
    const solo = defineAction({
      name: 'lint',
      image: 'alpine',
      steps: ({ name }) => [{ name, script: sh`lint .` }],
    });
    expect(solo().steps.map(s => s.name)).toEqual(['lint']);
    expect(solo(undefined, { name: 'lint-docs' }).steps.map(s => s.name)).toEqual(['lint-docs']);
  });

  it('lets the instance override the image', () => {
    const sbom = syft({ image: 'app:1.0' }, { image: 'ghcr.io/example/syft:2.0.0' });
    expect(sbom.steps[0].image).toBe('ghcr.io/example/syft:2.0.0');
  });

  it('lets a step override the image', () => {
    const mixed = defineAction({
      name: 'mixed',
      image: 'alpine',
      steps: () => [
        { name: 'a', script: sh`echo a` },
        { name: 'b', image: 'busybox', script: sh`echo b` },
      ],
    })();
    expect(mixed.steps.map(s => s.image)).toEqual(['alpine', 'busybox']);
  });

  it('rejects a step with no image anywhere', () => {
    const imageless = defineAction({ name: 'imageless', steps: () => [{ name: 'a', script: sh`echo a` }] });
    expect(() => imageless()).toThrow(/step 'a' has no image/);
  });

  it('rejects an instance name that is not a DNS label', () => {
    expect(() => syft({ image: 'app:1.0' }, { name: 'App SBOM' })).toThrow(/not a DNS label/);
  });

  it('rejects duplicate step names within one action', () => {
    const dup = defineAction({
      name: 'dup',
      image: 'alpine',
      steps: () => [{ name: 'a' }, { name: 'a' }],
    });
    expect(() => dup()).toThrow(/duplicate step name 'a'/);
  });

  it('resolves contributions from the instance inputs', () => {
    const ws = new Workspace({ name: 'source' });
    const token = new Param({ name: 'token' });
    const uses = defineAction<{ workspace: Workspace }>({
      name: 'uses',
      image: 'alpine',
      params: [token],
      workspaces: i => [i.workspace],
      steps: () => [{ name: 'a', script: sh`echo hi` }],
    });
    const instance = uses({ workspace: ws });
    expect(instance.params).toEqual([token]);
    expect(instance.workspaces).toEqual([ws]);
  });
});

describe('composing actions into a task', () => {
  it('expands actions into steps, interleaved with hand-written ones', () => {
    const sbom = syft({ image: 'app:1.0' });
    const task = new Task({
      name: 'scan',
      steps: [
        { name: 'prepare', image: 'alpine', script: sh`echo prepare` },
        sbom,
        { name: 'inspect', image: 'alpine', script: sh`cat ${sbom.outputs.sbom}` },
      ],
    });
    expect(task.steps.map(s => s.name)).toEqual(['prepare', 'syft-sbom-scan', 'inspect']);
    expect(task.actions).toEqual([sbom]);
  });

  it('interpolates an output handle into a later step with no path convention', () => {
    const sbom = syft({ image: 'app:1.0' });
    const view = synthTask(
      new Task({
        name: 'scan',
        steps: [sbom, { name: 'grype', image: 'ghcr.io/example/grype:0.110.0', script: sh`grype sbom:${sbom.outputs.sbom}` }],
      }),
    );
    expect(view.script('grype')).toContain(`grype sbom:${ACTION_OUTPUT_DIR}/syft-sbom-sbom.json`);
  });

  it('mounts the shared output volume on every step, so a later step can read it', () => {
    const view = synthTask(
      new Task({ name: 'scan', steps: [syft({ image: 'app:1.0' }), { name: 'after', image: 'alpine' }] }),
    );
    const spec = view.manifest.spec as Record<string, unknown>;
    expect(spec.volumes).toEqual([{ name: ACTION_VOLUME_NAME, emptyDir: {} }]);
    expect((spec.stepTemplate as Record<string, unknown>).volumeMounts).toEqual([
      { name: ACTION_VOLUME_NAME, mountPath: ACTION_OUTPUT_DIR },
    ]);
  });

  it('keeps the task stepTemplate volumeMounts alongside the injected one', () => {
    const view = synthTask(
      new Task({
        name: 'scan',
        steps: [syft({ image: 'app:1.0' })],
        stepTemplate: { volumeMounts: [{ name: 'cfg', mountPath: '/etc/cfg' }] },
        volumes: [{ name: 'cfg', configMap: { name: 'cfg' } }],
      }),
    );
    const spec = view.manifest.spec as Record<string, unknown>;
    expect((spec.stepTemplate as Record<string, unknown>).volumeMounts).toEqual([
      { name: ACTION_VOLUME_NAME, mountPath: ACTION_OUTPUT_DIR },
      { name: 'cfg', mountPath: '/etc/cfg' },
    ]);
    expect(spec.volumes).toEqual([
      { name: 'cfg', configMap: { name: 'cfg' } },
      { name: ACTION_VOLUME_NAME, emptyDir: {} },
    ]);
  });

  it('omits the volume when no composed action declares outputs', () => {
    const quiet = defineAction({ name: 'quiet', image: 'alpine', steps: () => [{ name: 'a' }] })();
    const view = synthTask(new Task({ name: 'plain', steps: [quiet] }));
    const spec = view.manifest.spec as Record<string, unknown>;
    expect(spec.volumes).toBeUndefined();
    expect((spec.stepTemplate as Record<string, unknown>).volumeMounts).toBeUndefined();
  });

  it('merges action params, workspaces, caches and volumes upward, the task winning by name', () => {
    const ws = new Workspace({ name: 'source' });
    const taskToken = new Param({ name: 'token', default: 'task' });
    const actionToken = new Param({ name: 'token', default: 'action' });
    const heavy = defineAction({
      name: 'heavy',
      image: 'alpine',
      params: [actionToken, new Param({ name: 'registry' })],
      workspaces: [ws],
      caches: [{ name: 'grype-db', key: [], paths: ['.grype'], workspace: ws }],
      volumes: [{ name: 'scratch', emptyDir: {} }],
      steps: () => [{ name: 'a', script: sh`echo hi` }],
    })();
    const task = new Task({ name: 'scan', params: [taskToken], steps: [heavy] });
    expect(task.params.map(p => p.name)).toEqual(['token', 'registry']);
    expect(task.params[0].default).toBe('task');
    expect(task.workspaces.map(w => w.name)).toEqual(['source']);
    expect(task.caches.map(c => c.name)).toEqual(['grype-db']);
    expect(task.volumes.map(v => v.name)).toEqual(['scratch']);
  });

  it('rejects two actions composed under the same name', () => {
    expect(
      () => new Task({ name: 'scan', steps: [syft({ image: 'a:1' }), syft({ image: 'b:1' })] }),
    ).toThrow(/two actions are composed as 'syft-sbom'/);
    // …and accepts them once one is renamed.
    const task = new Task({
      name: 'scan',
      steps: [syft({ image: 'a:1' }), syft({ image: 'b:1' }, { name: 'base-sbom' })],
    });
    expect(task.steps.map(s => s.name)).toEqual(['syft-sbom-scan', 'base-sbom-scan']);
  });

  it('rejects a duplicate step name between an action and a hand-written step', () => {
    expect(
      () =>
        new Task({
          name: 'scan',
          steps: [syft({ image: 'a:1' }), { name: 'syft-sbom-scan', image: 'alpine' }],
        }),
    ).toThrow(/duplicate step name 'syft-sbom-scan'/);
  });
});

describe('the exit-code contract', () => {
  const reporter = new GitHubStatusReporter();
  // The reporter's step needs nushell, so these tasks synthesize with a project image
  // declaring it — as a project does with `injectedStepImage`.
  const CAPABLE = { injectedStepImage: 'ghcr.io/example/ci-base:test' } as const;

  it('wraps an action step exactly as a hand-written one in a reporting task', () => {
    const view = synthTask(
      new Task({ name: 'scan', statusReporter: reporter, steps: [syft({ image: 'app:1.0' })] }),
      CAPABLE,
    );
    expect(view.script('syft-sbom-scan')).toContain(EXIT_CODE_PATH);
    expect(view.step('syft-sbom-scan').onError).toBe('continue');
    // The reporter sees the expanded step, so its per-step exit code is consulted too.
    expect(view.stepNames).toEqual(['syft-sbom-scan', 'report-status']);
    expect(view.script('report-status')).toContain('syft-sbom-scan');
  });

  it('rejects an action that opts out with onError stopAndFail', () => {
    const stubborn = defineAction({
      name: 'stubborn',
      image: 'alpine',
      steps: () => [{ name: 'a', script: sh`echo hi`, onError: 'stopAndFail' as const }],
    })();
    expect(() => new Task({ name: 'scan', statusReporter: reporter, steps: [stubborn] })).toThrow(
      /cannot opt out of the exit-code contract/,
    );
    // Without a reporter there is no contract to break.
    expect(() => new Task({ name: 'scan', steps: [stubborn] })).not.toThrow();
  });

  it('rejects an action whose body is a bare shebang string in a reporting task', () => {
    const raw = defineAction({
      name: 'raw',
      image: 'alpine',
      steps: () => [{ name: 'a', script: '#!/bin/sh\necho hi' }],
    })();
    expect(() => synthTask(new Task({ name: 'scan', statusReporter: reporter, steps: [raw] }))).toThrow(
      /silently opts out of the exit-code contract/,
    );
  });

  it('lets an action state the opt-out with rawScript, as a hand-written step may', () => {
    const stated = defineAction({
      name: 'stated',
      image: 'alpine',
      steps: () => [{ name: 'a', script: rawScript(`#!/bin/sh\nprintf '%s' 0 > ${EXIT_CODE_PATH}`) }],
    })();
    const view = synthTask(new Task({ name: 'scan', statusReporter: reporter, steps: [stated] }), CAPABLE);
    expect(view.script('stated-a')).toBe(`#!/bin/sh\nprintf '%s' 0 > ${EXIT_CODE_PATH}`);
  });
});

describe('promoting an output across the pod boundary', () => {
  it('copies into a Result and contributes it to the task', () => {
    const sbom = syft({ image: 'app:1.0' });
    const digest = new Result({ name: 'sbom-digest' });
    const task = new Task({ name: 'scan', steps: [sbom, sbom.outputs.sbom.toResult(digest)] });
    expect(task.results).toEqual([digest]);
    expect(task.steps.map(s => s.name)).toEqual(['syft-sbom-scan', 'promote-sbom-to-result']);
    const view = synthTask(task);
    expect(view.script('promote-sbom-to-result')).toContain(`src='${sbom.outputs.sbom.path}'`);
    expect(view.script('promote-sbom-to-result')).toContain(`cp "$src" '$(results.sbom-digest.path)'`);
    // The 4KB result cap is enforced in the step, not discovered by truncation.
    expect(view.script('promote-sbom-to-result')).toContain('4096');
    expect((view.manifest.spec as Record<string, unknown>).results).toEqual([
      { name: 'sbom-digest', type: 'string' },
    ]);
  });

  it('binds a Result passed both to the task and to a promotion exactly once', () => {
    const sbom = syft({ image: 'app:1.0' });
    const digest = new Result({ name: 'sbom-digest' });
    const task = new Task({
      name: 'scan',
      results: [digest],
      steps: [sbom, sbom.outputs.sbom.toResult(digest)],
    });
    expect(task.results).toEqual([digest]);
    expect(`${digest}`).toBe('$(tasks.scan.results.sbom-digest)');
  });

  it('copies into a workspace file and contributes the workspace', () => {
    const ws = new Workspace({ name: 'artifacts' });
    const sbom = syft({ image: 'app:1.0' });
    const task = new Task({
      name: 'scan',
      steps: [sbom, sbom.outputs.sbom.toWorkspace(ws, 'reports/app.sbom.json')],
    });
    expect(task.workspaces.map(w => w.name)).toEqual(['artifacts']);
    const view = synthTask(task);
    expect(view.script('promote-sbom-to-workspace')).toContain(
      `dest='$(workspaces.artifacts.path)/reports/app.sbom.json'`,
    );
  });

  it('defaults the workspace destination to the output file name', () => {
    const ws = new Workspace({ name: 'artifacts' });
    const sbom = syft({ image: 'app:1.0' });
    const view = synthTask(
      new Task({ name: 'scan', steps: [sbom, sbom.outputs.sbom.toWorkspace(ws)] }),
    );
    expect(view.script('promote-sbom-to-workspace')).toContain(
      `dest='$(workspaces.artifacts.path)/sbom.json'`,
    );
  });

  it('runs the copy in the producing action image unless told otherwise', () => {
    const ws = new Workspace({ name: 'artifacts' });
    const sbom = syft({ image: 'app:1.0' });
    const task = new Task({
      name: 'scan',
      steps: [
        sbom,
        sbom.outputs.sbom.toWorkspace(ws, undefined, { image: 'alpine:3.22', name: 'stash-sbom' }),
      ],
    });
    expect(task.steps[1].name).toBe('stash-sbom');
    expect(task.steps[1].image).toBe('alpine:3.22');
    const defaulted = new Task({ name: 'other', steps: [syft({ image: 'app:1.0' })] });
    expect(defaulted.steps[0].image).toBe('ghcr.io/example/syft:1.42.3');
  });

  it('demands an image when the producing action declares none', () => {
    const imageless = defineAction<void, 'report'>({
      name: 'imageless',
      outputs: { report: 'report.txt' },
      steps: () => [{ name: 'a', image: 'alpine', script: sh`echo hi` }],
    })();
    expect(() => imageless.outputs.report.toResult(new Result({ name: 'r' }))).toThrow(
      /has no image to run in/,
    );
  });
});

describe('taskPreset and actions', () => {
  it('stamps step defaults onto a composed action without mutating the instance', () => {
    const ciTask = taskPreset({
      step: { computeResources: { requests: { cpu: '250m' } }, env: [{ name: 'CI', value: 'true' }] },
    });
    const sbom = syft({ image: 'app:1.0' });
    const task = ciTask({ name: 'scan', steps: [sbom] });
    expect(task.steps[0].computeResources).toEqual({ requests: { cpu: '250m' } });
    expect(task.steps[0].env).toEqual([{ name: 'CI', value: 'true' }]);
    expect(task.steps[0].image).toBe('ghcr.io/example/syft:1.42.3');
    // The original instance is untouched, so the same action composes elsewhere unchanged.
    expect(sbom.steps[0].computeResources).toBeUndefined();
    expect(sbom).toBeInstanceOf(Action);
  });
});

/**
 * The validation gate from the issue: ocidex hand-rolls `uploadSarifStep` as a bare
 * `TaskStepSpec` factory and passes `buildSteps?: TaskStepSpec[]` into its dep-scan job as an
 * untyped escape hatch. This is that shape rewritten against the action API — the inputs are
 * declared and checked, the SARIF path is a handle rather than a convention, and the job
 * factory takes `Action`s instead of loose steps.
 */
describe('validation gate: the ocidex dep-scan case', () => {
  const sbomAction = defineAction<{ image: string }, 'sbom'>({
    name: 'syft',
    version: '1.0.0',
    image: 'ghcr.io/example/syft:1.42.3',
    outputs: { sbom: 'sbom.json' },
    steps: ({ inputs, outputs }) => [
      { name: 'sbom', script: sh`syft "${inputs.image}" -o cyclonedx-json=${outputs.sbom}` },
    ],
  });

  const grypeAction = defineAction<{ sbom: ActionOutput | string }, 'sarif'>({
    name: 'grype',
    version: '1.0.0',
    image: 'ghcr.io/example/grype:0.110.0',
    outputs: { sarif: 'scan.sarif' },
    steps: ({ inputs, outputs }) => [
      { name: 'scan', script: sh`grype sbom:${inputs.sbom} -o sarif=${outputs.sarif}` },
    ],
  });

  const uploadSarif = defineAction<{ sarif: ActionOutput | string; category: string }>({
    name: 'upload-sarif',
    version: '1.0.0',
    image: 'ghcr.io/example/gh:2.82.1',
    params: [new Param({ name: 'repo-full-name' }), new Param({ name: 'revision' })],
    steps: ({ inputs }) => [
      {
        name: 'upload',
        script: sh`gh api /repos/$(params.repo-full-name)/code-scanning/sarifs -f sarif=@${inputs.sarif} -f category=${inputs.category}`,
      },
    ],
  });

  interface DepScanOptions {
    name?: string;
    image: string;
    workspace: Workspace;
    /** Extra actions composed after the scan — typed units, not loose steps. */
    extraActions?: Action<string>[];
  }

  function depScanTask(opts: DepScanOptions): Task {
    const sbom = sbomAction({ image: opts.image });
    const scan = grypeAction({ sbom: sbom.outputs.sbom });
    return new Task({
      name: opts.name ?? 'dep-scan',
      workspaces: [opts.workspace],
      steps: [
        sbom,
        scan,
        uploadSarif({ sarif: scan.outputs.sarif, category: 'dep-scan' }),
        ...(opts.extraActions ?? []),
      ],
    });
  }

  it('composes syft → grype → upload with no path conventions between them', () => {
    const view = synthTask(depScanTask({ image: 'app:1.0', workspace: new Workspace({ name: 'source' }) }));
    expect(view.stepNames).toEqual(['syft-sbom', 'grype-scan', 'upload-sarif-upload']);
    expect(view.script('syft-sbom')).toContain(`-o cyclonedx-json=${ACTION_OUTPUT_DIR}/syft-sbom.json`);
    expect(view.script('grype-scan')).toContain(`grype sbom:${ACTION_OUTPUT_DIR}/syft-sbom.json`);
    expect(view.script('grype-scan')).toContain(`-o sarif=${ACTION_OUTPUT_DIR}/grype-scan.sarif`);
    expect(view.script('upload-sarif-upload')).toContain(`sarif=@${ACTION_OUTPUT_DIR}/grype-scan.sarif`);
    // The upload action's params arrive on the task without the job factory restating them.
    expect(view.paramNames).toEqual(['repo-full-name', 'revision']);
  });

  it('keeps the SARIF for a downstream task when asked, explicitly', () => {
    const artifacts = new Workspace({ name: 'artifacts' });
    const image = 'app:1.0';
    const sbom = sbomAction({ image });
    const scan = grypeAction({ sbom: sbom.outputs.sbom });
    const sarifPath = new Result({ name: 'sarif-path' });
    const task = new Task({
      name: 'dep-scan',
      steps: [
        sbom,
        scan,
        scan.outputs.sarif.toWorkspace(artifacts, 'dep-scan.sarif'),
        scan.outputs.sarif.toResult(sarifPath, { name: 'record-sarif' }),
      ],
    });
    expect(task.workspaces.map(w => w.name)).toEqual(['artifacts']);
    expect(task.results.map(r => r.name)).toEqual(['sarif-path']);
    expect(task.steps.map(s => s.name)).toEqual([
      'syft-sbom',
      'grype-scan',
      'promote-sarif-to-workspace',
      'record-sarif',
    ]);
  });
});

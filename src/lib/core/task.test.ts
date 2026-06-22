import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { Task } from './task';
import { Param } from './param';
import { Workspace } from './workspace';
import { Result } from './result';
import { HubTaskRef } from './hub-task-ref';
import { gcs } from '../cache/gcs-backend';
import { RESTRICTED_STEP_SECURITY_CONTEXT, DEFAULT_STEP_RESOURCES, DEFAULT_BASE_IMAGE, DEFAULT_GCS_CACHE_IMAGE } from '../constants';
import { GitHubStatusReporter } from '../reporters/github-status-reporter';
import { nu, EXIT_CODE_PATH } from '../script';

describe('Task', () => {
  const workspace = new Workspace({ name: 'workspace' });
  const urlParam = new Param({ name: 'url' });

  it('stores all properties', () => {
    const dep = new Task({ name: 'dep', steps: [{ name: 's', image: 'alpine' }] });
    const t = new Task({
      name: 'test',
      params: [urlParam],
      workspaces: [workspace],
      needs: [dep],
      steps: [{ name: 'run', image: 'node:22' }],
    });
    expect(t.name).toBe('test');
    expect(t.params).toEqual([urlParam]);
    expect(t.workspaces).toEqual([workspace]);
    expect(t.needs).toEqual([dep]);
    expect(t.steps).toHaveLength(1);
  });

  it('defaults needs to empty array', () => {
    const t = new Task({ name: 'solo', steps: [{ name: 's', image: 'alpine' }] });
    expect(t.needs).toEqual([]);
    expect(t.params).toEqual([]);
    expect(t.workspaces).toEqual([]);
  });

  it('accepts a HubTaskRef in needs', () => {
    const hub = new HubTaskRef({ taskName: 'git-clone', version: '0.9' });
    const t = new Task({ name: 'build', needs: [hub], steps: [{ name: 's', image: 'alpine' }] });
    expect(t.needs).toContain(hub);
  });

  it('auto-merges statusReporter.requiredParams into params', () => {
    const reporter = new GitHubStatusReporter();
    const buildPath = new Param({ name: 'build-path', default: './' });
    const t = new Task({
      name: 'test',
      params: [buildPath],
      statusReporter: reporter,
      steps: [{ name: 's', image: 'alpine' }],
    });
    const paramNames = t.params.map(p => p.name);
    expect(paramNames).toContain('build-path');
    expect(paramNames).toContain('revision');
    expect(paramNames).toContain('repo-full-name');
  });

  it('user-declared params take precedence over statusReporter params on name collision', () => {
    const customRevision = new Param({ name: 'revision', type: 'string', description: 'custom' });
    const reporter = new GitHubStatusReporter();
    const t = new Task({
      name: 'test',
      params: [customRevision],
      statusReporter: reporter,
      steps: [{ name: 's', image: 'alpine' }],
    });
    const revParam = t.params.find(p => p.name === 'revision');
    expect(revParam?.description).toBe('custom');
    expect(t.params.filter(p => p.name === 'revision')).toHaveLength(1);
  });

  describe('synth()', () => {
    it('creates valid Task resource with default security context', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'my-task',
        params: [urlParam],
        workspaces: [workspace],
        steps: [{ name: 'run', image: 'alpine', command: ['echo', 'hi'] }],
      });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      expect(manifest.apiVersion).toBe('tekton.dev/v1');
      expect(manifest.kind).toBe('Task');
      expect(manifest.metadata).toEqual({ name: 'my-task', namespace: 'ns' });
      expect(manifest.spec.params).toEqual([{ name: 'url', type: 'string' }]);
      expect(manifest.spec.workspaces).toEqual([{ name: 'workspace' }]);
      expect(manifest.spec.stepTemplate.securityContext.allowPrivilegeEscalation).toBe(false);
    });

    it('applies default resource requests and limits via stepTemplate', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({ name: 'bare', steps: [{ name: 's', image: 'alpine' }] });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      expect(manifest.spec.stepTemplate.computeResources).toEqual(DEFAULT_STEP_RESOURCES);
      expect(manifest.spec.steps[0].computeResources).toBeUndefined();
    });

    it('per-step computeResources override default', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'heavy',
        steps: [{ name: 's', image: 'alpine', computeResources: { limits: { cpu: '4', memory: '4Gi' } } }],
      });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      expect(manifest.spec.steps[0].computeResources).toEqual({ limits: { cpu: '4', memory: '4Gi' } });
    });

    it('merges custom stepTemplate over defaults', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'restricted',
        steps: [{ name: 'run', image: 'alpine' }],
        stepTemplate: { securityContext: RESTRICTED_STEP_SECURITY_CONTEXT },
      });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      expect(manifest.spec.stepTemplate.securityContext.runAsNonRoot).toBe(true);
    });

    it('merges project defaultStepSecurityContext into stepTemplate securityContext', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({ name: 'bare', steps: [{ name: 's', image: 'alpine' }] });
      t.synth(chart, 'ns', undefined, { runAsNonRoot: true, runAsUser: 1000 });
      const manifest = chart.toJson()[0];
      expect(manifest.spec.stepTemplate.securityContext.allowPrivilegeEscalation).toBe(false);
      expect(manifest.spec.stepTemplate.securityContext.runAsNonRoot).toBe(true);
      expect(manifest.spec.stepTemplate.securityContext.runAsUser).toBe(1000);
    });

    it('task stepTemplate.securityContext overrides project defaultStepSecurityContext', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'custom',
        steps: [{ name: 's', image: 'alpine' }],
        stepTemplate: { securityContext: { allowPrivilegeEscalation: false, runAsUser: 999 } },
      });
      t.synth(chart, 'ns', undefined, { runAsUser: 1000 });
      const manifest = chart.toJson()[0];
      // task stepTemplate wins over project default
      expect(manifest.spec.stepTemplate.securityContext.runAsUser).toBe(999);
    });

    it('per-step securityContext appears in synthesized step spec', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'step-ctx',
        steps: [
          { name: 'privileged', image: 'alpine', securityContext: { runAsUser: 0 } },
          { name: 'normal', image: 'alpine' },
        ],
      });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      expect(manifest.spec.steps[0].securityContext).toEqual({ runAsUser: 0 });
      expect(manifest.spec.steps[1].securityContext).toBeUndefined();
    });

    it('stepTemplate.securityContext does not include pod-level fields by default', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({ name: 'bare', steps: [{ name: 's', image: 'alpine' }] });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      expect(manifest.spec.stepTemplate.securityContext.fsGroup).toBeUndefined();
    });

    it('applies namePrefix', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({ name: 'clone', steps: [{ name: 's', image: 'git' }] });
      t.synth(chart, 'ns', 'myapp');
      const manifest = chart.toJson()[0];
      expect(manifest.metadata.name).toBe('myapp-clone');
    });

    it('omits params and workspaces when empty', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({ name: 'bare', steps: [{ name: 's', image: 'alpine' }] });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      expect(manifest.spec.params).toBeUndefined();
      expect(manifest.spec.workspaces).toBeUndefined();
    });

    it('emits results array in synthesized spec', () => {
      const commit = new Result({ name: 'commit' });
      const shortSha = new Result({ name: 'short-sha', description: 'Abbreviated SHA', type: 'string' });
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'clone',
        results: [commit, shortSha],
        steps: [{ name: 's', image: 'alpine' }],
      });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      expect(manifest.spec.results).toHaveLength(2);
      expect(manifest.spec.results[0]).toEqual({ name: 'commit', type: 'string' });
      expect(manifest.spec.results[1]).toEqual({ name: 'short-sha', type: 'string', description: 'Abbreviated SHA' });
    });

    it('omits results when none declared', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({ name: 'bare', steps: [{ name: 's', image: 'alpine' }] });
      t.synth(chart, 'ns');
      expect(chart.toJson()[0].spec.results).toBeUndefined();
    });

    it('results are bound to task name after construction', () => {
      const commit = new Result({ name: 'commit' });
      new Task({ name: 'git-clone', results: [commit], steps: [{ name: 's', image: 'alpine' }] });
      expect(commit.toString()).toBe('$(tasks.git-clone.results.commit)');
    });
  });

  describe('cache step injection', () => {
    const cacheWs = new Workspace({ name: 'npm-cache' });
    const cacheSpec = {
      name: 'npm',
      key: ['package-lock.json'],
      paths: ['node_modules'],
      workspace: cacheWs,
    };

    it('auto-adds cache workspace to task workspaces', () => {
      const t = new Task({ name: 'cached', steps: [{ name: 's', image: 'alpine' }], caches: [cacheSpec] });
      expect(t.workspaces.map(w => w.name)).toContain('npm-cache');
    });

    it('does not duplicate workspace already declared', () => {
      const t = new Task({
        name: 'cached',
        workspaces: [cacheWs],
        steps: [{ name: 's', image: 'alpine' }],
        caches: [cacheSpec],
      });
      expect(t.workspaces.filter(w => w.name === 'npm-cache')).toHaveLength(1);
    });

    it('inserts restore step before and save step after user steps', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'cached',
        steps: [{ name: 'run', image: 'alpine' }],
        caches: [cacheSpec],
      });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      const names = manifest.spec.steps.map((s: any) => s.name);
      expect(names[0]).toBe('restore-npm-cache');
      expect(names[1]).toBe('run');
      expect(names[2]).toBe('save-npm-cache');
    });

    it('save step is inserted before status reporter step', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const reporter = new GitHubStatusReporter();
      const t = new Task({
        name: 'cached',
        statusReporter: reporter,
        steps: [{ name: 'run', image: 'alpine' }],
        caches: [cacheSpec],
      });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      const names = manifest.spec.steps.map((s: any) => s.name);
      const saveIdx = names.indexOf('save-npm-cache');
      const reporterIdx = names.findIndex((n: string) => n !== 'restore-npm-cache' && n !== 'run' && n !== 'save-npm-cache');
      expect(saveIdx).toBeGreaterThan(0);
      expect(reporterIdx).toBeGreaterThan(saveIdx);
    });

    it('restore script hashes key files and uses workspace path', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'cached',
        steps: [{ name: 'run', image: 'alpine' }],
        caches: [cacheSpec],
      });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      const restoreStep = manifest.spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restoreStep.script).toContain('sha256sum');
      expect(restoreStep.script).toContain('$(workspaces.npm-cache.path)');
      expect(restoreStep.script).toContain('package-lock.json');
      expect(restoreStep.script).toContain('node_modules');
    });

    it('save script reads hash file and skips when cache dir exists', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'cached',
        steps: [{ name: 'run', image: 'alpine' }],
        caches: [cacheSpec],
      });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      const saveStep = manifest.spec.steps.find((s: any) => s.name === 'save-npm-cache');
      expect(saveStep.script).toContain('/tekton/home/.cache-npm-hash');
      expect(saveStep.script).toContain('[ ! -d "$CACHE_DIR" ]');
      expect(saveStep.onError).toBe('continue');
    });

    it('multiple caches produce multiple restore/save pairs in order', () => {
      const ws2 = new Workspace({ name: 'go-cache' });
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'multi',
        steps: [{ name: 'run', image: 'alpine' }],
        caches: [
          cacheSpec,
          { name: 'go', key: ['go.sum'], paths: ['vendor'], workspace: ws2 },
        ],
      });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      const names = manifest.spec.steps.map((s: any) => s.name);
      expect(names).toEqual([
        'restore-npm-cache',
        'restore-go-cache',
        'run',
        'save-npm-cache',
        'save-go-cache',
      ]);
    });

    describe('compress: true', () => {
      const compressedSpec = { ...cacheSpec, compress: true as const };

      it('restore script uses nushell with tar --zstd and .tar.zst archive', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({ name: 'c', steps: [{ name: 's', image: 'alpine' }], caches: [compressedSpec] });
        t.synth(chart, 'ns');
        const step = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
        expect(step.script).toContain('#!/usr/bin/env nu');
        expect(step.script).toContain('zstd -d -T1 -c');
        expect(step.script).toContain('tar xf -');
        expect(step.script).toContain('.tar.zst');
        expect(step.script).toContain('path exists');
        expect(step.script).toContain('hash sha256');
      });

      it('save script uses nushell with tar --zstd and .tar.zst archive', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({ name: 'c', steps: [{ name: 's', image: 'alpine' }], caches: [compressedSpec] });
        t.synth(chart, 'ns');
        const step = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
        expect(step.script).toContain('#!/usr/bin/env nu');
        expect(step.script).toContain('tar cf -');
        expect(step.script).toContain('zstd -');
        expect(step.script).toContain('.tar.zst');
      });

      it('scripts do not require any package installation', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({ name: 'c', steps: [{ name: 's', image: 'alpine' }], caches: [compressedSpec] });
        t.synth(chart, 'ns');
        const steps = chart.toJson()[0].spec.steps;
        const restore = steps.find((s: any) => s.name === 'restore-npm-cache');
        const save = steps.find((s: any) => s.name === 'save-npm-cache');
        expect(restore.script).not.toContain('apk add');
        expect(save.script).not.toContain('apk add');
      });

      it('workingDir is set on restore and save steps when provided', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...compressedSpec, workingDir: '$(workspaces.workspace.path)' }],
        });
        t.synth(chart, 'ns');
        const steps = chart.toJson()[0].spec.steps;
        const restore = steps.find((s: any) => s.name === 'restore-npm-cache');
        const save = steps.find((s: any) => s.name === 'save-npm-cache');
        expect(restore.workingDir).toBe('$(workspaces.workspace.path)');
        expect(save.workingDir).toBe('$(workspaces.workspace.path)');
      });

      it('workingDir is omitted from steps when not provided', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({ name: 'c', steps: [{ name: 's', image: 'alpine' }], caches: [compressedSpec] });
        t.synth(chart, 'ns');
        const steps = chart.toJson()[0].spec.steps;
        const restore = steps.find((s: any) => s.name === 'restore-npm-cache');
        expect(restore.workingDir).toBeUndefined();
      });

      it('uncompressed cache still uses cp -r, not tar', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({ name: 'c', steps: [{ name: 's', image: 'alpine' }], caches: [cacheSpec] });
        t.synth(chart, 'ns');
        const steps = chart.toJson()[0].spec.steps;
        const restore = steps.find((s: any) => s.name === 'restore-npm-cache');
        const save = steps.find((s: any) => s.name === 'save-npm-cache');
        expect(restore.script).toContain('cp -r');
        expect(restore.script).not.toContain('tar');
        expect(save.script).toContain('cp -r');
        expect(save.script).not.toContain('tar');
      });
    });

    describe('ScriptLanguage routing (de-mandate nushell)', () => {
      const renderCache = (spec: any) => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({ name: 'c', steps: [{ name: 's', image: 'alpine' }], caches: [spec] });
        t.synth(chart, 'ns');
        const steps = chart.toJson()[0].spec.steps;
        return {
          restore: steps.find((s: any) => s.name === 'restore-npm-cache').script,
          save: steps.find((s: any) => s.name === 'save-npm-cache').script,
        };
      };

      it('uncompressed PVC cache is portable sh — no nushell mandated', () => {
        const { restore, save } = renderCache(cacheSpec);
        for (const script of [restore, save]) {
          expect(script).toContain('#!/bin/sh');
          expect(script).not.toContain('#!/usr/bin/env nu');
          // plugin-generated log preamble, not a hand-written one
          expect(script).toContain("log() { printf '[%s] %s\\n' \"$(date +%H:%M:%S)\" \"$*\"; }");
        }
      });

      it('compressed PVC cache routes through the nushell plugin preamble', () => {
        const { restore, save } = renderCache({ ...cacheSpec, compress: true as const });
        for (const script of [restore, save]) {
          // single plugin-generated shebang + log def, no hand-written duplicate
          expect(script.match(/#!\/usr\/bin\/env nu/g)).toHaveLength(1);
          expect(script).toContain("def log [msg: string] { print $\"[(date now | format date '%H:%M:%S')] ($msg)\" }");
        }
        // label is supplied at the call site, not baked into a per-script def
        expect(restore).toContain('restore-npm-cache: hit');
        expect(save).toContain('save-npm-cache: saved');
      });

      it('GCS cache routes through the nushell plugin preamble', () => {
        const { restore, save } = renderCache({ ...cacheSpec, backend: gcs({ bucket: 'my-bucket' }) });
        for (const script of [restore, save]) {
          expect(script.match(/#!\/usr\/bin\/env nu/g)).toHaveLength(1);
          expect(script).toContain("def log [msg: string] { print $\"[(date now | format date '%H:%M:%S')] ($msg)\" }");
        }
        expect(restore).toContain('restore-npm-cache: checking');
        expect(save).toContain('save-npm-cache: uploading');
      });
    });

    describe('default cache image', () => {
      it('uses DEFAULT_BASE_IMAGE when no image specified', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [cacheSpec],
        });
        t.synth(chart, 'ns');
        const steps = chart.toJson()[0].spec.steps;
        const restore = steps.find((s: any) => s.name === 'restore-npm-cache');
        const save = steps.find((s: any) => s.name === 'save-npm-cache');
        expect(restore.image).toBe(DEFAULT_BASE_IMAGE);
        expect(save.image).toBe(DEFAULT_BASE_IMAGE);
      });

      it('respects custom image override', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, image: 'node:22-alpine' }],
        });
        t.synth(chart, 'ns');
        const steps = chart.toJson()[0].spec.steps;
        const restore = steps.find((s: any) => s.name === 'restore-npm-cache');
        expect(restore.image).toBe('node:22-alpine');
      });
    });

    describe('compressionLevel', () => {
      it('defaults to zstd level 1 in save script', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, compress: true }],
        });
        t.synth(chart, 'ns');
        const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
        expect(save.script).toContain('zstd -1 -T1');
      });

      it('uses custom compressionLevel in save script', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, compress: true, compressionLevel: 5 }],
        });
        t.synth(chart, 'ns');
        const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
        expect(save.script).toContain('zstd -5 -T1');
      });
    });

    describe('computeResources', () => {
      it('propagates computeResources to cache steps', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const resources = { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } };
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, computeResources: resources }],
        });
        t.synth(chart, 'ns');
        const steps = chart.toJson()[0].spec.steps;
        const restore = steps.find((s: any) => s.name === 'restore-npm-cache');
        const save = steps.find((s: any) => s.name === 'save-npm-cache');
        expect(restore.computeResources).toEqual(resources);
        expect(save.computeResources).toEqual(resources);
      });

      it('omits computeResources when not specified', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [cacheSpec],
        });
        t.synth(chart, 'ns');
        const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
        expect(restore.computeResources).toBeUndefined();
      });
    });

    describe('maxEntries', () => {
      it('defaults to 3 in save script', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, compress: true }],
        });
        t.synth(chart, 'ns');
        const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
        expect(save.script).toContain('let max = 3');
      });

      it('uses custom maxEntries in save script', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, compress: true, maxEntries: 5 }],
        });
        t.synth(chart, 'ns');
        const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
        expect(save.script).toContain('let max = 5');
      });

      it('eviction logic present in compressed save script', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, compress: true }],
        });
        t.synth(chart, 'ns');
        const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
        expect(save.script).toContain('sort-by modified');
        expect(save.script).toContain('evicting');
      });
    });

    describe('saveStrategy: "finally"', () => {
      const finallySpec = { ...cacheSpec, compress: true, saveStrategy: 'finally' as const };

      it('excludes save step from task when saveStrategy is "finally"', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [finallySpec],
        });
        t.synth(chart, 'ns');
        const names = chart.toJson()[0].spec.steps.map((s: any) => s.name);
        expect(names).toContain('restore-npm-cache');
        expect(names).not.toContain('save-npm-cache');
      });

      it('restore step writes hash to cache PVC for finally strategy', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [finallySpec],
        });
        t.synth(chart, 'ns');
        const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
        // Hash file should be on the cache PVC, not /tekton/home
        expect(restore.script).toContain('$(workspaces.npm-cache.path)/.cache-npm-hash-c');
        expect(restore.script).not.toContain('/tekton/home');
      });

      it('getCacheFinallyTasks returns save tasks for finally strategy', () => {
        const t = new Task({
          name: 'build-go',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [finallySpec],
        });
        const finallyTasks = t.getCacheFinallyTasks();
        expect(finallyTasks).toHaveLength(1);
        expect(finallyTasks[0].name).toBe('save-npm-cache-build-go');
        expect(finallyTasks[0].workspaces.map(w => w.name)).toContain('npm-cache');
      });

      it('getCacheFinallyTasks returns empty for step strategy', () => {
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, compress: true }],
        });
        expect(t.getCacheFinallyTasks()).toHaveLength(0);
      });

      it('step strategy still uses pod-local hash file', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, compress: true }],
        });
        t.synth(chart, 'ns');
        const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
        expect(restore.script).toContain('/tekton/home/.cache-npm-hash');
      });
    });

    describe('forceSave', () => {
      it('compressed save skips existing archive by default', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, compress: true }],
        });
        t.synth(chart, 'ns');
        const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
        expect(save.script).toContain('exists, skipping');
      });

      it('forceSave removes the skip-existing check', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, compress: true, forceSave: true }],
        });
        t.synth(chart, 'ns');
        const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
        expect(save.script).not.toContain('exists, skipping');
        expect(save.script).toContain('compressing');
      });
    });

    describe('empty key (static hash)', () => {
      it('compressed restore uses static hash when key is empty', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, key: [], compress: true }],
        });
        t.synth(chart, 'ns');
        const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
        expect(restore.script).toContain('"" | hash sha256');
        expect(restore.script).not.toContain('open --raw');
      });

      it('uncompressed restore uses static hash when key is empty', () => {
        const app = new App();
        const chart = new Chart(app, 'test');
        const t = new Task({
          name: 'c',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [{ ...cacheSpec, key: [] }],
        });
        t.synth(chart, 'ns');
        const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
        expect(restore.script).toContain('echo -n ""');
        expect(restore.script).toContain('sha256sum');
      });
    });

    it('task with no caches is unchanged', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({ name: 'plain', steps: [{ name: 's', image: 'alpine' }] });
      t.synth(chart, 'ns');
      const manifest = chart.toJson()[0];
      expect(manifest.spec.steps).toHaveLength(1);
      expect(manifest.spec.steps[0].name).toBe('s');
    });
  });

  describe('multiThreadCompression', () => {
    const cacheWs = new Workspace({ name: 'npm-cache' });

    it('defaults to -T1 for PVC backend', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'c',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'], workspace: cacheWs, compress: true }],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.script).toContain('-T1');
      expect(restore.script).not.toContain('-T0');
    });

    it('uses -T0 when multiThreadCompression is true', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'c',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'], workspace: cacheWs, compress: true, multiThreadCompression: true }],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.script).toContain('-T0');
      const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
      expect(save.script).toContain('-T0');
    });

    it('defaults to -T0 for GCS backend', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'c',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'], compress: true, backend: gcs({ bucket: 'my-bucket' }) }],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.script).toContain('-T0');
    });

    it('GCS backend can be overridden to -T1', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'c',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'], compress: true, backend: gcs({ bucket: 'my-bucket' }), multiThreadCompression: false }],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.script).toContain('-T1');
    });
  });

  describe('GCS cache backend', () => {
    const gcsCacheSpec = {
      name: 'npm',
      key: ['package-lock.json'],
      paths: ['node_modules'],
      compress: true,
      backend: gcs({ bucket: 'my-ci-cache', prefix: 'tekton/' }),
    };

    it('does not auto-add workspace for GCS cache', () => {
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      expect(t.workspaces).toHaveLength(0);
    });

    it('injects restore and save steps named after cache name', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 'run', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const names = chart.toJson()[0].spec.steps.map((s: any) => s.name);
      expect(names[0]).toBe('restore-npm-cache');
      expect(names[1]).toBe('run');
      expect(names[2]).toBe('save-npm-cache');
    });

    it('restore script uses gcloud storage ls for existence check', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.script).toContain('gcloud storage ls $gcs_url | complete');
      expect(restore.script).not.toContain('metadata.google.internal');
      expect(restore.script).not.toContain('access_token');
    });

    it('restore script checks GCS object and uses prefix', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.script).toContain('gcloud storage');
      expect(restore.script).toContain('my-ci-cache');
      expect(restore.script).toContain('tekton/');
    });

    it('restore script logs download speed', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.script).toContain('MB/s');
      expect(restore.script).toContain('restored in');
    });

    it('save script uploads archive to GCS', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
      expect(save.script).toContain('gcloud storage cp');
      expect(save.script).toContain('my-ci-cache');
    });

    it('save script logs compression ratio and upload speed', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
      expect(save.script).toContain('ratio=');
      expect(save.script).toContain('MB/s');
      expect(save.script).toContain('uploaded ($gcs_url)');
    });

    it('save script evicts old entries via gcloud storage', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
      expect(save.script).toContain('gcloud storage ls -l');
      expect(save.script).toContain('let result = (^gcloud storage rm $e.url | complete)');
      expect(save.script).toContain('if $result.exit_code == 0');
      expect(save.script).toContain('warn: failed to evict');
      expect(save.script).toContain('sort-by created');
    });

    it('uses default GCS compression level (3)', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
      expect(save.script).toContain('zstd -3');
    });

    it('respects custom compression level', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ ...gcsCacheSpec, compressionLevel: 7 }],
      });
      t.synth(chart, 'ns');
      const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
      expect(save.script).toContain('zstd -7');
    });

    it('save step has onError: continue', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
      expect(save.onError).toBe('continue');
    });

    it('GCS without prefix uses empty string', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const noPrefix = { ...gcsCacheSpec, backend: gcs({ bucket: 'my-bucket' }) };
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [noPrefix],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.script).toContain('let object = $"($hash).tar.zst"');
    });

    it('forceSave removes the skip-existing check', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ ...gcsCacheSpec, forceSave: true }],
      });
      t.synth(chart, 'ns');
      const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
      expect(save.script).not.toContain('exists, skipping');
    });

    it('uses hash file in pod-local path keyed by cache name', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.script).toContain('/tekton/home/.cache-npm-hash');
    });

    it('getCacheFinallyTasks returns tasks without cache workspace for GCS', () => {
      const ws = new Workspace({ name: 'workspace' });
      const t = new Task({
        name: 'gcs-task',
        workspaces: [ws],
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ ...gcsCacheSpec, saveStrategy: 'finally' }],
      });
      const finallyTasks = t.getCacheFinallyTasks();
      expect(finallyTasks).toHaveLength(1);
      expect(finallyTasks[0].name).toBe('save-npm-cache-gcs-task');
      expect(finallyTasks[0].workspaces.map(w => w.name)).toEqual(['workspace']);
    });

    it('uses DEFAULT_GCS_CACHE_IMAGE for GCS cache steps', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [gcsCacheSpec],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
      expect(restore.image).toBe(DEFAULT_GCS_CACHE_IMAGE);
      expect(save.image).toBe(DEFAULT_GCS_CACHE_IMAGE);
    });

    it('respects custom image override for GCS steps', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ ...gcsCacheSpec, image: 'my-custom-image:latest' }],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.image).toBe('my-custom-image:latest');
    });

    it('empty key produces static hash', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ ...gcsCacheSpec, key: [] }],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.script).toContain('"" | hash sha256');
    });

    it('propagates workingDir to cache steps', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ ...gcsCacheSpec, workingDir: '$(workspaces.workspace.path)' }],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.workingDir).toBe('$(workspaces.workspace.path)');
    });

    it('restore script handles subdirectory paths in cache_paths', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const subdirSpec = {
        name: 'go',
        key: ['api/go.sum'],
        paths: ['api/vendor'],
        compress: true,
        backend: gcs({ bucket: 'my-ci-cache' }),
        workingDir: '$(workspaces.workspace.path)',
      };
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [subdirSpec],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-go-cache');
      expect(restore.script).toContain('"api/vendor"');
      expect(restore.script).toContain('"api/go.sum"');
      expect(restore.script).toContain('rm -rf $p');
    });

    it('save script handles subdirectory paths', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const subdirSpec = {
        name: 'go',
        key: ['api/go.sum'],
        paths: ['api/vendor'],
        compress: true,
        backend: gcs({ bucket: 'my-ci-cache' }),
        workingDir: '$(workspaces.workspace.path)',
      };
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [subdirSpec],
      });
      t.synth(chart, 'ns');
      const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-go-cache');
      expect(save.script).toContain('"api/vendor"');
      expect(save.script).toContain('tar cf - ...$paths');
    });

    it('supports multiple caches for different subdirectory projects', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const goCache = {
        name: 'go',
        key: ['api/go.sum'],
        paths: ['api/vendor'],
        compress: true,
        backend: gcs({ bucket: 'my-ci-cache' }),
        workingDir: '$(workspaces.workspace.path)',
      };
      const npmCache = {
        name: 'npm',
        key: ['web/package-lock.json'],
        paths: ['web/node_modules'],
        compress: true,
        backend: gcs({ bucket: 'my-ci-cache' }),
        workingDir: '$(workspaces.workspace.path)',
      };
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [goCache, npmCache],
      });
      t.synth(chart, 'ns');
      const steps = chart.toJson()[0].spec.steps;
      const goRestore = steps.find((s: any) => s.name === 'restore-go-cache');
      const npmRestore = steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(goRestore).toBeDefined();
      expect(npmRestore).toBeDefined();
      expect(goRestore.script).toContain('api/go.sum');
      expect(goRestore.script).toContain('"api/vendor"');
      expect(npmRestore.script).toContain('web/package-lock.json');
      expect(npmRestore.script).toContain('"web/node_modules"');
    });

    it('propagates computeResources to cache steps', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const resources = { requests: { cpu: '50m', memory: '64Mi' } };
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ ...gcsCacheSpec, computeResources: resources }],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.computeResources).toEqual(resources);
    });

    it('respects custom image', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      const t = new Task({
        name: 'gcs-task',
        steps: [{ name: 's', image: 'alpine' }],
        caches: [{ ...gcsCacheSpec, image: 'custom:latest' }],
      });
      t.synth(chart, 'ns');
      const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
      expect(restore.image).toBe('custom:latest');
    });
  });

  describe('sidecars', () => {
    it('emits sidecars in the synthesized Task spec', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      new Task({
        name: 'with-sidecar',
        steps: [{ name: 'run', image: 'alpine' }],
        sidecars: [{
          name: 'postgres',
          image: 'postgres:16-alpine',
          env: [{ name: 'POSTGRES_PASSWORD', value: 'test' }],
        }],
      }).synth(chart, 'ns');
      const manifest = chart.toJson()[0] as any;

      expect(manifest.spec.sidecars).toHaveLength(1);
      expect(manifest.spec.sidecars[0].name).toBe('postgres');
      expect(manifest.spec.sidecars[0].image).toBe('postgres:16-alpine');
      expect(manifest.spec.sidecars[0].env).toEqual([{ name: 'POSTGRES_PASSWORD', value: 'test' }]);
    });

    it('omits sidecars from spec when none declared', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      new Task({ name: 'bare', steps: [{ name: 's', image: 'alpine' }] }).synth(chart, 'ns');
      const manifest = chart.toJson()[0] as any;

      expect(manifest.spec.sidecars).toBeUndefined();
    });
  });

  describe('volumes', () => {
    it('emits volumes in the synthesized Task spec', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      new Task({
        name: 'with-volume',
        steps: [{ name: 'run', image: 'alpine' }],
        volumes: [
          { name: 'shared', emptyDir: {} },
          { name: 'config', configMap: { name: 'my-config' } },
        ],
      }).synth(chart, 'ns');
      const manifest = chart.toJson()[0] as any;

      expect(manifest.spec.volumes).toHaveLength(2);
      expect(manifest.spec.volumes[0]).toEqual({ name: 'shared', emptyDir: {} });
      expect(manifest.spec.volumes[1]).toEqual({ name: 'config', configMap: { name: 'my-config' } });
    });

    it('omits volumes from spec when none declared', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      new Task({ name: 'bare', steps: [{ name: 's', image: 'alpine' }] }).synth(chart, 'ns');
      const manifest = chart.toJson()[0] as any;

      expect(manifest.spec.volumes).toBeUndefined();
    });
  });

  describe('volumeMounts', () => {
    it('passes volumeMounts through in synthesized step spec', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      new Task({
        name: 'buildkit',
        steps: [{
          name: 'build',
          image: 'moby/buildkit:latest',
          volumeMounts: [
            { name: 'buildkit-socket', mountPath: '/run/buildkit' },
            { name: 'docker-config', mountPath: '/root/.docker', readOnly: true },
          ],
        }],
        volumes: [{ name: 'buildkit-socket', emptyDir: {} }],
      }).synth(chart, 'ns');
      const step = chart.toJson()[0].spec.steps[0];
      expect(step.volumeMounts).toEqual([
        { name: 'buildkit-socket', mountPath: '/run/buildkit' },
        { name: 'docker-config', mountPath: '/root/.docker', readOnly: true },
      ]);
    });

    it('omits volumeMounts from step when not declared', () => {
      const app = new App();
      const chart = new Chart(app, 'test');
      new Task({ name: 'bare', steps: [{ name: 's', image: 'alpine' }] }).synth(chart, 'ns');
      expect(chart.toJson()[0].spec.steps[0].volumeMounts).toBeUndefined();
    });
  });

  describe('_toPipelineTaskSpec()', () => {
    it('generates correct spec with taskRef, params, workspaces, runAfter', () => {
      const t = new Task({
        name: 'test',
        params: [urlParam],
        workspaces: [workspace],
        steps: [{ name: 'run', image: 'alpine' }],
      });
      const spec = t._toPipelineTaskSpec(['clone']);
      expect(spec).toEqual({
        name: 'test',
        taskRef: { kind: 'Task', name: 'test' },
        params: [{ name: 'url', value: '$(params.url)' }],
        workspaces: [{ name: 'workspace', workspace: 'workspace' }],
        runAfter: ['clone'],
      });
    });

    it('applies namePrefix to taskRef', () => {
      const t = new Task({ name: 'build', steps: [{ name: 's', image: 'alpine' }] });
      const spec = t._toPipelineTaskSpec([], 'myapp');
      expect(spec.taskRef).toEqual({ kind: 'Task', name: 'myapp-build' });
    });

    it('omits runAfter when empty', () => {
      const t = new Task({ name: 'first', steps: [{ name: 's', image: 'alpine' }] });
      const spec = t._toPipelineTaskSpec([]);
      expect(spec.runAfter).toBeUndefined();
    });
  });

  describe('script authoring', () => {
    const stepScript = (t: Task): string => {
      const app = new App();
      const chart = new Chart(app, 'c');
      t.synth(chart, 'ns');
      return chart.toJson()[0].spec.steps[0].script;
    };

    it('renders a language-tagged body to a shebang script', () => {
      const t = new Task({
        name: 'fmt',
        steps: [{ name: 's', image: 'alpine', script: nu`log "hi"` }],
      });
      const s = stepScript(t);
      expect(s.startsWith('#!/usr/bin/env nu')).toBe(true);
      expect(s).toContain('def log [msg: string]');
      expect(s).toContain('log "hi"');
    });

    it('passes a raw shebang string through unchanged', () => {
      const raw = '#!/bin/sh\necho hi';
      const t = new Task({ name: 'r', steps: [{ name: 's', image: 'alpine', script: raw }] });
      expect(stepScript(t)).toBe(raw);
    });

    it('applies the task defaultLanguage to a bare string', () => {
      const t = new Task({
        name: 'd',
        defaultLanguage: 'bash',
        steps: [{ name: 's', image: 'alpine', script: 'echo hi' }],
      });
      expect(stepScript(t).startsWith('#!/usr/bin/env bash')).toBe(true);
    });

    it('lets the project defaultLanguage apply when the task has none', () => {
      const t = new Task({ name: 'p', steps: [{ name: 's', image: 'alpine', script: 'echo hi' }] });
      const app = new App();
      const chart = new Chart(app, 'c');
      t.synth(chart, 'ns', undefined, undefined, 'bash');
      expect(chart.toJson()[0].spec.steps[0].script.startsWith('#!/usr/bin/env bash')).toBe(true);
    });
  });

  describe('status contract (m8d)', () => {
    const synthSteps = (t: Task) => {
      const app = new App();
      const chart = new Chart(app, 'c');
      t.synth(chart, 'ns');
      return chart.toJson()[0].spec.steps as Array<Record<string, string>>;
    };

    it('captures exit code + injects onError on user steps, and the reporter reads the contract', () => {
      const t = new Task({
        name: 'fmt',
        statusReporter: new GitHubStatusReporter(),
        steps: [{ name: 'fmt', image: 'alpine', script: nu`log "hi"` }],
      });
      const steps = synthSteps(t);
      const user = steps.find((s) => s.name === 'fmt')!;
      expect(user.onError).toBe('continue');
      expect(user.script).toContain('math max');
      expect(user.script).toContain(`save -f ${EXIT_CODE_PATH}`);
      const report = steps.find((s) => s.name === 'report-status')!;
      expect(report.script).toContain(EXIT_CODE_PATH);
    });

    it('does not capture or inject onError when there is no reporter', () => {
      const t = new Task({
        name: 'fmt',
        steps: [{ name: 'fmt', image: 'alpine', script: nu`log "hi"` }],
      });
      const user = synthSteps(t).find((s) => s.name === 'fmt')!;
      expect(user.onError).toBeUndefined();
      expect(user.script).not.toContain('math max');
      expect(user.script).not.toContain(EXIT_CODE_PATH);
    });

    it('preserves an explicit step onError', () => {
      const t = new Task({
        name: 'fmt',
        statusReporter: new GitHubStatusReporter(),
        steps: [{ name: 'fmt', image: 'alpine', script: nu`log "hi"`, onError: 'stopAndFail' }],
      });
      const user = synthSteps(t).find((s) => s.name === 'fmt')!;
      expect(user.onError).toBe('stopAndFail');
    });
  });
});

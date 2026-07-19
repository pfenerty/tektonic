import { describe, it, expect } from 'vitest';
import { globToRegex, triggerEvents, triggerAnnotations } from './pac-trigger';
import { TRIGGER_EVENTS } from './trigger-events';

const PAC = 'pipelinesascode.tekton.dev';

describe('globToRegex', () => {
  it('maps ** to .* and * to [^/]*, anchored', () => {
    expect(globToRegex('src/**')).toBe('^src/.*$');
    expect(globToRegex('src/*.ts')).toBe('^src/[^/]*\\.ts$');
    expect(globToRegex('package.json')).toBe('^package\\.json$');
  });
});

describe('triggerEvents', () => {
  it('unions and dedups rule events', () => {
    expect(
      triggerEvents({
        rules: [
          { on: [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST] },
          { on: TRIGGER_EVENTS.PUSH },
        ],
      }),
    ).toEqual([TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST]);
  });
});

describe('triggerAnnotations — simple (single rule) → discrete', () => {
  it('emits on-event / on-target-branch / on-path-changed', () => {
    const a = triggerAnnotations({
      rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST, branch: 'main', pathsChanged: ['src/**'] }],
    });
    expect(a[`${PAC}/on-event`]).toBe('[pull_request]');
    expect(a[`${PAC}/on-target-branch`]).toBe('[main]');
    expect(a[`${PAC}/on-path-changed`]).toBe('[src/**]');
    expect(a[`${PAC}/on-cel-expression`]).toBeUndefined();
  });

  it('defaults on-target-branch to [*] and forces refs/tags/* for TAG', () => {
    expect(triggerAnnotations({ rules: [{ on: TRIGGER_EVENTS.PUSH }] })[`${PAC}/on-target-branch`]).toBe('[*]');
    expect(triggerAnnotations({ rules: [{ on: TRIGGER_EVENTS.TAG }] })[`${PAC}/on-target-branch`]).toBe('[refs/tags/*]');
  });
});

describe('triggerAnnotations — compound → on-cel-expression', () => {
  it('OR-joins rules and folds event/branch/source/paths into CEL', () => {
    const a = triggerAnnotations({
      rules: [
        { on: [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST], branch: 'main' },
        { on: TRIGGER_EVENTS.PULL_REQUEST, sourceBranch: 'feature/*', pathsChanged: ['src/**'] },
      ],
    });
    const cel = a[`${PAC}/on-cel-expression`];
    expect(cel).toBeDefined();
    expect(a[`${PAC}/on-event`]).toBeUndefined();
    expect(cel).toContain("event in ['push', 'pull_request']");
    expect(cel).toContain("target_branch == 'main'");
    expect(cel).toContain("source_branch.matches('^feature/[^/]*$')");
    expect(cel).toContain("files.all.exists(f, f.matches('^src/.*$'))");
    expect(cel).toContain(' || ');
  });

  it('a single rule with a sourceBranch also uses CEL', () => {
    const a = triggerAnnotations({ rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST, sourceBranch: 'feature/*' }] });
    expect(a[`${PAC}/on-cel-expression`]).toContain("source_branch.matches(");
    expect(a[`${PAC}/on-event`]).toBeUndefined();
  });

  it('raw cel replaces the whole expression', () => {
    const a = triggerAnnotations({ rules: [{ on: TRIGGER_EVENTS.PUSH }], cel: "event == 'push'" });
    expect(a[`${PAC}/on-cel-expression`]).toBe("event == 'push'");
  });
});

describe('triggerAnnotations — orthogonal annotations', () => {
  it('emits comment / label / cancel-in-progress in both modes', () => {
    const a = triggerAnnotations({
      rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST, branch: 'main' }],
      comment: '^/ci',
      labels: ['ci', 'ready'],
      cancelInProgress: true,
    });
    expect(a[`${PAC}/on-comment`]).toBe('^/ci');
    expect(a[`${PAC}/on-label`]).toBe('[ci, ready]');
    expect(a[`${PAC}/cancel-in-progress`]).toBe('true');
  });
});

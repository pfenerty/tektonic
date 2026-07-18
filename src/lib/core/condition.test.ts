import { describe, it, expect } from 'vitest';
import {
  Condition,
  equals,
  notEquals,
  isIn,
  notIn,
  matches,
  and,
  or,
  not,
  normalizeWhen,
  onBranch,
  onBranches,
  onBranchMatching,
  GIT_BRANCH_REF,
} from './condition';
import { Param } from './param';

describe('condition constructors', () => {
  it('equals compiles to a classic in clause with the handle string', () => {
    const p = new Param({ name: 'route' });
    expect(equals(p, 'go').compile()).toEqual([
      { input: '$(params.route)', operator: 'in', values: ['go'] },
    ]);
  });

  it('notEquals compiles to notin', () => {
    expect(notEquals('$(params.x)', 'a').compile()).toEqual([
      { input: '$(params.x)', operator: 'notin', values: ['a'] },
    ]);
  });

  it('isIn / notIn carry the full value list', () => {
    expect(isIn('$(params.x)', ['a', 'b']).compile()).toEqual([
      { input: '$(params.x)', operator: 'in', values: ['a', 'b'] },
    ]);
    expect(notIn('$(params.x)', ['a', 'b']).compile()).toEqual([
      { input: '$(params.x)', operator: 'notin', values: ['a', 'b'] },
    ]);
  });

  it('matches compiles to a quoted CEL matches() guard', () => {
    expect(matches('$(params.branch)', 'release/.*').compile()).toEqual([
      { cel: "'$(params.branch)'.matches('release/.*')" },
    ]);
  });
});

describe('composition', () => {
  it('and concatenates clauses (Tekton when = AND)', () => {
    const c = equals('$(params.a)', '1').and(equals('$(params.b)', '2'));
    expect(c.compile()).toEqual([
      { input: '$(params.a)', operator: 'in', values: ['1'] },
      { input: '$(params.b)', operator: 'in', values: ['2'] },
    ]);
  });

  it('and() free function behaves the same', () => {
    expect(and(equals('$(params.a)', '1'), equals('$(params.b)', '2')).compile()).toHaveLength(2);
  });

  it('or compiles to a single CEL clause joined with ||', () => {
    const clauses = or(onBranch('main'), onBranch('release')).compile();
    expect(clauses).toHaveLength(1);
    expect('cel' in clauses[0]).toBe(true);
    const cel = (clauses[0] as { cel: string }).cel;
    expect(cel).toContain('||');
    expect(cel).toContain(`'${GIT_BRANCH_REF}' in ['main']`);
    expect(cel).toContain(`'${GIT_BRANCH_REF}' in ['release']`);
  });

  it('not(equals) flips in to notin and stays classic (no flag)', () => {
    expect(not(equals('$(params.x)', 'a')).compile()).toEqual([
      { input: '$(params.x)', operator: 'notin', values: ['a'] },
    ]);
  });

  it('not(notEquals) flips back to in', () => {
    expect(not(notEquals('$(params.x)', 'a')).compile()).toEqual([
      { input: '$(params.x)', operator: 'in', values: ['a'] },
    ]);
  });

  it('not(and(...)) falls back to a negated CEL clause', () => {
    const clauses = not(and(equals('$(params.a)', '1'), equals('$(params.b)', '2'))).compile();
    expect(clauses).toHaveLength(1);
    expect((clauses[0] as { cel: string }).cel.startsWith('!(')).toBe(true);
  });
});

describe('branch helpers', () => {
  it('onBranch references the well-known git-clone branch result (classic)', () => {
    expect(onBranch('main').compile()).toEqual([
      { input: GIT_BRANCH_REF, operator: 'in', values: ['main'] },
    ]);
    expect(GIT_BRANCH_REF).toBe('$(tasks.git-clone.results.branch)');
  });

  it('onBranches lists all branches', () => {
    expect(onBranches(['main', 'develop']).compile()).toEqual([
      { input: GIT_BRANCH_REF, operator: 'in', values: ['main', 'develop'] },
    ]);
  });

  it('onBranchMatching compiles to a CEL matches() guard', () => {
    expect(onBranchMatching('^(main|release/.*)$').compile()).toEqual([
      { cel: `'${GIT_BRANCH_REF}'.matches('^(main|release/.*)$')` },
    ]);
  });
});

describe('normalizeWhen', () => {
  it('compiles a Condition', () => {
    expect(normalizeWhen(onBranch('main'))).toEqual([
      { input: GIT_BRANCH_REF, operator: 'in', values: ['main'] },
    ]);
  });

  it('passes raw clauses through unchanged', () => {
    const raw = [{ input: '$(params.x)', operator: 'in' as const, values: ['a'] }];
    expect(normalizeWhen(raw)).toBe(raw);
  });

  it('a Condition is an instanceof Condition', () => {
    expect(onBranch('main')).toBeInstanceOf(Condition);
  });
});

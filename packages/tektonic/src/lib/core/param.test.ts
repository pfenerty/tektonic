import { describe, it, expect } from 'vitest';
import { Param } from './param';

describe('Param', () => {
  it('stores name and defaults type to string', () => {
    const p = new Param({ name: 'url' });
    expect(p.name).toBe('url');
    expect(p.type).toBe('string');
    expect(p.default).toBeUndefined();
    expect(p.description).toBeUndefined();
  });

  it('stores all options', () => {
    const p = new Param({ name: 'items', type: 'array', default: ['a', 'b'], description: 'list of items' });
    expect(p.type).toBe('array');
    expect(p.default).toEqual(['a', 'b']);
    expect(p.description).toBe('list of items');
  });

  it('toString() returns $(params.<name>)', () => {
    const p = new Param({ name: 'revision' });
    expect(p.toString()).toBe('$(params.revision)');
    expect(`ref: ${p}`).toBe('ref: $(params.revision)');
  });

  it('toSpec() returns correct Tekton param spec', () => {
    const p = new Param({ name: 'url', type: 'string' });
    expect(p.toSpec()).toEqual({ name: 'url', type: 'string' });
  });

  it('toSpec() includes default and description when set', () => {
    const p = new Param({ name: 'path', default: './', description: 'build path' });
    expect(p.toSpec()).toEqual({
      name: 'path',
      type: 'string',
      default: './',
      description: 'build path',
    });
  });
});

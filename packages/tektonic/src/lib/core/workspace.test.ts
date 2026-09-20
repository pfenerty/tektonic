import { describe, it, expect } from 'vitest';
import { Workspace } from './workspace';

describe('Workspace', () => {
  it('stores name and defaults optional to false', () => {
    const w = new Workspace({ name: 'source' });
    expect(w.name).toBe('source');
    expect(w.optional).toBe(false);
    expect(w.description).toBeUndefined();
  });

  it('path returns $(workspaces.<name>.path)', () => {
    const w = new Workspace({ name: 'workspace' });
    expect(w.path).toBe('$(workspaces.workspace.path)');
  });

  it('bound returns $(workspaces.<name>.bound)', () => {
    const w = new Workspace({ name: 'workspace' });
    expect(w.bound).toBe('$(workspaces.workspace.bound)');
  });

  it('path works in template literals', () => {
    const w = new Workspace({ name: 'ws' });
    expect(`${w.path}/src`).toBe('$(workspaces.ws.path)/src');
  });

  it('toSpec() returns correct workspace declaration', () => {
    const w = new Workspace({ name: 'source' });
    expect(w.toSpec()).toEqual({ name: 'source' });
  });

  it('toSpec() includes optional and description when set', () => {
    const w = new Workspace({ name: 'creds', optional: true, description: 'credentials' });
    expect(w.toSpec()).toEqual({ name: 'creds', optional: true, description: 'credentials' });
  });
});

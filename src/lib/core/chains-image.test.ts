import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { ChainsImage } from './chains-image';
import { Task } from './task';

describe('ChainsImage', () => {
  it('creates an IMAGE_URL / IMAGE_DIGEST result pair from the name', () => {
    const api = new ChainsImage({ name: 'api' });
    const names = api.results.map(r => r.name);
    expect(api.results).toHaveLength(2);
    expect(names).toEqual(['api-IMAGE_URL', 'api-IMAGE_DIGEST']);
  });

  it('result names carry the Chains type-hint suffixes', () => {
    const api = new ChainsImage({ name: 'scanner-worker' });
    expect(api.urlResult.name.endsWith('IMAGE_URL')).toBe(true);
    expect(api.digestResult.name.endsWith('IMAGE_DIGEST')).toBe(true);
  });

  it('exposes step write paths for url and digest', () => {
    const api = new ChainsImage({ name: 'api' });
    expect(api.urlPath).toBe('$(results.api-IMAGE_URL.path)');
    expect(api.digestPath).toBe('$(results.api-IMAGE_DIGEST.path)');
  });

  it('path getters work before the results are attached to a Task', () => {
    const api = new ChainsImage({ name: 'api' });
    expect(() => api.urlPath).not.toThrow();
    expect(() => api.digestPath).not.toThrow();
  });

  it('url/digest pipeline references throw until attached to a Task', () => {
    const api = new ChainsImage({ name: 'api' });
    expect(() => api.url).toThrow(/not bound to a task/);
    expect(() => api.digest).toThrow(/not bound to a task/);
  });

  it('url/digest produce pipeline references once attached to a Task', () => {
    const api = new ChainsImage({ name: 'api' });
    new Task({
      name: 'build-api',
      results: [...api.results],
      steps: [{ name: 'build', image: 'moby/buildkit:rootless' }],
    });
    expect(api.url).toBe('$(tasks.build-api.results.api-IMAGE_URL)');
    expect(api.digest).toBe('$(tasks.build-api.results.api-IMAGE_DIGEST)');
  });

  it('renders the result pair into the synthesized Task spec', () => {
    const api = new ChainsImage({ name: 'api' });
    const task = new Task({
      name: 'build-api',
      results: [...api.results],
      steps: [{ name: 'build', image: 'moby/buildkit:rootless' }],
    });
    const app = new App();
    const chart = new Chart(app, 'c');
    task.synth(chart, 'ns');
    const manifest = chart.toJson().find((m: any) => m.kind === 'Task' && m.metadata.name === 'build-api');
    const resultNames = manifest.spec.results.map((r: any) => r.name);
    expect(resultNames).toContain('api-IMAGE_URL');
    expect(resultNames).toContain('api-IMAGE_DIGEST');
  });

  it('distinct names produce distinct result prefixes for multiple images', () => {
    const a = new ChainsImage({ name: 'api' });
    const b = new ChainsImage({ name: 'web' });
    const all = [...a.results, ...b.results].map(r => r.name);
    expect(new Set(all).size).toBe(4);
    expect(all).toContain('web-IMAGE_DIGEST');
  });
});

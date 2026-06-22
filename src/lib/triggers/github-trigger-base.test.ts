import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { GitHubPushTrigger } from './github-push.trigger';

describe('GitHubTriggerBase', () => {
  const baseProps = {
    namespace: 'test-ns',
    pipelineRef: 'my-pipeline',
  };

  const getTriggerTemplate = (props: object) => {
    const app = new App();
    const chart = new Chart(app, 'test');
    new GitHubPushTrigger(chart, 'trigger', { ...baseProps, ...props } as any);
    return chart.toJson().find((m: any) => m.kind === 'TriggerTemplate');
  };

  const getPipelineRunWorkspaces = (props: object) => {
    const template = getTriggerTemplate(props);
    return template.spec.resourcetemplates[0].spec.workspaces;
  };

  describe('workspace bindings in PipelineRun', () => {
    it('has only the main ephemeral workspace when cacheWorkspaces is empty', () => {
      const workspaces = getPipelineRunWorkspaces({ cacheWorkspaces: [] });
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].name).toBe('workspace');
      expect(workspaces[0].volumeClaimTemplate).toBeDefined();
    });

    it('has only the main ephemeral workspace when cacheWorkspaces is omitted', () => {
      const workspaces = getPipelineRunWorkspaces({});
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].name).toBe('workspace');
    });

    it('adds persistentVolumeClaim binding for each cacheWorkspace', () => {
      const workspaces = getPipelineRunWorkspaces({
        cacheWorkspaces: [{ workspaceName: 'grype-cache', claimName: 'myapp-grype-cache' }],
      });
      expect(workspaces).toHaveLength(2);
      expect(workspaces[1].name).toBe('grype-cache');
      expect(workspaces[1].persistentVolumeClaim).toEqual({ claimName: 'myapp-grype-cache' });
    });

    it('adds multiple cache workspace bindings', () => {
      const workspaces = getPipelineRunWorkspaces({
        cacheWorkspaces: [
          { workspaceName: 'cache-a', claimName: 'pvc-a' },
          { workspaceName: 'cache-b', claimName: 'pvc-b' },
        ],
      });
      expect(workspaces).toHaveLength(3);
      expect(workspaces[1].name).toBe('cache-a');
      expect(workspaces[2].name).toBe('cache-b');
    });

    it('uses workspaceStorageSize for the ephemeral workspace', () => {
      const workspaces = getPipelineRunWorkspaces({ workspaceStorageSize: '5Gi' });
      expect(workspaces[0].volumeClaimTemplate.spec.resources.requests.storage).toBe('5Gi');
    });

    it('defaults workspaceStorageSize to 1Gi', () => {
      const workspaces = getPipelineRunWorkspaces({});
      expect(workspaces[0].volumeClaimTemplate.spec.resources.requests.storage).toBe('1Gi');
    });
  });

  describe('pipelineRunAnnotations', () => {
    const getPipelineRun = (props: object) =>
      getTriggerTemplate(props).spec.resourcetemplates[0];

    it('merges pipelineRunAnnotations into the PipelineRun template metadata', () => {
      const pr = getPipelineRun({
        pipelineRunAnnotations: { 'chains.tekton.dev/transparency-upload': 'true' },
      });
      expect(pr.metadata.annotations['chains.tekton.dev/transparency-upload']).toBe('true');
    });

    it('omits annotations when none provided', () => {
      const pr = getPipelineRun({});
      expect(pr.metadata.annotations).toBeUndefined();
    });
  });
});

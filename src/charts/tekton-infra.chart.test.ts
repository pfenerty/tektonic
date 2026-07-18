import { describe, it, expect } from 'vitest';
import { App } from 'cdk8s';
import { TektonInfraChart } from './tekton-infra.chart';
import { DEFAULT_POD_SECURITY_CONTEXT } from '../lib/constants';

describe('TektonInfraChart', () => {
  const baseProps = {
    namespace: 'test-ns',
    pushPipelineRef: 'push-pipeline',
    pullRequestPipelineRef: 'pr-pipeline',
  };

  describe('push branch overlay', () => {
    it('adds a CEL interceptor that normalizes the pushed ref into extensions.branch', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', { ...baseProps });
      const manifests = app.charts.flatMap(c => c.toJson());
      const el = manifests.find((m: any) => m.kind === 'EventListener');
      const pushTrigger = el.spec.triggers.find((t: any) =>
        t.interceptors?.some((i: any) =>
          i.params?.some((p: any) => Array.isArray(p.value) && p.value.includes('push')),
        ),
      );
      const cel = pushTrigger.interceptors.find((i: any) => i.ref.name === 'cel');
      const overlays = cel.params.find((p: any) => p.name === 'overlays').value;
      expect(overlays[0].key).toBe('branch');
      expect(overlays[0].expression).toContain("refs/heads/");
    });
  });

  describe('cache PVC generation', () => {
    it('generates a PVC for each cache entry', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', {
        ...baseProps,
        caches: [{
          workspaceName: 'grype-cache',
          claimName: 'myapp-grype-cache',
          storageSize: '2Gi',
        }],
      });
      const manifests = app.charts.flatMap(c => c.toJson());
      const pvc = manifests.find((m: any) => m.kind === 'PersistentVolumeClaim');
      expect(pvc).toBeDefined();
      expect(pvc.metadata.name).toBe('myapp-grype-cache');
      expect(pvc.metadata.namespace).toBe('test-ns');
      expect(pvc.spec.accessModes).toEqual(['ReadWriteOnce']);
      expect(pvc.spec.resources.requests.storage).toBe('2Gi');
    });

    it('includes storageClassName in PVC when provided', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', {
        ...baseProps,
        caches: [{
          workspaceName: 'grype-cache',
          claimName: 'myapp-grype-cache',
          storageSize: '1Gi',
          storageClassName: 'fast-ssd',
        }],
      });
      const manifests = app.charts.flatMap(c => c.toJson());
      const pvc = manifests.find((m: any) => m.kind === 'PersistentVolumeClaim');
      expect(pvc.spec.storageClassName).toBe('fast-ssd');
    });

    it('omits storageClassName from PVC when not provided', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', {
        ...baseProps,
        caches: [{
          workspaceName: 'grype-cache',
          claimName: 'myapp-grype-cache',
          storageSize: '1Gi',
        }],
      });
      const manifests = app.charts.flatMap(c => c.toJson());
      const pvc = manifests.find((m: any) => m.kind === 'PersistentVolumeClaim');
      expect(pvc.spec.storageClassName).toBeUndefined();
    });

    it('generates multiple PVCs for multiple cache entries', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', {
        ...baseProps,
        caches: [
          { workspaceName: 'cache-a', claimName: 'pvc-a', storageSize: '1Gi' },
          { workspaceName: 'cache-b', claimName: 'pvc-b', storageSize: '2Gi' },
        ],
      });
      const manifests = app.charts.flatMap(c => c.toJson());
      const pvcs = manifests.filter((m: any) => m.kind === 'PersistentVolumeClaim');
      expect(pvcs).toHaveLength(2);
      expect(pvcs.map((p: any) => p.metadata.name)).toContain('pvc-a');
      expect(pvcs.map((p: any) => p.metadata.name)).toContain('pvc-b');
    });

    it('generates no PVC when caches is empty', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', { ...baseProps, caches: [] });
      const manifests = app.charts.flatMap(c => c.toJson());
      const pvcs = manifests.filter((m: any) => m.kind === 'PersistentVolumeClaim');
      expect(pvcs).toHaveLength(0);
    });

    it('generates no PVC when caches is omitted', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', baseProps);
      const manifests = app.charts.flatMap(c => c.toJson());
      const pvcs = manifests.filter((m: any) => m.kind === 'PersistentVolumeClaim');
      expect(pvcs).toHaveLength(0);
    });

    it('defaults cache PVC accessModes to ReadWriteOnce when omitted', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', {
        ...baseProps,
        caches: [{ workspaceName: 'npm-cache', claimName: 'npm-pvc', storageSize: '2Gi' }],
      });
      const manifests = app.charts.flatMap(c => c.toJson());
      const pvc = manifests.find((m: any) => m.kind === 'PersistentVolumeClaim');
      expect(pvc.spec.accessModes).toEqual(['ReadWriteOnce']);
    });

    it('uses provided accessModes on cache PVC', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', {
        ...baseProps,
        caches: [{
          workspaceName: 'shared-cache',
          claimName: 'shared-pvc',
          storageSize: '5Gi',
          accessModes: ['ReadWriteMany'],
        }],
      });
      const manifests = app.charts.flatMap(c => c.toJson());
      const pvc = manifests.find((m: any) => m.kind === 'PersistentVolumeClaim');
      expect(pvc.spec.accessModes).toEqual(['ReadWriteMany']);
    });
  });

  describe('service account annotations', () => {
    it('omits annotations when not provided', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', baseProps);
      const manifests = app.charts.flatMap(c => c.toJson());
      const sa = manifests.find((m: any) => m.kind === 'ServiceAccount');
      expect(sa.metadata.annotations).toBeUndefined();
    });

    it('applies annotations to the service account', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', {
        ...baseProps,
        serviceAccountAnnotations: {
          'iam.gke.io/gcp-service-account': 'sa@project.iam.gserviceaccount.com',
        },
      });
      const manifests = app.charts.flatMap(c => c.toJson());
      const sa = manifests.find((m: any) => m.kind === 'ServiceAccount');
      expect(sa.metadata.annotations).toEqual({
        'iam.gke.io/gcp-service-account': 'sa@project.iam.gserviceaccount.com',
      });
    });
  });

  describe('pod security context', () => {
    // PipelineRuns live inside TriggerTemplate.spec.resourcetemplates, not as top-level resources
    const getPipelineRuns = (app: App) =>
      app.charts
        .flatMap(c => c.toJson())
        .filter((m: any) => m.kind === 'TriggerTemplate')
        .flatMap((tt: any) => tt.spec?.resourcetemplates ?? [])
        .filter((rt: any) => rt.kind === 'PipelineRun');

    it('applies DEFAULT_POD_SECURITY_CONTEXT to PipelineRun podTemplate by default', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', baseProps);
      const prs = getPipelineRuns(app);
      expect(prs.length).toBeGreaterThan(0);
      for (const pr of prs) {
        expect(pr.spec.taskRunTemplate.podTemplate.securityContext.fsGroup).toBe(DEFAULT_POD_SECURITY_CONTEXT.fsGroup);
        expect(pr.spec.taskRunTemplate.podTemplate.securityContext.runAsNonRoot).toBe(DEFAULT_POD_SECURITY_CONTEXT.runAsNonRoot);
      }
    });

    it('merges defaultPodSecurityContext on top of DEFAULT_POD_SECURITY_CONTEXT', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', {
        ...baseProps,
        defaultPodSecurityContext: { fsGroup: 2000, runAsUser: 2000 },
      });
      const prs = getPipelineRuns(app);
      expect(prs.length).toBeGreaterThan(0);
      for (const pr of prs) {
        expect(pr.spec.taskRunTemplate.podTemplate.securityContext.fsGroup).toBe(2000);
        expect(pr.spec.taskRunTemplate.podTemplate.securityContext.runAsUser).toBe(2000);
        // Other defaults still present
        expect(pr.spec.taskRunTemplate.podTemplate.securityContext.runAsNonRoot).toBe(true);
      }
    });

    it('pod securityContext does not contain container-only fields', () => {
      const app = new App();
      new TektonInfraChart(app, 'infra', baseProps);
      const prs = getPipelineRuns(app);
      for (const pr of prs) {
        expect(pr.spec.taskRunTemplate.podTemplate.securityContext.capabilities).toBeUndefined();
        expect(pr.spec.taskRunTemplate.podTemplate.securityContext.allowPrivilegeEscalation).toBeUndefined();
      }
    });
  });
});

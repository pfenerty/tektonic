# Secrets & security

Tektonic doesn't manage secrets — it wires Kubernetes Secrets into your steps using standard
mechanisms, so you stay in control of where secrets live and how they're provisioned. This guide
covers the two injection patterns (env vars and mounted files) and the secure-by-default
security contexts Tektonic applies.

## Secrets as environment variables

The most common pattern: reference a key from a `Secret` via `valueFrom.secretKeyRef` on a step.
The value is exposed as an env var inside the container and never written to disk:

```typescript
const release = new Task({
  name: 'gh-release',
  steps: [{
    name: 'release',
    image: baseImage,
    env: [
      { name: 'BUILD_ENV', value: 'production' },          // plain value
      {                                                     // from a Secret
        name: 'GITHUB_TOKEN',
        valueFrom: { secretKeyRef: { name: 'github-token', key: 'token' } },
      },
    ],
    script: nu`http post --headers [Authorization $"Bearer ($env.GITHUB_TOKEN)"] ...`,
  }],
});
```

Create the secret out of band before running the pipeline:

```bash
kubectl create secret generic github-token \
  --namespace=ci \
  --from-literal=token=YOUR_GITHUB_TOKEN
```

### Project-wide env (PAC)

To inject the same secret-backed env into **every** step of every task, use `PACProject`'s
`podTemplateEnv`. This is how the PAC git auth token is wired — its secret name is itself a PAC
template variable resolved before the run reaches Kubernetes:

```typescript
new PACProject({
  // ...
  podTemplateEnv: [{
    name: 'GITHUB_TOKEN',
    valueFrom: { secretKeyRef: { name: '{{ git_auth_secret }}', key: 'git-provider-token' } },
  }],
});
```

## Secrets as mounted files

When a tool expects a file (a Docker registry config, a kubeconfig, a TLS cert), declare a
`secret` volume on the task and mount it into the step with `volumeMounts`. Use `subPath` to
project a single key to a specific file path:

```typescript
import { Task, TaskVolumeSpec } from '@pfenerty/tektonic';

const dockerConfig: TaskVolumeSpec = {
  name: 'docker-config',
  secret: { secretName: 'ghcr-docker-config' },
};

const build = new Task({
  name: 'image-build',
  volumes: [dockerConfig],
  steps: [{
    name: 'build-and-push',
    image: 'moby/buildkit:rootless',
    env: [{ name: 'DOCKER_CONFIG', value: '/tmp/docker-auth' }],
    volumeMounts: [{
      name: 'docker-config',
      mountPath: '/tmp/docker-auth/config.json',
      subPath: '.dockerconfigjson',
      readOnly: true,
    }],
    script: buildScript,
  }],
});
```

`volumes` follows the Kubernetes `v1.Volume` schema, so `configMap`, `secret`,
`persistentVolumeClaim`, and `emptyDir` all work. Each `volumeMounts` entry must reference a
volume declared in the task's `volumes` (or a workspace-backed volume).

## Security defaults

Every task gets a secure-by-default `stepTemplate`, and every project pod gets a default pod
security context. You don't opt in — you opt out when a specific step needs more.

**Container level** (`DEFAULT_STEP_SECURITY_CONTEXT`, applied to all steps):

```yaml
allowPrivilegeEscalation: false
capabilities: { drop: [ALL] }
```

**Pod level** (`DEFAULT_POD_SECURITY_CONTEXT`, applied to each PipelineRun pod):

```yaml
runAsNonRoot: true
runAsUser: 1001
runAsGroup: 1001
fsGroup: 1001                       # chowns mounted volumes so non-root steps can write
seccompProfile: { type: RuntimeDefault }
```

`fsGroup` is what lets non-root steps write to a shared PVC workspace whose root may be owned by
root (e.g. with the local-path provisioner) — set it to match your storage rather than forcing a
universal `runAsUser`.

### Overriding

- **Per project:** `defaultPodSecurityContext` / `defaultStepSecurityContext` on
  `TektonProject`/`PACProject` are merged *over* the defaults.
- **Per step:** `securityContext` on a `TaskStepSpec` is applied on top of the task's
  stepTemplate. This is the escape hatch for steps that genuinely need more privilege — e.g. a
  rootless buildkit step that needs `SETUID`/`SETGID`:

  ```typescript
  securityContext: {
    seccompProfile: { type: 'Unconfined' },
    allowPrivilegeEscalation: true,
    runAsUser: 1000, runAsGroup: 1000,
    capabilities: { drop: [], add: ['SETUID', 'SETGID'] },
  }
  ```

- **Stricter steps:** `RESTRICTED_STEP_SECURITY_CONTEXT` adds `runAsNonRoot: true` at the
  container level; apply it via a task's `stepTemplate.securityContext`.

Keep privilege escalations scoped to the single step that needs them — the defaults should remain
in force everywhere else.

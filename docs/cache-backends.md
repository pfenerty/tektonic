# Custom Cache Backends

Tektonic ships two built-in cache backends:

| Backend | Class | Factory | Storage |
|---|---|---|---|
| PVC (default) | `PvcBackend` | _(no factory; omit `backend`)_ | Kubernetes PersistentVolumeClaim |
| GCS | `GcsBackend` | `gcs({ bucket, prefix? })` | Google Cloud Storage bucket |

When `TaskCacheSpec.backend` is omitted, Tektonic uses `PvcBackend` automatically.

## The `CacheBackend` interface

To write a custom backend, implement `CacheBackend`:

```typescript
import type { CacheBackend, BackendCtx } from '@pfenerty/tektonic';
import type { TaskCacheSpec, TaskStepSpec } from '@pfenerty/tektonic';

export class NoopBackend implements CacheBackend {
  readonly type = 'noop';
  readonly needsPvcWorkspace = false; // true only if your backend stores data on a PVC

  restoreStep(spec: TaskCacheSpec, taskName: string, ctx: BackendCtx): TaskStepSpec {
    return {
      name: `restore-${spec.name}-cache`,
      image: ctx.defaultBaseImage,
      script: `#!/bin/sh\necho "[noop] cache restore skipped for ${spec.name}"`,
    };
  }

  saveStep(spec: TaskCacheSpec, taskName: string, ctx: BackendCtx): TaskStepSpec {
    return {
      name: `save-${spec.name}-cache`,
      image: ctx.defaultBaseImage,
      script: `#!/bin/sh\necho "[noop] cache save skipped for ${spec.name}"`,
      onError: 'continue',
    };
  }
}
```

## `needsPvcWorkspace`

Set `needsPvcWorkspace = true` when your backend reads/writes to a Kubernetes PVC (i.e. `spec.workspace`). Tektonic will then:

1. Auto-register `spec.workspace` on the task if it isn't already declared.
2. Prepend the cache workspace to finally-task workspace bindings so hash files survive pod boundaries.

Set it to `false` for remote-storage backends (GCS, S3, etc.) that don't need a local PVC.

## Using a custom backend

```typescript
const myBackend = new NoopBackend();

const buildTask = new Task({
  name: 'build',
  steps: [{ name: 'run', image: 'node:22-alpine', command: ['npm', 'run', 'build'] }],
  caches: [{
    name: 'npm',
    key: ['package-lock.json'],
    paths: ['node_modules'],
    backend: myBackend,
  }],
});
```

## `BackendCtx`

`restoreStep` and `saveStep` receive a `BackendCtx` with project-level image defaults:

```typescript
interface BackendCtx {
  defaultBaseImage: string;      // e.g. 'ghcr.io/pfenerty/apko-cicd/base:stable'
  defaultGcsCacheImage: string;  // e.g. 'ghcr.io/pfenerty/apko-cicd/gcs-cache:stable'
}
```

Use `ctx.defaultBaseImage` as your step image unless you need something more specific.

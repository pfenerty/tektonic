# Custom Cache Backends

Tektonic ships two built-in cache backends:

| Backend | Class | Factory | Storage |
|---|---|---|---|
| PVC (default) | `PvcBackend` | _(no factory; omit `backend`)_ | Kubernetes PersistentVolumeClaim |
| GCS | `GcsBackend` | `gcs({ bucket, prefix?, image? })` | Google Cloud Storage bucket |

When `TaskCacheSpec.backend` is omitted, Tektonic uses `PvcBackend` automatically.

## The `CacheBackend` interface

To write a custom backend, implement `CacheBackend`:

```typescript
import type { CacheBackend, BackendCtx } from '@pfenerty/tektonic';
import type { TaskCacheSpec, TaskStepSpec } from '@pfenerty/tektonic';

/** Your backend's image default lives beside your backend, not in tektonic's core. */
const DEFAULT_S3_CACHE_IMAGE = 'ghcr.io/example/aws-cli:stable';

export interface S3BackendOptions {
  bucket: string;
  /** Overrides {@link DEFAULT_S3_CACHE_IMAGE} for this instance. */
  image?: string;
}

export class S3Backend implements CacheBackend {
  readonly type = 's3';
  readonly needsPvcWorkspace = false; // true only if your backend stores data on a PVC

  constructor(private readonly opts: S3BackendOptions) {}

  restoreStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
    return {
      name: `restore-${spec.name}-cache`,
      image: this.image(spec),
      script: `#!/bin/sh\necho "[s3] restore ${spec.name} for ${ctx.taskName} from ${this.opts.bucket}"`,
    };
  }

  saveStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
    return {
      name: `save-${spec.name}-cache`,
      image: this.image(spec),
      script: `#!/bin/sh\necho "[s3] save ${spec.name} for ${ctx.taskName} to ${this.opts.bucket}"`,
      onError: 'continue',
    };
  }

  private image(spec: TaskCacheSpec): string {
    return spec.image ?? this.opts.image ?? DEFAULT_S3_CACHE_IMAGE;
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
const myBackend = new S3Backend({ bucket: 'my-ci-cache' });

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

`restoreStep` and `saveStep` receive a `BackendCtx` carrying only what every backend
needs, whatever it stores archives in:

```typescript
interface BackendCtx {
  taskName: string;      // the task this cache is attached to
  defaultImage: string;  // project-level fallback step image
}
```

There is deliberately nothing provider-specific in it — no bucket, no cloud SDK image.
Adding a backend therefore requires no change to tektonic's core.

`taskName` is the name of the task the cache belongs to. For a
`saveStrategy: 'finally'` cache, which is rendered into its own pod, it is still the
*source* task's name, so hash files written by the restore step stay addressable across
the pod boundary.

### Image resolution

Step images resolve in one order, and every backend should honour it:

1. `spec.image` — the per-cache override on `TaskCacheSpec`.
2. Your backend's own default — an `image` option on your backend, falling back to a
   module-level constant you own (`DEFAULT_S3_CACHE_IMAGE` above).
3. `ctx.defaultImage` — the project-level fallback, for a backend with no image needs
   of its own.

The built-ins follow it: `PvcBackend` has no default of its own and lands on
`ctx.defaultImage` (currently `DEFAULT_BASE_IMAGE`), while `GcsBackend` defaults to its
own `DEFAULT_GCS_CACHE_IMAGE` — overridable per instance with
`gcs({ bucket, image: 'ghcr.io/example/gcloud:pinned' })`, and still yielding to
`spec.image`.

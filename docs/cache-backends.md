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
2. Your backend's own default — an `image` option on your backend.
3. The project's `injectedStepImage`, reached either as `ctx.defaultImage` (which requires
   nothing beyond `sh`) or as `injectedImageRef(...capabilities)` when your steps need more.

Tektonic ships no image of its own: it generates every injected script and only expects the
image to *provide* what that script invokes. `injectedImageRef` is how a backend says which
interpreters and CLIs that is, so a project whose image lacks one is told at synth time:

```ts
private _image(spec: TaskCacheSpec, ctx: BackendCtx): string {
  // nushell + zstd for the compressed path; plain `sh` needs nothing extra.
  return spec.image ?? this.opts.image ?? (spec.compress
    ? injectedImageRef('nushell', 'zstd', 'tar')
    : ctx.defaultImage);
}
```

The built-ins follow it. `PvcBackend` has no image of its own: an uncompressed cache lands on
`ctx.defaultImage`, a compressed one asks for `nushell`/`tar`/`zstd`. `GcsBackend` asks for
those plus `gcloud`, and yields to `gcs({ bucket, image: 'ghcr.io/example/gcloud:pinned' })`
and then to `spec.image`. `DEFAULT_GCS_CACHE_IMAGE` is still exported as one image known to
satisfy the GCS set:

```ts
gcs({ bucket: 'my-ci-cache', image: DEFAULT_GCS_CACHE_IMAGE })
```

A project that names no capable image gets an error at synth time naming the missing
capability, rather than a `command not found` inside a pod minutes into a run.

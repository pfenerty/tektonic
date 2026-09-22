# Tekton Chains

[Tekton Chains](https://tekton.dev/docs/chains/) is a cluster controller that observes
completed TaskRuns/PipelineRuns and produces signed [SLSA](https://slsa.dev/) build provenance.
It works by reading **conventionally-named results and annotations** off the runs — so the
authoring side (what Tektonic generates) and the cluster side (the Chains controller, signing
keys, storage) are cleanly separable.

**Tektonic covers the authoring side.** It emits the result/annotation conventions Chains
consumes, so provenance "just works" once Chains is installed. It deliberately does **not**
install or configure Chains itself — see [the boundary](#the-cluster-boundary) below.

Everything here is inert when Chains is not installed: the extra results and annotations are
harmless no-ops.

## Source provenance (automatic)

Chains records the fetched source as a provenance *material* from results named
`CHAINS-GIT_URL` and `CHAINS-GIT_COMMIT`. [`GitPipeline`](agent-guide.md#gitpipeline) already
clones the repo and knows the remote URL and commit SHA, so it emits these by default — no
configuration needed:

```typescript
const pipeline = new GitPipeline({
  trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
  tasks: [build],
  // CHAINS-GIT_URL / CHAINS-GIT_COMMIT emitted automatically
});
```

Opt out with `chainsProvenance: false` if you don't want them:

```typescript
new GitPipeline({ trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] }, tasks: [build], chainsProvenance: false });
```

## Build subjects: `ChainsImage`

Chains records what a build produced as provenance *subjects* from results whose names end in
`IMAGE_URL` / `IMAGE_DIGEST`. The `ChainsImage` helper bundles that result pair and hands you
the step paths to write into, keeping the build task declarative:

```typescript
import { ChainsImage, Task, sh } from '@pfenerty/tektonic';

const api = new ChainsImage({ name: 'api' });   // → api-IMAGE_URL, api-IMAGE_DIGEST

const buildApi = new Task({
  name: 'build-api',
  results: [...api.results],
  steps: [{
    name: 'build',
    image: 'moby/buildkit:rootless',
    env: [{ name: 'IMAGE', value: 'ghcr.io/org/api' }],
    script: sh`
      buildctl build ... \
        --output type=image,name=$IMAGE,push=true \
        --metadata-file /tmp/md.json
      # Chains requires the digest in alg:hex form (e.g. sha256:…)
      jq -r '."containerimage.digest"' /tmp/md.json | tr -d '\n' > ${api.digestPath}
      printf '%s' "$IMAGE" > ${api.urlPath}`,
  }],
});
```

`buildctl --metadata-file` writes `containerimage.digest` as `sha256:…`, exactly the form Chains
expects. A downstream task can consume the built image via the pipeline references
`api.url` / `api.digest` (valid once the result pair is attached to a Task):

| Member | Produces |
|--------|----------|
| `api.results` | the `[urlResult, digestResult]` pair to spread into a Task's `results` |
| `api.urlPath` / `api.digestPath` | `$(results.api-IMAGE_URL.path)` / `…-IMAGE_DIGEST.path` — write in the step |
| `api.url` / `api.digest` | `$(tasks.build-api.results.api-IMAGE_URL)` — reference downstream |

Use a distinct `name` per image when a task builds more than one.

## Non-image subjects: artifact provenance

`ChainsImage` covers the case where the thing built is an image. For anything else a task
declares in `produces` — a release tarball, a signed bundle, an SBOM — tektonic can emit
[TEP-0147](https://github.com/tektoncd/community/blob/main/teps/0147-tekton-artifacts-phase1.md)
artifact provenance instead: `{uri, digest}` records in the TaskRun status, which Chains reads
the same way.

```typescript
new TektonicProject({ namespace: 'ci', pipelines, artifactProvenance: true });

new Task({
  name: 'release',
  workspaces: [ws],
  steps: [build],
  produces: {
    bundle:   { from: 'out/release.tar.gz', buildOutput: true },  // subject
    coverage: 'out/coverage.xml',                                 // byproduct
  },
});
```

`buildOutput` is the whole distinction: an output is a SLSA *byproduct* unless it is marked,
at which point Chains treats it as a **subject**. Artifacts the task `consumes` are recorded as
`inputs`, i.e. materials.

Unlike everything else on this page, this one is **not** inert when the cluster is not set up
for it: it is alpha upstream, so nothing reads the records unless the cluster's `feature-flags`
ConfigMap sets `enable-artifacts: "true"`. That is why it is off by default. Details, and the
constraint it puts on the injected step's image, are in [artifacts.md](artifacts.md#tep-0147-artifact-provenance).

## Controlling signing & transparency: annotations

Chains reads a few `chains.tekton.dev/*` annotations off the runs it observes (most commonly
`chains.tekton.dev/transparency-upload` to push entries to a Rekor transparency log). Tektonic
exposes a generic annotations escape hatch at every layer:

- **Per task** — `Task.annotations` sets metadata on the generated `Task`.
`TektonicProject.pipelineRunAnnotations` merges into every generated `PipelineRun` template
(alongside the PAC annotations), so Chains controls apply to every run.

```typescript
new TektonicProject({
  namespace: 'ci',
  pipelines: [pushPipeline],
  pipelineRunAnnotations: { 'chains.tekton.dev/transparency-upload': 'true' },
});

new TektonicProject({
  name: 'app', namespace: 'ci', pipelines: [pushPipeline],
  pipelineRunAnnotations: { 'chains.tekton.dev/transparency-upload': 'true' },
});
```

The same option accepts any annotation, so it doubles as a general metadata passthrough.

## The cluster boundary

Tektonic stops at the authoring conventions above. The following is **cluster configuration**,
owned by your platform/GitOps layer (e.g. Flux), not by Tektonic — because it encodes
deployment choices (which signer, which storage) that don't belong in a portable pipeline
definition:

- Installing the Tekton Chains controller.
- The `chains-config` ConfigMap in the `tekton-chains` namespace — signer (`x509`/`kms`/`none`),
  storage backend (OCI/GCS/Grafeas/Archivista), payload format (in-toto/SLSA), and transparency
  (Rekor) settings.
- The signing key secret.
- **Registry push credentials for OCI storage.** With `artifacts.oci.storage: oci`, Chains
  attaches signatures and attestations to your images in the registry. It authenticates as the
  **TaskRun's ServiceAccount** — i.e. the SA your run executes under (`TektonicProject` /
  `TektonicProject` `serviceAccountName`, default `default`), *not* the Chains controller's SA.
  Link a registry-push secret to that SA in your cluster GitOps, e.g.:

  ```yaml
  apiVersion: v1
  kind: ServiceAccount
  metadata: { name: default, namespace: my-ci }
  secrets:                       # what Chains reads to authenticate the push
    - name: registry-docker-config
  ```

  Tektonic only *references* the SA by name; create the SA and link its credentials in your
  platform layer. Without this, signing still succeeds (tekton storage + Rekor) but OCI pushes
  fail with `UNAUTHORIZED`.

See the [Chains configuration docs](https://tekton.dev/docs/chains/config/) and
[authenticating to an OCI registry](https://tekton.dev/docs/chains/authentication/). Once that
is in place, pipelines authored with the conventions above are signed and attested automatically.

## How the pieces map to Chains

| Tektonic | Chains type hint | Provenance role |
|----------|------------------|-----------------|
| `GitPipeline` (default) | `CHAINS-GIT_URL` / `CHAINS-GIT_COMMIT` results | source material |
| `ChainsImage` | `*_IMAGE_URL` / `*_IMAGE_DIGEST` results | build subject |
| `artifactProvenance` + `produces` | TEP-0147 `outputs` in the TaskRun status | build subject (`buildOutput: true`) or byproduct |
| `artifactProvenance` + `consumes` | TEP-0147 `inputs` in the TaskRun status | material |
| `*.annotations` / `*.pipelineRunAnnotations` | `chains.tekton.dev/*` | signing/transparency control |

References: [SLSA provenance / type hinting](https://tekton.dev/docs/chains/slsa-provenance/),
[Chains config](https://tekton.dev/docs/chains/config/).

# ADR 0001 — An artifacts/dependencies primitive

- **Status**: accepted; option A implemented in tektonic-46j.14
- **Issue**: tektonic-46j.8
- **Date**: 2026-09-22

## Context

GitLab's `artifacts:`/`dependencies:` pair lets a job declare *these files are my output* and
another job declare *I need that job's output*. Tektonic, whose API is modelled on GitLab CI,
has no analogue. What it has instead:

- **Workspaces** — a shared PVC, lifetime = the run, mounted by every task that asks. Nothing
  is declared: everything is visible to everything, ordering is the only isolation, and two
  concurrently scheduled tasks writing one tree is a data race.
- **Results** — strings, capped at 4KB by Tekton. Fine for a SHA or a boolean, useless for an
  SBOM, a binary or a test report.
- **`ActionOutput.toWorkspace()`** — the action layer's explicit promotion across the pod
  boundary. It copies a file to a workspace path, which is the *mechanism* an artifact needs,
  but it declares nothing: no consumer is named, so nothing checks that anyone reads it or
  that the reader is ordered after the writer.

The cost is real, not theoretical. `Pipeline.flagSharedWorkspaceCaches`
(`packages/tektonic/src/lib/core/pipeline.ts:176`) is defensive machinery that exists because
a cache restore can land on a tree a concurrently scheduled task is actively using; it
silently switches such caches to `skipRestoreIfPathsExist` and warns. Tektonic-46j.8 records
the consumer-side version of the same problem: several `skipRestoreIfPathsExist` caches in
ocidex exist purely because multiple tasks hand-coordinate state on one shared PVC, with the
failure they were written to prevent spelled out in their comments.

Tektonic's own self-CI is not exempt. `npm run check` against `examples/self-ci.ts` emits the
warning five times — `npm` and `grype-db` caches restoring into a `workspace` that three or
four tasks in the same pipeline mount. The single shared tree is the default experience, not
an ocidex quirk.

## Upstream: what Tekton actually offers today

Read rather than assumed, 2026-09-22.

**TEP-0147 "Tekton Artifacts phase 1" — implemented, alpha.** Gated behind the
`enable-artifacts` feature flag. A step writes JSON to `$(step.artifacts.path)` describing
`inputs` and `outputs` as `{uri, digest}` pairs; the controller lifts it into the TaskRun
status; downstream steps and tasks read it as `$(steps.<step>.outputs.<name>)` and
`$(tasks.<task>.outputs.<name>)`, which resolve to the *values array*, i.e. the URI and digest
as JSON text.

**This is provenance metadata, not file transport.** It moves no bytes. It travels the same
TaskRun-status channel as results, so it inherits the same size constraints, and its declared
purpose is feeding Tekton Chains: an output is a SLSA byproduct unless it is marked
`"buildOutput": true`, at which point Chains treats it as a subject of the build. It is the
answer to "what did this build produce, and can you prove it", not to "hand me that file".

**TEP-0139 "Trusted Artifacts" — proposed, and stalled.** This is the one that would move
bytes: digest/upload/download/verify steps around a shared store, a declared `spec.inputs` and
`spec.outputs` on a Task, and `inputs: [{name: bar, value: $(tasks.producer.foo)}]` piping at
the Pipeline level. Its own motivation names the gap precisely — "to avoid wasteful copy data,
these trusted steps need better granularity than that provided today by `Workspaces`". It has
been `proposed` and unchanged since 2023-07-27.

PipelineResources, the original artifact-passing mechanism, were deprecated and removed
(TEP-0074, implemented). Nothing replaced their transport half.

**Conclusion:** there is no upstream primitive to wrap for file handoff. There *is* one worth
wrapping for provenance, and it is additive to whatever we build.

## Options considered

### A — declared subpaths on the shared workspace

A task declares `produces`, a consumer declares `consumes` against the producer's typed
handle; tektonic injects the copy steps into a per-task subdirectory of the ephemeral
workspace and validates the wiring at synth time.

### B — an artifact store behind a backend seam

Producers upload a tarball keyed by run + task + name, consumers download it. Reuses the
hashing and compression helpers in `packages/tektonic/src/lib/cache/shared.ts`, and works with
no shared PVC at all.

### C — wrap Tekton's own artifact mechanism

Emit TEP-0147 provenance and read it downstream.

## Evaluation

The four criteria from tektonic-46j.8, in priority order.

| | A: declared subpaths | B: artifact store | C: upstream artifacts |
|---|---|---|---|
| 1. Missing producer is a **synth-time** error | yes | yes | no |
| 2. Removes ocidex's `skipRestoreIfPathsExist` | no (see below) | no (see below) | no |
| 3. Survives concurrent tasks | yes, for artifacts | yes | n/a |
| 4. Works without a shared RWO PVC | **no** | yes | n/a |

**1 — the point of the exercise.** A and B are identical here, because the declaration is the
product and it lives in TypeScript, not in the transport. `consumes: [build.artifacts.dist]`
cannot name an output no producer declares — that is a type error before synthesis runs. The
check worth having on top is the ordering one: the producing task must be a transitive `needs`
of the consumer, or synthesis fails. That catches "declared, but not ordered", which is exactly
the class of bug that is a runtime file-not-found today. C fails outright: its data is runtime
status, it carries no compile-time shape, and it is alpha behind a cluster feature flag we
cannot require of consumers.

**2 — the honest answer is no, for all three, and that is acceptable.** Those caches are
caches, not artifacts. They are content-addressed, reused *across* runs, and restored at the
start of any task that wants a warm tree; an artifact is run-scoped, written once by a named
producer and read by named consumers. The race `flagSharedWorkspaceCaches` defends against is a
cache restore overwriting a tree a concurrent task is mid-build on — nothing about declaring
artifacts changes that, because the cache still restores into the same shared workspace.

What an artifact primitive does remove is the *subset* of shared-PVC coordination that is
really a handoff wearing a cache's clothes: a tree produced once and read by several downstream
tasks. Declared as an artifact, the consumer restores nothing, the producer is ordered before
it by construction, and `flagSharedWorkspaceCaches` stops firing for that path. The genuinely
cache-shaped cases stay cache-shaped, and their real fix is either option B's store or a
per-task volume — filed separately rather than smuggled in here.

This assessment is made from the evidence quoted in tektonic-46j.8 and from
`flagSharedWorkspaceCaches` itself. It is not a fresh read of ocidex, which this session cannot
install against a 2.x build (tektonic-46j.12). Re-confirm it during tektonic-46j.13.

**3 — concurrency.** A fixes the artifact race by construction, because a per-task subdirectory
has exactly one writer; it does not fix the cache race, per above. B has no shared mutable tree
to race on.

**4 — the one place A loses.** A keeps the RWO-PVC assumption, so a pipeline still cannot
schedule its tasks across nodes. B is the only option that lifts it.

## Decision

**Take option A now, shaped so that option B is a backend swap rather than a rewrite. Defer C
as an additive provenance layer.**

The reasoning:

- Criterion 1 is the product, and A meets it completely, at a fraction of B's cost. Nothing in
  the typed declaration knows how bytes move.
- A adds no infrastructure. It is synth-time validation plus copy steps on a PVC that every
  tektonic pipeline already provisions.
- A's failure on criterion 4 is not a regression. Tektonic already binds one ephemeral RWO
  workspace across the run; A does not make cross-node scheduling any less possible than it is
  today, it just does not fix it.
- The second implementation is genuinely a backend, not a second design. A's injected steps are
  "copy out to a location" and "copy in from a location" — the same restore/save step shape the
  `CacheBackend` seam already has. B replaces the location and the copy command behind an
  `ArtifactStore` interface; the `produces`/`consumes` declaration, the ordering check and the
  handle types are untouched.
- B should **not** be built on `CacheBackend` itself, despite the issue's sketch. That contract
  is content-addressed and cross-run (`hashExpr`, restore-or-miss, save-at-end); artifacts are
  run-scoped and single-writer. Forcing one through the other distorts both. A sibling
  `ArtifactStore` seam that *shares helpers* with `cache/shared.ts` is the right shape.

## Proposed API surface

Producer side — a task declares what it publishes, promoting a pod-internal action output
across the boundary:

```typescript
const build = new Task({
  name: 'build',
  steps: [compile],
  produces: {
    dist: compile.outputs.bundle.toArtifact(),   // ActionOutput -> declared TaskArtifact
    report: 'target/report.xml',                 // or a plain path a hand-written step wrote
  },
});
```

Consumer side — a task declares what it needs, by handle:

```typescript
const test = new Task({
  name: 'test',
  needs: [build],
  consumes: [build.artifacts.dist],
  steps: [sh`run-tests ${build.artifacts.dist}`],  // interpolates to the mounted path
});
```

`build.artifacts.dist` is a `TaskArtifact`: typed, `toString()`s to the path the *consumer*
sees, and carries its producer so synthesis can assert the ordering. Synthesis then injects a
publish step into the producer (copy to `<workspace>/.tektonic/artifacts/build/dist`) and a
fetch step into the consumer, and fails if the producer is not a transitive `needs` of the
consumer.

The rules that make this worth having, all enforced at synth time:

- A consumer may only name an artifact some task in the same pipeline produces.
- The producer must be ordered before the consumer.
- One producer per artifact name per task. Two tasks producing the same name is fine; the
  handles are distinct because they are reached through their producing task.
- An artifact declared and never consumed is a warning, not an error — publishing for a human
  to download is legitimate.

## Vocabulary, reconciled with the Action design

The action layer (tektonic-46j.6) already owns the pod-internal half, and the two must not
collide:

| Term | Scope | Lives at | Crosses a pod? |
|---|---|---|---|
| **action output** (`ActionOutput`) | pod-internal | `/tektonic/actions/<action>-<name>`, an `emptyDir` | no |
| **task artifact** (`TaskArtifact`) | run-scoped, cross-pod | a per-task subpath of the ephemeral workspace | yes |

The rule: **"output" is always pod-internal, "artifact" is always cross-pod.** They connect at
exactly one point, `ActionOutput.toArtifact()`, which joins the existing `toResult()` and
`toWorkspace()` promotions — an artifact is the declared sibling of `toWorkspace`, and
`toWorkspace` stays as the undeclared escape hatch for a file nobody in this pipeline consumes.

One external collision to state plainly: upstream Tekton calls its TEP-0147 provenance records
"artifacts" too. When tektonic eventually emits them (option C), they are
**artifact provenance** in docs and `artifactProvenance` in the API, never bare `artifacts`.

## Consequences

- `Task` grows `produces` and `consumes`; `TaskArtifact` and `ActionOutput.toArtifact()` are
  new public surface.
- Synthesis grows two injected step kinds and three new failure modes, all at synth time.
- The RWO-PVC constraint is unchanged. Cross-node scheduling stays blocked until an
  `ArtifactStore` lands.
- Tektonic gains a declared producer/consumer graph for files, which is also the input a
  provenance layer would need — so C becomes cheap later, instead of being designed twice.

## Follow-up work

- ~~Implement option A (`produces`/`consumes`, `TaskArtifact`, the synth-time checks).~~ Done in
  tektonic-46j.14. The `ArtifactStore` seam landed with it rather than after it, because the
  acceptance criterion was a test swapping a fixture store in — which is the only thing that
  shows the shape survives a second implementation.
- A store-backed `ArtifactStore` implementation, when cross-node scheduling or a PVC-less
  pipeline is actually wanted.
- Emit TEP-0147 artifact provenance for declared artifacts, feeding Tekton Chains alongside
  the existing `ChainsImage` integration.

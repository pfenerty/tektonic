/**
 * Example: pipeline using a hub-resolved git-clone task.
 *
 * Demonstrates HubTaskRef as a first-class pipeline node. The hub-resolved
 * task appears in the synthesized Pipeline spec with a resolver-based taskRef;
 * no local Task resource is generated for it.
 *
 * Synthesizes to: .tektonic-hub-example/
 *
 * Run with:
 *   flox activate -- npx ts-node examples/hub-task.ts
 */

import {
    Param,
    Workspace,
    Task,
    HubTaskRef,
    Pipeline,
    TektonProject,
    TRIGGER_EVENTS,
} from "../src";

// ── Shared workspace ─────────────────────────────────────────────────────────
const output = new Workspace({ name: "output" });

// ── Params consumed by the hub git-clone task ─────────────────────────────────
const url = new Param({ name: "url" });
const revision = new Param({ name: "revision" });

// ── Hub-resolved git-clone from the Tekton catalog ───────────────────────────
//    Resolved at PipelineRun time via:
//      taskRef:
//        resolver: hub
//        params: [{ name: catalog, value: tekton }, ...]
//    See: https://artifacthub.io/packages/tekton-task/tekton-catalog/git-clone
const hubGitClone = new HubTaskRef({
    taskName: "git-clone",
    version: "0.9",
    params: [url, revision],
    workspaces: [output],
});

// ── Local task that runs after the hub clone ──────────────────────────────────
const npmTest = new Task({
    name: "npm-test",
    needs: [hubGitClone],
    workspaces: [output],
    steps: [
        {
            name: "test",
            image: "node:22-alpine",
            workingDir: "$(workspaces.output.path)",
            command: ["npm", "test"],
        },
    ],
});

// ── Plain Pipeline (not GitPipeline) — workspace wiring is explicit ───────────
const pipeline = new Pipeline({
    name: "hub-clone-pipeline",
    triggers: [TRIGGER_EVENTS.PUSH],
    tasks: [npmTest],
});

// ── Synthesize ────────────────────────────────────────────────────────────────
new TektonProject({
    name: "hub-example",
    namespace: "tekton-pipelines",
    pipelines: [pipeline],
    outdir: ".tektonic-hub-example",
});

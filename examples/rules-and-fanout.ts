/**
 * Rules + runtime fan-out example.
 *
 * Demonstrates the declarative job attributes:
 *   - `when:` — a typed rule (exact branch and branch-pattern) as a job attribute
 *   - `fanOut:` — one deploy job per service discovered at runtime
 *
 * A monorepo CI that lints every push, runs the full suite only on main/release/*,
 * and deploys each *changed* service (count unknown until the parse task runs).
 */
import {
    Task,
    Param,
    Result,
    GitPipeline,
    TektonProject,
    TRIGGER_EVENTS,
    onBranch,
    onBranchMatching,
    sh,
} from "../src";

const nodeImage = "node:22-alpine";

// Always runs.
const lint = new Task({
    name: "lint",
    steps: [{ name: "lint", image: nodeImage, script: sh`npm ci && npm run lint` }],
});

// Rule as a job attribute: full suite only on main or release/* (branch pattern → CEL guard).
const test = new Task({
    name: "test",
    when: onBranchMatching("^(main|release/.*)$"),
    steps: [{ name: "test", image: nodeImage, script: sh`npm ci && npm test` }],
});

// Parse step: emit which services changed as a runtime array result (e.g. ["api","web"]).
const changed = new Result({ name: "changed-services", type: "array" });
const detect = new Task({
    name: "detect-changes",
    results: [changed],
    steps: [
        {
            name: "detect",
            image: nodeImage,
            script: sh`node scripts/changed-services.mjs > ${changed.path}`,
        },
    ],
});

// Per-service deploy — one TaskRun per changed service, only on main.
const service = new Param({ name: "service" });
const deploy = new Task({
    name: "deploy",
    params: [service],
    when: onBranch("main"), // exact branch → classic when, no feature flag
    fanOut: { over: changed, as: service }, // runtime fan-out over the parsed array
    steps: [{ name: "deploy", image: nodeImage, script: sh`./deploy.sh ${service}` }],
});

new TektonProject({
    name: "monorepo",
    namespace: "tekton-ci",
    outdir: ".tekton-rules-example",
    webhookSecretRef: { secretName: "github-webhook-secret", secretKey: "secret" },
    pipelines: [
        new GitPipeline({
            name: "ci",
            triggers: [TRIGGER_EVENTS.PUSH],
            tasks: [lint, test, detect, deploy], // clean list — rules/fan-out are on the jobs
        }),
    ],
});

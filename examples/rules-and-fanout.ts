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
    TektonicProject,
    TRIGGER_EVENTS,
    onBranch,
    onBranchMatching,
    onChanges,
    or,
    sh,
} from "../src";

const nodeImage = "node:22-alpine";

// Always runs.
const lint = new Task({
    name: "lint",
    steps: [{ name: "lint", image: nodeImage, script: sh`npm ci && npm run lint` }],
});

// Compound rule: always on main / merges to main; on feature branches only when the
// app source or dependencies actually changed (a detection task is auto-wired in).
const integration = new Task({
    name: "integration",
    when: or(onBranch("main"), onChanges(["src/**", "package.json"])),
    steps: [{ name: "integration", image: nodeImage, script: sh`npm ci && npm run test:integration` }],
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
    name: "detect-services",
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

new TektonicProject({
    name: "monorepo",
    namespace: "tekton-ci",
    outdir: ".tekton-rules-example",
    repository: { url: "https://github.com/pfenerty/monorepo" },
    pipelines: [
        new GitPipeline({
            name: "ci",
            triggers: [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST],
            // PAC pipeline-level matching: supersede older PR runs, and allow /ci re-runs.
            // (Job-level `when`/`onChanges`/`fanOut` on the tasks are orthogonal to this.)
            match: { cancelInProgress: true, onComment: "^/ci" },
            tasks: [lint, test, integration, detect, deploy], // clean list — rules/fan-out are on the jobs
        }),
    ],
});

import {
    Workspace,
    Task,
    GitPipeline,
    TektonicProject,
    TRIGGER_EVENTS,
} from "../src";

// ---- Variables ──────────────────────────────────────────────────────────────
const golangVersion = "1.23.0";

// ─── Shared workspace ────────────────────────────────────────────────────────
const workspace = new Workspace({ name: "workspace" });

// ─── Tasks ───────────────────────────────────────────────────────────────────
const goTest = new Task({
    name: "test-go",
    steps: [
        {
            name: "test",
            image: `golang:${golangVersion}-alpine`,
            command: ["go", "test", "./..."],
        },
    ],
});

const goBuild = new Task({
    name: "build-go",
    steps: [
        {
            name: "build",
            image: `golang:${golangVersion}-alpine`,
            command: ["go", "build", "./..."],
        },
    ],
});

const sbom = new Task({
    name: "generate-sbom",
    steps: [
        {
            name: "sbom",
            image: "anchore/syft:v1.11.0-debug",
            command: ["sh", "-c", "syft . -o cyclonedx-json > sbom.json"],
        },
    ],
});

const vulnScan = new Task({
    name: "vuln-scan",
    needs: [sbom],
    steps: [
        {
            name: "scan",
            image: "anchore/grype:v0.79.6-debug",
            command: ["sh", "-c", "grype sbom:sbom.json"],
        },
    ],
});

const lint = new Task({
    name: "lint-go",
    steps: [
        {
            name: "lint",
            image: "golangci/golangci-lint:latest",
            command: ["golangci-lint", "run", "./..."],
        },
    ],
});

// ─── Pipelines ───────────────────────────────────────────────────────────────
const pushPipeline = new GitPipeline({
    name: "go-push",
    workspace,
    triggers: [TRIGGER_EVENTS.PUSH],
    tasks: [goTest, goBuild, sbom, vulnScan],
});

const prPipeline = new GitPipeline({
    name: "go-pull-request",
    workspace,
    triggers: [TRIGGER_EVENTS.PULL_REQUEST],
    tasks: [goTest, sbom, vulnScan],
});

const lintPipeline = new GitPipeline({
    name: "go-lint",
    workspace,
    tasks: [lint],
});

// ─── Synthesize ──────────────────────────────────────────────────────────────
new TektonicProject({
    name: "homelab",
    namespace: "tekton-builds",
    pipelines: [pushPipeline, prPipeline, lintPipeline],
    outdir: ".tekton",
    repository: { url: "https://github.com/pfenerty/homelab" },
});

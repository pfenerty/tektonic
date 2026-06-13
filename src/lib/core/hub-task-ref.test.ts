import { describe, it, expect } from "vitest";
import { App, Chart } from "cdk8s";
import { HubTaskRef } from "./hub-task-ref";
import { Task } from "./task";
import { Param } from "./param";
import { Workspace } from "./workspace";
import { Pipeline } from "./pipeline";

describe("HubTaskRef", () => {
    const url = new Param({ name: "url" });
    const revision = new Param({ name: "revision" });
    const output = new Workspace({ name: "output" });

    it("synthesizable is false", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9" });
        expect(ref.synthesizable).toBe(false);
    });

    it("name defaults to taskName", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9" });
        expect(ref.name).toBe("git-clone");
    });

    it("name can be overridden", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9", name: "clone" });
        expect(ref.name).toBe("clone");
    });

    it("catalog defaults to 'tekton'", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9" });
        const spec = ref._toPipelineTaskSpec([]) as any;
        const catalogParam = spec.taskRef.params.find((p: any) => p.name === "catalog");
        expect(catalogParam.value).toBe("tekton");
    });

    it("catalog can be overridden", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9", catalog: "custom" });
        const spec = ref._toPipelineTaskSpec([]) as any;
        const catalogParam = spec.taskRef.params.find((p: any) => p.name === "catalog");
        expect(catalogParam.value).toBe("custom");
    });

    it("_toPipelineTaskSpec emits hub resolver block", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9" });
        const spec = ref._toPipelineTaskSpec([]) as any;
        expect(spec.taskRef.resolver).toBe("hub");
        expect(spec.taskRef.params).toContainEqual({ name: "name", value: "git-clone" });
        expect(spec.taskRef.params).toContainEqual({ name: "version", value: "0.9" });
    });

    it("does not emit kind: Task in taskRef", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9" });
        const spec = ref._toPipelineTaskSpec([]) as any;
        expect(spec.taskRef.kind).toBeUndefined();
    });

    it("forwards params as pipeline expressions", () => {
        const ref = new HubTaskRef({
            taskName: "git-clone",
            version: "0.9",
            params: [url, revision],
        });
        const spec = ref._toPipelineTaskSpec([]) as any;
        expect(spec.params).toContainEqual({ name: "url", value: "$(params.url)" });
        expect(spec.params).toContainEqual({ name: "revision", value: "$(params.revision)" });
    });

    it("forwards workspaces by name", () => {
        const ref = new HubTaskRef({
            taskName: "git-clone",
            version: "0.9",
            workspaces: [output],
        });
        const spec = ref._toPipelineTaskSpec([]) as any;
        expect(spec.workspaces).toContainEqual({ name: "output", workspace: "output" });
    });

    it("omits params/workspaces when empty", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9" });
        const spec = ref._toPipelineTaskSpec([]) as any;
        expect(spec.params).toBeUndefined();
        expect(spec.workspaces).toBeUndefined();
    });

    it("emits runAfter when provided", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9" });
        const spec = ref._toPipelineTaskSpec(["setup"]) as any;
        expect(spec.runAfter).toEqual(["setup"]);
    });

    it("omits runAfter when empty", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9" });
        const spec = ref._toPipelineTaskSpec([]) as any;
        expect(spec.runAfter).toBeUndefined();
    });

    it("namePrefix is ignored (hub tasks are resolved remotely)", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9" });
        const withPrefix = ref._toPipelineTaskSpec([], "myapp") as any;
        const withoutPrefix = ref._toPipelineTaskSpec([]) as any;
        expect(withPrefix.name).toBe(withoutPrefix.name);
        expect(withPrefix.taskRef).toEqual(withoutPrefix.taskRef);
    });

    it("needs defaults to empty array", () => {
        const ref = new HubTaskRef({ taskName: "git-clone", version: "0.9" });
        expect(ref.needs).toHaveLength(0);
    });
});

describe("HubTaskRef in Pipeline", () => {
    const url = new Param({ name: "url" });
    const revision = new Param({ name: "revision" });
    const output = new Workspace({ name: "output" });

    it("pipeline discovers hub ref as a node and wires downstream runAfter", () => {
        const hubClone = new HubTaskRef({
            taskName: "git-clone",
            version: "0.9",
            params: [url, revision],
            workspaces: [output],
        });
        const test = new Task({
            name: "test",
            needs: [hubClone],
            workspaces: [output],
            steps: [{ name: "run", image: "node:22-alpine" }],
        });

        const pipeline = new Pipeline({ name: "ci", tasks: [test] });
        expect(pipeline.allTasks).toContain(hubClone);
        expect(pipeline.allTasks).toContain(test);

        const app = new App();
        const chart = new Chart(app, "test");
        pipeline._build(chart, "pipeline", "ns");
        const manifest = chart.toJson()[0] as any;

        const hubEntry = manifest.spec.tasks.find((t: any) => t.name === "git-clone");
        expect(hubEntry).toBeDefined();
        expect(hubEntry.taskRef.resolver).toBe("hub");
        expect(hubEntry.taskRef.params).toContainEqual({ name: "name", value: "git-clone" });

        const testEntry = manifest.spec.tasks.find((t: any) => t.name === "test");
        expect(testEntry.runAfter).toEqual(["git-clone"]);
    });

    it("pipeline infers hub ref params and workspaces at the pipeline level", () => {
        const hubClone = new HubTaskRef({
            taskName: "git-clone",
            version: "0.9",
            params: [url, revision],
            workspaces: [output],
        });
        const pipeline = new Pipeline({ name: "ci", tasks: [hubClone] });
        const paramNames = pipeline.inferParams().map((p: any) => p.name);
        expect(paramNames).toContain("url");
        expect(paramNames).toContain("revision");
        const wsNames = pipeline.inferWorkspaces().map((w: any) => w.name);
        expect(wsNames).toContain("output");
    });
});

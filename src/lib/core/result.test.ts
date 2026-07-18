import { describe, it, expect } from "vitest";
import { Result } from "./result";

describe("Result", () => {
    it("stores name from options", () => {
        const r = new Result({ name: "commit" });
        expect(r.name).toBe("commit");
    });

    it("stores description from options", () => {
        const r = new Result({ name: "commit", description: "Full commit SHA" });
        expect(r.description).toBe("Full commit SHA");
    });

    it("type defaults to 'string'", () => {
        const r = new Result({ name: "commit" });
        expect(r.type).toBe("string");
    });

    it("stores explicit type", () => {
        const r = new Result({ name: "items", type: "array" });
        expect(r.type).toBe("array");
    });

    it("description is undefined when not provided", () => {
        const r = new Result({ name: "commit" });
        expect(r.description).toBeUndefined();
    });

    it("path returns Tekton result path expression pre-bind", () => {
        const r = new Result({ name: "commit" });
        expect(r.path).toBe("$(results.commit.path)");
    });

    it("path works for hyphenated names", () => {
        const r = new Result({ name: "short-sha" });
        expect(r.path).toBe("$(results.short-sha.path)");
    });

    it("toString() throws before _bindToTask()", () => {
        const r = new Result({ name: "commit" });
        expect(() => String(r)).toThrow(/not bound to a task/);
    });

    it("_bindToTask() throws when already bound to a different task", () => {
        const r = new Result({ name: "commit" });
        r._bindToTask("task-a");
        expect(() => r._bindToTask("task-b")).toThrow(/already bound to task 'task-a'/);
    });

    it("toString() returns pipeline reference expression after _bindToTask()", () => {
        const r = new Result({ name: "commit" });
        r._bindToTask("git-clone");
        expect(r.toString()).toBe("$(tasks.git-clone.results.commit)");
    });

    it("toString() works in template literals after bind", () => {
        const r = new Result({ name: "commit" });
        r._bindToTask("git-clone");
        expect(`ref: ${r}`).toBe("ref: $(tasks.git-clone.results.commit)");
    });

    it("toSpec() returns name and type without description", () => {
        const r = new Result({ name: "commit" });
        expect(r.toSpec()).toEqual({ name: "commit", type: "string" });
    });

    it("toSpec() includes description when set", () => {
        const r = new Result({ name: "commit", description: "Full commit SHA" });
        expect(r.toSpec()).toEqual({ name: "commit", type: "string", description: "Full commit SHA" });
    });

    it("toSpec() with array type", () => {
        const r = new Result({ name: "items", type: "array" });
        expect(r.toSpec()).toEqual({ name: "items", type: "array" });
    });

    it("path works in template literal pre-bind", () => {
        const r = new Result({ name: "commit" });
        expect(`git rev-parse HEAD > ${r.path}`).toBe(
            "git rev-parse HEAD > $(results.commit.path)",
        );
    });

    it("owner is undefined before bind and set after", () => {
        const r = new Result({ name: "items", type: "array" });
        expect(r.owner).toBeUndefined();
        const owner = { name: "detect" } as unknown as import("./task").TaskLike;
        r._bindToTask("detect", owner);
        expect(r.owner).toBe(owner);
    });

    it("arrayRef returns the [*] splat for a bound array result", () => {
        const r = new Result({ name: "targets", type: "array" });
        r._bindToTask("detect");
        expect(r.arrayRef).toBe("$(tasks.detect.results.targets[*])");
    });

    it("arrayRef throws for a non-array result", () => {
        const r = new Result({ name: "commit", type: "string" });
        r._bindToTask("git-clone");
        expect(() => r.arrayRef).toThrow(/not 'array'/);
    });

    it("arrayRef throws before bind", () => {
        const r = new Result({ name: "targets", type: "array" });
        expect(() => r.arrayRef).toThrow(/not bound to a task/);
    });
});

/**
 * The parts of `runJust` that do not need a real `just` binary — the trust
 * refusal, and a spawn failure against a path that cannot possibly resolve.
 * The successful-spawn path is exercised against real binaries instead, in
 * `test/differential/trust.test.ts` — this file belongs to the `unit`
 * project, which must not depend on `just` being installed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { recorded, resetStub, TaskScope, workspace } from "../../test/stubs/vscode.js";
import { runJust, startJustTask } from "./trust.js";

beforeEach(resetStub);

describe("runJust", () => {
    it("refuses to spawn anything when the workspace is untrusted", async () => {
        workspace.isTrusted = false;
        const outcome = await runJust("just", ["--version"]);
        expect(outcome).toEqual({ ok: false, reason: "untrusted" });
    });

    it("does not even look at the executable path when untrusted", async () => {
        // A path this obviously wrong would fail differently — and slower —
        // if it were ever actually handed to child_process.
        workspace.isTrusted = false;
        const outcome = await runJust("/no/such/executable/at/all", ["--version"]);
        expect(outcome).toEqual({ ok: false, reason: "untrusted" });
    });

    it("reports a spawn error, not a throw, for an executable that cannot exist", async () => {
        const outcome = await runJust("/no/such/executable/at/all", ["--version"]);
        expect(outcome).toEqual({
            ok: false,
            reason: "spawn-error",
            message: expect.any(String),
        });
    });
});

describe("startJustTask", () => {
    const options = { cwd: "/w", scope: TaskScope.Workspace, label: "just build", recipe: "build" };

    it("refuses to start a task when the workspace is untrusted", async () => {
        workspace.isTrusted = false;
        const outcome = await startJustTask("just", ["build"], options);
        expect(outcome).toEqual({ ok: false, reason: "untrusted" });
        expect(recorded.executedTasks).toEqual([]);
    });

    it("hands VS Code an argv, every element strongly quoted, the executable included", async () => {
        const outcome = await startJustTask("just", ["build", "two words"], options);
        expect(outcome.ok).toBe(true);
        const task = recorded.executedTasks[0];
        expect(task?.execution.command).toEqual({ value: "just", quoting: 2 });
        expect(task?.execution.args).toEqual([
            { value: "build", quoting: 2 },
            { value: "two words", quoting: 2 },
        ]);
        expect(task?.execution.options?.cwd).toBe("/w");
        expect(task?.definition).toEqual({ type: "just", recipe: "build" });
        expect(task?.name).toBe("just build");
        expect(task?.source).toBe("just");
    });

    it("keeps an executable path with spaces as one word", async () => {
        await startJustTask("C:\\Program Files\\just\\just.exe", ["build"], options);
        expect(recorded.executedTasks[0]?.execution.command).toEqual({
            value: "C:\\Program Files\\just\\just.exe",
            quoting: 2,
        });
    });

    it("reports a task system failure as a result rather than rejecting", async () => {
        recorded.taskLaunchError = new Error("no terminal");
        const outcome = await startJustTask("just", ["build"], options);
        expect(outcome).toEqual({ ok: false, reason: "launch-error", message: "no terminal" });
    });

    it("reveals the terminal and shares a panel between runs", async () => {
        await startJustTask("just", ["build"], options);
        expect(recorded.executedTasks[0]?.presentationOptions).toMatchObject({
            reveal: 1,
            panel: 1,
            showReuseMessage: true,
        });
    });
});

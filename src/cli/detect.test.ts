import { beforeEach, describe, expect, it } from "vitest";
import { recorded, resetStub, workspace } from "../../test/stubs/vscode.js";
import { detectJust, parseVersion, resolveExecutablePath } from "./detect.js";
import type { JustOutcome } from "./trust.js";

beforeEach(resetStub);

describe("parseVersion", () => {
    it("reads the version out of `just --version`'s output", () => {
        expect(parseVersion("just 1.58.0\n")).toBe("1.58.0");
    });

    it("tolerates no trailing newline", () => {
        expect(parseVersion("just 1.21.0")).toBe("1.21.0");
    });

    it("is undefined for output that is not shaped like a version line", () => {
        expect(parseVersion("")).toBeUndefined();
        expect(parseVersion("command not found\n")).toBeUndefined();
    });
});

describe("resolveExecutablePath", () => {
    it("defaults to `just` when nothing is configured", () => {
        expect(resolveExecutablePath()).toBe("just");
    });

    it("uses the configured path when trusted", () => {
        recorded.config.set("just.executablePath", "/opt/just/bin/just");
        expect(resolveExecutablePath()).toBe("/opt/just/bin/just");
    });

    it("falls back to `just` for a blank configured path", () => {
        recorded.config.set("just.executablePath", "   ");
        expect(resolveExecutablePath()).toBe("just");
    });

    it("falls back to `just` for a config value that is not a string", () => {
        // `getConfiguration().get<string>()`'s type parameter is a
        // compile-time cast only; VS Code never validates a hand-edited
        // settings.json value against the schema. A number here must not
        // reach `.trim()` and throw.
        recorded.config.set("just.executablePath", 42);
        expect(() => resolveExecutablePath()).not.toThrow();
        expect(resolveExecutablePath()).toBe("just");
    });

    it("ignores the configured path when the workspace is untrusted", () => {
        // A malicious repository's own .vscode/settings.json must not be able
        // to point the extension at a binary of its choosing. See AGENTS.md
        // invariant 2 and PRD 8.31.
        recorded.config.set("just.executablePath", "/opt/evil/just");
        workspace.isTrusted = false;
        expect(resolveExecutablePath()).toBe("just");
    });
});

describe("detectJust", () => {
    function fakeRun(
        outcome: JustOutcome,
    ): (path: string, args: readonly string[]) => Promise<JustOutcome> {
        return () => Promise.resolve(outcome);
    }

    it("reports untrusted without needing to look at the outcome further", () => {
        return detectJust(fakeRun({ ok: false, reason: "untrusted" })).then((detection) => {
            expect(detection).toEqual({ state: "untrusted" });
        });
    });

    it("reports not-found when the spawn fails", async () => {
        const detection = await detectJust(
            fakeRun({ ok: false, reason: "spawn-error", message: "ENOENT" }),
        );
        expect(detection).toEqual({ state: "not-found" });
    });

    it("reports not-found when the output cannot be parsed as a version", async () => {
        const detection = await detectJust(fakeRun({ ok: true, stdout: "not just at all\n" }));
        expect(detection).toEqual({ state: "not-found" });
    });

    it("reports a supported version at or above the minimum", async () => {
        const detection = await detectJust(fakeRun({ ok: true, stdout: "just 1.58.0\n" }));
        expect(detection).toEqual({
            state: "detected",
            detected: { executablePath: "just", version: "1.58.0", supported: true },
        });
    });

    it("reports an unsupported version below the minimum", async () => {
        const detection = await detectJust(fakeRun({ ok: true, stdout: "just 1.21.0\n" }));
        expect(detection).toEqual({
            state: "detected",
            detected: { executablePath: "just", version: "1.21.0", supported: false },
        });
    });

    it("carries the resolved executable path through", async () => {
        recorded.config.set("just.executablePath", "/opt/just/bin/just");
        const detection = await detectJust(fakeRun({ ok: true, stdout: "just 1.58.0\n" }));
        expect(detection.state).toBe("detected");
        expect(detection.state === "detected" && detection.detected.executablePath).toBe(
            "/opt/just/bin/just",
        );
    });
});

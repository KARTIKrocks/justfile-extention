/**
 * The parts of `runJust` that do not need a real `just` binary — the trust
 * refusal, and a spawn failure against a path that cannot possibly resolve.
 * The successful-spawn path is exercised against real binaries instead, in
 * `test/differential/trust.test.ts` — this file belongs to the `unit`
 * project, which must not depend on `just` being installed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetStub, workspace } from "../../test/stubs/vscode.js";
import { runJust } from "./trust.js";

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

/**
 * `runJust` against a real `just` binary.
 *
 * This belongs to the `differential` project, not `unit`, for the same
 * reason `harness.ts` does: it shells out to `just`, so it needs
 * `JUST_BINARY` (or `just` on PATH) and the differential project's longer
 * timeout. It is not itself a differential comparison — there is nothing
 * here to compare our parser's output against — it is just the one place
 * `src/cli/trust.ts`'s successful-spawn path gets exercised against a real
 * binary rather than a fake one.
 */

import { describe, expect, it } from "vitest";
import { runJust } from "../../src/cli/trust.js";
import { justBinary } from "./harness.js";

describe("runJust, against the real CLI", () => {
    it("runs the real binary and returns its version output", async () => {
        const outcome = await runJust(justBinary(), ["--version"]);
        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.stdout).toContain("just");
    });

    it("reports a spawn error rather than throwing for a flag the CLI rejects", async () => {
        const outcome = await runJust(justBinary(), ["--this-flag-does-not-exist"]);
        expect(outcome.ok).toBe(false);
    });
});

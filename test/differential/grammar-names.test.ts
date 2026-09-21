/**
 * The grammar's setting and attribute names, checked against the real CLI.
 *
 * These lists were produced by asking just about each candidate rather than
 * from memory, and they will go stale the moment just renames something. The
 * same question, asked on every run, is what keeps them honest.
 *
 * This only proves no name is bogus. just does not enumerate what it accepts,
 * so a name added upstream shows up as missing highlighting, not a failure.
 *
 * The grammar tracks current just, and the CI matrix runs this suite all the way
 * back to the supported floor, where most of these names had not been added yet.
 * Only a just at least as new as the one the lists were built from can judge
 * them, so older ones skip rather than report an upgrade as a defect.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { attributeNames, loadGrammar, settingNames } from "../grammar/grammar.js";
import { justBinary, justVersion, versionAtLeast } from "./harness.js";

const grammar = loadGrammar();
const dir = mkdtempSync(join(tmpdir(), "just-grammar-names-"));

/** The just the setting and attribute lists were read off. */
const VERIFIED_AGAINST = "1.58.0";
const installed = justVersion();

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

/**
 * What just says about a source, whether it succeeded or not.
 *
 * A name is real when just stops complaining that it does not know it. Most of
 * these still fail for another reason — a missing argument, the wrong value
 * type — and that is fine: those errors prove the name was recognised.
 */
function complaintAbout(source: string): string {
    const file = join(dir, "justfile");
    writeFileSync(file, source);
    try {
        execFileSync(justBinary(), ["--justfile", file, "--working-directory", dir, "--dump"], {
            encoding: "utf8",
            timeout: 15_000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return "";
    } catch (error) {
        const stderr = (error as { stderr?: string }).stderr;
        return stderr ?? String(error);
    }
}

describe.skipIf(!versionAtLeast(installed, VERIFIED_AGAINST))(
    `grammar names against just ${installed}`,
    () => {
        for (const name of settingNames(grammar)) {
            it(`just knows the setting ${name}`, () => {
                expect(complaintAbout(`set ${name}\n`)).not.toContain("unknown setting");
            });
        }

        for (const name of attributeNames(grammar)) {
            it(`just knows the attribute ${name}`, () => {
                expect(complaintAbout(`[${name}]\nfoo:\n    echo hi\n`)).not.toContain(
                    "unknown attribute",
                );
            });
        }
    },
);

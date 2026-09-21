/**
 * The argv `src/execution/plan.ts` builds, against a real `just` binary.
 *
 * `justArgv` commits the extension to two flags and one parsing rule, and
 * this is where each is proven at every version in the CI matrix rather than
 * assumed from the docs:
 *
 * * `--justfile` and `--working-directory` exist and are honoured — the run
 *   is started from a *different* directory to make sure.
 * * After the recipe name, `just` stops parsing options: `-x`, `--verbose`
 *   and `--` all reach the recipe verbatim, so no separator is inserted.
 *
 * Belongs to the `differential` project because it shells out to `just`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { justArgv } from "../../src/execution/plan.js";
import { justBinary } from "./harness.js";

// One line per argument, so quoting or splitting shows up as a changed count.
// `positional-arguments` and "$@" rather than {{args}}: an interpolation is
// spliced into the shell line, so a quote in an argument would break the
// recipe and prove nothing about how it arrived.
const JUSTFILE = `set positional-arguments

show *args:
    @pwd
    @for a in "$@"; do printf '<%s>\\n' "$a"; done
`;

function scratch(): { dir: string; file: string; elsewhere: string } {
    const dir = mkdtempSync(join(tmpdir(), "just-lang-exec-"));
    const file = join(dir, "justfile");
    writeFileSync(file, JUSTFILE);
    const elsewhere = mkdtempSync(join(tmpdir(), "just-lang-elsewhere-"));
    return { dir, file, elsewhere };
}

function run(argv: readonly string[], cwd: string): string {
    return execFileSync(justBinary(), argv, {
        cwd,
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
    });
}

describe("justArgv, against the real CLI", () => {
    it("runs the named justfile in its own directory, wherever it is started from", () => {
        const { dir, file, elsewhere } = scratch();
        const out = run(justArgv(file, dir, "show", []), elsewhere);
        // macOS puts /tmp behind a symlink, so compare resolved paths.
        expect(realpathSync(out.trim())).toBe(realpathSync(dir));
        expect(realpathSync(dir)).not.toBe(realpathSync(elsewhere));
    });

    it("passes arguments through in order, each one intact", () => {
        const { dir, file, elsewhere } = scratch();
        const out = run(justArgv(file, dir, "show", ["one", "two words", 'q"uote']), elsewhere);
        expect(out.split("\n").slice(1, 4)).toEqual(["<one>", "<two words>", '<q"uote>']);
    });

    it("needs no separator: option-looking arguments reach the recipe verbatim", () => {
        const { dir, file, elsewhere } = scratch();
        const out = run(justArgv(file, dir, "show", ["-x", "--verbose", "--"]), elsewhere);
        expect(out.split("\n").slice(1, 4)).toEqual(["<-x>", "<--verbose>", "<-->"]);
    });
});

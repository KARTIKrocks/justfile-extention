/**
 * Detecting the `just` binary and its version.
 *
 * Tier 2: reads workspace configuration and, through `src/cli/trust.ts`, may
 * spawn a process. See AGENTS.md.
 */

import * as vscode from "vscode";
import { type JustOutcome, runJust } from "./trust.js";
import { MINIMUM_SUPPORTED_VERSION, versionAtLeast } from "./version.js";

const CONFIG_SECTION = "just";
const CONFIG_KEY = "executablePath";
const DEFAULT_EXECUTABLE = "just";

export interface DetectedJust {
    readonly executablePath: string;
    readonly version: string;
    /** Whether `version` meets `MINIMUM_SUPPORTED_VERSION`. */
    readonly supported: boolean;
}

export type Detection =
    | { readonly state: "untrusted" }
    | { readonly state: "not-found" }
    | { readonly state: "detected"; readonly detected: DetectedJust };

/**
 * The executable path to use, honouring `just.executablePath` only when the
 * workspace is trusted.
 *
 * A malicious repository can commit `.vscode/settings.json` with an
 * arbitrary `just.executablePath`; an untrusted workspace must not be able
 * to point the extension at a binary of its own choosing. See AGENTS.md
 * invariant 2 and PRD 8.31. `runJust` already refuses to spawn anything at
 * all while untrusted, which is what actually keeps this safe — falling
 * back to the default here as well means a caller that only looked at the
 * resolved path, without checking `Detection`'s state, still sees something
 * unremarkable rather than an attacker-chosen string.
 *
 * `get<string>()`'s type parameter is a compile-time cast, not a runtime
 * check — VS Code never validates a hand-edited settings.json value against
 * the schema `just.executablePath` declares, so `configured` can be a
 * number, an array, anything JSON allows. The `typeof` guard is what keeps
 * that from reaching `.trim()` and throwing.
 */
export function resolveExecutablePath(): string {
    if (!vscode.workspace.isTrusted) {
        return DEFAULT_EXECUTABLE;
    }
    const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY);
    return typeof configured === "string" && configured.trim() !== ""
        ? configured
        : DEFAULT_EXECUTABLE;
}

/** `just 1.58.0\n` → `1.58.0`. Absent when the output is not shaped like that. */
export function parseVersion(stdout: string): string | undefined {
    const match = /^just\s+(\S+)/.exec(stdout.trim());
    return match?.[1];
}

/**
 * Detect the `just` binary and its version.
 *
 * `run` is injectable so this is testable without spawning a real process.
 * The default is `runJust`, the one trust-checked entry point every real
 * call goes through — production code never has a reason to pass another.
 */
export async function detectJust(
    run: (executablePath: string, args: readonly string[]) => Promise<JustOutcome> = runJust,
): Promise<Detection> {
    const executablePath = resolveExecutablePath();
    const outcome = await run(executablePath, ["--version"]);
    if (!outcome.ok) {
        return outcome.reason === "untrusted" ? { state: "untrusted" } : { state: "not-found" };
    }
    const version = parseVersion(outcome.stdout);
    if (version === undefined) {
        return { state: "not-found" };
    }
    return {
        state: "detected",
        detected: {
            executablePath,
            version,
            supported: versionAtLeast(version, MINIMUM_SUPPORTED_VERSION),
        },
    };
}

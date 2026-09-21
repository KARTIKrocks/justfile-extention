/**
 * The single point every `just` subprocess spawn must go through.
 *
 * Tier 2. See AGENTS.md invariant 2: reading a Justfile with the CLI is
 * itself execution — backticks and `shell()` run at parse time — so no
 * feature module may call `child_process` on its own. Every call lands here,
 * where trust is checked fresh, not cached from activation, because a user
 * can grant trust mid-session and a stale "untrusted" reading would leave
 * Tier 2 dark longer than it needs to be.
 *
 * This module is not itself the trust *policy* — it does not decide which
 * executable path to use, only refuses to run one when untrusted. Deciding
 * that a workspace-level `just.executablePath` must be ignored when
 * untrusted is `src/cli/detect.ts`'s job, made moot in practice today by the
 * stronger rule here: nothing runs at all until the workspace is trusted, so
 * an untrusted-workspace path is never reached regardless of its source.
 */

import { execFile } from "node:child_process";
import * as vscode from "vscode";

export type JustOutcome =
    | { readonly ok: true; readonly stdout: string }
    | { readonly ok: false; readonly reason: "untrusted" }
    | { readonly ok: false; readonly reason: "spawn-error"; readonly message: string };

const TIMEOUT_MS = 10_000;

/**
 * Run `just` with `args`. Resolves, never rejects — a failed spawn is data,
 * not an exception, so callers do not need a try/catch around every use.
 */
export function runJust(executablePath: string, args: readonly string[]): Promise<JustOutcome> {
    if (!vscode.workspace.isTrusted) {
        return Promise.resolve({ ok: false, reason: "untrusted" });
    }
    return new Promise((resolve) => {
        execFile(executablePath, args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    ok: false,
                    reason: "spawn-error",
                    message: stderr.trim() || error.message,
                });
                return;
            }
            resolve({ ok: true, stdout });
        });
    });
}
